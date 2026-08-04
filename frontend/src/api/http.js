import { getStoredWorldId, setStoredWorldId } from './worldId';

// The world we were pointed at no longer exists — deleted from another tab,
// most likely. Drop the stale id and reload: the next request goes
// header-less, which the backend treats as "use the default world," rather
// than getting stuck failing every request forever. Exported so the
// streaming SSE helpers in api/chat.js, api/phone.js, api/groups.js, and
// api/calls.js — which bypass request() below entirely, since they need the
// raw fetch Response to read its body as a stream — can trigger the same
// recovery instead of just surfacing a generic error forever.
export function handleUnknownWorld(res, data) {
  if (!res.ok && data?.code === 'UNKNOWN_WORLD') {
    setStoredWorldId(null);
    location.reload();
    return true;
  }
  return false;
}

// Every backend route returns JSON (including error bodies, `{ error }`),
// so this is the one place that shape gets parsed — callers get back
// `{ ok, status, data }` and decide what to do with a non-ok response
// themselves, same as the original inline `res.ok` checks did. Also the
// one place the active world id is attached (X-World-Id) — every api/*.js
// wrapper funnels through here, so this single chokepoint covers all of
// them; the SSE streaming helpers across chat/phone/groups/calls bypass
// this function entirely and attach the header themselves.
async function request(path, options) {
  const worldId = getStoredWorldId();
  const finalOptions = worldId
    ? { ...options, headers: { ...(options?.headers || {}), 'X-World-Id': worldId } }
    : options;
  const res = await fetch(path, finalOptions);
  const data = await res.json().catch(() => ({}));
  handleUnknownWorld(res, data);
  return { ok: res.ok, status: res.status, data };
}

export function apiGet(path) {
  return request(path);
}

export function apiJson(path, method, body) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export function apiDelete(path) {
  return request(path, { method: 'DELETE' });
}

// For multipart uploads (character cards, persona avatars) — no
// Content-Type header, the browser sets the multipart boundary itself.
export function apiForm(path, formData, method = 'POST') {
  return request(path, { method, body: formData });
}

// For downloads that aren't JSON (a zip/PNG file) — request() unconditionally
// calls res.json(), which would fail on a binary body. Returns the raw Blob
// plus whatever filename the server suggested via Content-Disposition, so a
// caller can hand both straight to the Blob-download pattern (see
// PresetCard.vue's exportJson) without re-deriving a name itself.
async function requestBlob(path, options) {
  const worldId = getStoredWorldId();
  const finalOptions = worldId
    ? { ...options, headers: { ...(options?.headers || {}), 'X-World-Id': worldId } }
    : options;
  const res = await fetch(path, finalOptions);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, data };
  }
  const blob = await res.blob();
  const match = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
  return { ok: true, status: res.status, blob, filename: match ? match[1] : null };
}

export function apiBlobGet(path) {
  return requestBlob(path);
}

export function apiBlobPost(path, body) {
  return requestBlob(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}
