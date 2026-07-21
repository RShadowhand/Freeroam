import { apiGet, apiJson } from './http';
import { getStoredWorldId } from './worldId';

export const getTextLog = (characterId) => apiGet(`/api/texts/${encodeURIComponent(characterId)}`);
export const sendTextApi = (characterId, body) => apiJson(`/api/texts/${encodeURIComponent(characterId)}/send`, 'POST', body);

// Streaming variant returns the raw fetch Response so the caller can read
// its SSE body directly — same pattern as api/chat.js's sayStreamRequest,
// bypassing http.js's JSON-parsing helper.
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const sendTextStreamRequest = (characterId, body) =>
  fetch(`/api/texts/${encodeURIComponent(characterId)}/send`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body) });
