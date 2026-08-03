import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldRegistry } from '../lib/worldRegistry.js';
import { encodeEmbedding, upsertMemoryVectors } from '../lib/db.js';
import { deleteAllCharacterMemories } from '../lib/memoryStore.js';
import { logger } from '../lib/log.js';

logger.setLevel('error'); // keep test output clean

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-registry-test-'));
}

describe('createWorldRegistry — fresh install', () => {
  test('init() with no existing data creates one seeded default world', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    const { worlds, defaultWorldId } = registry.list();
    assert.equal(worlds.length, 1);
    assert.equal(worlds[0].name, 'My World');
    assert.equal(worlds[0].id, defaultWorldId);
    assert.ok(worlds[0].createdAt);
    assert.equal(worlds[0].lastPlayedAt, worlds[0].createdAt);

    // Seeded mode writes nothing — the app's own lazy seed-on-catch would
    // fire on first read, which this registry-only test doesn't exercise,
    // but the directory itself must exist and be empty of world.json etc.
    const world = registry.getDefault();
    assert.equal(fs.existsSync(world.dataDir), true);
    assert.equal(fs.existsSync(world.paths.characters), false);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe('createWorldRegistry — legacy single-world migration', () => {
  function seedLegacyLayout(rootDir) {
    // Under the renamed { dataRoot } API, dataRoot IS the flat data folder
    // directly (no nested data/ appended) — so legacy artifacts seed right
    // at its top level, matching what a pre-migration install now looks like.
    const dataDir = rootDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'chats'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'characters.json'), JSON.stringify([
      { id: 'ezra', name: 'Ezra Vane', avatarUrl: '/avatars/ezra.png' },
      { id: 'mireille', name: 'Mireille', avatarUrl: null },
    ]));
    fs.writeFileSync(path.join(dataDir, 'places.json'), JSON.stringify([{ id: 'square', name: 'Town Square' }]));
    fs.writeFileSync(path.join(dataDir, 'world.json'), JSON.stringify({ placements: {} }));
    fs.writeFileSync(path.join(dataDir, 'personas.json'), JSON.stringify({
      personas: [{ id: 'p1', name: 'Kael', avatarUrl: '/avatars/personas/p1.png' }],
      activePersonaId: 'p1',
    }));
    fs.writeFileSync(path.join(dataDir, 'chats', 'square.json'), JSON.stringify([{ type: 'system', text: 'You arrive.' }]));

    const avatarsRoot = path.join(rootDir, 'uploads', 'avatars');
    fs.mkdirSync(path.join(avatarsRoot, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(avatarsRoot, 'ezra.png'), 'fake-png-bytes');
    fs.writeFileSync(path.join(avatarsRoot, 'personas', 'p1.png'), 'fake-png-bytes');

    return dataDir;
  }

  test('moves legacy files into a new world dir and rewrites avatar URLs', async () => {
    const rootDir = tempRoot();
    const dataDir = seedLegacyLayout(rootDir);

    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    const { worlds, defaultWorldId } = registry.list();
    assert.equal(worlds.length, 1);
    assert.equal(worlds[0].name, 'My World');
    const world = registry.get(defaultWorldId);

    // Old flat locations are gone.
    assert.equal(fs.existsSync(path.join(dataDir, 'characters.json')), false);
    assert.equal(fs.existsSync(path.join(rootDir, 'uploads', 'avatars', 'ezra.png')), false);

    // New world-scoped locations exist with the same content.
    const chars = JSON.parse(fs.readFileSync(world.paths.characters, 'utf-8'));
    assert.equal(chars.length, 2);
    assert.equal(fs.existsSync(path.join(world.avatarDir, 'ezra.png')), true);
    assert.equal(fs.existsSync(path.join(world.personaAvatarDir, 'p1.png')), true);
    assert.equal(fs.existsSync(path.join(world.chatDir, 'square.json')), true);

    // avatarUrl strings rewritten to the new world-scoped path.
    assert.equal(chars.find((c) => c.id === 'ezra').avatarUrl, `/avatars/${world.id}/ezra.png`);
    assert.equal(chars.find((c) => c.id === 'mireille').avatarUrl, null); // untouched, was already null
    const personas = JSON.parse(fs.readFileSync(world.paths.personas, 'utf-8'));
    assert.equal(personas.personas[0].avatarUrl, `/avatars/${world.id}/personas/p1.png`);
    assert.equal(personas.activePersonaId, 'p1'); // the active pointer survives the move untouched

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('a second init() against the same rootDir does not re-migrate or duplicate worlds', async () => {
    const rootDir = tempRoot();
    seedLegacyLayout(rootDir);

    const first = createWorldRegistry({ dataRoot: rootDir });
    await first.init();
    const idAfterFirst = first.list().defaultWorldId;
    first.closeAll();

    const second = createWorldRegistry({ dataRoot: rootDir });
    await second.init();
    const { worlds, defaultWorldId } = second.list();
    assert.equal(worlds.length, 1);
    assert.equal(defaultWorldId, idAfterFirst);

    second.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe('createWorldRegistry — create()', () => {
  test('mode "empty" writes empty seed files so the app-level lazy seed never fires', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    const entry = await registry.create({ name: 'Blank Slate', mode: 'empty' });
    const world = registry.get(entry.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(world.paths.characters, 'utf-8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(world.paths.places, 'utf-8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(world.paths.world, 'utf-8')), { placements: {} });

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('mode "clone" copies the source world\'s JSON files and rewrites avatar URLs', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    const src = await registry.create({ name: 'Source', mode: 'empty' });
    const srcWorld = registry.get(src.id);
    fs.writeFileSync(srcWorld.paths.characters, JSON.stringify([{ id: 'a', name: 'A', avatarUrl: '/avatars/' + src.id + '/a.png' }]));
    fs.mkdirSync(srcWorld.avatarDir, { recursive: true });
    fs.writeFileSync(path.join(srcWorld.avatarDir, 'a.png'), 'fake-bytes');

    const clone = await registry.create({ name: 'Clone', mode: 'clone', cloneFromId: src.id });
    const cloneWorld = registry.get(clone.id);
    const chars = JSON.parse(fs.readFileSync(cloneWorld.paths.characters, 'utf-8'));
    assert.equal(chars[0].avatarUrl, `/avatars/${clone.id}/a.png`); // rewritten to the NEW world's id
    assert.equal(fs.existsSync(path.join(cloneWorld.avatarDir, 'a.png')), true);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('mode "clone" with includeHistory:false also wipes memory_vectors AND its sqlite-vec shadow tables', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    const src = await registry.create({ name: 'Source', mode: 'empty' });
    const srcWorld = registry.get(src.id);

    const memoryId = 'mem-1';
    const embedding = encodeEmbedding([0.1, 0.2, 0.3, 0.4]);
    srcWorld.db.prepare(`
      INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memoryId, 'p1', 'Something happened.', embedding, null, 1, 'noon', new Date().toISOString());
    srcWorld.db.prepare('INSERT INTO memory_participants (memory_id, character_id) VALUES (?, ?)').run(memoryId, 'a');
    srcWorld.db.prepare('INSERT INTO memory_entries (memory_id, entry_id) VALUES (?, ?)').run(memoryId, 'entry-1');
    upsertMemoryVectors(srcWorld.db, memoryId, ['a'], [embedding]);
    assert.equal(srcWorld.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n, 1);
    // vec0 backs its virtual table with several shadow tables (info/chunks/
    // rowids/vector_chunks*/auxiliary) that a plain DELETE never touches —
    // the source should have them so the clone's absence check means something.
    const srcShadowTables = srcWorld.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory_vectors%'").all();
    assert.ok(srcShadowTables.length > 1, 'expected shadow tables alongside memory_vectors itself');

    const clone = await registry.create({
      name: 'Clone No History', mode: 'clone', cloneFromId: src.id, includeHistory: false,
    });
    const cloneWorld = registry.get(clone.id);

    assert.equal(cloneWorld.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
    assert.equal(cloneWorld.db.prepare('SELECT COUNT(*) AS n FROM memory_participants').get().n, 0);
    assert.equal(cloneWorld.db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n, 0);
    // memory_vectors and every one of its shadow tables should be gone
    // entirely (dropped, not just emptied) — a lingering shadow table is
    // exactly what a plain DELETE FROM memory_vectors leaves behind.
    const cloneShadowTables = cloneWorld.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory_vectors%'").all();
    assert.deepEqual(cloneShadowTables, []);

    // Dropping the table (rather than emptying it) means it doesn't exist at
    // all until the next write — deleting a character's memories in this
    // freshly-cloned world (a real flow: e.g. deleting a character before
    // any new conversation happens) must tolerate that, not crash assuming
    // memory_vectors is present-but-empty like the old DELETE-based wipe left it.
    assert.doesNotThrow(() => deleteAllCharacterMemories(cloneWorld.db, 'a'));

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('rejects a missing or overlong name', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    await assert.rejects(() => registry.create({ name: '  ' }), /name is required/i);
    await assert.rejects(() => registry.create({ name: 'x'.repeat(101) }), /100 characters/i);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe('createWorldRegistry — rename/touch/remove', () => {
  test('rename() updates the name, validates like create()', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();
    const { defaultWorldId } = registry.list();

    const renamed = registry.rename(defaultWorldId, '  New Name  ');
    assert.equal(renamed.name, 'New Name');
    assert.equal(registry.list().worlds[0].name, 'New Name');
    assert.throws(() => registry.rename(defaultWorldId, ''), /name is required/i);
    assert.throws(() => registry.rename('nope', 'X'), /unknown world/i);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('touch() updates lastPlayedAt once, then throttles further calls', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();
    const { defaultWorldId } = registry.list();
    const before = registry.list().worlds[0].lastPlayedAt;

    await new Promise((r) => setTimeout(r, 5));
    registry.touch(defaultWorldId);
    const afterFirst = registry.list().worlds[0].lastPlayedAt;
    assert.notEqual(afterFirst, before);

    await new Promise((r) => setTimeout(r, 5));
    registry.touch(defaultWorldId); // within the throttle window — should be a no-op
    const afterSecond = registry.list().worlds[0].lastPlayedAt;
    assert.equal(afterSecond, afterFirst);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('remove() refuses to delete the only remaining world', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();
    const { defaultWorldId } = registry.list();

    await assert.rejects(() => registry.remove(defaultWorldId), /only world/i);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('remove() deletes a non-default world, closes its db, and the dir is gone', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    const second = await registry.create({ name: 'Second', mode: 'empty' });
    const secondWorld = registry.get(second.id);
    void secondWorld.db; // open the db handle, like a real request would

    const result = await registry.remove(second.id);
    assert.equal(result.defaultWorldId, registry.list().defaultWorldId);
    assert.equal(registry.list().worlds.some((w) => w.id === second.id), false);
    assert.equal(fs.existsSync(path.join(rootDir, 'worlds', second.id)), false);
    assert.equal(registry.get(second.id), null);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('removing the current default world reassigns defaultWorldId to a remaining world', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();
    const originalDefault = registry.list().defaultWorldId;

    const second = await registry.create({ name: 'Second', mode: 'empty' });
    const result = await registry.remove(originalDefault);
    assert.equal(result.defaultWorldId, second.id);
    assert.equal(registry.list().defaultWorldId, second.id);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe('createWorldRegistry — get()', () => {
  test('returns null for an unknown id, never constructs a path from it', async () => {
    const rootDir = tempRoot();
    const registry = createWorldRegistry({ dataRoot: rootDir });
    await registry.init();

    assert.equal(registry.get('../../etc/passwd'), null);
    assert.equal(registry.get(''), null);
    assert.equal(registry.get(undefined), null);

    registry.closeAll();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
