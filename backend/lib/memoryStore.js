import crypto from 'crypto';
import { encodeEmbedding, decodeEmbedding } from './db.js';
import { logger } from './log.js';

// Per-(character, persona) semantic memory, SQLite-backed (see db.js).
// A character's memory of "the visitor" is kept separate per persona,
// since the same character shouldn't conflate their relationship with two
// different personas you might play. personaId of null/undefined is
// normalized to the 'none' key. Every memory row can be linked (via the
// memory_entries junction) to the chat entry ids that formed it, so
// editing/deleting/regenerating a chat message can rebuild exactly the
// memories that witnessed it.

// --- Pure similarity math (no I/O, directly unit-testable) ----------------

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function rankBySimilarity(queryEmbedding, entries) {
  return entries
    .map(entry => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
    .sort((a, b) => b.score - a.score);
}

export function topKSimilar(queryEmbedding, entries, k) {
  return rankBySimilarity(queryEmbedding, entries).slice(0, k).map(r => r.entry);
}

// --- Helpers ---------------------------------------------------------

function personaKeyFor(personaId) {
  return personaId || 'none';
}

// Memory text carries the in-world date so recall is time-anchored; the
// same values live in columns for querying.
export function timePrefix(day, timeOfDay) {
  if (!day && !timeOfDay) return '';
  return `(Day ${day || '?'}, ${timeOfDay || 'sometime'})\n`;
}

function rowToMemory(row) {
  return {
    id: row.id,
    text: row.text,
    placeId: row.place_id,
    day: row.day,
    timeOfDay: row.time_of_day,
    timestamp: row.timestamp,
    participants: JSON.parse(row.participants || '[]'),
    personaId: row.persona_key === 'none' ? null : row.persona_key,
  };
}

// --- Recording --------------------------------------------------------

// Records one turn's text as a memory for every character present — one
// row per (character, persona), all sharing a single embedding computation.
// `entryIds` links the memory to the chat entries that formed it.
export async function recordTurn({ db, embedFn, characterIds, personaId, text, placeId, entryIds = [], day = null, timeOfDay = null }) {
  if (!text || !text.trim() || !Array.isArray(characterIds) || !characterIds.length) return { count: 0 };
  const fullText = timePrefix(day, timeOfDay) + text;
  const embedding = encodeEmbedding(await embedFn(fullText));
  const timestamp = new Date().toISOString();
  const personaKey = personaKeyFor(personaId);

  const insertMem = db.prepare(`
    INSERT INTO memories (id, character_id, persona_key, text, embedding, place_id, day, time_of_day, timestamp, participants)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLink = db.prepare('INSERT INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');

  const write = db.transaction(() => {
    characterIds.forEach((characterId) => {
      const id = crypto.randomUUID();
      insertMem.run(
        id, characterId, personaKey, fullText, embedding, placeId || null,
        day, timeOfDay, timestamp,
        JSON.stringify(characterIds.filter((c) => c !== characterId))
      );
      entryIds.forEach((entryId) => insertLink.run(id, entryId));
    });
  });
  write();

  logger.info('memory', `recorded turn for [${characterIds.join(', ')}] persona=${personaKey} place=${placeId || '-'} (${fullText.length} chars, ${entryIds.length} linked entries)`);
  return { count: characterIds.length };
}

// --- Retrieval --------------------------------------------------------

// Two selection passes per character, merged and deduped by text:
//   semantic — up to topKPerCharacter most similar to the query, but only
//              ones that clear minScore. Small local embedding models (this
//              app's included one especially) can inflate cosine similarity
//              for short texts that merely share a common word ("hand"
//              appearing in both the query and a dozen unrelated memories),
//              and topK alone always returns K results regardless of how
//              weak the best available matches are — minScore is the actual
//              relevance gate; topK just caps how many pass it.
//   recency  — the recentPerCharacter newest rows regardless of similarity,
//              which is what lets a conversation follow a character across
//              rooms. Not threshold-filtered — recency's whole purpose is
//              surfacing regardless of topical relevance. Final list is
//              chronological.
// excludeEntryIds skips any memory row formed (even partially) from one of
// those chat entries — used to keep memory from re-surfacing the current,
// still-visible interaction: it's already in the messages array as real
// chat history, so repeating it in the "what's remembered" block would only
// duplicate content and burn context budget for nothing.
// Memory is global, not persona-scoped: a character's recollection of a
// moment with one persona is still theirs to recall when a different
// persona is active (e.g. "how did your date with Kael go?" asked by a
// different persona later) — persona_key is recorded per memory for
// context/display only, never filtered on here.
export async function retrieveMemories({ db, embedFn, characterIds, query, topKPerCharacter = 3, recentPerCharacter = 2, excludeEntryIds = [], minScore = 0 }) {
  if (!query || !query.trim() || !Array.isArray(characterIds) || !characterIds.length) return [];
  const queryEmbedding = await embedFn(query);

  const excludedMemoryIds = new Set();
  if (excludeEntryIds.length) {
    const placeholders = excludeEntryIds.map(() => '?').join(',');
    db.prepare(`SELECT DISTINCT memory_id FROM memory_entries WHERE entry_id IN (${placeholders})`)
      .all(...excludeEntryIds)
      .forEach((r) => excludedMemoryIds.add(r.memory_id));
  }

  const selectAll = db.prepare('SELECT id, text, embedding, timestamp FROM memories WHERE character_id = ?');

  const selected = new Map(); // text -> { text, timestamp, score }
  characterIds.forEach((characterId) => {
    const rows = selectAll.all(characterId)
      .filter((r) => !excludedMemoryIds.has(r.id))
      .map((r) => ({ id: r.id, text: r.text, timestamp: r.timestamp, embedding: decodeEmbedding(r.embedding) }));

    const ranked = rankBySimilarity(queryEmbedding, rows);
    ranked.filter((r) => r.score >= minScore).slice(0, topKPerCharacter).forEach(({ entry, score }) => {
      selected.set(entry.text, { text: entry.text, timestamp: entry.timestamp, score });
    });
    if (recentPerCharacter > 0) {
      [...rows].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, recentPerCharacter)
        .forEach((entry) => {
          if (!selected.has(entry.text)) selected.set(entry.text, { text: entry.text, timestamp: entry.timestamp, score: null });
        });
    }
  });

  const results = [...selected.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  logger.info('memory', `retrieve: ${results.length} hits for [${characterIds.join(', ')}]`);
  logger.debug('memory', 'retrieval detail', {
    query,
    hits: results.map((r) => ({
      score: r.score,
      source: r.score === null ? 'recent' : 'semantic',
      text: r.text.slice(0, 80),
    })),
  });
  return results.map((r) => r.text);
}

// --- Management (memories modal) ---------------------------------------

export function listCharacterMemories(db, characterId) {
  return db.prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY timestamp DESC')
    .all(characterId)
    .map(rowToMemory);
}

export async function addCharacterMemory({ db, embedFn, characterId, personaId, text, placeId, day = null, timeOfDay = null }) {
  if (!text || !text.trim()) return null;
  const id = crypto.randomUUID();
  const fullText = timePrefix(day, timeOfDay) + text.trim();
  db.prepare(`
    INSERT INTO memories (id, character_id, persona_key, text, embedding, place_id, day, time_of_day, timestamp, participants)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
  `).run(id, characterId, personaKeyFor(personaId), fullText, encodeEmbedding(await embedFn(fullText)), placeId || null, day, timeOfDay, new Date().toISOString());
  logger.info('memory', `added manual memory ${id} for ${characterId}`);
  return rowToMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
}

export async function updateCharacterMemory({ db, embedFn, characterId, entryId, text }) {
  if (!text || !text.trim()) return null;
  const row = db.prepare('SELECT * FROM memories WHERE id = ? AND character_id = ?').get(entryId, characterId);
  if (!row) return null;
  db.prepare('UPDATE memories SET text = ?, embedding = ?, timestamp = ? WHERE id = ?')
    .run(text.trim(), encodeEmbedding(await embedFn(text.trim())), new Date().toISOString(), entryId);
  logger.info('memory', `updated memory ${entryId} (re-embedded)`);
  return rowToMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(entryId));
}

export function deleteCharacterMemory(db, characterId, entryId) {
  const result = db.prepare('DELETE FROM memories WHERE id = ? AND character_id = ?').run(entryId, characterId);
  if (result.changes > 0) {
    db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(entryId);
    logger.info('memory', `deleted memory ${entryId}`);
    return true;
  }
  return false;
}

export function deleteAllCharacterMemories(db, characterId) {
  const ids = db.prepare('SELECT id FROM memories WHERE character_id = ?').all(characterId).map((r) => r.id);
  const wipe = db.transaction(() => {
    ids.forEach((id) => {
      db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    });
  });
  wipe();
  if (ids.length) logger.info('memory', `deleted all ${ids.length} memories for ${characterId}`);
}

// --- Chat-entry sync (edit / delete / regenerate) -----------------------

// Regenerates each memory row's text from whichever of its linked entries
// still exist in the current log (in log order), keeping its original
// day/time prefix. A row left with no surviving entries is deleted outright.
async function rebuildMemories({ db, embedFn, memoryIds, log, userLabel, formatEntry }) {
  let rebuilt = 0;
  for (const mid of memoryIds) {
    const linkedIds = db.prepare('SELECT entry_id FROM memory_entries WHERE memory_id = ?').all(mid).map((r) => r.entry_id);
    const entries = log.filter((e) => linkedIds.includes(e.id) && (e.type === 'system' || e.type === 'user' || e.type === 'char'));

    if (!entries.length) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(mid);
      db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(mid);
      logger.info('memory', `sync: memory ${mid} emptied by chat edits — deleted`);
      continue;
    }

    const row = db.prepare('SELECT day, time_of_day FROM memories WHERE id = ?').get(mid);
    if (!row) continue;
    const text = timePrefix(row.day, row.time_of_day) + entries.map((e) => formatEntry(e, userLabel)).join('\n');
    db.prepare('UPDATE memories SET text = ?, embedding = ? WHERE id = ?')
      .run(text, encodeEmbedding(await embedFn(text)), mid);
    rebuilt += 1;
  }
  return rebuilt;
}

// The memory rows (if any) that were formed, in part, from a given chat
// entry — resolved up front, before any mutation, so callers can act on a
// stable snapshot (see detachEntryFromMemories/attachEntriesToMemories).
export function findMemoriesWitnessing(db, entryId) {
  return db.prepare('SELECT DISTINCT memory_id FROM memory_entries WHERE entry_id = ?').all(entryId).map((r) => r.memory_id);
}

// Rebuilds every memory that witnessed a given chat entry, after the chat
// log has already been mutated. newEntryIds:
//   null — the entry still exists (it was edited); memories keep their links
//   []   — the entry was deleted; drop its links
//   [ids] — the entry was replaced (regenerated); links move to the new ids
export async function syncMemoriesForEntry({ db, embedFn, entryId, newEntryIds = null, log, userLabel, formatEntry }) {
  const memoryIds = findMemoriesWitnessing(db, entryId);
  if (!memoryIds.length) return 0;

  if (newEntryIds !== null) {
    const remove = db.prepare('DELETE FROM memory_entries WHERE memory_id = ? AND entry_id = ?');
    const add = db.prepare('INSERT INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');
    const relink = db.transaction(() => {
      memoryIds.forEach((mid) => {
        remove.run(mid, entryId);
        newEntryIds.forEach((nid) => add.run(mid, nid));
      });
    });
    relink();
  }

  const rebuilt = await rebuildMemories({ db, embedFn, memoryIds, log, userLabel, formatEntry });
  if (rebuilt) logger.info('memory', `sync: rebuilt ${rebuilt} memories touching entry ${entryId}`);
  return rebuilt;
}

// Regenerate needs a two-phase update, unlike a plain edit/delete: the stale
// reply's contribution must be stripped from any shared round-memory *before*
// generating its replacement — otherwise memory retrieval for that very
// generation call would surface a "memory" quoting the exact reply about to
// be thrown away. detachEntryFromMemories runs first (against the log with
// the target entry removed); once the new entries exist,
// attachEntriesToMemories relinks the same memory rows (identified by the
// caller via findMemoriesWitnessing, captured before either call) to them.
export async function detachEntryFromMemories({ db, embedFn, memoryIds, entryId, log, userLabel, formatEntry }) {
  if (!memoryIds.length) return 0;
  const remove = db.prepare('DELETE FROM memory_entries WHERE memory_id = ? AND entry_id = ?');
  const detach = db.transaction(() => { memoryIds.forEach((mid) => remove.run(mid, entryId)); });
  detach();
  const rebuilt = await rebuildMemories({ db, embedFn, memoryIds, log, userLabel, formatEntry });
  if (rebuilt) logger.info('memory', `sync: detached entry ${entryId} from ${rebuilt} memories ahead of regeneration`);
  return rebuilt;
}

// Deletes any of the given memory rows that no longer have a surviving
// character-reply entry linked to them — rows reduced to just the user's
// own words. Deliberately narrower than rebuildMemories' emptied-row check
// (which only purges a row once *every* linked entry is gone): a lone
// character's reply being deleted out of a longer round is meant to leave
// the rest of that round's memory intact (see syncMemoriesForEntry), so
// this isn't applied there. It exists specifically for /retry: Retry
// reuses the same trigger user message across attempts rather than
// deleting it, so deleting every character reply from a round and
// retrying leaves that round's memory rows pointing at nothing but the
// user's message — call this right before recording the fresh round so
// that stale echo doesn't stick around alongside it.
export function pruneReplylessMemories(db, memoryIds, log) {
  let pruned = 0;
  for (const mid of memoryIds) {
    const linkedIds = db.prepare('SELECT entry_id FROM memory_entries WHERE memory_id = ?').all(mid).map((r) => r.entry_id);
    const hasCharReply = log.some((e) => linkedIds.includes(e.id) && e.type === 'char');
    if (!hasCharReply) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(mid);
      db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(mid);
      pruned += 1;
    }
  }
  if (pruned) logger.info('memory', `pruned ${pruned} reply-less memor${pruned === 1 ? 'y' : 'ies'} ahead of retry`);
  return pruned;
}

export async function attachEntriesToMemories({ db, embedFn, memoryIds, newEntryIds, log, userLabel, formatEntry }) {
  if (!memoryIds.length || !newEntryIds.length) return 0;
  const add = db.prepare('INSERT INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');
  const attach = db.transaction(() => { memoryIds.forEach((mid) => newEntryIds.forEach((nid) => add.run(mid, nid))); });
  attach();
  const rebuilt = await rebuildMemories({ db, embedFn, memoryIds, log, userLabel, formatEntry });
  if (rebuilt) logger.info('memory', `sync: rebuilt ${rebuilt} memories with regenerated entries`);
  return rebuilt;
}
