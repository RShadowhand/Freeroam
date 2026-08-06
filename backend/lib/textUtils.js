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

// Every alias a character can be addressed/referred to by: their full name,
// first name alone (the existing "first name is enough" convention already
// used throughout this app — see context.js's parseReplyLines), and any
// custom nicknames. The one place all three now come together, so anything
// matching "is this character being talked about" only has one list to check.
export function characterAliases(character) {
  const aliases = [character.name, character.name.trim().split(/\s+/)[0]];
  (character.nicknames || []).forEach((n) => { if (n && n.trim()) aliases.push(n.trim()); });
  return [...new Set(aliases.filter(Boolean))];
}

// Names are user/card-provided free text — escape regex metacharacters, or
// a name like "Dr. Vane (Ret.)" makes the RegExp constructor below throw.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The character's earliest alias match in `text` (case-insensitive), or
// Infinity if none of their aliases appear at all. Uses (?<!\w)/(?!\w)
// lookaround rather than \b at each end — \b only fires on an actual
// word/non-word *transition*, which silently fails to match at all when an
// alias itself starts or ends on a non-word character (e.g. "Dr. Vane
// (Ret.)" ends in ")", so \b right after it never fires); the lookaround
// form just asks "is the adjacent character (if any) not a word character,"
// which holds regardless of what the alias's own edges look like.
function earliestMentionIndex(text, character) {
  let earliest = Infinity;
  for (const alias of characterAliases(character)) {
    const re = new RegExp(`(?<!\\w)${escapeRegExp(alias)}(?!\\w)`, 'i');
    const m = re.exec(text);
    if (m && m.index < earliest) earliest = m.index;
  }
  return earliest;
}

// Whether `text` mentions `character` by name, first name, or any nickname.
export function characterMentionedIn(text, character) {
  return earliestMentionIndex(text, character) !== Infinity;
}

// The earliest-mentioned of `characters` in `text`, or null if none of them
// are mentioned at all. Used to let an explicitly-addressed character (by
// name or nickname) take priority as who responds first, without requiring
// a stored/manual order to already exist.
export function firstMentionedCharacter(text, characters) {
  let best = null;
  let bestIndex = Infinity;
  for (const c of characters) {
    const idx = earliestMentionIndex(text, c);
    if (idx < bestIndex) { bestIndex = idx; best = c; }
  }
  return best;
}

// Orders `characters` by where their earliest alias match appears in `text`
// — mentioned characters first, in mention order; characters not mentioned
// at all keep their existing relative order, at the end (stable sort, so
// their prior manual/default ordering survives untouched). Lets a message
// like "*pets Soot* ... *then turns to Erza*" set that round's response
// order dynamically, layered on top of whatever order was already set.
export function orderByMentionIn(text, characters) {
  return characters
    .map((c, i) => ({ c, i, earliest: earliestMentionIndex(text, c) }))
    .sort((a, b) => (a.earliest !== b.earliest ? a.earliest - b.earliest : a.i - b.i))
    .map((p) => p.c);
}
