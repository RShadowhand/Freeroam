import { apiGet, apiJson, apiDelete, apiForm } from './http';

export const getPersonas = () => apiGet('/api/personas');
export const createPersona = ({ name, description, avatarFile }) => {
  const form = new FormData();
  form.append('name', name);
  form.append('description', description || '');
  if (avatarFile) form.append('avatar', avatarFile);
  return apiForm('/api/personas', form);
};
export const updatePersona = (id, { avatarFile, ...fields } = {}) => {
  if (avatarFile) {
    const form = new FormData();
    if (fields.name !== undefined) form.append('name', fields.name);
    if (fields.description !== undefined) form.append('description', fields.description);
    form.append('avatar', avatarFile);
    return apiForm(`/api/personas/${id}`, form, 'PUT');
  }
  return apiJson(`/api/personas/${id}`, 'PUT', fields);
};
export const deletePersona = (id) => apiDelete(`/api/personas/${id}`);
export const setActivePersona = (id) => apiJson('/api/personas/active', 'POST', { id });
export const exportPersona = (id) => apiGet(`/api/personas/${id}/export`);
export const exportAllPersonas = () => apiGet('/api/personas/export');
export const importPersonas = (personas) => apiJson('/api/personas/import', 'POST', { personas });
export const importPersonaCard = (file) => {
  const form = new FormData();
  form.append('card', file);
  return apiForm('/api/personas/import', form);
};
