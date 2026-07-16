import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './log.js';

// SQLite storage for the vector-bearing data (memories) and relationships.
// Chat logs / places / characters / presets stay in their JSON files —
// they're small, human-editable, and don't carry embeddings. Memories were
// the ballooning problem: each entry serialized a 384-float embedding as
// JSON text (~5KB); here it's a 1536-byte binary blob, indexed, and read
// selectively instead of whole-file.

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
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
    CREATE INDEX IF NOT EXISTS idx_mem_char ON memories(character_id, persona_key);

    CREATE TABLE IF NOT EXISTS memory_entries (
      memory_id TEXT NOT NULL,
      entry_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_me_entry ON memory_entries(entry_id);
    CREATE INDEX IF NOT EXISTS idx_me_mem ON memory_entries(memory_id);

    CREATE TABLE IF NOT EXISTS relationships (
      character_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      labels TEXT NOT NULL DEFAULT '[]',
      embedding BLOB,
      PRIMARY KEY (character_id, target_id)
    );
  `);

  // Upgrade path for databases created before relationships were embeddable
  // (CREATE TABLE IF NOT EXISTS above only applies to brand-new files).
  const relColumns = db.prepare("PRAGMA table_info(relationships)").all().map((c) => c.name);
  if (!relColumns.includes('embedding')) {
    db.exec('ALTER TABLE relationships ADD COLUMN embedding BLOB');
  }

  return db;
}

export function encodeEmbedding(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

export function decodeEmbedding(buf) {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// One-time import of the previous JSON memory files
// (data/memories/<characterId>__<personaKey>.json). The directory is
// renamed afterward so this never runs twice.
export function importJsonMemories(db, memoryDir) {
  let files;
  try {
    files = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // no legacy directory — nothing to import
  }
  if (!files.length) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memories (id, character_id, persona_key, text, embedding, place_id, day, time_of_day, timestamp, participants)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
  `);
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
        insert.run(
          e.id || crypto.randomUUID(),
          characterId,
          personaKey,
          e.text || '',
          encodeEmbedding(e.embedding),
          e.placeId || null,
          e.timestamp || new Date().toISOString(),
          JSON.stringify(e.participants || [])
        );
        count += 1;
      });
    });
  });
  importAll();

  fs.renameSync(memoryDir, `${memoryDir}.imported`);
  logger.info('memory', `imported ${count} legacy JSON memory entries into SQLite`);
  return count;
}
