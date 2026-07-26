import { createRouter, createWebHashHistory } from 'vue-router';

// Hash-based, same URL scheme the original hand-rolled router used
// (#/world/places, #/settings/prompts, ...) so existing bookmarks/muscle
// memory keep working. "top" groups routes under one of the three main-nav
// tabs; DEFAULT_SUBROUTE below picks a sub-route when only the top-level
// path is given (e.g. #/world -> #/world/places).
const routes = [
  { path: '/', name: 'freeroam', component: () => import('../views/FreeroamView.vue'), meta: { top: '/' } },
  { path: '/world', redirect: '/world/places' },
  { path: '/world/places', name: 'world-places', component: () => import('../views/PlacesView.vue'), meta: { top: '/world' } },
  { path: '/world/cast', name: 'world-cast', component: () => import('../views/CastView.vue'), meta: { top: '/world' } },
  // Personas merged into the Cast page — redirected rather than dropped
  // outright so an old bookmark/muscle-memory URL still lands somewhere
  // sensible (same convention as /settings/variables below).
  { path: '/world/persona', redirect: '/world/cast' },
  // A distinct top-level prefix from '/world' on purpose — '/world/*' is
  // the in-fiction content editors (places/cast/persona), while this is
  // the save-slot switcher; sharing a prefix would be confusing on both
  // sides of that distinction.
  { path: '/worlds', name: 'worlds', component: () => import('../views/WorldsView.vue'), meta: { top: '/worlds' } },
  { path: '/settings', redirect: '/settings/connection' },
  { path: '/settings/connection', name: 'settings-connection', component: () => import('../views/SettingsView.vue'), meta: { top: '/settings' } },
  { path: '/settings/system', name: 'settings-system', component: () => import('../views/SystemView.vue'), meta: { top: '/settings' } },
  { path: '/settings/prompts', name: 'settings-prompts', component: () => import('../views/PromptsView.vue'), meta: { top: '/settings' } },
  { path: '/settings/guides', name: 'settings-guides', component: () => import('../views/GuidesView.vue'), meta: { top: '/settings' } },
  // Variables moved under Guides — redirected rather than dropped outright
  // so an old bookmark/muscle-memory URL still lands somewhere sensible.
  { path: '/settings/variables', redirect: '/settings/guides' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
