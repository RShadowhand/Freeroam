import { apiGet, apiJson, apiDelete, apiForm } from './http';

export const addPlace = (body) => apiJson('/api/places', 'POST', body);
export const updatePlace = (id, body) => apiJson(`/api/places/${id}`, 'PUT', body);
export const setPlaceOrder = (id, order) => apiJson(`/api/places/${id}/order`, 'PUT', { order });
export const deletePlace = (id) => apiDelete(`/api/places/${id}`);
export const exportPlace = (id) => apiGet(`/api/places/${id}/export`);
export const exportPlacesByArea = (area) => apiGet(`/api/places/export?area=${encodeURIComponent(area)}`);
export const exportAllPlaces = () => apiGet('/api/places/export');
export const importPlaces = (places) => apiJson('/api/places/import', 'POST', { places });
export const importPlaceCard = (file) => {
  const form = new FormData();
  form.append('card', file);
  return apiForm('/api/places/import', form);
};
