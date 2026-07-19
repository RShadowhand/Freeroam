import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, encodeEmbedding, decodeEmbedding } from '../lib/db.js';
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
