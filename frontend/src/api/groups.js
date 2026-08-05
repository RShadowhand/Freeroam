import { apiGet, apiJson, apiDelete } from './http';
import { getStoredWorldId } from './worldId';

export const getGroups = () => apiGet('/api/groups');
export const createGroupApi = (body) => apiJson('/api/groups', 'POST', body);
export const getGroupLog = (groupId) => apiGet(`/api/groups/${encodeURIComponent(groupId)}`);
export const updateGroupApi = (groupId, body) => apiJson(`/api/groups/${encodeURIComponent(groupId)}`, 'PUT', body);
export const sendGroupTextApi = (groupId, body, signal) => apiJson(`/api/groups/${encodeURIComponent(groupId)}/send`, 'POST', body, { signal });
export const retryGroupApi = (groupId, signal) => apiJson(`/api/groups/${encodeURIComponent(groupId)}/retry`, 'POST', {}, { signal });
// characterId omitted -> backend picks a random participant.
export const triggerGroupApi = (groupId, characterId = null) =>
  apiJson(`/api/groups/${encodeURIComponent(groupId)}/trigger`, 'POST', characterId ? { characterId } : {});
export const allowGroupCascadeApi = (groupId, autoAllow = false) =>
  apiJson(`/api/groups/${encodeURIComponent(groupId)}/cascade/allow`, 'POST', { autoAllow });
export const denyGroupCascadeApi = (groupId) =>
  apiJson(`/api/groups/${encodeURIComponent(groupId)}/cascade/deny`, 'POST', {});
export const deleteGroupApi = (groupId) => apiDelete(`/api/groups/${encodeURIComponent(groupId)}`);
export const deleteGroupMessageApi = (groupId, entryId) =>
  apiDelete(`/api/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(entryId)}`);

// Streaming variant — same pattern as api/phone.js's sendTextStreamRequest.
function streamHeaders() {
  const worldId = getStoredWorldId();
  return { 'Content-Type': 'application/json', ...(worldId ? { 'X-World-Id': worldId } : {}) };
}
export const sendGroupTextStreamRequest = (groupId, body, signal) =>
  fetch(`/api/groups/${encodeURIComponent(groupId)}/send`, { method: 'POST', headers: streamHeaders(), body: JSON.stringify(body), signal });
export const retryGroupStreamRequest = (groupId, signal) =>
  fetch(`/api/groups/${encodeURIComponent(groupId)}/retry`, { method: 'POST', headers: streamHeaders(), body: '{}', signal });
