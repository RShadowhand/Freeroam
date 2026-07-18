import { apiJson, apiDelete } from './http';

export const addPlace = (body) => apiJson('/api/places', 'POST', body);
export const updatePlace = (id, body) => apiJson(`/api/places/${id}`, 'PUT', body);
export const deletePlace = (id) => apiDelete(`/api/places/${id}`);
