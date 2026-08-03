import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldRegistry } from '../lib/worldRegistry.js';
import { relocateDataRoot, consolidatePerWorldExtras } from '../lib/externalDataRoot.js';
import { logger } from '../lib/log.js';

logger.setLevel('error'); // keep test output clean

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-extdata-test-'));
}

describe('relocateDataRoot', () => {
  test('moves backend/data, backend/uploads, and backend/config.json to the new dataRoot', () => {
    const backendDir = tempRoot();
    const dataRoot = path.join(backendDir, '..', 'external-data');
    fs.mkdirSync(path.join(backendDir, 'data', 'worlds'), { recursive: true });
    fs.writeFileSync(path.join(backendDir, 'data', 'worlds.json'), '{"worlds":[]}');
    fs.mkdirSync(path.join(backendDir, 'uploads', 'avatars'), { recursive: true });
    fs.writeFileSync(path.join(backendDir, 'config.json'), '{"apiKey":"x"}');

    relocateDataRoot({ backendDir, dataRoot });

    assert.equal(fs.existsSync(path.join(backendDir, 'data')), false);
    assert.equal(fs.existsSync(path.join(backendDir, 'uploads')), false);
    assert.equal(fs.existsSync(path.join(backendDir, 'config.json')), false);
    assert.equal(fs.readFileSync(path.join(dataRoot, 'worlds.json'), 'utf-8'), '{"worlds":[]}');
    assert.equal(fs.existsSync(path.join(dataRoot, 'uploads', 'avatars')), true);
    assert.equal(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf-8'), '{"apiKey":"x"}');

    fs.rmSync(backendDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  test('is a no-op when nothing is left at the old backend-local locations', () => {
    const backendDir = tempRoot();
    const dataRoot = path.join(backendDir, '..', 'external-data-2');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'worlds.json'), '{"worlds":[]}');

    assert.doesNotThrow(() => relocateDataRoot({ backendDir, dataRoot }));
    assert.equal(fs.readFileSync(path.join(dataRoot, 'worlds.json'), 'utf-8'), '{"worlds":[]}');

    fs.rmSync(backendDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
});

describe('consolidatePerWorldExtras', () => {
  test('folds legacy uploads/avatars/<id> into each world\'s own avatarDir, merging into the personas subfolder contextFor already created', async () => {
    const dataRoot = tempRoot();
    const registry = createWorldRegistry({ dataRoot });
    await registry.init();
    const { defaultWorldId } = registry.list();

    // Seed a legacy per-world avatar tree — includes a top-level file AND a
    // "personas" subfolder, since registry.get() below (called internally by
    // consolidatePerWorldExtras) will have already mkdir'd an EMPTY
    // avatars/personas for this world via contextFor — the exact collision
    // that broke a plain renameSync of the whole directory on Windows.
    const legacySrc = path.join(dataRoot, 'uploads', 'avatars', defaultWorldId);
    fs.mkdirSync(path.join(legacySrc, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(legacySrc, 'char.png'), 'char-bytes');
    fs.writeFileSync(path.join(legacySrc, 'personas', 'p1.png'), 'persona-bytes');

    consolidatePerWorldExtras({ registry, dataRoot });

    const world = registry.get(defaultWorldId);
    assert.equal(fs.readFileSync(path.join(world.avatarDir, 'char.png'), 'utf-8'), 'char-bytes');
    assert.equal(fs.readFileSync(path.join(world.personaAvatarDir, 'p1.png'), 'utf-8'), 'persona-bytes');
    assert.equal(fs.existsSync(path.join(dataRoot, 'uploads')), false);

    registry.closeAll();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  test('merges per-world presets.json files into one global presets.json, deduping by id and preferring the default world\'s active pointer', async () => {
    const dataRoot = tempRoot();
    const registry = createWorldRegistry({ dataRoot });
    await registry.init();
    const { defaultWorldId } = registry.list();
    const other = await registry.create({ name: 'Other', mode: 'empty' });

    const defaultWorld = registry.get(defaultWorldId);
    const otherWorld = registry.get(other.id);
    const presetA = { id: 'preset-a', name: 'A', prompts: [] };
    const presetB = { id: 'preset-b', name: 'B', prompts: [] };
    fs.writeFileSync(path.join(defaultWorld.dataDir, 'presets.json'),
      JSON.stringify({ presets: [presetA], activePresetId: 'preset-a' }));
    fs.writeFileSync(path.join(otherWorld.dataDir, 'presets.json'),
      JSON.stringify({ presets: [presetB], activePresetId: 'preset-b' }));

    consolidatePerWorldExtras({ registry, dataRoot });

    const merged = JSON.parse(fs.readFileSync(path.join(dataRoot, 'presets.json'), 'utf-8'));
    assert.equal(merged.presets.length, 2);
    assert.deepEqual(merged.presets.map((p) => p.id).sort(), ['preset-a', 'preset-b']);
    assert.equal(merged.activePresetId, 'preset-a'); // the default world's own active pointer wins
    assert.equal(fs.existsSync(path.join(defaultWorld.dataDir, 'presets.json')), false);
    assert.equal(fs.existsSync(path.join(otherWorld.dataDir, 'presets.json')), false);

    registry.closeAll();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  test('is idempotent — a second call is a no-op once global presets.json already exists', async () => {
    const dataRoot = tempRoot();
    const registry = createWorldRegistry({ dataRoot });
    await registry.init();
    const { defaultWorldId } = registry.list();
    const world = registry.get(defaultWorldId);
    fs.writeFileSync(path.join(world.dataDir, 'presets.json'),
      JSON.stringify({ presets: [{ id: 'p1', name: 'P1', prompts: [] }], activePresetId: 'p1' }));

    consolidatePerWorldExtras({ registry, dataRoot }); // first call: consolidates
    const afterFirst = fs.readFileSync(path.join(dataRoot, 'presets.json'), 'utf-8');

    // A leftover per-world presets.json appearing after global consolidation
    // (e.g. from an old backup) must NOT be picked up on a second run.
    fs.writeFileSync(path.join(world.dataDir, 'presets.json'),
      JSON.stringify({ presets: [{ id: 'stale', name: 'Stale', prompts: [] }], activePresetId: 'stale' }));

    assert.doesNotThrow(() => consolidatePerWorldExtras({ registry, dataRoot }));
    const afterSecond = fs.readFileSync(path.join(dataRoot, 'presets.json'), 'utf-8');
    assert.equal(afterSecond, afterFirst);

    registry.closeAll();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  test('skips presets consolidation cleanly when no world ever had a presets.json (fresh install)', async () => {
    const dataRoot = tempRoot();
    const registry = createWorldRegistry({ dataRoot });
    await registry.init();

    assert.doesNotThrow(() => consolidatePerWorldExtras({ registry, dataRoot }));
    assert.equal(fs.existsSync(path.join(dataRoot, 'presets.json')), false);

    registry.closeAll();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
});
