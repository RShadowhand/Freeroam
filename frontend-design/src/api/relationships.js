import { apiGet, apiJson } from './http';

export const getRelationships = () => apiGet('/api/relationships');
export const setRelationshipLabels = (characterId, targetId, labels) =>
  apiJson(`/api/relationships/${characterId}/${targetId}`, 'PUT', { labels });

// Debug tool: ranks every one of a character's relationships (forward and
// reverse) against a free-text description ("your friend with the blue
// eyes"), annotated with whether the real retrieveRelevantRelationships()
// selection would actually surface it. No LLM call — pure local-embedding
// math against the same sqlite-stored vectors real generation reads.
export const queryRelationships = (characterId, body) => apiJson(`/api/relationships/${characterId}/query`, 'POST', body);
