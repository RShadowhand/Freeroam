import { encodeEmbedding, decodeEmbedding } from './db.js';
import { logger } from './log.js';

// One identity embedding per character (name + description/personality),
// stored once and joined against wherever "which person does this text
// describe?" needs answering — currently relationship retrieval, where a
// query like "your friend with the blue eyes" is scored against both the
// relationship's label vector and the other party's identity vector. Kept
// separate from the relationships table so a character with 50 friends has
// their description embedded once, not 50 times, and an edit re-embeds one
// row instead of every row naming them.

// How much of a character's description/personality goes into the identity
// text. Enough to carry appearance and demeanor ("blue eyes", "always
// joking"), small enough that the whole text fits the model's input window.
const SNIPPET_MAX_CHARS = 600;

// A compact, embedding-friendly slice of who a character is.
export function characterSnippet(char) {
  if (!char) return '';
  const text = [char.description, char.personality].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text;
}

export function characterIdentityText(char) {
  return [char.name, characterSnippet(char)].filter(Boolean).join('. ');
}

// Returns the character's identity vector, computing and storing it on
// first use — new and imported characters get embedded lazily, the same
// way legacy relationship rows are backfilled during retrieval.
export async function getCharacterEmbedding({ db, embedFn, char }) {
  const row = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').get(char.id);
  if (row) return decodeEmbedding(row.embedding);
  const vector = await embedFn(characterIdentityText(char));
  db.prepare('INSERT OR REPLACE INTO character_embeddings (character_id, embedding) VALUES (?, ?)')
    .run(char.id, encodeEmbedding(vector));
  logger.debug('memory', `computed identity embedding for ${char.name}`);
  return vector;
}

// Recomputes the identity vector after a character's name/description/
// personality is edited.
export async function refreshCharacterEmbedding({ db, embedFn, char }) {
  db.prepare('INSERT OR REPLACE INTO character_embeddings (character_id, embedding) VALUES (?, ?)')
    .run(char.id, encodeEmbedding(await embedFn(characterIdentityText(char))));
}

export function deleteCharacterEmbedding(db, characterId) {
  db.prepare('DELETE FROM character_embeddings WHERE character_id = ?').run(characterId);
}

// Re-embeds every character's identity vector with whatever embedFn is
// passed in — part of the "rebuild embeddings" settings action alongside
// memories and relationships.
export async function rebuildAllCharacterEmbeddings({ db, embedFn, characters }) {
  for (const char of characters) {
    await refreshCharacterEmbedding({ db, embedFn, char });
  }
  return characters.length;
}
