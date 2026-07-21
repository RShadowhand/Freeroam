import { defineStore } from 'pinia';
import { useUiStore } from './ui';
import { getSettings } from '../api/settings';
import {
  getGroups, createGroupApi, getGroupLog, sendGroupTextApi, sendGroupTextStreamRequest, deleteGroupApi,
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
    loading: false,
    streamingState: null, // { groupId, charId, name } | null
    loadedIds: new Set(),
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

    async openConversation(groupId) {
      if (this.loadedIds.has(groupId)) return;
      const { ok, data } = await getGroupLog(groupId);
      if (ok) {
        this.logs[groupId] = data.log;
        this.loadedIds.add(groupId);
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
      if (!text || this.loading) return;
      this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'user', text }];
      this.loading = true;

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
          this.logs[groupId] = [...this.logs[groupId], { type: 'error', text: `Couldn't send that. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[groupId] = [...(this.logs[groupId] || []), { type: 'error', text: `Couldn't send that. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.loading = false;
      }
    },
  },
});
