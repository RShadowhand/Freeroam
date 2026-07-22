import { apiGet, apiJson, apiDelete } from './http';

export const addPlace = (body) => apiJson('/api/places', 'POST', body);
export const updatePlace = (id, body) => apiJson(`/api/places/${id}`, 'PUT', body);
export const deletePlace = (id) => apiDelete(`/api/places/${id}`);
export const exportPlace = (id) => apiGet(`/api/places/${id}/export`);
export const exportPlacesByArea = (area) => apiGet(`/api/places/export?area=${encodeURIComponent(area)}`);
export const exportAllPlaces = () => apiGet('/api/places/export');
export const importPlaces = (places) => apiJson('/api/places/import', 'POST', { places });
