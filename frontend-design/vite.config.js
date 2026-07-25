import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Design-only fork of frontend/ — no backend, no proxy. src/mock/mockBackend.js
// intercepts window.fetch for every /api/* call before it ever reaches the
// network, so there's nothing to proxy to; deliberately NOT pointing this at
// :3001 like the real frontend/vite.config.js does, so a bug in the mock
// (something falling through unhandled) fails loudly as a network error in
// devtools instead of silently reaching a real backend if one happens to be running.
export default defineConfig({
  plugins: [vue()],
});
