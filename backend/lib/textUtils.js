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
