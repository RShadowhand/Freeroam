// Splits an accumulating text buffer on SSE's blank-line frame separator and
// parses each frame's `data:` line as JSON. Shared by chat.js/phone.js/
// groups.js's SSE-consuming loops — they all speak the exact same wire
// format (ack/speaker/delta/turn/done events), just against different
// per-place/per-character/per-group endpoints.
export function parseSseEvents(buffer) {
  const events = [];
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const chunk = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const line = chunk.split('\n').find((l) => l.startsWith('data:'));
    if (line) {
      try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore malformed chunk */ }
    }
  }
  return { events, rest: buffer };
}
