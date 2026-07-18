import { apiGet, apiJson } from './http';

export const getSettings = () => apiGet('/api/settings');
export const saveSettings = (body) => apiJson('/api/settings', 'POST', body);
export const clearApiKey = () => apiJson('/api/settings/clear-key', 'POST', {});
export const getModels = () => apiGet('/api/models');
export const getModelProviders = (modelId) => apiGet(`/api/models/providers?model=${encodeURIComponent(modelId)}`);
export const sendTestMessage = () => apiJson('/api/chat', 'POST', {
  system: 'You are a connection test. Reply with one short sentence confirming you received this.',
  messages: [{ role: 'user', content: 'Testing, testing.' }],
});
