import { defineStore } from 'pinia';
import { useWorldStore } from './world';
import { useUiStore } from './ui';
import { placeCharacter } from '../api/characters';
import { getSettings } from '../api/settings';
import { getStoredWorldId } from '../api/worldId';
import { handleUnknownWorld } from '../api/http';
import {
  enterPlaceApi, sayApi, retryApi, regenerateApi,
  sayStreamRequest, retryStreamRequest, regenerateStreamRequest,
  updateMessage, deleteMessageApi,
} from '../api/chat';
import { startCallApi, callSayApi, callSayStreamRequest, endCallApi } from '../api/calls';

// "Last place" is scoped per-world (each save slot resumes independently) —
// reads getStoredWorldId() directly rather than the worlds Pinia store, to
// avoid a store <-> store circular import (worlds.js already depends on
// this store for switchWorld's $reset()). Pre-worlds installs only ever
// had the flat LEGACY key; initFreeroam() below copies it forward once so
// upgrading doesn't lose an existing user's resume point.
const LEGACY_LAST_PLACE_KEY = 'freeroam.lastPlace';
function lastPlaceKey() {
  const worldId = getStoredWorldId();
  return worldId ? `freeroam.lastPlace.${worldId}` : LEGACY_LAST_PLACE_KEY;
}

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
    activeCall: null, // { charId, name } | null — a phone call in progress at currentPlace (Phase 3)
    savedNpcNames: new Set(), // lowercased names already promoted to real characters this session
    pendingReturnMarker: new Set(), // places needing a "You return to X." marker once engaged
    bannerMessage: null, // the dismissable-free info banner (no API key / can't reach backend)
    editingMessageId: null,
    pendingMessageIds: new Set(), // entryIds with a save-edit/delete currently in flight
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
      // A call ties down the place it was placed from (its bystanders were
      // demoted there, its transcript lives in that place's log) — walking
      // away mid-call would strand that state with no way to restore it.
      if (this.activeCall) {
        useUiStore().showError('Hang up before going somewhere else.');
        return;
      }
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
        this.activeCall = data.activeCall || null;
        if (data.returnMarkerPending) this.pendingReturnMarker.add(id); else this.pendingReturnMarker.delete(id);
        localStorage.setItem(lastPlaceKey(), id);
      } catch (err) {
        this.logs[id] = [...(this.logs[id] || []), { type: 'error', id: crypto.randomUUID(), text: `Something went wrong trying to reach the room. (${err.message})` }];
        useUiStore().showError(`Couldn't enter that place. (${err.message})`);
      } finally {
        this.entering = false;
        this.setLoading(false);
      }
    },

    async initFreeroam() {
      const world = useWorldStore();
      await world.loadWorldState();

      // One-time forward-copy: an existing (pre-worlds) install's flat
      // "last place" becomes this world's scoped key, so upgrading doesn't
      // strand the user back at the first place in the list.
      const key = lastPlaceKey();
      if (key !== LEGACY_LAST_PLACE_KEY && localStorage.getItem(key) === null) {
        const legacy = localStorage.getItem(LEGACY_LAST_PLACE_KEY);
        if (legacy) localStorage.setItem(key, legacy);
      }

      if (world.places.length) {
        // Resume wherever the visitor left off last session, falling back
        // to the first place for a genuinely new world. enterPlace() is
        // idempotent for an already-visited place (no duplicate arrival
        // marker, no generation) — it just loads the persisted log.
        const savedId = localStorage.getItem(key);
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
          this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', id: crypto.randomUUID(), text: `Something went wrong trying to reach the room. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', id: crypto.randomUUID(), text: `Something went wrong trying to reach the room. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    async sendMessage(text) {
      if (!text || this.loading || this.entering || this.currentPlace === null) return;
      // InputRow doesn't need to know whether a call is active — sendMessage
      // is the one place that decides where a line actually goes.
      if (this.activeCall) return this.sendCallMessage(text);
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
          this.logs[placeId] = [...this.logs[placeId], { type: 'error', id: crypto.randomUUID(), text: `Something went wrong trying to reach the room. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', id: crypto.randomUUID(), text: `Something went wrong trying to reach the room. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    // Calls a character not physically present at the current place —
    // everyone who is present becomes a silent bystander for the call's
    // duration (see backend/server.js's call routes for the demote/restore
    // and redacted-memory mechanics). The call's own back-and-forth still
    // appears right here in the place's message list, tagged call:true.
    async startCall(characterId) {
      if (this.loading || this.entering || this.currentPlace === null || this.activeCall) return;
      const placeId = this.currentPlace;
      this.setLoading(true);
      try {
        const { ok, data } = await startCallApi(characterId, placeId);
        if (!ok) throw new Error(data.error || 'request failed');
        this.logs[placeId] = data.log;
        this.activeCall = { charId: data.callee.id, name: data.callee.name };
        if (data.placements) useWorldStore().placements = data.placements;
      } catch (err) {
        useUiStore().showError(`Could not start the call. (${err.message})`);
      } finally {
        this.setLoading(false);
      }
    },

    // The call's own send path — sendMessage() routes here whenever
    // activeCall is set, so InputRow never has to know a call is happening.
    async sendCallMessage(text) {
      const placeId = this.currentPlace;
      const characterId = this.activeCall.charId;

      this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'user', text, call: true }];
      this.setLoading(true);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this.consumeReactionSse(placeId, await callSayStreamRequest(characterId, { placeId, text }));
        } else {
          const { ok, data } = await callSayApi(characterId, { placeId, text });
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[placeId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[placeId] = [...this.logs[placeId], { type: 'error', id: crypto.randomUUID(), text: `Something went wrong on the call. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', id: crypto.randomUUID(), text: `Something went wrong on the call. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    async endCall() {
      // Same re-entrancy guard as startCall — without checking `loading`,
      // hanging up while sendCallMessage's reply is still in flight fires
      // endCallApi concurrently with it, and whichever resolves last silently
      // overwrites logs[placeId]/activeCall, possibly dropping the reply.
      if (!this.activeCall || this.currentPlace === null || this.loading || this.entering) return;
      const placeId = this.currentPlace;
      const characterId = this.activeCall.charId;
      this.setLoading(true);
      try {
        const { ok, data } = await endCallApi(characterId, placeId);
        if (!ok) throw new Error(data.error || 'request failed');
        this.logs[placeId] = data.log;
        if (data.placements) useWorldStore().placements = data.placements;
      } catch (err) {
        useUiStore().showError(`Could not end the call cleanly. (${err.message})`);
      } finally {
        this.activeCall = null;
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
        this.logs[placeId] = [...(this.logs[placeId] || []), { type: 'error', id: crypto.randomUUID(), text: `Could not regenerate. (${err.message})` }];
      } finally {
        this.streamingState = null;
        this.setLoading(false);
      }
    },

    async saveMessageEdit(entryId, text) {
      // Without this, double-clicking Save (or clicking one of EditRow's two
      // Save buttons twice) fires two concurrent requests for the same entry;
      // if responses resolve out of order, the earlier one can land after the
      // later one and silently overwrite the log with the stale edit.
      if (!text || this.pendingMessageIds.has(entryId)) return;
      this.pendingMessageIds.add(entryId);
      const placeId = this.currentPlace;
      try {
        const { ok, data } = await updateMessage(placeId, entryId, text);
        if (!ok) throw new Error(data.error || 'request failed');
        this.logs[placeId] = data.log;
      } catch (err) {
        useUiStore().showError(`Could not save the edit. (${err.message})`);
      } finally {
        this.editingMessageId = null;
        this.pendingMessageIds.delete(entryId);
      }
    },

    async deleteMessage(entryId) {
      if (this.pendingMessageIds.has(entryId)) return;
      this.pendingMessageIds.add(entryId);
      const placeId = this.currentPlace;
      try {
        const { ok, data } = await deleteMessageApi(placeId, entryId);
        if (!ok) throw new Error(data.error || 'request failed');
        this.logs[placeId] = data.log;
      } catch (err) {
        useUiStore().showError(`Could not delete the message. (${err.message})`);
      } finally {
        this.pendingMessageIds.delete(entryId);
      }
    },

    // A generation-failure error is a client-only render artifact — every
    // catch block above appends one straight to `logs`, never to the
    // backend (there's nothing persisted to delete), so removing it is a
    // pure local filter, no API call.
    removeError(entryId) {
      const placeId = this.currentPlace;
      this.logs[placeId] = (this.logs[placeId] || []).filter((m) => m.id !== entryId);
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
