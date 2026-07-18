import { apiGet, apiJson } from './http';

export const getWorld = () => apiGet('/api/world');
export const saveWorldSetting = (setting) => apiJson('/api/world/setting', 'POST', { setting });
export const postWorldTime = (body) => apiJson('/api/world/time', 'POST', body);
export const randomizePlacements = () => apiJson('/api/world/randomize', 'POST', {});
