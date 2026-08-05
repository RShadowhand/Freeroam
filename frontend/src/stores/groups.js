import { defineStore } from 'pinia';
import { useUiStore } from './ui';
import { getSettings } from '../api/settings';
import { handleUnknownWorld } from '../api/http';
import { parseSseEvents } from '../utils/sse';
import {
  getGroups, createGroupApi, getGroupLog, updateGroupApi, sendGroupTextApi, sendGroupTextStreamRequest,
  retryGroupApi, retryGroupStreamRequest, deleteGroupApi, deleteGroupMessageApi, triggerGroupApi,
  allowGroupCascadeApi, denyGroupCascadeApi,
} from '../api/groups';

// Group text conversations — same stored-log shape as stores/phone.js's
// 1-on-1 threads, just keyed by group id, plus a `groups` list carrying
// each group's name/participantIds. Shares parseSseEvents (utils/sse.js)
// and the same consume-loop shape with phone.js's _consumeSse.
export const useGroupsStore = defineStore('groups', {
  state: () => ({
    groups: [], // [{id, name, participantIds, createdAt}]
    logs: {}, // groupId -> entries[]
    // `loadingIds` (not a single flag) since more than one group conversation
    // can be in flight at once — sending to one group must not show as
    // loading/typing in a different group's thread.
    loadingIds: new Set(), // groupIds with a send/retry currently in flight
    streamingState: null, // { groupId, charId, name } | null
    loadedIds: new Set(),
    openingIds: new Set(), // groupIds whose log GET is currently in flight (re-entrancy guard)
    // The AbortController backing each groupId's in-flight send/retry — a
    // Map, not a single field, same keying as loadingIds, since more than
    // one group conversation can be generating at once.
    abortControllers: new Map(),
    // groupId -> { charId, name } | undefined — a cascade reply awaiting the
    // user's explicit allow/deny (manual-response-flow feature, only ever
    // populated when settings.groupCascadeManualApproval is on). Backend is
    // the source of truth for whether one exists; this just mirrors it.
    pendingReplies: {},
  }),
  actions: {
    // Aborts groupId's in-flight send/retry, if any — the backend's own
    // connection-close signal (requestCancelSignal in server.js) turns this
    // into a genuine server-side cancel, not just hiding it client-side.
    cancelText(groupId) {
      this.abortControllers.get(groupId)?.abort();
    },

    // streamingState is one shared field, not a per-id Map like loadingIds/
    // abortControllers — without this guard, one group's completion (or its
    // own 'turn' event) while a different group is still generating
    // concurrently would clear or stomp on that other group's still-in-
    // flight typing state.
    clearStreamingStateFor(groupId) {
      if (this.streamingState?.groupId === groupId) this.streamingState = null;
    },

    async loadGroups() {
      const { ok, data } = await getGroups();
      if (ok) this.groups = data.groups;
    },

    async createGroup(name, participantIds) {
      const { ok, data } = await createGroupApi({ name, participantIds });
      if (ok) this.groups = [...this.groups, data.group];
      return { ok, data };
    },

    async deleteGroup(groupId) {
      const { ok, data } = await deleteGroupApi(groupId);
      if (ok) {
        this.groups = this.groups.filter((g) => g.id !== groupId);
        delete this.logs[groupId];
        this.loadedIds.delete(groupId);
      }
      return { ok, data };
    },

    async updateGroup(groupId, { name, participantIds } = {}) {
      const body = {};
      if (name !== undefined) body.name = name;
      if (participantIds !== undefined) body.participantIds = participantIds;
      const { ok, data } = await updateGroupApi(groupId, body);
      if (ok) this.groups = this.groups.map((g) => (g.id === groupId ? data.group : g));
      return { ok, data };
    },

    async deleteMessage(groupId, entryId) {
      const { ok, data } = await deleteGroupMessageApi(groupId, entryId);
      if (ok) this.logs[groupId] = data.log;
      else useUiStore().showError(data.error || 'Could not delete the message.');
      return { ok, data };
    },

    // Mirrors pendingReplies[groupId] to whatever the backend just reported
    // (see pendingCascadeSteps in server.js) — present on the GET-group
    // response (reopening a thread re-shows a reply that was still awaiting
    // a decision) and on send/retry/trigger/allow's own responses.
    setPendingReply(groupId, pendingReply) {
      if (pendingReply) this.pendingReplies[groupId] = pendingReply;
      else delete this.pendingReplies[groupId];
    },

    async openConversation(groupId) {
      // loadedIds alone isn't a re-entrancy guard — it's only set *after* the
      // GET below resolves, so two calls before that (e.g. rapid navigation)
      // would both pass and fire duplicate requests without also checking
      // openingIds, which is set synchronously before the first await.
      if (this.loadedIds.has(groupId) || this.openingIds.has(groupId)) return;
      this.openingIds.add(groupId);
      try {
        const { ok, data } = await getGroupLog(groupId);
        if (ok) {
          this.logs[groupId] = data.log;
          this.loadedIds.add(groupId);
          this.setPendingReply(groupId, data.pendingReply);
        } else {
          useUiStore().showError(data.error || 'Could not load that conversation.');
        }
      } finally {
        this.openingIds.delete(groupId);
      }
    },

    async _consumeSse(groupId, res) {
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
            this.logs[groupId] = evt.log;
          } else if (evt.type === 'speaker') {
            this.streamingState = { groupId, charId: evt.charId, name: evt.name };
          } else if (evt.type === 'turn') {
            this.logs[groupId] = [...(this.logs[groupId] || []), ...evt.entries];
            this.clearStreamingStateFor(groupId);
          } else if (evt.type === 'done') {
            finalLog = evt.log;
            finalError = evt.error || null;
          }
        });
      }

      this.clearStreamingStateFor(groupId);
      if (finalLog) this.logs[groupId] = finalLog;
      return { error: finalError };
    },

    async sendText(groupId, text) {
      if (!text || this.loadingIds.has(groupId)) return;
      this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'user', text }];
      this.loadingIds.add(groupId);
      const controller = new AbortController();
      this.abortControllers.set(groupId, controller);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        // Manual cascade approval never streams server-side (see
        // beginGroupCascade in server.js) regardless of cfg.streaming — each
        // step is already separated by a real user decision, so there's
        // nothing to stream. Using the SSE path here would just try to parse
        // a plain JSON body as an SSE frame and silently produce nothing.
        if (cfg.streaming && !cfg.groupCascadeManualApproval) {
          result = await this._consumeSse(groupId, await sendGroupTextStreamRequest(groupId, { text }, controller.signal));
        } else {
          const { ok, data } = await sendGroupTextApi(groupId, { text }, controller.signal);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[groupId] = data.log;
          this.setPendingReply(groupId, data.pendingReply);
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[groupId] = [...this.logs[groupId], { type: 'error', id: crypto.randomUUID(), text: `Couldn't send that. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't send that. (${err.message})` }];
          useUiStore().showError(err.message);
        }
      } finally {
        this.clearStreamingStateFor(groupId);
        this.abortControllers.delete(groupId);
        this.loadingIds.delete(groupId);
      }
    },

    // Re-runs the cascade for the trailing user message when nothing
    // replied — same "nothing new sent, just try generation again" idea as
    // chat.js's retryMessage.
    async retryText(groupId) {
      if (this.loadingIds.has(groupId)) return;
      this.loadingIds.add(groupId);
      const controller = new AbortController();
      this.abortControllers.set(groupId, controller);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        // Same manual-approval-never-streams reasoning as sendText — see its comment.
        if (cfg.streaming && !cfg.groupCascadeManualApproval) {
          result = await this._consumeSse(groupId, await retryGroupStreamRequest(groupId, controller.signal));
        } else {
          const { ok, data } = await retryGroupApi(groupId, controller.signal);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[groupId] = data.log;
          this.setPendingReply(groupId, data.pendingReply);
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't retry. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't retry. (${err.message})` }];
          useUiStore().showError(err.message);
        }
      } finally {
        this.clearStreamingStateFor(groupId);
        this.abortControllers.delete(groupId);
        this.loadingIds.delete(groupId);
      }
    },

    // Manual "make someone text first" — characterId omitted asks the
    // backend to pick a random participant. Deliberately non-streaming, no
    // AbortController — same simplicity as 1-on-1 texting's own triggerText
    // (phone.js), just guarded by loadingIds like every other group action
    // here since it's a real generation call, not an instant local one.
    async triggerText(groupId, characterId = null) {
      if (this.loadingIds.has(groupId)) return { ok: false, data: {} };
      this.loadingIds.add(groupId);
      try {
        const { ok, data } = await triggerGroupApi(groupId, characterId);
        if (ok) {
          this.logs[groupId] = data.log;
          this.setPendingReply(groupId, data.pendingReply);
          if (data.error) useUiStore().showError(data.error);
        } else {
          useUiStore().showError(data.error || 'Could not trigger a text.');
        }
        return { ok, data };
      } finally {
        this.loadingIds.delete(groupId);
      }
    },

    // The user approves the reply currently parked in pendingReplies[groupId]
    // (see setPendingReply) — autoAllow=true means "yes, and don't ask again
    // for the rest of this cascade." Guarded by loadingIds like every other
    // generation call here, both to block a double-click and so the thread's
    // existing typing/busy UI applies to this too.
    async allowPendingReply(groupId, { autoAllow = false } = {}) {
      if (this.loadingIds.has(groupId)) return;
      this.loadingIds.add(groupId);
      try {
        const { ok, data } = await allowGroupCascadeApi(groupId, autoAllow);
        if (ok) {
          this.logs[groupId] = data.log;
          this.setPendingReply(groupId, data.pendingReply);
          if (data.error) useUiStore().showError(data.error);
        } else {
          useUiStore().showError(data.error || 'Could not generate that reply.');
          if (data.log) this.logs[groupId] = data.log;
          this.setPendingReply(groupId, null);
        }
      } finally {
        this.loadingIds.delete(groupId);
      }
    },

    // The user declines — the cascade round ends here (see the backend's
    // own comment on /cascade/deny for why this doesn't reroll to someone
    // else).
    async denyPendingReply(groupId) {
      if (this.loadingIds.has(groupId)) return;
      this.loadingIds.add(groupId);
      try {
        const { ok, data } = await denyGroupCascadeApi(groupId);
        if (ok) this.logs[groupId] = data.log;
        else useUiStore().showError(data.error || 'Could not dismiss that.');
        this.setPendingReply(groupId, null);
      } finally {
        this.loadingIds.delete(groupId);
      }
    },

    // A generation-failure error is a client-only render artifact — never
    // sent to the backend, so removing it is a pure local filter.
    removeError(groupId, entryId) {
      this.logs[groupId] = (this.logs[groupId] || []).filter((m) => m.id !== entryId);
    },
  },
});
