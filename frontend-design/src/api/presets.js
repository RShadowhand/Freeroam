import { apiGet, apiJson, apiDelete } from './http';

export const getPresets = () => apiGet('/api/presets');
export const getStandardBlocks = () => apiGet('/api/prompts/standard-blocks');
export const createPreset = (body) => apiJson('/api/presets', 'POST', body);
export const updatePreset = (id, body) => apiJson(`/api/presets/${id}`, 'PUT', body);
export const deletePreset = (id) => apiDelete(`/api/presets/${id}`);
export const setActivePreset = (id) => apiJson('/api/presets/active', 'POST', { id });
export const importPreset = (raw, fallbackName) => apiJson('/api/presets/import', 'POST', { raw, fallbackName });
export const exportPreset = (body) => apiJson('/api/presets/export', 'POST', body);
