import { defineStore } from 'pinia';
import { useUiStore } from './ui';
import { getSettings } from '../api/settings';
import { handleUnknownWorld } from '../api/http';
import { parseSseEvents } from '../utils/sse';
import {
  getTextLog, sendTextApi, sendTextStreamRequest, retryTextApi, retryTextStreamRequest, deleteTextMessageApi,
  triggerTextApi, getUnreadTextCount,
} from '../api/phone';

// One conversation per character (Phase 2 scope — group texting is a
// later phase), so a character's own id doubles as its conversation id.
// Deliberately simpler than stores/chat.js: no "current place"/entering
// concept, and the streaming state only ever tracks *who's* replying
// (characterId, name), never the accumulating live text — the typing
// indicator (see PhoneThread.vue) is a generic "..." state, not a
// character-by-character reveal, so there's nothing else to accumulate.
// `loadingIds` (not a single flag) since more than one conversation can be
// in flight at once — the user can send to A, then navigate to B's thread
// before A's reply lands, and B must not show A's loading/typing state.
export const usePhoneStore = defineStore('phone', {
  state: () => ({
    logs: {}, // characterId -> entries[]
    loadingIds: new Set(), // characterIds with a send/retry currently in flight
    streamingState: null, // { characterId, name } | null
    loadedIds: new Set(), // characters whose log has been fetched at least once this session
    openingIds: new Set(), // characterIds whose log GET is currently in flight (re-entrancy guard)
    unreadCount: 0, // proactive texts (Phase 5) not yet seen — badge count
    unreadByCharacterId: {}, // characterId -> unread count, for the per-contact badge (only non-zero entries present)
    // The AbortController backing each characterId's in-flight send/retry —
    // a Map, not a single field, same keying as loadingIds, since more than
    // one conversation can be generating at once.
    abortControllers: new Map(),
  }),
  actions: {
    // Aborts characterId's in-flight send/retry, if any — the backend's own
    // connection-close signal (requestCancelSignal in server.js) turns this
    // into a genuine server-side cancel, not just hiding it client-side.
    cancelText(characterId) {
      this.abortControllers.get(characterId)?.abort();
    },

    // streamingState is one shared field, not a per-id Map like loadingIds/
    // abortControllers — without this guard, conversation A finishing (or
    // hitting its own 'turn' event) while B is still generating concurrently
    // would clear or stomp on B's still-in-flight typing state.
    clearStreamingStateFor(characterId) {
      if (this.streamingState?.characterId === characterId) this.streamingState = null;
    },

    async openConversation(characterId) {
      // loadedIds alone isn't a re-entrancy guard — it's only set *after* the
      // GET below resolves, so two calls before that (e.g. rapid navigation)
      // would both pass and fire duplicate requests without also checking
      // openingIds, which is set synchronously before the first await.
      //
      // loadedIds alone also isn't a "don't need to fetch again" guard: this
      // GET is the only thing that marks this contact's proactive texts as
      // read server-side AND pulls in whatever landed since the first open —
      // skipping it forever after the first visit left a contact's thread
      // permanently stale and its badge stuck once a new message arrived
      // later in the same session. Re-fetch whenever there's known unread
      // for this contact, even if it was already loaded once.
      const alreadyLoaded = this.loadedIds.has(characterId);
      const hasUnread = this.unreadByCharacterId[characterId] > 0;
      if ((alreadyLoaded && !hasUnread) || this.openingIds.has(characterId)) return;
      this.openingIds.add(characterId);
      try {
        const { ok, data } = await getTextLog(characterId);
        if (ok) {
          this.logs[characterId] = data.log;
          this.loadedIds.add(characterId);
          // The GET just marked any proactive texts in this conversation as
          // read server-side — refresh the badge to match.
          this.refreshUnreadCount();
        } else {
          useUiStore().showError(data.error || 'Could not load that conversation.');
        }
      } finally {
        this.openingIds.delete(characterId);
      }
    },

    async refreshUnreadCount() {
      const { ok, data } = await getUnreadTextCount();
      if (ok) {
        this.unreadCount = data.total;
        this.unreadByCharacterId = data.byCharacterId || {};
      }
    },

    // Manual "nudge" — same generation path as a real automatic hit, just
    // skipping the dice roll. Doesn't touch loading/streamingState (this
    // isn't a reply to anything the user is actively waiting on) but does
    // update the conversation log and badge once it lands. Deliberately
    // does NOT mark characterId as loaded — the message still counts as
    // unread server-side until the conversation is actually opened, and
    // openConversation's own GET is what marks it read; skipping that here
    // would let loadedIds' guard block that GET from ever firing.
    async triggerText(characterId) {
      const { ok, data } = await triggerTextApi(characterId);
      if (ok) {
        this.logs[characterId] = data.log;
        this.refreshUnreadCount();
      } else {
        useUiStore().showError(data.error || 'Could not reach them.');
      }
      return { ok, data };
    },

    async _consumeSse(characterId, res) {
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        // Streaming requests bypass http.js's request(), so this is the
        // equivalent stale-world recovery for them — without it, a world
        // deleted from another tab just throws a generic error forever
        // instead of self-recovering the way non-streaming requests do.
        if (handleUnknownWorld(res, data)) throw new Error('The active world no longer exists — reloading.');
        throw new Error(data.error || `request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalLog = null;
      let finalError = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;

        parsed.events.forEach((evt) => {
          if (evt.type === 'ack') {
            this.logs[characterId] = evt.log;
          } else if (evt.type === 'speaker') {
            this.streamingState = { characterId, name: evt.name };
          } else if (evt.type === 'turn') {
            this.logs[characterId] = [...(this.logs[characterId] || []), ...evt.entries];
            this.clearStreamingStateFor(characterId);
          } else if (evt.type === 'done') {
            finalLog = evt.log;
            finalError = evt.error || null;
          }
        });
      }

      this.clearStreamingStateFor(characterId);
      if (finalLog) this.logs[characterId] = finalLog;
      return { error: finalError };
    },

    async sendText(characterId, text) {
      if (!text || this.loadingIds.has(characterId)) return;
      this.logs[characterId] = [...(this.logs[characterId] || []), { type: 'user', text }];
      this.loadingIds.add(characterId);
      const controller = new AbortController();
      this.abortControllers.set(characterId, controller);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this._consumeSse(characterId, await sendTextStreamRequest(characterId, { text }, controller.signal));
        } else {
          const { ok, data } = await sendTextApi(characterId, { text }, controller.signal);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[characterId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[characterId] = [...this.logs[characterId], { type: 'error', id: crypto.randomUUID(), text: `Couldn't send that. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          this.logs[characterId] = [...(this.logs[characterId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't send that. (${err.message})` }];
          useUiStore().showError(err.message);
        }
      } finally {
        this.clearStreamingStateFor(characterId);
        this.abortControllers.delete(characterId);
        this.loadingIds.delete(characterId);
      }
    },

    // Re-runs generation for the trailing user message when nothing
    // replied — same idea as chat.js's retryMessage and groups.js's
    // retryText.
    async retryText(characterId) {
      if (this.loadingIds.has(characterId)) return;
      this.loadingIds.add(characterId);
      const controller = new AbortController();
      this.abortControllers.set(characterId, controller);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this._consumeSse(characterId, await retryTextStreamRequest(characterId, controller.signal));
        } else {
          const { ok, data } = await retryTextApi(characterId, controller.signal);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[characterId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[characterId] = [...(this.logs[characterId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't retry. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          this.logs[characterId] = [...(this.logs[characterId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't retry. (${err.message})` }];
          useUiStore().showError(err.message);
        }
      } finally {
        this.clearStreamingStateFor(characterId);
        this.abortControllers.delete(characterId);
        this.loadingIds.delete(characterId);
      }
    },

    async deleteMessage(characterId, entryId) {
      const { ok, data } = await deleteTextMessageApi(characterId, entryId);
      if (ok) this.logs[characterId] = data.log;
      else useUiStore().showError(data.error || 'Could not delete the message.');
      return { ok, data };
    },

    // A generation-failure error is a client-only render artifact — never
    // sent to the backend, so removing it is a pure local filter.
    removeError(characterId, entryId) {
      this.logs[characterId] = (this.logs[characterId] || []).filter((m) => m.id !== entryId);
    },
  },
});
