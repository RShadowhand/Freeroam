import crypto from 'crypto';
import {
  encodeEmbedding,
  upsertMemoryVectors, removeMemoryVectorParticipant, deleteMemoryVectors,
  deleteMemoryVectorsForCharacter, queryMemoryVectorIndex,
} from './db.js';
import { weekdayFor } from './context.js';
import { chunkText, MAX_CHUNKS_PER_TEXT } from './textChunks.js';
import { logger } from './log.js';

// Per-(character, persona) semantic memory, SQLite-backed (see db.js). A
// round is recorded once — a single memories row, shared by every present
// character via memory_participants — rather than duplicated per
// character; retrieval/management join through that table, so from the
// outside a character's memories still behave as if they were their own.
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
// same values live in columns for querying. The weekday is folded into the
// embedded text (not just the day number) so a query like "how did your
// exam on Monday go?" has something to actually match against — day counts
// alone mean nothing to a semantic search, but "Monday" is a real word.
// Matches the "Day X (Weekday)" phrasing already used in context.js/
// narrator.js for the same day -> weekday derivation (see weekdayFor).
export function timePrefix(day, timeOfDay) {
  if (!day && !timeOfDay) return '';
  const weekday = weekdayFor(day);
  const dayLabel = day ? `Day ${day}${weekday ? ` (${weekday})` : ''}` : 'Day ?';
  return `(${dayLabel}, ${timeOfDay || 'sometime'})\n`;
}

// --- Chunking & embeddings ---------------------------------------------
// recordTurn joins every present character's full reply into one text
// block (a "round"). Embedding that whole block as a single vector dilutes
// any short, specific phrase across everything else in it — a sentence
// embedding model pools over the whole input, so a 1000-character passage
// covering several unrelated topics ends up as a vector that faintly
// resembles all of them and strongly resembles none. A query for one exact
// short phrase can then rank well below memories that just happen to
// repeat a common word many times. Splitting into smaller chunks before
// embedding — each chunk scored independently, see queryMemoryVectorIndex
// — keeps a short salient phrase from getting averaged away. chunkText
// itself (and MAX_CHUNKS_PER_TEXT) lives in textChunks.js, shared with
// characterEmbeddings.js for the same reason applied to character
// descriptions.

// Computes everything a memory write needs: a single whole-text embedding
// (for the memories.embedding column — still useful as a coarse
// representative vector, and as the seed for backfilling older databases)
// plus one embedding per chunk (for memory_vectors). When there's only one
// chunk — the common case for short memories — it IS the whole text, so
// its embedding is reused instead of embedding the same string twice.
async function computeMemoryEmbeddings(embedFn, fullText) {
  const chunks = chunkText(fullText);
  const effectiveChunks = chunks.length ? chunks : [fullText];
  const chunkBuffers = [];
  for (const chunk of effectiveChunks) chunkBuffers.push(encodeEmbedding(await embedFn(chunk)));
  const wholeTextBuffer = effectiveChunks.length === 1 ? chunkBuffers[0] : encodeEmbedding(await embedFn(fullText));
  return { wholeTextBuffer, chunkBuffers };
}

// Fetches this character's memory_vectors nearest to queryBuffer and
// collapses multiple chunk-hits for the same memory down to its single
// best (smallest-distance) hit — a long memory can occupy several chunk
// rows (see chunkText), and each should only ever count once when ranking
// memories against each other, scored by whichever of its chunks matched
// best. `fetchK` must be large enough to guarantee seeing every chunk of
// the memories that matter — callers size it off MAX_CHUNKS_PER_TEXT.
function bestChunkPerMemory(db, characterId, queryBuffer, fetchK, excludedMemoryIds = null) {
  const raw = queryMemoryVectorIndex(db, characterId, queryBuffer, fetchK);
  const bestByMemory = new Map();
  for (const r of raw) {
    if (excludedMemoryIds && excludedMemoryIds.has(r.memory_id)) continue;
    const prev = bestByMemory.get(r.memory_id);
    if (!prev || r.distance < prev.distance) bestByMemory.set(r.memory_id, r);
  }
  return [...bestByMemory.values()].sort((a, b) => a.distance - b.distance);
}

// `participants` is relative to `characterId` — everyone else who shared
// this memory, matching the shape callers already expect (self excluded).
function rowToMemory(db, row, characterId) {
  const participants = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ? AND character_id != ?')
    .all(row.id, characterId)
    .map((r) => r.character_id);
  return {
    id: row.id,
    text: row.text,
    placeId: row.place_id,
    day: row.day,
    timeOfDay: row.time_of_day,
    timestamp: row.timestamp,
    participants,
    personaId: row.persona_key === 'none' ? null : row.persona_key,
  };
}

// --- Recording --------------------------------------------------------

// Records one turn's text as a single memory row, shared by every present
// character via memory_participants — one memories row regardless of how
// many characters witnessed it (the text gets split into chunks for
// embedding, see computeMemoryEmbeddings, but that's an indexing detail —
// there's still exactly one editable/deletable memory here).
// `entryIds` links the memory to the chat entries that formed it.
export async function recordTurn({ db, embedFn, characterIds, personaId, text, placeId, entryIds = [], day = null, timeOfDay = null }) {
  if (!text || !text.trim() || !Array.isArray(characterIds) || !characterIds.length) return { count: 0 };
  const fullText = timePrefix(day, timeOfDay) + text;
  const { wholeTextBuffer, chunkBuffers } = await computeMemoryEmbeddings(embedFn, fullText);
  const timestamp = new Date().toISOString();
  const personaKey = personaKeyFor(personaId);
  const id = crypto.randomUUID();

  const insertMem = db.prepare(`
    INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertParticipant = db.prepare('INSERT OR IGNORE INTO memory_participants (memory_id, character_id) VALUES (?, ?)');
  const insertLink = db.prepare('INSERT OR IGNORE INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');

  const write = db.transaction(() => {
    insertMem.run(id, personaKey, fullText, wholeTextBuffer, placeId || null, day, timeOfDay, timestamp);
    characterIds.forEach((characterId) => insertParticipant.run(id, characterId));
    entryIds.forEach((entryId) => insertLink.run(id, entryId));
    upsertMemoryVectors(db, id, characterIds, chunkBuffers);
  });
  write();

  logger.info('memory', `recorded turn for [${characterIds.join(', ')}] persona=${personaKey} place=${placeId || '-'} (${fullText.length} chars, ${chunkBuffers.length} chunk(s), ${entryIds.length} linked entries, 1 row)`);
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
  const queryBuffer = encodeEmbedding(queryEmbedding);

  const excludedMemoryIds = new Set();
  if (excludeEntryIds.length) {
    const placeholders = excludeEntryIds.map(() => '?').join(',');
    db.prepare(`SELECT DISTINCT memory_id FROM memory_entries WHERE entry_id IN (${placeholders})`)
      .all(...excludeEntryIds)
      .forEach((r) => excludedMemoryIds.add(r.memory_id));
  }

  const getMemory = db.prepare('SELECT text, timestamp FROM memories WHERE id = ?');
  const selectRecent = db.prepare(`
    SELECT m.id, m.text, m.timestamp
    FROM memories m
    JOIN memory_participants mp ON mp.memory_id = m.id
    WHERE mp.character_id = ?
    ORDER BY m.timestamp DESC
  `);

  const selected = new Map(); // text -> { text, timestamp, score }
  characterIds.forEach((characterId) => {
    // Indexed KNN, nearest first — over-fetch by the number of excluded
    // memories, times MAX_CHUNKS_PER_TEXT (a memory can occupy several
    // chunk rows — see chunkText/bestChunkPerMemory — so guaranteeing
    // topKPerCharacter *distinct* memories after dedup needs that many raw
    // rows in the worst case where a few memories monopolize the nearest
    // chunks), so that filtering excluded/duplicate rows out afterward can
    // never leave fewer than topKPerCharacter real candidates when enough
    // exist (results come back in distance order, so the top
    // topKPerCharacter surviving ones after this filter are exactly what a
    // full-scan-then-filter would have picked).
    const knn = bestChunkPerMemory(
      db, characterId, queryBuffer,
      (topKPerCharacter + excludedMemoryIds.size) * MAX_CHUNKS_PER_TEXT,
      excludedMemoryIds
    );
    knn.filter((r) => (1 - r.distance) >= minScore).slice(0, topKPerCharacter).forEach((r) => {
      const row = getMemory.get(r.memory_id);
      if (row) selected.set(row.text, { text: row.text, timestamp: row.timestamp, score: 1 - r.distance });
    });

    if (recentPerCharacter > 0) {
      let seen = 0;
      for (const row of selectRecent.iterate(characterId)) {
        if (excludedMemoryIds.has(row.id)) continue;
        if (seen >= recentPerCharacter) break;
        seen += 1;
        if (!selected.has(row.text)) selected.set(row.text, { text: row.text, timestamp: row.timestamp, score: null });
      }
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

// --- Debugging -------------------------------------------------------
// retrieveMemories() only ever hands generation the winning text strings
// — by design, since that's all a prompt needs. For a human trying to
// understand *why* a character did or didn't recall something, that's not
// enough: you need to see where a near-miss actually landed. This ranks
// every one of a character's memories against a query (same single-pass
// cosine ranking retrieveMemories uses per character) and annotates each
// with whether the real topK/recency/minScore selection would have picked
// it, and which pass did it. Reads the character's whole memory set to
// rank it — unavoidable for an honest ranking, same as retrieveMemories
// already does per character today.
export async function queryCharacterMemories({ db, embedFn, characterId, query, topK = 3, recentCount = 2, minScore = 0, limit = 50 }) {
  if (!query || !query.trim()) return [];
  const queryEmbedding = await embedFn(query);
  const queryBuffer = encodeEmbedding(queryEmbedding);

  const rows = db.prepare(`
    SELECT m.* FROM memories m
    JOIN memory_participants mp ON mp.memory_id = m.id
    WHERE mp.character_id = ?
  `).all(characterId);
  if (!rows.length) return [];

  const rowById = new Map(rows.map((r) => [r.id, r]));
  // Exhaustive ranking via the same index retrieveMemories uses (k = every
  // chunk row this character could possibly have — rows.length memories ×
  // MAX_CHUNKS_PER_TEXT chunks each, an exact upper bound — so every
  // memory is guaranteed to be seen) — this is a diagnostic tool whose
  // whole point is showing near-misses too, not just the winners, so it
  // needs the full ranked list, not just topK. Low-frequency/manual, so the
  // "fetch everyone" cost doesn't matter the way it would on the hot path.
  const knn = bestChunkPerMemory(db, characterId, queryBuffer, rows.length * MAX_CHUNKS_PER_TEXT);
  const ranked = knn.map((r) => ({ entry: rowById.get(r.memory_id), score: 1 - r.distance })).filter((r) => r.entry);

  const recentIds = new Set(
    [...rows].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, recentCount).map((r) => r.id)
  );
  const semanticIds = new Set(
    ranked.filter((r) => r.score >= minScore).slice(0, topK).map((r) => r.entry.id)
  );

  return ranked.slice(0, limit).map(({ entry, score }) => {
    const isSemantic = semanticIds.has(entry.id);
    const isRecent = recentIds.has(entry.id);
    return {
      ...rowToMemory(db, entry, characterId),
      score,
      selected: isSemantic || isRecent,
      selectionReason: isSemantic && isRecent ? 'semantic + recent' : isSemantic ? 'semantic' : isRecent ? 'recent' : null,
    };
  });
}

// --- Management (memories modal) ---------------------------------------

// Newest-first, paginated — a long-running roleplay can pile up hundreds
// of memories per character, and the management UI has no business
// pulling all of them (and their embeddings) into one response.
export function listCharacterMemories(db, characterId, { limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT m.* FROM memories m
    JOIN memory_participants mp ON mp.memory_id = m.id
    WHERE mp.character_id = ?
    ORDER BY m.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(characterId, limit, offset);
  return rows.map((row) => rowToMemory(db, row, characterId));
}

export function countCharacterMemories(db, characterId) {
  return db.prepare('SELECT COUNT(*) AS n FROM memory_participants WHERE character_id = ?').get(characterId).n;
}

export async function addCharacterMemory({ db, embedFn, characterId, personaId, text, placeId, day = null, timeOfDay = null }) {
  if (!text || !text.trim()) return null;
  const id = crypto.randomUUID();
  const fullText = timePrefix(day, timeOfDay) + text.trim();
  const { wholeTextBuffer, chunkBuffers } = await computeMemoryEmbeddings(embedFn, fullText);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, personaKeyFor(personaId), fullText, wholeTextBuffer, placeId || null, day, timeOfDay, new Date().toISOString());
    db.prepare('INSERT INTO memory_participants (memory_id, character_id) VALUES (?, ?)').run(id, characterId);
    upsertMemoryVectors(db, id, [characterId], chunkBuffers);
  })();
  logger.info('memory', `added manual memory ${id} for ${characterId}`);
  return rowToMemory(db, db.prepare('SELECT * FROM memories WHERE id = ?').get(id), characterId);
}

export async function updateCharacterMemory({ db, embedFn, characterId, entryId, text }) {
  if (!text || !text.trim()) return null;
  const owns = db.prepare('SELECT 1 FROM memory_participants WHERE memory_id = ? AND character_id = ?').get(entryId, characterId);
  if (!owns) return null;
  const { wholeTextBuffer, chunkBuffers } = await computeMemoryEmbeddings(embedFn, text.trim());
  const participantIds = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ?').all(entryId).map((r) => r.character_id);
  db.transaction(() => {
    db.prepare('UPDATE memories SET text = ?, embedding = ?, timestamp = ? WHERE id = ?')
      .run(text.trim(), wholeTextBuffer, new Date().toISOString(), entryId);
    upsertMemoryVectors(db, entryId, participantIds, chunkBuffers);
  })();
  logger.info('memory', `updated memory ${entryId} (re-embedded)`);
  return rowToMemory(db, db.prepare('SELECT * FROM memories WHERE id = ?').get(entryId), characterId);
}

// Re-embeds every stored memory row with whatever embedFn is passed in —
// used when the embedding model changes, since old vectors live in a
// different vector space and aren't comparable to freshly embedded queries.
// Deliberately never called automatically; see /api/settings/rebuild-embeddings.
// Also rebuilds memory_vectors for every row, re-chunking as it goes — this
// is the only path that upgrades memories written before chunked embedding
// existed to the finer-grained chunks (see chunkText). If the new model has
// a different dimension, the first upsertMemoryVectors call drops and
// recreates the vec0 table to match (see ensureMemoryVectorsTable in
// db.js), so every subsequent row in this same loop lands in the
// correctly-shaped table.
export async function rebuildAllMemoryEmbeddings({ db, embedFn }) {
  const rows = db.prepare('SELECT id, text FROM memories').all();

  // All the async embedding-model work happens first, outside any
  // transaction (db.transaction() requires a synchronous callback) — only
  // once every row's new vectors are computed do the actual DB writes run,
  // wrapped in one transaction so a crash partway through can't leave some
  // rows re-embedded and others stale.
  const computed = [];
  for (const row of rows) {
    const { wholeTextBuffer, chunkBuffers } = await computeMemoryEmbeddings(embedFn, row.text);
    computed.push({ id: row.id, wholeTextBuffer, chunkBuffers });
  }

  const update = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?');
  const getParticipants = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ?');
  const applyAll = db.transaction(() => {
    for (const { id, wholeTextBuffer, chunkBuffers } of computed) {
      update.run(wholeTextBuffer, id);
      const participantIds = getParticipants.all(id).map((p) => p.character_id);
      upsertMemoryVectors(db, id, participantIds, chunkBuffers);
    }
  });
  applyAll();

  return rows.length;
}

// Removes just this character's participation — a memory shared with
// others stays intact for them. Only when the last participant leaves does
// the row (and its entry links) actually disappear, since nobody's left to
// recall it.
export function deleteCharacterMemory(db, characterId, entryId) {
  const result = db.prepare('DELETE FROM memory_participants WHERE memory_id = ? AND character_id = ?').run(entryId, characterId);
  if (result.changes === 0) return false;
  removeMemoryVectorParticipant(db, entryId, characterId);

  const { n: remaining } = db.prepare('SELECT COUNT(*) AS n FROM memory_participants WHERE memory_id = ?').get(entryId);
  if (remaining === 0) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(entryId);
    db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(entryId);
    deleteMemoryVectors(db, entryId);
  }
  logger.info('memory', `deleted memory ${entryId} for ${characterId}${remaining === 0 ? ' (last participant — row removed)' : ''}`);
  return true;
}

// Removes a character from every memory they participated in — used when
// the character itself is deleted. Rows other characters still share
// survive; a row left with no participants is removed outright.
export function deleteAllCharacterMemories(db, characterId) {
  const memoryIds = db.prepare('SELECT memory_id FROM memory_participants WHERE character_id = ?').all(characterId).map((r) => r.memory_id);
  let removedRows = 0;
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM memory_participants WHERE character_id = ?').run(characterId);
    deleteMemoryVectorsForCharacter(db, characterId);
    memoryIds.forEach((mid) => {
      const { n: remaining } = db.prepare('SELECT COUNT(*) AS n FROM memory_participants WHERE memory_id = ?').get(mid);
      if (remaining === 0) {
        db.prepare('DELETE FROM memories WHERE id = ?').run(mid);
        db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(mid);
        deleteMemoryVectors(db, mid);
        removedRows += 1;
      }
    });
  });
  wipe();
  if (memoryIds.length) logger.info('memory', `removed ${characterId} from ${memoryIds.length} memories (${removedRows} row(s) fully removed)`);
}

// --- Chat-entry sync (edit / delete / regenerate) -----------------------

// Regenerates each memory row's text from whichever of its linked entries
// still exist in the current log (in log order), keeping its original
// day/time prefix. A row left with no surviving entries is deleted outright
// (its participants and entry links go with it).
async function rebuildMemories({ db, embedFn, memoryIds, log, userLabel, formatEntry }) {
  // Same split as rebuildAllMemoryEmbeddings above: figure out what needs to
  // happen to each row (delete, or recompute text + embeddings) first, doing
  // all the async embedding-model work up front, then apply every resulting
  // delete/update as one synchronous db.transaction() — a crash partway
  // through updating several memories at once (e.g. everything one round
  // witnessed) can no longer leave some rebuilt and others stale/orphaned.
  const actions = [];
  for (const mid of memoryIds) {
    const linkedIds = db.prepare('SELECT entry_id FROM memory_entries WHERE memory_id = ?').all(mid).map((r) => r.entry_id);
    const entries = log.filter((e) => linkedIds.includes(e.id) && (e.type === 'system' || e.type === 'user' || e.type === 'char' || e.type === 'narrator'));

    if (!entries.length) {
      actions.push({ type: 'delete', mid });
      continue;
    }

    const row = db.prepare('SELECT day, time_of_day FROM memories WHERE id = ?').get(mid);
    if (!row) continue;
    const text = timePrefix(row.day, row.time_of_day) + entries.map((e) => formatEntry(e, userLabel)).join('\n');
    const { wholeTextBuffer, chunkBuffers } = await computeMemoryEmbeddings(embedFn, text);
    const participantIds = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ?').all(mid).map((r) => r.character_id);
    actions.push({ type: 'update', mid, text, wholeTextBuffer, chunkBuffers, participantIds });
  }

  let rebuilt = 0;
  const applyAll = db.transaction(() => {
    for (const action of actions) {
      if (action.type === 'delete') {
        db.prepare('DELETE FROM memories WHERE id = ?').run(action.mid);
        db.prepare('DELETE FROM memory_entries WHERE memory_id = ?').run(action.mid);
        db.prepare('DELETE FROM memory_participants WHERE memory_id = ?').run(action.mid);
        deleteMemoryVectors(db, action.mid);
        logger.info('memory', `sync: memory ${action.mid} emptied by chat edits — deleted`);
      } else {
        db.prepare('UPDATE memories SET text = ?, embedding = ? WHERE id = ?').run(action.text, action.wholeTextBuffer, action.mid);
        upsertMemoryVectors(db, action.mid, action.participantIds, action.chunkBuffers);
        rebuilt += 1;
      }
    }
  });
  applyAll();

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
    const add = db.prepare('INSERT OR IGNORE INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');
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
      db.prepare('DELETE FROM memory_participants WHERE memory_id = ?').run(mid);
      deleteMemoryVectors(db, mid);
      pruned += 1;
    }
  }
  if (pruned) logger.info('memory', `pruned ${pruned} reply-less memor${pruned === 1 ? 'y' : 'ies'} ahead of retry`);
  return pruned;
}

export async function attachEntriesToMemories({ db, embedFn, memoryIds, newEntryIds, log, userLabel, formatEntry }) {
  if (!memoryIds.length || !newEntryIds.length) return 0;
  const add = db.prepare('INSERT OR IGNORE INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');
  const attach = db.transaction(() => { memoryIds.forEach((mid) => newEntryIds.forEach((nid) => add.run(mid, nid))); });
  attach();
  const rebuilt = await rebuildMemories({ db, embedFn, memoryIds, log, userLabel, formatEntry });
  if (rebuilt) logger.info('memory', `sync: rebuilt ${rebuilt} memories with regenerated entries`);
  return rebuilt;
}
