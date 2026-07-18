// Every backend route returns JSON (including error bodies, `{ error }`),
// so this is the one place that shape gets parsed — callers get back
// `{ ok, status, data }` and decide what to do with a non-ok response
// themselves, same as the original inline `res.ok` checks did.
async function request(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
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
