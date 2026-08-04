import { defineStore } from 'pinia';
import { useUiStore } from './ui';
import { getSettings } from '../api/settings';
import { handleUnknownWorld } from '../api/http';
import {
  getGroups, createGroupApi, getGroupLog, updateGroupApi, sendGroupTextApi, sendGroupTextStreamRequest,
  retryGroupApi, retryGroupStreamRequest, deleteGroupApi, deleteGroupMessageApi,
} from '../api/groups';

// Group text conversations — same stored-log shape as stores/phone.js's
// 1-on-1 threads, just keyed by group id, plus a `groups` list carrying
// each group's name/participantIds. Its own _parseSseEvents/consume
// method rather than sharing phone.js's, matching this codebase's existing
// convention (chat.js and phone.js each already keep their own copy).
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
  }),
  actions: {
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
        } else {
          useUiStore().showError(data.error || 'Could not load that conversation.');
        }
      } finally {
        this.openingIds.delete(groupId);
      }
    },

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
        const parsed = this._parseSseEvents(buffer);
        buffer = parsed.rest;

        parsed.events.forEach((evt) => {
          if (evt.type === 'ack') {
            this.logs[groupId] = evt.log;
          } else if (evt.type === 'speaker') {
            this.streamingState = { groupId, charId: evt.charId, name: evt.name };
          } else if (evt.type === 'turn') {
            this.logs[groupId] = [...(this.logs[groupId] || []), ...evt.entries];
            this.streamingState = null;
          } else if (evt.type === 'done') {
            finalLog = evt.log;
            finalError = evt.error || null;
          }
        });
      }

      this.streamingState = null;
      if (finalLog) this.logs[groupId] = finalLog;
      return { error: finalError };
    },

    async sendText(groupId, text) {
      if (!text || this.loadingIds.has(groupId)) return;
      this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'user', text }];
      this.loadingIds.add(groupId);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this._consumeSse(groupId, await sendGroupTextStreamRequest(groupId, { text }));
        } else {
          const { ok, data } = await sendGroupTextApi(groupId, { text });
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[groupId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[groupId] = [...this.logs[groupId], { type: 'error', id: crypto.randomUUID(), text: `Couldn't send that. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't send that. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.loadingIds.delete(groupId);
      }
    },

    // Re-runs the cascade for the trailing user message when nothing
    // replied — same "nothing new sent, just try generation again" idea as
    // chat.js's retryMessage.
    async retryText(groupId) {
      if (this.loadingIds.has(groupId)) return;
      this.loadingIds.add(groupId);

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this._consumeSse(groupId, await retryGroupStreamRequest(groupId));
        } else {
          const { ok, data } = await retryGroupApi(groupId);
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[groupId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't retry. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', id: crypto.randomUUID(), text: `Couldn't retry. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
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
