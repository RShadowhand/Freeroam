import { apiGet, apiJson, apiDelete } from './http';

export const getWorlds = () => apiGet('/api/worlds');
export const createWorld = (body) => apiJson('/api/worlds', 'POST', body);
export const renameWorld = (id, name) => apiJson(`/api/worlds/${id}`, 'PUT', { name });
export const deleteWorld = (id) => apiDelete(`/api/worlds/${id}`);
export const duplicateWorld = (id, body) => apiJson(`/api/worlds/${id}/duplicate`, 'POST', body);
