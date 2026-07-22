export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// SillyTavern-style message formatting, applied to character and user
// bubbles: **bold**, *italics* (typically actions/gestures), and "quoted
// speech" highlighted. Escapes HTML first, so the rules can safely emit
// markup. Order matters: ** before * so bold isn't eaten by the italics rule.
export function formatMessage(s, formatPrefs) {
  let out = escapeHtml(s);
  // Hidden angle-bracket tags first (ST-style OOC/meta annotations like
  // <thinking>...</thinking>) — removed before the other rules run so their
  // contents can't accidentally trip bold/italic/quote matching.
  if (formatPrefs.hideAngleBrackets) {
    out = out.replace(/&lt;[^&]*?&gt;/g, '');
  }
  if (formatPrefs.bold) out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  if (formatPrefs.italics) out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  if (formatPrefs.quotes) {
    // escapeHtml (textContent -> innerHTML) never turns a literal " into
    // &quot; — entity-escaping quote marks is only required inside HTML
    // attribute values, not text-node content, so browsers don't bother.
    // Match the literal character instead; inserting it back via innerHTML
    // in text content (not inside an attribute) is safe either way.
    out = out.replace(/"([^"]*)"/g, '<span class="quote">"$1"</span>');
  }
  return out;
}

export function formatPrice(perToken) {
  if (perToken === undefined || perToken === null || perToken === '') return '';
  const perMillion = Number(perToken) * 1_000_000;
  if (!Number.isFinite(perMillion)) return '';
  return `$${perMillion < 1 ? perMillion.toFixed(3) : perMillion.toFixed(2)}/M`;
}

export function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');
}

export function castPreview(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// "A" / "A and B" / "A, B, and C" — small deliberate duplication of the
// backend's own joinNames (backend/lib/textUtils.js); separate processes,
// not worth sharing a module for four lines.
export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export function groupedByArea(list) {
  const groups = {};
  list.forEach((p) => {
    const key = p.area || 'Unsorted';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  return groups;
}
