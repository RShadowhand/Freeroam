import { encodeEmbedding, decodeEmbedding } from './db.js';
import { rankBySimilarity } from './memoryStore.js';
import { logger } from './log.js';

// Relationships as a small RAG store, same idea as character memory: a
// character can plausibly know dozens of people, but only a handful are
// relevant to any given line ("who's your mother?" shouldn't drag in
// everyone they've ever met). Each (character, target) row's labels are
// embedded once on write; retrieval blends a small unconditional "core" set
// (the user's own relation, and anything family-labeled — the facts a
// character should never plausibly forget) with the top-K semantically
// relevant rows for whatever's being asked. The dynamic part — whether the
// character currently knows the other person's whereabouts — stays a
// per-generation random roll in server.js, computed only for this narrowed
// set rather than for every relationship the character has.

// Labels that make a character likelier to know a relative's whereabouts,
// and that mark a relationship as always-relevant "core" context.
export const FAMILY_HINTS = ['mother', 'father', 'parent', 'daughter', 'son', 'child', 'sister', 'brother', 'sibling',
  'wife', 'husband', 'spouse', 'grandmother', 'grandfather', 'aunt', 'uncle', 'cousin', 'niece', 'nephew', 'family'];

export function relationshipFactText(otherName, labels) {
  return `${otherName}: ${labels.join(', ')}`;
}

// Writes (or, for an empty label list, deletes) one directed relationship
// row and its embedding. `targetName` is only used to build the embedded
// text — pass 'the visitor' for the target_id === 'user' sentinel.
export async function upsertRelationship({ db, embedFn, characterId, targetId, targetName, labels }) {
  const cleaned = [...new Set((labels || []).map((l) => l.trim()).filter(Boolean))];
  if (!cleaned.length) {
    db.prepare('DELETE FROM relationships WHERE character_id = ? AND target_id = ?').run(characterId, targetId);
    return { removed: true };
  }

  const embedding = encodeEmbedding(await embedFn(relationshipFactText(targetName, cleaned)));
  db.prepare(`
    INSERT INTO relationships (character_id, target_id, labels, embedding) VALUES (?, ?, ?, ?)
    ON CONFLICT(character_id, target_id) DO UPDATE SET labels = excluded.labels, embedding = excluded.embedding
  `).run(characterId, targetId, JSON.stringify(cleaned), embedding);
  return { labels: cleaned };
}

// Re-embeds every stored relationship row — same rationale as
// rebuildAllMemoryEmbeddings in memoryStore.js. Needs charactersById to
// rebuild each row's fact text (target_id === 'user' is the one sentinel
// that isn't a real character).
export async function rebuildAllRelationshipEmbeddings({ db, embedFn, charactersById = {} }) {
  const rows = db.prepare('SELECT character_id, target_id, labels FROM relationships').all();
  const update = db.prepare('UPDATE relationships SET embedding = ? WHERE character_id = ? AND target_id = ?');
  for (const row of rows) {
    const labels = JSON.parse(row.labels || '[]');
    const otherName = row.target_id === 'user' ? 'the visitor' : (charactersById[row.target_id]?.name || row.target_id);
    update.run(encodeEmbedding(await embedFn(relationshipFactText(otherName, labels))), row.character_id, row.target_id);
  }
  return rows.length;
}

function isCore(candidate, familyHints) {
  return candidate.otherId === 'user' || candidate.labels.some((l) => familyHints.some((h) => l.toLowerCase().includes(h)));
}

// Returns the relationship rows relevant to `speakerId` right now: every
// "core" row (the user's own relation + family-labeled ties, unconditional)
// plus the top-K remaining rows ranked by similarity to `query`. Each result
// is { direction: 'forward'|'reverse', otherId, labels } — forward means
// "otherId is speakerId's {labels}" (speaker's own relationships.character_id
// row), reverse means "speakerId is otherId's {labels}" (someone else's row
// naming the speaker as their target).
export async function retrieveRelevantRelationships({ db, embedFn, speakerId, query, charactersById = {}, topK = 6, familyHints = FAMILY_HINTS }) {
  const forward = db.prepare('SELECT target_id AS otherId, labels, embedding FROM relationships WHERE character_id = ?')
    .all(speakerId)
    .map((r) => ({ direction: 'forward', characterId: speakerId, targetId: r.otherId, otherId: r.otherId, labels: JSON.parse(r.labels || '[]'), embedding: r.embedding }));
  const reverse = db.prepare('SELECT character_id AS otherId, labels, embedding FROM relationships WHERE target_id = ?')
    .all(speakerId)
    .map((r) => ({ direction: 'reverse', characterId: r.otherId, targetId: speakerId, otherId: r.otherId, labels: JSON.parse(r.labels || '[]'), embedding: r.embedding }));

  const candidates = [...forward, ...reverse];
  if (!candidates.length) return [];

  // Rows saved before relationships were embeddable get backfilled lazily —
  // only for this speaker's (small) candidate set, not the whole table.
  for (const c of candidates) {
    if (c.embedding) continue;
    const otherName = c.otherId === 'user' ? 'the visitor' : (charactersById[c.otherId]?.name || c.otherId);
    const vec = encodeEmbedding(await embedFn(relationshipFactText(otherName, c.labels)));
    db.prepare('UPDATE relationships SET embedding = ? WHERE character_id = ? AND target_id = ?')
      .run(vec, c.characterId, c.targetId);
    c.embedding = vec;
  }

  const core = candidates.filter((c) => isCore(c, familyHints));
  const rest = candidates.filter((c) => !isCore(c, familyHints));

  let chosen = core;
  if (rest.length) {
    if (query && query.trim()) {
      const queryEmbedding = await embedFn(query);
      const ranked = rankBySimilarity(queryEmbedding, rest.map((c) => ({ ...c, embedding: decodeEmbedding(c.embedding) })));
      chosen = chosen.concat(ranked.slice(0, topK).map((r) => r.entry));
    } else {
      chosen = chosen.concat(rest.slice(0, topK));
    }
  }

  logger.debug('memory', `relationship retrieval for ${speakerId}: ${chosen.length}/${candidates.length} rows (${core.length} core)`);
  return chosen.map(({ direction, otherId, labels }) => ({ direction, otherId, labels }));
}
