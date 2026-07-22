// Tiny, dependency-free string helpers shared across prompt builders —
// kept in its own module (rather than living in texting.js, its original
// home) so context.js and narrator.js can both import it without creating
// a circular dependency (texting.js already imports from context.js).

// "A" / "A and B" / "A, B, and C".
export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

// Deterministic-ish color, spread around the wheel — keyed by the
// character/persona's own unique id, not their name. Two characters can
// share a name with no surname to tell them apart (nothing stops it, and
// it happens); hashing the name would give them the identical color too,
// defeating the one thing that's still supposed to disambiguate them at a
// glance (the Cast grid, relationship rows, chat avatars, ... and now
// pngCard.js's generated placeholder card image).
export function colorForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash}, 55%, 62%)`;
}
