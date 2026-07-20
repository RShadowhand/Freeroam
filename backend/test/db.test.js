import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  openDb, encodeEmbedding, decodeEmbedding,
  upsertMemoryVectors, removeMemoryVectorParticipant, deleteMemoryVectors,
  deleteMemoryVectorsForCharacter, queryMemoryVectorIndex,
} from '../lib/db.js';
import { logger } from '../lib/log.js';

logger.setLevel('error'); // keep test output clean

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-db-test-'));
  return path.join(dir, 'freeroam.db');
}

// Hand-builds a database in the OLD (pre-memory_participants) shape: one
// full row — including the embedding — per present character per round.
// openDb()'s own :memory: use elsewhere always creates the new schema
// fresh, so this is the only place the actual migration path gets
// exercised against realistic legacy data.
function seedOldSchema(dbPath, rounds) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      persona_key TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      place_id TEXT,
      day INTEGER,
      time_of_day TEXT,
      timestamp TEXT NOT NULL,
      participants TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE memory_entries (
      memory_id TEXT NOT NULL,
      entry_id TEXT NOT NULL
    );
  `);
  const insertMem = raw.prepare(`
    INSERT INTO memories (id, character_id, persona_key, text, embedding, place_id, day, time_of_day, timestamp, participants)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLink = raw.prepare('INSERT INTO memory_entries (memory_id, entry_id) VALUES (?, ?)');

  rounds.forEach((round) => {
    round.characterIds.forEach((cid) => {
      const id = `${round.timestamp}-${cid}`;
      insertMem.run(
        id, cid, round.personaKey || 'none', round.text,
        encodeEmbedding(round.embedding || [1, 0, 0]),
        round.placeId || null, round.day ?? null, round.timeOfDay ?? null,
        round.timestamp, JSON.stringify(round.characterIds.filter((c) => c !== cid))
      );
      (round.entryIds || []).forEach((eid) => insertLink.run(id, eid));
    });
  });
  raw.close();
}

describe('openDb — memories schema migration', () => {
  test('an old-shape db (character_id + participants columns) is deduplicated into shared rows + memory_participants', () => {
    const dbPath = tempDbPath();
    seedOldSchema(dbPath, [
      {
        characterIds: ['ezra', 'mireille', 'soot'], text: 'A shared round about cats.',
        timestamp: '2026-01-01T00:00:00.000Z', entryIds: ['e1', 'e2'],
        day: 1, timeOfDay: 'morning', personaKey: 'kael',
      },
      { characterIds: ['ezra'], text: 'A solo memory.', timestamp: '2026-01-02T00:00:00.000Z', entryIds: ['e3'] },
    ]);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 2); // 4 old rows -> 2 rounds

      const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
      assert.ok(!cols.includes('character_id'));
      assert.ok(!cols.includes('participants'));

      const sharedRow = db.prepare("SELECT * FROM memories WHERE text = 'A shared round about cats.'").get();
      const participants = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ? ORDER BY character_id')
        .all(sharedRow.id).map((r) => r.character_id);
      assert.deepEqual(participants, ['ezra', 'mireille', 'soot']);
      assert.equal(sharedRow.day, 1);
      assert.equal(sharedRow.time_of_day, 'morning');
      assert.equal(sharedRow.persona_key, 'kael');
      assert.deepEqual(decodeEmbedding(sharedRow.embedding), [1, 0, 0]);

      // 3 old rows × 2 entries = 6 old links, deduplicated to 2.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE memory_id = ?').get(sharedRow.id).n, 2);

      const soloRow = db.prepare("SELECT * FROM memories WHERE text = 'A solo memory.'").get();
      const soloParticipants = db.prepare('SELECT character_id FROM memory_participants WHERE memory_id = ?').all(soloRow.id).map((r) => r.character_id);
      assert.deepEqual(soloParticipants, ['ezra']);

      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_old'").get(), undefined); // old table dropped
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('re-opening an already-migrated db is a no-op — idempotent, no duplication', () => {
    const dbPath = tempDbPath();
    seedOldSchema(dbPath, [{ characterIds: ['ezra', 'soot'], text: 'Once.', timestamp: '2026-01-01T00:00:00.000Z', entryIds: ['e1'] }]);

    let db = openDb(dbPath);
    const firstCount = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
    const firstId = db.prepare('SELECT id FROM memories').get().id;
    db.close();

    db = openDb(dbPath); // second open on the same file — must not re-migrate or duplicate
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, firstCount);
    assert.equal(db.prepare('SELECT id FROM memories').get().id, firstId);
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('a brand-new db gets the new schema directly — no character_id column, memory_participants exists', () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    try {
      const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
      assert.ok(!cols.includes('character_id'));
      assert.ok(cols.includes('persona_key'));
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_participants'").get();
      assert.equal(table.name, 'memory_participants');
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

// Hand-builds a database already in the current shared-row shape (memories
// + memory_participants) but predating memory_vectors — the state every
// real db was in immediately before this feature shipped. openDb()'s own
// :memory: use elsewhere always creates memory_vectors fresh alongside an
// empty memories table, so this is the only place the backfill path (an
// existing db with real rows, no index yet) gets exercised.
function seedSharedRowSchemaNoVectors(dbPath, rounds) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, persona_key TEXT NOT NULL, text TEXT NOT NULL,
      embedding BLOB NOT NULL, place_id TEXT, day INTEGER, time_of_day TEXT, timestamp TEXT NOT NULL
    );
    CREATE TABLE memory_participants (
      memory_id TEXT NOT NULL, character_id TEXT NOT NULL, PRIMARY KEY (memory_id, character_id)
    );
    CREATE TABLE memory_entries (memory_id TEXT NOT NULL, entry_id TEXT NOT NULL);
    CREATE TABLE relationships (character_id TEXT NOT NULL, target_id TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]', embedding BLOB, PRIMARY KEY (character_id, target_id));
    CREATE TABLE character_embeddings (character_id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
  `);
  const insertMem = raw.prepare(`
    INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertParticipant = raw.prepare('INSERT INTO memory_participants (memory_id, character_id) VALUES (?, ?)');
  rounds.forEach((round) => {
    insertMem.run(
      round.id, round.personaKey || 'none', round.text, encodeEmbedding(round.embedding),
      round.placeId || null, round.day ?? null, round.timeOfDay ?? null, round.timestamp
    );
    round.characterIds.forEach((cid) => insertParticipant.run(round.id, cid));
  });
  raw.close();
}

describe('openDb — memory_vectors backfill', () => {
  test('an existing shared-row db with no memory_vectors table gets one built from memories + memory_participants', () => {
    const dbPath = tempDbPath();
    seedSharedRowSchemaNoVectors(dbPath, [
      { id: 'mem-1', characterIds: ['ezra', 'mireille'], text: 'A shared memory.', embedding: [1, 0, 0], timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'mem-2', characterIds: ['ezra'], text: 'A solo memory.', embedding: [0, 1, 0], timestamp: '2026-01-02T00:00:00.000Z' },
    ]);

    const db = openDb(dbPath);
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get();
      assert.ok(table, 'memory_vectors table should exist after backfill');

      const ezraHits = queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5).map((r) => r.memory_id).sort();
      assert.deepEqual(ezraHits, ['mem-1', 'mem-2']);

      const mireilleHits = queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0]), 5).map((r) => r.memory_id);
      assert.deepEqual(mireilleHits, ['mem-1']); // not a participant in mem-2

      // Nearest match wins: querying with [1,0,0] against ezra's two memories
      // ([1,0,0] and [0,1,0]) should rank mem-1 first (distance ~0).
      const ranked = queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5);
      assert.equal(ranked[0].memory_id, 'mem-1');
      assert.ok(ranked[0].distance < ranked[1].distance);
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('re-opening an already-indexed db does not duplicate rows', () => {
    const dbPath = tempDbPath();
    seedSharedRowSchemaNoVectors(dbPath, [
      { id: 'mem-1', characterIds: ['ezra'], text: 'Once.', embedding: [1, 0, 0], timestamp: '2026-01-01T00:00:00.000Z' },
    ]);

    let db = openDb(dbPath);
    db.close();
    db = openDb(dbPath); // second open — must not re-backfill or duplicate
    try {
      const hits = queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 10);
      assert.equal(hits.length, 1);
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a brand-new db has no memory_vectors table until the first write', () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get();
      assert.equal(table, undefined);
      assert.deepEqual(queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5), []);
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe('memory_vectors write/delete helpers', () => {
  function freshDb() {
    return openDb(':memory:');
  }

  test('upsertMemoryVectors creates the table lazily and inserts one row per participant', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [encodeEmbedding([1, 0, 0])]);
    const ezra = queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5);
    const mireille = queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0]), 5);
    assert.equal(ezra.length, 1);
    assert.equal(mireille.length, 1);
    db.close();
  });

  test('upsertMemoryVectors replaces prior rows for the same memory (delete + reinsert)', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [encodeEmbedding([1, 0, 0])]);
    upsertMemoryVectors(db, 'mem-1', ['ezra'], [encodeEmbedding([0, 1, 0])]); // mireille dropped, vector changed
    assert.equal(queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0]), 5).length, 0);
    const ezra = queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([0, 1, 0]), 5);
    assert.equal(ezra.length, 1);
    assert.ok(ezra[0].distance < 0.001);
  });

  test('removeMemoryVectorParticipant removes just one participant, leaving others intact', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [encodeEmbedding([1, 0, 0])]);
    removeMemoryVectorParticipant(db, 'mem-1', 'ezra');
    assert.equal(queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5).length, 0);
    assert.equal(queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0]), 5).length, 1);
  });

  test('deleteMemoryVectors removes every participant row for a memory', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [encodeEmbedding([1, 0, 0])]);
    deleteMemoryVectors(db, 'mem-1');
    assert.equal(queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5).length, 0);
    assert.equal(queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0]), 5).length, 0);
  });

  test('deleteMemoryVectorsForCharacter removes a character across every memory, leaving other participants', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [encodeEmbedding([1, 0, 0])]);
    upsertMemoryVectors(db, 'mem-2', ['ezra'], [encodeEmbedding([0, 1, 0])]);
    deleteMemoryVectorsForCharacter(db, 'ezra');
    assert.equal(queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0]), 5).length, 0);
    assert.equal(queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0]), 5).length, 1);
  });

  test('upsertMemoryVectors recreates the table when the embedding dimension changes, without leaving stale rows', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra'], [encodeEmbedding([1, 0, 0])]); // 3-dim
    upsertMemoryVectors(db, 'mem-2', ['mireille'], [encodeEmbedding([1, 0, 0, 0])]); // 4-dim -> table rebuilt
    // mem-1's 3-dim row was in the dropped table and was never reinserted —
    // simulating what rebuildAllMemoryEmbeddings does row-by-row.
    assert.equal(queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([1, 0, 0, 0]), 5).length, 0);
    const mireille = queryMemoryVectorIndex(db, 'mireille', encodeEmbedding([1, 0, 0, 0]), 5);
    assert.equal(mireille.length, 1);
    assert.equal(mireille[0].memory_id, 'mem-2');
  });

  test('upsertMemoryVectors accepts multiple chunk embeddings per memory — one row per (participant, chunk)', () => {
    const db = freshDb();
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [
      encodeEmbedding([1, 0, 0]),
      encodeEmbedding([0, 1, 0]),
      encodeEmbedding([0, 0, 1]),
    ]);
    // Each participant gets one row per chunk: 3 chunks x 2 participants.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n, 6);
    // Each of the 3 axis-aligned chunk vectors is findable via its own exact match.
    assert.equal(queryMemoryVectorIndex(db, 'ezra', encodeEmbedding([0, 1, 0]), 1)[0].memory_id, 'mem-1');
    // A later upsert (delete + reinsert) fully replaces the chunk set, not just appends.
    upsertMemoryVectors(db, 'mem-1', ['ezra', 'mireille'], [encodeEmbedding([1, 1, 1])]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n, 2);
  });
});

// Hand-builds a database in the OLD character_embeddings shape (character_id
// as an actual PRIMARY KEY — one row per character, no room for chunks).
// openDb()'s own :memory: use elsewhere always creates the new shape fresh,
// so this is the only place the migration path gets exercised.
function seedOldCharacterEmbeddingsSchema(dbPath, rows) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE character_embeddings (
      character_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL
    );
  `);
  const insert = raw.prepare('INSERT INTO character_embeddings (character_id, embedding) VALUES (?, ?)');
  rows.forEach((r) => insert.run(r.characterId, encodeEmbedding(r.embedding)));
  raw.close();
}

describe('openDb — character_embeddings schema migration', () => {
  test('an old-shape db (character_id PRIMARY KEY) is migrated to allow multiple chunk rows, preserving existing data', () => {
    const dbPath = tempDbPath();
    seedOldCharacterEmbeddingsSchema(dbPath, [
      { characterId: 'ezra', embedding: [1, 0, 0] },
      { characterId: 'mireille', embedding: [0, 1, 0] },
    ]);

    const db = openDb(dbPath);
    try {
      const idColumn = db.prepare('PRAGMA table_info(character_embeddings)').all().find((c) => c.name === 'character_id');
      assert.equal(idColumn.pk, 0); // no longer a primary key

      const ezraRows = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').all('ezra');
      assert.equal(ezraRows.length, 1);
      assert.deepEqual(decodeEmbedding(ezraRows[0].embedding), [1, 0, 0]);

      // The new shape actually allows a second row for the same character.
      db.prepare('INSERT INTO character_embeddings (character_id, embedding) VALUES (?, ?)')
        .run('ezra', encodeEmbedding([0, 0, 1]));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings WHERE character_id = ?').get('ezra').n, 2);
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('re-opening an already-migrated db is a no-op — idempotent, no duplication', () => {
    const dbPath = tempDbPath();
    seedOldCharacterEmbeddingsSchema(dbPath, [{ characterId: 'ezra', embedding: [1, 0, 0] }]);

    let db = openDb(dbPath);
    db.close();
    db = openDb(dbPath); // second open — must not re-migrate or duplicate
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings').get().n, 1);
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test('a brand-new db gets the new shape directly — character_id is not a primary key', () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    try {
      const idColumn = db.prepare('PRAGMA table_info(character_embeddings)').all().find((c) => c.name === 'character_id');
      assert.equal(idColumn.pk, 0);
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
