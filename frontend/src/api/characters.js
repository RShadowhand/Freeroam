import { apiGet, apiJson, apiDelete, apiForm } from './http';

export const getCharacters = () => apiGet('/api/characters');
export const createCharacter = (body) => apiJson('/api/characters', 'POST', body);
export const uploadCharacterCard = (file) => {
  const form = new FormData();
  form.append('card', file);
  return apiForm('/api/characters', form);
};
export const updateCharacter = (id, body) => apiJson(`/api/characters/${id}`, 'PUT', body);
export const deleteCharacter = (id) => apiDelete(`/api/characters/${id}`);
export const placeCharacter = (id, body) => apiJson(`/api/characters/${id}/place`, 'POST', body);
export const saveScheduleSlot = (id, day, timeOfDay, body) =>
  apiJson(`/api/characters/${id}/schedule/${day}/${timeOfDay}`, 'PUT', body);
export const draftCharacterDescription = (body) => apiJson('/api/characters/draft', 'POST', body);
export const exportCharacter = (id) => apiGet(`/api/characters/${id}/export`);
export const exportAllCharacters = () => apiGet('/api/characters/export');
export const importCharacters = (characters) => apiJson('/api/characters/import', 'POST', { characters });
