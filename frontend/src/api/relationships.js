import { apiGet, apiJson } from './http';

export const getRelationships = () => apiGet('/api/relationships');
export const setRelationshipLabels = (characterId, targetId, labels) =>
  apiJson(`/api/relationships/${characterId}/${targetId}`, 'PUT', { labels });
