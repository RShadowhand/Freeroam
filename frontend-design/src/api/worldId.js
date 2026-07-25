// The active world id lives in localStorage, not a Pinia store — api/http.js
// (which every store's requests eventually go through) needs to read it on
// every request, and importing a store there would set up a circular
// dependency (store -> api -> store). This tiny, dependency-free module is
// the single source of truth for the key name and read/write access;
// stores/worlds.js is the only writer, but any request-layer code (http.js,
// api/chat.js's SSE helpers) can read it directly.
const KEY = 'freeroam.worldId';

export function getStoredWorldId() {
  return localStorage.getItem(KEY);
}

export function setStoredWorldId(id) {
  if (id) localStorage.setItem(KEY, id);
  else localStorage.removeItem(KEY);
}
