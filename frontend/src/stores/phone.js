import { defineStore } from 'pinia';
import { useUiStore } from './ui';
import { getSettings } from '../api/settings';
import { getTextLog, sendTextApi, sendTextStreamRequest } from '../api/phone';

// One conversation per character (Phase 2 scope — group texting is a
// later phase), so a character's own id doubles as its conversation id.
// Deliberately simpler than stores/chat.js: no "current place"/entering
// concept, and the streaming state only ever tracks *who's* replying
// (characterId, name), never the accumulating live text — the typing
// indicator (see PhoneThread.vue) is a generic "..." state, not a
// character-by-character reveal, so there's nothing else to accumulate.
export const usePhoneStore = defineStore('phone', {
  state: () => ({
    logs: {}, // characterId -> entries[]
    loading: false,
    streamingState: null, // { characterId, name } | null
    loadedIds: new Set(), // characters whose log has been fetched at least once this session
  }),
  actions: {
    async openConversation(characterId) {
      if (this.loadedIds.has(characterId)) return;
      const { ok, data } = await getTextLog(characterId);
      if (ok) {
        this.logs[characterId] = data.log;
        this.loadedIds.add(characterId);
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

    async _consumeSse(characterId, res) {
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
            this.logs[characterId] = evt.log;
          } else if (evt.type === 'speaker') {
            this.streamingState = { characterId, name: evt.name };
          } else if (evt.type === 'turn') {
            this.logs[characterId] = [...(this.logs[characterId] || []), ...evt.entries];
            this.streamingState = null;
          } else if (evt.type === 'done') {
            finalLog = evt.log;
            finalError = evt.error || null;
          }
        });
      }

      this.streamingState = null;
      if (finalLog) this.logs[characterId] = finalLog;
      return { error: finalError };
    },

    async sendText(characterId, text) {
      if (!text || this.loading) return;
      this.logs[characterId] = [...(this.logs[characterId] || []), { type: 'user', text }];
      this.loading = true;

      try {
        const cfg = await getSettings().then((r) => r.data).catch(() => ({}));
        let result;
        if (cfg.streaming) {
          result = await this._consumeSse(characterId, await sendTextStreamRequest(characterId, { text }));
        } else {
          const { ok, data } = await sendTextApi(characterId, { text });
          if (!ok) throw new Error(data.error || 'request failed');
          this.logs[characterId] = data.log;
          result = { error: data.error };
        }

        if (result.error) {
          this.logs[characterId] = [...this.logs[characterId], { type: 'error', text: `Couldn't send that. (${result.error})` }];
          useUiStore().showError(result.error);
        }
      } catch (err) {
        this.logs[characterId] = [...(this.logs[characterId] || []), { type: 'error', text: `Couldn't send that. (${err.message})` }];
        useUiStore().showError(err.message);
      } finally {
        this.streamingState = null;
        this.loading = false;
      }
    },
  },
});
