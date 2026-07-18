import { apiGet, apiJson, apiDelete, apiForm } from './http';

export const getPersonas = () => apiGet('/api/personas');
export const createPersona = ({ name, description, avatarFile }) => {
  const form = new FormData();
  form.append('name', name);
  form.append('description', description || '');
  if (avatarFile) form.append('avatar', avatarFile);
  return apiForm('/api/personas', form);
};
export const updatePersona = (id, body) => apiJson(`/api/personas/${id}`, 'PUT', body);
export const deletePersona = (id) => apiDelete(`/api/personas/${id}`);
export const setActivePersona = (id) => apiJson('/api/personas/active', 'POST', { id });
