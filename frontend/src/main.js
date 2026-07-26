import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from './router';
import App from './App.vue';
import './styles/shared.css';
import './styles/main.css';
import { useThemeStore } from './stores/theme';
import { useWorldsStore } from './stores/worlds';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// Applied before mount, same as the original inline script's
// `applyTheme();` call right after defining it — as early as possible,
// before the rest of the page renders.
useThemeStore().apply();

// Awaited before mount so the nav's current-world chip has a resolved
// world by first paint. Not load-bearing for correctness — api/http.js
// sends no X-World-Id header until one is set in localStorage, which the
// backend treats as "use the default world" — so this degrades gracefully
// if the backend is briefly unreachable at startup (list stays empty).
// Wrapped in an async IIFE rather than a top-level await — Vite's
// configured browser targets (see vite.config.js) predate top-level
// module await.
(async () => {
  // `npm run dev` (vite --mode mock) runs this app with zero backend
  // dependency: mock/mockBackend.js patches window.fetch to answer every
  // /api/* call in-browser with seeded demo data, entirely before the
  // network layer ever sees a request — so it must be imported (and awaited)
  // before the very first real call, useWorldsStore().init() below.
  // `npm run dev:live` (a real backend on :3001) and `npm start` (production
  // build) never touch this branch — import.meta.env.MODE is a compile-time
  // constant, so those builds strip this whole branch (and the mock module
  // along with it) via dead-code elimination.
  if (import.meta.env.MODE === 'mock') {
    await import('./mock/mockBackend.js');
  }
  await useWorldsStore().init();
  app.mount('#app');
})();
