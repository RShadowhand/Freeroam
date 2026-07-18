import { apiGet, apiJson, apiDelete } from './http';

export const getMemories = (characterId) => apiGet(`/api/memory/${characterId}`);
export const addMemory = (characterId, body) => apiJson(`/api/memory/${characterId}`, 'POST', body);
export const updateMemory = (characterId, entryId, body) => apiJson(`/api/memory/${characterId}/${entryId}`, 'PUT', body);
export const deleteMemory = (characterId, entryId) => apiDelete(`/api/memory/${characterId}/${entryId}`);
