import { getStoredWorldId, setStoredWorldId } from './worldId';

// Every backend route returns JSON (including error bodies, `{ error }`),
// so this is the one place that shape gets parsed — callers get back
// `{ ok, status, data }` and decide what to do with a non-ok response
// themselves, same as the original inline `res.ok` checks did. Also the
// one place the active world id is attached (X-World-Id) — every api/*.js
// wrapper funnels through here, so this single chokepoint covers all of
// them; the 3 SSE streaming helpers in api/chat.js bypass this function
// entirely and attach the header themselves.
async function request(path, options) {
  const worldId = getStoredWorldId();
  const finalOptions = worldId
    ? { ...options, headers: { ...(options?.headers || {}), 'X-World-Id': worldId } }
    : options;
  const res = await fetch(path, finalOptions);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.code === 'UNKNOWN_WORLD') {
    // The world we were pointed at no longer exists — deleted from another
    // tab, most likely. Drop the stale id and reload: the next request
    // goes header-less, which the backend treats as "use the default
    // world," rather than getting stuck failing every request forever.
    setStoredWorldId(null);
    location.reload();
  }
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
