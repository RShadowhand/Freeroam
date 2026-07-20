import { encodeEmbedding, decodeEmbedding } from './db.js';
import { chunkText } from './textChunks.js';
import { logger } from './log.js';

// A character's identity (name + description/personality), embedded and
// stored so relationship retrieval can answer "which person does this text
// describe?" — a query like "your friend with the blue eyes" is scored
// against both the relationship's label vector and the other party's
// identity vector. Kept separate from the relationships table so a
// character with 50 friends has their description embedded once, not 50
// times, and an edit re-embeds one character's rows instead of every row
// naming them.
//
// A description can run long and cover several unrelated traits (looks,
// job history, speech patterns); embedding it as a single pooled vector
// dilutes any short, specific detail ("twenty-three years old") across
// everything else, the same problem chunkText fixes for memory text — see
// memoryStore.js. So identity text is split into chunks (chunkText caps
// how many; there's no separate length truncation here) and each is
// embedded and stored as its own row; a candidate is scored against
// whichever chunk matches best (see getCharacterEmbeddingChunks).

// A compact, embedding-friendly slice of who a character is.
export function characterSnippet(char) {
  if (!char) return '';
  return [char.description, char.personality].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function characterIdentityText(char) {
  return [char.name, characterSnippet(char)].filter(Boolean).join('. ');
}

async function computeAndStoreCharacterEmbeddings(db, embedFn, char) {
  const identityText = characterIdentityText(char);
  const chunks = chunkText(identityText);
  const effectiveChunks = chunks.length ? chunks : [identityText];
  const vectors = [];
  for (const chunk of effectiveChunks) vectors.push(await embedFn(chunk));

  db.prepare('DELETE FROM character_embeddings WHERE character_id = ?').run(char.id);
  const insert = db.prepare('INSERT INTO character_embeddings (character_id, embedding) VALUES (?, ?)');
  vectors.forEach((vec) => insert.run(char.id, encodeEmbedding(vec)));

  logger.debug('memory', `computed ${vectors.length} identity chunk(s) for ${char.name}`);
  return vectors;
}

// Returns the character's identity chunk vectors, computing and storing
// them on first use — new and imported characters get embedded lazily, the
// same way legacy relationship rows are backfilled during retrieval.
// Callers score a candidate against whichever chunk matches best (max
// cosine similarity across the array), not an average of all of them.
export async function getCharacterEmbeddingChunks({ db, embedFn, char }) {
  const rows = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').all(char.id);
  if (rows.length) return rows.map((r) => decodeEmbedding(r.embedding));
  return computeAndStoreCharacterEmbeddings(db, embedFn, char);
}

// Recomputes the identity chunk vectors after a character's name/
// description/personality is edited.
export async function refreshCharacterEmbedding({ db, embedFn, char }) {
  await computeAndStoreCharacterEmbeddings(db, embedFn, char);
}

export function deleteCharacterEmbedding(db, characterId) {
  db.prepare('DELETE FROM character_embeddings WHERE character_id = ?').run(characterId);
}

// Re-embeds every character's identity vectors with whatever embedFn is
// passed in — part of the "rebuild embeddings" settings action alongside
// memories and relationships.
export async function rebuildAllCharacterEmbeddings({ db, embedFn, characters }) {
  for (const char of characters) {
    await refreshCharacterEmbedding({ db, embedFn, char });
  }
  return characters.length;
}
