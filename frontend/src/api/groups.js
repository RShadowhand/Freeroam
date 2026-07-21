import { apiGet, apiJson, apiDelete } from './http';
import { getStoredWorldId } from './worldId';

export const getGroups = () => apiGet('/api/groups');
export const createGroupApi = (body) => apiJson('/api/groups', 'POST', body);
export const getGroupLog = (groupId) => apiGet(`/api/groups/${encodeURIComponent(groupId)}`);
export const updateGroupApi = (groupId, body) => apiJson(`/api/groups/${encodeURIComponent(groupId)}`, 'PUT', body);
export const sendGroupTextApi = (groupId, body) => apiJson(`/api/groups/${encodeURIComponent(groupId)}/send`, 'POST', body);
export const retryGroupApi = (groupId) => apiJson(`/api/groups/${encodeURIComponent(groupId)}/retry`, 'POST', {});
export const deleteGroupApi = (groupId) => apiDelete(`/api/groups/${encodeURIComponent(groupId)}`);
export const deleteGroupMessageApi = (groupId, entryId) =>
  apiDelete(`/api/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(entryId)}`);

// Streaming variant — same pattern as api/phone.js's sendTextStreamRequest.
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const sendGroupTextStreamRequest = (groupId, body) =>
  fetch(`/api/groups/${encodeURIComponent(groupId)}/send`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body) });
export const retryGroupStreamRequest = (groupId) =>
  fetch(`/api/groups/${encodeURIComponent(groupId)}/retry`, { method: 'POST', headers: streamHeaders(), body: '{}' });
