import { defineStore } from 'pinia';

// A dismissible banner for real endpoint/network failures — separate from
// the "no API key configured" info banner (see stores/chat.js's
// noKeyBanner), which is informational rather than an error that just
// happened. Cross-cutting: surfaced from Freeroam actions and Settings'
// test-connection button alike.
export const useUiStore = defineStore('ui', {
  state: () => ({ errorMessage: null }),
  actions: {
    showError(message) { this.errorMessage = message; },
    dismissError() { this.errorMessage = null; },
  },
});
