import { defineStore } from 'pinia';
import { useWorldStore } from './world';
import { useUiStore } from './ui';
import { placeCharacter } from '../api/characters';
import { getSettings } from '../api/settings';
import {
  enterPlaceApi, sayApi, retryApi, regenerateApi,
  sayStreamRequest, retryStreamRequest, regenerateStreamRequest,
  updateMessage, deleteMessageApi,
} from '../api/chat';

const LAST_PLACE_KEY = 'freeroam.lastPlace';

// Chat is persisted and owned by the backend (data/chats/<placeId>.json):
// entering a place and saying something are single API calls that append
// entries server-side (arrival markers, greetings, generated replies) and
// return the full log; `logs` here is just a render cache of what the
// server sent back. Reply parsing, NPC detection, memory recording, and
// all context management happen server-side.
export const useChatStore = defineStore('chat', {
  state: () => ({
    currentPlace: null,
    logs: {}, // placeId -> entries[]
    loading: false,
    entering: false, // synchronous re-entrancy guard for enterPlace
    streamingState: null, // { placeId, charId, name, text, reasoning } | null
    savedNpcNames: new Set(), // lowercased names already promoted to real characters this session
    pendingReturnMarker: new Set(), // places needing a "You return to X." marker once engaged
    bannerMessage: null, // the dismissable-free info banner (no API key / can't reach backend)
    editingMessageId: null,
    expandedReasoningIds: new Set(),
    dismissedSuggestionIds: new Set(),
  }),
  getters: {
    currentLog: (state) => state.logs[state.currentPlace] || [],
  },
  actions: {
    setLoading(v) {
      this.loading = v;
    },

    async moveCharacter(charId, placeId) {
      const world = useWorldStore();
      const { ok, data } = await placeCharacter(charId, { placeId });
      if (ok) world.placements = data.placements;
      return { ok, data };
    },

    // Promotes/demotes a present character — active participants take a
    // turn each round, inactive ones stay in the room (still aware of what's
    // said, still remembered) but don't generate a reply until promoted again.
    async setCharacterActive(charId, active) {
      const world = useWorldStore();
      const { ok, data } = await placeCharacter(charId, { active });
      if (ok) world.placements = data.placements;
      return { ok, data };
    },

    // Sends a character elsewhere AND follows them there — the user's own
    // view switches to that place too, unlike a plain moveCharacter "send to".
    async goWithCharacterTo(charId, placeId) {
      await this.moveCharacter(charId, placeId);
      await this.enterPlace(placeId);
    },

    async checkApiKeyBanner() {
      try {
        const { data } = await getSettings();
        this.bannerMessage = data.hasKey ? null : 'no-key';
      } catch {
        this.bannerMessage = 'unreachable';
      }
    },

    async enterPlace(id) {
      const world = useWorldStore();
      if (this.entering || this.loading) return;
      if (id === this.currentPlace) return; // clicking the room you're already in is a no-op
      this.entering = true;

      try {
        await world.loadWorldState(); // pick up any places/placements changed on other views since last visit

        const p = world.placeById(id);
        if (!p) return; // place may have just been deleted elsewhere

        this.currentPlace = id;
        this.setLoading(true);

        // Entering is free — the backend only appends the arrival marker
        // (and first-visit scripted greetings); no generation happens until say().
        const { ok, data } = await enterPlaceApi(id);
        if (!ok) throw new Error(data.error || 'request failed');

        this.logs[id] = data.log;
        if (data.returnMarkerPending) this.pendingReturnMarker.add(id); else this.pendingReturnMarker.delete(id);
        localStorage.setItem(LAST_PLACE_KEY, id);
      } catch (err) {
        this.logs[id] = [...(this.logs[id] || []), { type: 'error', text: `Something goes wrong trying to reach the room. (${err.message})` }];
        useUiStore().showError(`Couldn't enter that place. (${err.message})`);
      } finally {
        this.entering = false;
        this.setLoading(false);
      }
    },

    async initFreeroam() {
      const world = useWorldStore();
      await world.loadWorldState();
      if (world.places.length) {
        // Resume wherever the visitor left off last session, falling back
        // to the first place for a genuinely new world. enterPlace() is
        // idempotent for an already-visited place (no duplicate arrival
        // marker, no generation) — it just loads the persisted log.
        const savedId = localStorage.getItem(LAST_PLACE_KEY);
        const start = (savedId && world.placeById(savedId)) || world.places[0];
        await this.enterPlace(start.id);
      }
      await this.checkApiKeyBanner();
    },

    // parseSseEvents: splits an accumulating text buffer on SSE's blank-line
    // frame separator and parses each frame's `data:` line as JSON.
    _parseSseEvents(buffer) {
      const events = [];
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore malformed chunk */ }
        }
      }
      return { events, rest: buffer };
    },

    // Consumes an SSE reaction-round stream (shared shape across say/retry/
    // regenerate: ack/speaker/delta/turn/done), updating `logs` and the live
    // streaming bubble as events arrive. Returns { error } once the stream
    // ends. say/retry append each turn's entries as they land
    // (appendOnTurn); regenerate instead relies solely on `done`'s
    // authoritative log, since it's splicing a replacement into the middle
    // of the log, not appending to the end.
    async consumeReactionSse(placeId, res, { appendOnTurn = true } = {}) {
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
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
        const parsed = this._parseSseEvents(buffer);
        buffer = parsed.rest;

        parsed.events.forEach((evt) => {
          if (evt.type === 'ack') {
            this.logs[placeId] = evt.log;
          } else if (evt.type === 'speaker') {
            this.streamingState = { placeId, charId: evt.charId, name: evt.name, text: '', reasoning: '' };
          } else if (evt.type === 'delta') {
            if (this.streamingState && evt.text) this.streamingState.text += evt.text;
            if (this.streamingState && evt.reasoning) this.streamingState.reasoning += evt.reasoning;
          } else if (evt.type === 'turn') {
            if (appendOnTurn) this.logs[placeId] = [...(this.logs[placeId] || []), ...evt.entries];
            this.streamingState = null;
          } else if (evt.type === 'done') {
            finalLog = evt.log;
            finalError = evt.error || null;
          }
        });
      }

      this.streamingState = null;
      if (finalLog) this.logs[placeId] = finalLog;
      return { error: finalError };
    },

    // Re-runs generation for the trailing user message when nothing replied
    // to it — every reply was deleted, or generation errored and left
    // nothing persisted. No new user line is sent; the backend reuses the
    // existing one.
    async retryMessage() {
      if (this.loading || this.entering || this.currentPlace === null) return;
      const placeId = this.currentPlace;
      this.setLoading(true);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this.consumeReactionSse(placeId, await retryStreamRequest(placeId));
        } else {
          const { ok, data } = await retryApi(placeId);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[placeId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', text: `Something goes wrong trying to reach the room. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', text: `Something goes wrong trying to reach the room. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    async sendMessage(text) {
      if (!text || this.loading || this.entering || this.currentPlace === null) return;
      const placeId = this.currentPlace;
      const announceArrival = this.pendingReturnMarker.has(placeId);

      // Optimistic render of the user's line while the server round-trip
      // runs; the authoritative log from the response replaces it.
      this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'user', text }];
      this.setLoading(true);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this.consumeReactionSse(placeId, await sayStreamRequest(placeId, { text, announceArrival }));
        } else {
          const { ok, data } = await sayApi(placeId, { text, announceArrival });
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[placeId] = data.log;
          result = { error: data.error };
        }

        this.pendingReturnMarker.delete(placeId);
        if (result.error) {
          this.logs[placeId] = [...this.logs[placeId], { type: 'error', text: `Something goes wrong trying to reach the room. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', text: `Something goes wrong trying to reach the room. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    async regenerateMessage(entryId) {
      if (this.loading || this.entering || this.currentPlace === null) return;
      const placeId = this.currentPlace;
      this.setLoading(true);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        if (cfg.streaming) {
          // Pull the stale message out of view immediately — its
          // replacement streams in at the bottom, like a fresh reply,
          // until `done` restores the authoritative log with the new text
          // back in its original slot.
          this.logs[placeId] = (this.logs[placeId] || []).filter((m) => m.id !== entryId);
          const result = await this.consumeReactionSse(placeId, await regenerateStreamRequest(placeId, entryId), { appendOnTurn: false });
          if (result.error) throw new Error(result.error);
        } else {
          const { ok, data } = await regenerateApi(placeId, entryId);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[placeId] = data.log;
        }
      } catch (err) {
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', text: `Could not regenerate. (${err.message})` }];
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    async saveMessageEdit(entryId, text) {
      if (!text) return;
      const placeId = this.currentPlace;
      try {
        const { ok, data } = await updateMessage(placeId, entryId, text);
        if (!ok) throw new Error(data.error || 'request failed');
        this.logs[placeId] = data.log;
      } catch (err) {
        useUiStore().showError(`Could not save the edit. (${err.message})`);
      } finally {
        this.editingMessageId = null;
      }
    },

    async deleteMessage(entryId) {
      const placeId = this.currentPlace;
      try {
        const { ok, data } = await deleteMessageApi(placeId, entryId);
        if (!ok) throw new Error(data.error || 'request failed');
        this.logs[placeId] = data.log;
      } catch (err) {
        useUiStore().showError(`Could not delete the message. (${err.message})`);
      }
    },

    toggleReasoning(id) {
      if (this.expandedReasoningIds.has(id)) this.expandedReasoningIds.delete(id);
      else this.expandedReasoningIds.add(id);
    },

    dismissSuggestion(id) {
      this.dismissedSuggestionIds.add(id);
    },
  },
});
