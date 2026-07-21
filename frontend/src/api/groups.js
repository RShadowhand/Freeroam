import { apiGet, apiJson, apiDelete } from './http';
import { getStoredWorldId } from './worldId';

export const getGroups = () => apiGet('/api/groups');
export const createGroupApi = (body) => apiJson('/api/groups', 'POST', body);
export const getGroupLog = (groupId) => apiGet(`/api/groups/${encodeURIComponent(groupId)}`);
export const sendGroupTextApi = (groupId, body) => apiJson(`/api/groups/${encodeURIComponent(groupId)}/send`, 'POST', body);
export const deleteGroupApi = (groupId) => apiDelete(`/api/groups/${encodeURIComponent(groupId)}`);

// Streaming variant — same pattern as api/phone.js's sendTextStreamRequest.
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const sendGroupTextStreamRequest = (groupId, body) =>
  fetch(`/api/groups/${encodeURIComponent(groupId)}/send`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body) });
