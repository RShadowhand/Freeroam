import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The Express backend (backend/server.js) owns all data/generation logic
// and serves this app's production build as static files (see its
// express.static line, pointed at frontend/dist). In dev, Vite serves the
// SPA itself and just proxies API/avatar requests through to the backend
// on :3001 so relative fetch('/api/...') calls used throughout the app
// work unchanged in both modes.
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/avatars': 'http://localhost:3001',
    },
  },
});
