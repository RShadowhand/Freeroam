import { apiJson } from './http';
import { getStoredWorldId } from './worldId';

export const startCallApi = (characterId, placeId) =>
  apiJson(`/api/calls/${encodeURIComponent(characterId)}/start`, 'POST', { placeId });
export const callSayApi = (characterId, body, signal) =>
  apiJson(`/api/calls/${encodeURIComponent(characterId)}/say`, 'POST', body, { signal });
export const endCallApi = (characterId, placeId) =>
  apiJson(`/api/calls/${encodeURIComponent(characterId)}/end`, 'POST', { placeId });

// Streaming variant — same rationale as api/chat.js's sayStreamRequest:
// bypasses http.js's JSON-parsing helper so the caller can read the SSE
// body directly (see stores/chat.js's consumeReactionSse, reused as-is).
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const callSayStreamRequest = (characterId, body, signal) =>
  fetch(`/api/calls/${encodeURIComponent(characterId)}/say`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body), signal });
