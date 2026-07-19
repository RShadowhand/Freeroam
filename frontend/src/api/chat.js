import { apiGet, apiJson, apiDelete } from './http';
import { getStoredWorldId } from './worldId';

export const getChatLog = (placeId) => apiGet(`/api/places/${encodeURIComponent(placeId)}/chat`);
export const enterPlaceApi = (placeId) => apiJson(`/api/places/${encodeURIComponent(placeId)}/enter`, 'POST', {});

// Non-streaming say/retry/regenerate — plain JSON responses.
export const sayApi = (placeId, body) => apiJson(`/api/places/${encodeURIComponent(placeId)}/say`, 'POST', body);
export const retryApi = (placeId) => apiJson(`/api/places/${encodeURIComponent(placeId)}/retry`, 'POST', {});
export const regenerateApi = (placeId, entryId) => apiJson(`/api/places/${encodeURIComponent(placeId)}/regenerate`, 'POST', { entryId });

// Streaming variants return the raw fetch Response so the caller can read
// its SSE body directly (see stores/chat.js's consumeReactionSse) — these
// bypass http.js's JSON-parsing helper entirely, unlike everything else in
// the api/ layer, so the world header is attached here instead. A function,
// not a constant — the active world can change at runtime (switching
// worlds), so it must be read fresh on every call, not captured once.
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const sayStreamRequest = (placeId, body) =>
  fetch(`/api/places/${encodeURIComponent(placeId)}/say`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body) });
export const retryStreamRequest = (placeId) =>
  fetch(`/api/places/${encodeURIComponent(placeId)}/retry`, { method: 'POST', headers: streamHeaders(), body: '{}' });
export const regenerateStreamRequest = (placeId, entryId) =>
  fetch(`/api/places/${encodeURIComponent(placeId)}/regenerate`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify({ entryId }) });

export const updateMessage = (placeId, entryId, text) =>
  apiJson(`/api/places/${encodeURIComponent(placeId)}/messages/${entryId}`, 'PUT', { text });
export const deleteMessageApi = (placeId, entryId) =>
  apiDelete(`/api/places/${encodeURIComponent(placeId)}/messages/${entryId}`);
