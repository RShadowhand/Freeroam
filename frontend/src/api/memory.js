import { apiGet, apiJson, apiDelete } from './http';

// { limit, offset } are optional — GET /api/memory/:characterId defaults
// to the newest 50 server-side when omitted.
export const getMemories = (characterId, { limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit);
  if (offset !== undefined) params.set('offset', offset);
  const qs = params.toString();
  return apiGet(`/api/memory/${characterId}${qs ? `?${qs}` : ''}`);
};
export const addMemory = (characterId, body) => apiJson(`/api/memory/${characterId}`, 'POST', body);
export const updateMemory = (characterId, entryId, body) => apiJson(`/api/memory/${characterId}/${entryId}`, 'PUT', body);
export const deleteMemory = (characterId, entryId) => apiDelete(`/api/memory/${characterId}/${entryId}`);

// Debug tool: ranks every one of a character's memories against a query,
// annotated with whether the real retrieveMemories() selection (same
// topK/recency defaults, same Settings > Memory threshold unless
// overridden) would actually recall it.
export const queryMemories = (characterId, body) => apiJson(`/api/memory/${characterId}/query`, 'POST', body);
