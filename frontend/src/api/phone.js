import { apiGet, apiJson, apiDelete } from './http';
import { getStoredWorldId } from './worldId';

export const getTextLog = (characterId) => apiGet(`/api/texts/${encodeURIComponent(characterId)}`);
export const sendTextApi = (characterId, body, signal) => apiJson(`/api/texts/${encodeURIComponent(characterId)}/send`, 'POST', body, { signal });
export const retryTextApi = (characterId, signal) => apiJson(`/api/texts/${encodeURIComponent(characterId)}/retry`, 'POST', {}, { signal });
export const deleteTextMessageApi = (characterId, entryId) =>
  apiDelete(`/api/texts/${encodeURIComponent(characterId)}/messages/${encodeURIComponent(entryId)}`);
export const triggerTextApi = (characterId, hint = null) =>
  apiJson(`/api/texts/${encodeURIComponent(characterId)}/trigger`, 'POST', hint ? { hint } : {});
export const getUnreadTextCount = () => apiGet('/api/texts/unread');

// Streaming variant returns the raw fetch Response so the caller can read
// its SSE body directly — same pattern as api/chat.js's sayStreamRequest,
// bypassing http.js's JSON-parsing helper.
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const sendTextStreamRequest = (characterId, body, signal) =>
  fetch(`/api/texts/${encodeURIComponent(characterId)}/send`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body), signal });
export const retryTextStreamRequest = (characterId, signal) =>
  fetch(`/api/texts/${encodeURIComponent(characterId)}/retry`, { method: 'POST', headers: streamHeaders(), body: '{}', signal });
