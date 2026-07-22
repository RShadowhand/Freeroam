import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './log.js';

// SQLite storage for the vector-bearing data (memories) and relationships.
// Chat logs / places / characters / presets stay in their JSON files —
// they're small, human-editable, and don't carry embeddings.
//
// A memory row is one recorded round, shared by everyone who witnessed it
// (see memory_participants) rather than duplicated per character. A
// 6-character round used to write 6 full rows, each duplicating the same
// ~1.5KB embedding and the same text; now it's one memories row plus 6
// tiny (memory_id, character_id) rows.

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      persona_key TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      place_id TEXT,
      day INTEGER,
      time_of_day TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_participants (
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      PRIMARY KEY (memory_id, character_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mp_char ON memory_participants(character_id);

    CREATE TABLE IF NOT EXISTS memory_entries (
      memory_id TEXT NOT NULL,
      entry_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_me_entry ON memory_entries(entry_id);
    CREATE INDEX IF NOT EXISTS idx_me_mem ON memory_entries(memory_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_me_unique ON memory_entries(memory_id, entry_id);

    CREATE TABLE IF NOT EXISTS relationships (
      character_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      labels TEXT NOT NULL DEFAULT '[]',
      embedding BLOB,
      PRIMARY KEY (character_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS character_embeddings (
      character_id TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ce_char ON character_embeddings(character_id);
  `);

  // Upgrade path for databases created before relationships were embeddable
  // (CREATE TABLE IF NOT EXISTS above only applies to brand-new files).
  const relColumns = db.prepare("PRAGMA table_info(relationships)").all().map((c) => c.name);
  if (!relColumns.includes('embedding')) {
    db.exec('ALTER TABLE relationships ADD COLUMN embedding BLOB');
  }

  migrateMemoriesSchema(db);
  backfillMemoryVectorIndex(db);
  migrateCharacterEmbeddingsSchema(db);

  return db;
}

// Upgrade path for databases created before memories were deduplicated —
// CREATE TABLE IF NOT EXISTS above only applies to a brand-new file, so an
// existing db still has the old per-character-row shape (a character_id
// column plus one full row — embedding included — per present character
// per round). Detected by the presence of that column; runs at most once
// per db, entirely inside one transaction so a crash mid-migration leaves
// the old schema untouched for a clean retry next boot rather than a
// half-migrated mess.
function migrateMemoriesSchema(db) {
  const columns = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  if (!columns.includes('character_id')) return; // already migrated, or created fresh with the new shape

  logger.info('memory', 'migrating memories table: deduplicating per-character rows into shared rows + memory_participants');
  let roundCount = 0;

  const migrate = db.transaction(() => {
    db.exec('ALTER TABLE memories RENAME TO memories_old;');
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        persona_key TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        place_id TEXT,
        day INTEGER,
        time_of_day TEXT,
        timestamp TEXT NOT NULL
      );
    `);

    // Old rows written by the same recordTurn() call share an identical
    // (timestamp, text) — recordTurn always computed the embedding once
    // and stamped every row with one `new Date().toISOString()` — so
    // grouping by that pair recovers exactly which old rows were one
    // round, without needing to trust the old (self-excluding)
    // `participants` column at all: the union of `character_id` values
    // across a group already *is* the complete participant list.
    const rows = db.prepare('SELECT * FROM memories_old ORDER BY timestamp').all();
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.timestamp} ${row.text}`;
      if (!groups.has(key)) groups.set(key, { canonical: row, characterIds: new Set(), oldIds: [] });
      const group = groups.get(key);
      group.characterIds.add(row.character_id);
      group.oldIds.push(row.id);
    }

    const insertMem = db.prepare(`
      INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertParticipant = db.prepare('INSERT OR IGNORE INTO memory_participants (memory_id, character_id) VALUES (?, ?)');
    const selectLinkedEntries = db.prepare('SELECT DISTINCT entry_id FROM memory_entries WHERE memory_id = ?');
    const insertLink = db.prepare('INSERT OR IGNORE INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');
    const deleteOldLinks = db.prepare('DELETE FROM memory_entries WHERE memory_id = ?');

    for (const { canonical, characterIds, oldIds } of groups.values()) {
      const newId = crypto.randomUUID();
      insertMem.run(newId, canonical.persona_key, canonical.text, canonical.embedding, canonical.place_id, canonical.day, canonical.time_of_day, canonical.timestamp);
      characterIds.forEach((cid) => insertParticipant.run(newId, cid));
      oldIds.forEach((oldId) => {
        selectLinkedEntries.all(oldId).forEach((r) => insertLink.run(newId, r.entry_id));
        deleteOldLinks.run(oldId);
      });
      roundCount += 1;
    }

    db.exec('DROP TABLE memories_old;');
  });
  migrate();

  logger.info('memory', `memories table migration complete: ${roundCount} round(s) recovered`);
}

export function encodeEmbedding(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

export function decodeEmbedding(buf) {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// --- Vector index (memory_vectors) ----------------------------------------
// A sqlite-vec vec0 virtual table indexing every memory's embedding, one row
// per (participant, chunk) pair — a memory can have several participants
// (see memory_participants) and several text chunks (see chunkText in
// memoryStore.js: embedding a whole multi-paragraph round as one vector
// dilutes any short, specific phrase across everything else in it, so long
// memories get split into smaller pieces that are each embedded and scored
// on their own). Each vector is fixed-size (a few KB at most) regardless of
// how long the memory text is, so this reintroduces only that small,
// bounded duplication — not the unbounded per-character text duplication
// the memories/memory_participants split solved. `memories.embedding`
// stays a single whole-text representative vector (used by the one-time
// backfill below to seed pre-existing databases); memory_vectors is a
// derived lookup structure kept in sync by every write/delete path below,
// existing purely so retrieval can do an indexed KNN search instead of
// scanning every row in JS.

// The dimension is read back from the live CREATE VIRTUAL TABLE statement
// rather than tracked separately, so there's exactly one source of truth.
function memoryVectorsDim(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vectors'").get();
  if (!row) return null;
  const m = row.sql.match(/float\[(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

// Creates the vec0 table if it doesn't exist, or recreates it if the
// embedding dimension changed (e.g. a different embedding model) — a
// dimension change means every existing row is stale anyway, since vectors
// from two different models aren't comparable. Callers that switch models
// are expected to fully repopulate afterward (see rebuildAllMemoryEmbeddings
// in memoryStore.js).
function ensureMemoryVectorsTable(db, dim) {
  if (memoryVectorsDim(db) === dim) return;
  db.exec('DROP TABLE IF EXISTS memory_vectors;');
  db.exec(`
    CREATE VIRTUAL TABLE memory_vectors USING vec0(
      character_id TEXT PARTITION KEY,
      embedding float[${dim}] distance_metric=cosine,
      +memory_id TEXT
    );
  `);
}

// Replaces every memory_vectors row for one memory (there's no supported
// UPDATE for vec0 rows tied to a rowid we don't track — delete + reinsert
// is the safe, always-correct way to change a memory's embedding or
// participant list). `embeddingBuffers` is one Buffer per chunk of the
// memory's text (see chunkText in memoryStore.js) — embedding a long round
// as a single vector dilutes any short, specific phrase across everything
// else in it, so a memory can occupy several vector rows per participant,
// one per chunk, each scored independently at retrieval time. Callers with
// only one chunk (or legacy/backfilled data — see backfillMemoryVectorIndex)
// just pass a one-element array.
export function upsertMemoryVectors(db, memoryId, characterIds, embeddingBuffers) {
  if (!embeddingBuffers.length) return;
  ensureMemoryVectorsTable(db, embeddingBuffers[0].length / 4);
  db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(memoryId);
  const insert = db.prepare('INSERT INTO memory_vectors (character_id, embedding, memory_id) VALUES (?, ?, ?)');
  characterIds.forEach((cid) => {
    embeddingBuffers.forEach((buf) => insert.run(cid, buf, memoryId));
  });
}

// Guarded like queryMemoryVectorIndex below — a db that's never recorded a
// memory (a brand-new world, or a "no history" clone now that cloning DROPs
// rather than empties the table — see worldRegistry.js) has no
// memory_vectors table at all yet, and these are called unconditionally by
// memoryStore.js's delete paths (e.g. deleting a character) regardless of
// whether that character ever had a memory.
export function removeMemoryVectorParticipant(db, memoryId, characterId) {
  if (memoryVectorsDim(db) === null) return;
  db.prepare('DELETE FROM memory_vectors WHERE memory_id = ? AND character_id = ?').run(memoryId, characterId);
}

export function deleteMemoryVectors(db, memoryId) {
  if (memoryVectorsDim(db) === null) return;
  db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(memoryId);
}

export function deleteMemoryVectorsForCharacter(db, characterId) {
  if (memoryVectorsDim(db) === null) return;
  db.prepare('DELETE FROM memory_vectors WHERE character_id = ?').run(characterId);
}

// Indexed KNN lookup: the k nearest memories to queryEmbeddingBuffer among
// this character's own memories, nearest first. Returns
// [{ memory_id, distance }] — distance is cosine distance (0 = identical),
// so `1 - distance` is the same score cosineSimilarity() would have
// produced. Returns [] if nothing has been indexed yet for this db.
export function queryMemoryVectorIndex(db, characterId, queryEmbeddingBuffer, k) {
  if (memoryVectorsDim(db) === null || k <= 0) return [];
  return db.prepare(`
    SELECT memory_id, distance FROM memory_vectors
    WHERE character_id = ? AND embedding MATCH ? AND k = ?
  `).all(characterId, queryEmbeddingBuffer, k);
}

// --- World export/import (see worldExport.js) ------------------------------
// A whole-world export needs the memories/memory_participants/memory_entries
// data to survive the round trip without re-running the embedding model — a
// long-running world can have thousands of memory rows, and re-embedding all
// of them at import time (one local-model call per chunk) would be slow.
// Raw memory_vectors rows are dumped too (confirmed via a live spike that an
// unfiltered `SELECT * FROM memory_vectors` works against sqlite-vec, no
// `MATCH` required) so the vec0 index can be rebuilt without re-chunking.
// relationships/character_embeddings are deliberately NOT dumped with their
// embeddings — both are cheap to rebuild from text (rebuildAllRelationship
// Embeddings in relationshipStore.js, rebuildAllCharacterEmbeddings in
// characterEmbeddings.js), so only relationships' logical (non-blob) shape
// needs to survive; character_embeddings needs nothing at all, since it's
// fully rebuildable from the character list already in the export.
function encodeBlobColumns(row, keys) {
  const out = { ...row };
  keys.forEach((k) => { if (out[k] != null) out[k] = out[k].toString('base64'); });
  return out;
}

export function dumpMemoriesForExport(db) {
  return {
    memories: db.prepare('SELECT * FROM memories').all().map((r) => encodeBlobColumns(r, ['embedding'])),
    memoryParticipants: db.prepare('SELECT * FROM memory_participants').all(),
    memoryEntries: db.prepare('SELECT * FROM memory_entries').all(),
    memoryVectors: memoryVectorsDim(db) !== null
      ? db.prepare('SELECT character_id, embedding, memory_id FROM memory_vectors').all().map((r) => encodeBlobColumns(r, ['embedding']))
      : [],
    relationships: db.prepare('SELECT character_id, target_id, labels FROM relationships').all(),
  };
}

// Restores a dump built by dumpMemoriesForExport into a fresh world's db
// (always empty of these tables beforehand — this is an import target, not
// a merge). One transaction, so a crash partway through never leaves
// memory_entries/memory_vectors referencing memories that don't exist.
export function restoreMemoriesFromExport(db, dump) {
  const decode = (b64) => Buffer.from(b64, 'base64');
  const restore = db.transaction(() => {
    const insertMemory = db.prepare(`
      INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
      VALUES (@id, @persona_key, @text, @embedding, @place_id, @day, @time_of_day, @timestamp)
    `);
    (dump.memories || []).forEach((r) => insertMemory.run({ ...r, embedding: decode(r.embedding) }));

    const insertParticipant = db.prepare('INSERT INTO memory_participants (memory_id, character_id) VALUES (?, ?)');
    (dump.memoryParticipants || []).forEach((r) => insertParticipant.run(r.memory_id, r.character_id));

    const insertEntry = db.prepare('INSERT INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');
    (dump.memoryEntries || []).forEach((r) => insertEntry.run(r.memory_id, r.entry_id));

    const vectors = dump.memoryVectors || [];
    if (vectors.length) {
      ensureMemoryVectorsTable(db, decode(vectors[0].embedding).length / 4);
      const insertVector = db.prepare('INSERT INTO memory_vectors (character_id, embedding, memory_id) VALUES (?, ?, ?)');
      vectors.forEach((r) => insertVector.run(r.character_id, decode(r.embedding), r.memory_id));
    }

    const insertRelationship = db.prepare('INSERT INTO relationships (character_id, target_id, labels) VALUES (?, ?, ?)');
    (dump.relationships || []).forEach((r) => insertRelationship.run(r.character_id, r.target_id, r.labels));
  });
  restore();
}

// One-time backfill for databases that already have memories rows but no
// vector index yet (i.e. every db that existed before this feature).
// Skipped once memory_vectors exists — from then on it's kept in sync
// incrementally by the upsert/delete helpers above. If there are no
// memories yet, does nothing; the table gets created lazily on first write
// (see upsertMemoryVectors), whatever dimension that turns out to be.
function backfillMemoryVectorIndex(db) {
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get()) return;

  const rows = db.prepare('SELECT id, embedding FROM memories').all();
  if (!rows.length) return;

  const dim = decodeEmbedding(rows[0].embedding).length;
  ensureMemoryVectorsTable(db, dim);

  const getParticipants = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ?');
  const insert = db.prepare('INSERT INTO memory_vectors (character_id, embedding, memory_id) VALUES (?, ?, ?)');
  const backfill = db.transaction(() => {
    rows.forEach((row) => {
      getParticipants.all(row.id).forEach((p) => insert.run(p.character_id, row.embedding, row.id));
    });
  });
  backfill();

  logger.info('memory', `built vector index for ${rows.length} existing memories`);
}

// Upgrade path for databases created before character identity embeddings
// were chunked — the original schema had character_id as a PRIMARY KEY (one
// row per character); characterEmbeddings.js now stores one row per chunk
// of a character's description/personality (see chunkText in
// textChunks.js), the same dilution fix applied to memory text, so it
// needs several rows per character to be allowed. Detected by checking
// whether character_id is still a primary key column; runs at most once
// per db. Existing single-vector rows are carried over as-is (one chunk),
// not re-chunked here (no embedFn available synchronously) — they get
// upgraded to real multi-chunk embeddings the next time that character is
// edited or embeddings are rebuilt (see refreshCharacterEmbedding).
function migrateCharacterEmbeddingsSchema(db) {
  const columns = db.prepare('PRAGMA table_info(character_embeddings)').all();
  const idColumn = columns.find((c) => c.name === 'character_id');
  if (!idColumn || !idColumn.pk) return; // already migrated, or created fresh with the new shape

  logger.info('memory', 'migrating character_embeddings: allowing multiple chunk rows per character');
  const migrate = db.transaction(() => {
    db.exec('ALTER TABLE character_embeddings RENAME TO character_embeddings_old;');
    db.exec(`
      CREATE TABLE character_embeddings (
        character_id TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ce_char ON character_embeddings(character_id);
    `);
    db.exec('INSERT INTO character_embeddings (character_id, embedding) SELECT character_id, embedding FROM character_embeddings_old;');
    db.exec('DROP TABLE character_embeddings_old;');
  });
  migrate();
}

// One-time import of the previous JSON memory files
// (data/memories/<characterId>__<personaKey>.json). The directory is
// renamed afterward so this never runs twice. These ancient per-file
// entries predate any cross-file linkage — each file's entries are
// imported best-effort as their own memory row (folding in whichever other
// characters that file itself recorded as present via `participants`),
// without trying to deduplicate against a sibling character's independent
// file for what was really the same round: there's no reliable shared key
// to match them by this far back.
export function importJsonMemories(db, memoryDir) {
  let files;
  try {
    files = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // no legacy directory — nothing to import
  }
  if (!files.length) return 0;

  const insertMem = db.prepare(`
    INSERT OR IGNORE INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
  `);
  const insertParticipant = db.prepare('INSERT OR IGNORE INTO memory_participants (memory_id, character_id) VALUES (?, ?)');

  let count = 0;
  const importAll = db.transaction(() => {
    files.forEach((file) => {
      const sep = file.lastIndexOf('__');
      if (sep === -1) return;
      const characterId = file.slice(0, sep);
      const personaKey = file.slice(sep + 2, -'.json'.length);
      let entries;
      try {
        entries = JSON.parse(fs.readFileSync(path.join(memoryDir, file), 'utf-8'));
      } catch {
        return;
      }
      entries.forEach((e) => {
        if (!Array.isArray(e.embedding)) return;
        const id = e.id || crypto.randomUUID();
        const embedding = encodeEmbedding(e.embedding);
        insertMem.run(id, personaKey, e.text || '', embedding, e.placeId || null, e.timestamp || new Date().toISOString());
        insertParticipant.run(id, characterId);
        (e.participants || []).forEach((otherId) => insertParticipant.run(id, otherId));
        const participantIds = [characterId, ...(e.participants || [])];
        upsertMemoryVectors(db, id, participantIds, [embedding]); // legacy import: no re-chunking, one vector per memory
        count += 1;
      });
    });
  });
  importAll();

  fs.renameSync(memoryDir, `${memoryDir}.imported`);
  logger.info('memory', `imported ${count} legacy JSON memory entries into SQLite`);
  return count;
}
