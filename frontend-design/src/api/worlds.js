import { apiGet, apiJson, apiDelete, apiForm, apiBlobPost } from './http';

export const getWorlds = () => apiGet('/api/worlds');
export const createWorld = (body) => apiJson('/api/worlds', 'POST', body);
export const renameWorld = (id, name) => apiJson(`/api/worlds/${id}`, 'PUT', { name });
export const deleteWorld = (id) => apiDelete(`/api/worlds/${id}`);
export const duplicateWorld = (id, body) => apiJson(`/api/worlds/${id}/duplicate`, 'POST', body);
export const exportWorld = (id, includeHistory) => apiBlobPost(`/api/worlds/${id}/export`, { includeHistory });
export const importWorld = (file, name) => {
  const form = new FormData();
  form.append('bundle', file);
  if (name) form.append('name', name);
  return apiForm('/api/worlds/import', form);
};
