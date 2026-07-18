import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from './router';
import App from './App.vue';
import './styles/shared.css';
import './styles/main.css';
import { useThemeStore } from './stores/theme';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// Applied before mount, same as the original inline script's
// `applyTheme();` call right after defining it — as early as possible,
// before the rest of the page renders.
useThemeStore().apply();

app.mount('#app');
