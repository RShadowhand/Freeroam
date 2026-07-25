import './mock/mockBackend.js';
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
  await useWorldsStore().init();
  app.mount('#app');
})();
