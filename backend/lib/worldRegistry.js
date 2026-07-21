import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { openDb, importJsonMemories } from './db.js';
import { logger } from './log.js';

// Each world is a save slot: its own characters/places/world-state/personas/
// presets, its own chat logs, and its own SQLite db (memories/relationships/
// character-embeddings). config.json (API key, model, narrator/memory
// settings) stays global — see server.js. Worlds are resolved per-request
// (an X-World-Id header), never via a server-side "current world" pointer,
// so different browsers/users can be in different worlds at the same time.

const WORLD_JSON_FILES = ['characters.json', 'places.json', 'world.json', 'personas.json', 'presets.json', 'groups.json'];

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Matches "/avatars/<file>" (a pre-worlds legacy URL, no world segment) or
// "/avatars/<any-world-uuid>/<file>" (an already-scoped URL, e.g. the
// source side of a clone) and captures just the "<file>" tail — which may
// itself start with "personas/". Used to re-home a stored avatarUrl onto a
// *different* world id, not just onto its own.
const UUID_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AVATAR_URL_RE = new RegExp(`^/avatars/(?:${UUID_SEGMENT}/)?(.*)$`, 'i');

// A stored avatarUrl like "/avatars/<id>.png" (legacy, pre-migration) or
// "/avatars/<otherWorldId>/<id>.png" (a clone's source world) becomes
// "/avatars/<worldId>/<id>.png" — replacing any existing world segment
// rather than prepending onto it. Idempotent — a URL already scoped to
// this exact worldId round-trips unchanged, so this is safe to call on
// every clone/migration without double-nesting the path.
function rewriteOneAvatarUrl(url, worldId) {
  if (typeof url !== 'string' || !url) return url;
  const match = url.match(AVATAR_URL_RE);
  if (!match) return url;
  return `/avatars/${worldId}/${match[1]}`;
}

function rewriteAvatarUrls(dataDir, worldId) {
  const charsPath = path.join(dataDir, 'characters.json');
  try {
    const chars = JSON.parse(fs.readFileSync(charsPath, 'utf-8'));
    if (Array.isArray(chars)) {
      chars.forEach((c) => { c.avatarUrl = rewriteOneAvatarUrl(c.avatarUrl, worldId); });
      fs.writeFileSync(charsPath, JSON.stringify(chars, null, 2));
    }
  } catch { /* no characters.json yet — nothing to rewrite */ }

  const personasPath = path.join(dataDir, 'personas.json');
  try {
    const data = JSON.parse(fs.readFileSync(personasPath, 'utf-8'));
    if (Array.isArray(data.personas)) {
      data.personas.forEach((p) => { p.avatarUrl = rewriteOneAvatarUrl(p.avatarUrl, worldId); });
      fs.writeFileSync(personasPath, JSON.stringify(data, null, 2));
    }
  } catch { /* no personas.json yet — nothing to rewrite */ }
}

// One-time move of a pre-worlds single-world layout into
// data/worlds/<id>/ (+ uploads/avatars/<id>/), run at most once — the
// caller only invokes this when data/worlds/ doesn't exist yet. Renames,
// not copies: cheap, atomic (same volume), and leaves nothing behind to
// clean up. Returns the new { worlds, defaultWorldId } registry, or null
// if there was no legacy data to migrate (a true fresh install).
function migrateLegacyLayout({ dataRoot, worldsRoot, avatarsRoot }) {
  const legacyArtifacts = [
    'characters.json', 'places.json', 'world.json', 'personas.json', 'presets.json',
    'chats', 'freeroam.db', 'memories', 'memories.imported',
  ].map((f) => path.join(dataRoot, f));
  const hasLegacyAvatars = fs.existsSync(avatarsRoot) && fs.readdirSync(avatarsRoot).length > 0;
  if (!legacyArtifacts.some((p) => fs.existsSync(p)) && !hasLegacyAvatars) return null;

  const id = crypto.randomUUID();
  const dataDir = path.join(worldsRoot, id);
  fs.mkdirSync(dataDir, { recursive: true });
  // Crash marker: if this process dies mid-migration, the next boot sees it
  // and refuses to guess at a repair (the legacy files may be half-moved).
  const marker = path.join(dataDir, '.migrating');
  fs.writeFileSync(marker, String(Date.now()));

  const moves = [
    'characters.json', 'places.json', 'world.json', 'personas.json', 'presets.json',
    'chats', 'freeroam.db', 'freeroam.db-wal', 'freeroam.db-shm', 'memories', 'memories.imported',
  ];
  for (const name of moves) {
    const src = path.join(dataRoot, name);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(dataDir, name));
  }

  // Avatars: the destination (uploads/avatars/<id>) lives inside the
  // source (uploads/avatars) — rename the whole source dir aside first so
  // the move can't nest into itself.
  if (fs.existsSync(avatarsRoot)) {
    const staging = `${avatarsRoot}.migrating`;
    fs.renameSync(avatarsRoot, staging);
    fs.mkdirSync(avatarsRoot, { recursive: true });
    fs.renameSync(staging, path.join(avatarsRoot, id));
  }

  rewriteAvatarUrls(dataDir, id);

  const now = new Date().toISOString();
  const registryData = { worlds: [{ id, name: 'My World', createdAt: now, lastPlayedAt: now }], defaultWorldId: id };
  fs.writeFileSync(path.join(dataRoot, 'worlds.json'), JSON.stringify(registryData, null, 2));

  fs.rmSync(marker, { force: true });
  logger.info('world', `migrated existing single-world data into world ${id} ("My World")`);
  return registryData;
}

export function createWorldRegistry({ rootDir }) {
  const dataRoot = path.join(rootDir, 'data');
  const worldsRoot = path.join(dataRoot, 'worlds');
  const avatarsRoot = path.join(rootDir, 'uploads', 'avatars');
  const registryPath = path.join(dataRoot, 'worlds.json');

  const contexts = new Map(); // worldId -> context object (paths + lazy db)
  const lastTouchAt = new Map(); // worldId -> ms timestamp, throttles lastPlayedAt writes
  let registryData = null; // { worlds: [{id,name,createdAt,lastPlayedAt}], defaultWorldId }

  function loadRegistryFile() {
    try {
      return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  function saveRegistryFile() {
    fs.writeFileSync(registryPath, JSON.stringify(registryData, null, 2));
  }

  // Builds (or returns the cached) context object for a world id. Doesn't
  // validate the id against the registry — callers that accept ids from
  // outside (the header, route params) must check via get()/list() first,
  // which is also what keeps a raw header value from ever being joined
  // into a path unless it's already a known, on-disk world.
  function contextFor(id) {
    if (contexts.has(id)) return contexts.get(id);
    const dataDir = path.join(worldsRoot, id);
    const avatarDir = path.join(avatarsRoot, id);
    const personaAvatarDir = path.join(avatarDir, 'personas');
    const chatDir = path.join(dataDir, 'chats');
    const textsDir = path.join(dataDir, 'texts');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(textsDir, { recursive: true });
    fs.mkdirSync(personaAvatarDir, { recursive: true });

    const ctx = {
      id,
      dataDir,
      chatDir,
      textsDir,
      avatarDir,
      personaAvatarDir,
      avatarUrlBase: `/avatars/${id}`,
      paths: {
        characters: path.join(dataDir, 'characters.json'),
        places: path.join(dataDir, 'places.json'),
        world: path.join(dataDir, 'world.json'),
        personas: path.join(dataDir, 'personas.json'),
        presets: path.join(dataDir, 'presets.json'),
        weather: path.join(dataDir, 'weather.json'),
        calls: path.join(dataDir, 'calls.json'),
        groups: path.join(dataDir, 'groups.json'),
      },
      _db: null,
      get db() {
        if (!this._db) {
          this._db = openDb(path.join(dataDir, 'freeroam.db'));
          importJsonMemories(this._db, path.join(dataDir, 'memories'));
        }
        return this._db;
      },
    };
    contexts.set(id, ctx);
    return ctx;
  }

  function list() {
    return { worlds: registryData.worlds.map((w) => ({ ...w })), defaultWorldId: registryData.defaultWorldId };
  }

  function get(id) {
    if (!id || !registryData.worlds.some((w) => w.id === id)) return null;
    return contextFor(id);
  }

  function getDefault() {
    const id = registryData.worlds.some((w) => w.id === registryData.defaultWorldId)
      ? registryData.defaultWorldId
      : registryData.worlds[0]?.id;
    return id ? contextFor(id) : null;
  }

  // Copies one world's data into a brand-new (already-mkdir'd) world dir.
  // The db is copied via better-sqlite3's backup() API rather than a raw
  // file copy — a plain cpSync of a WAL-mode db can miss writes that
  // haven't been checkpointed yet, silently losing recent memories.
  async function cloneWorldInto(src, dest, includeHistory) {
    for (const file of WORLD_JSON_FILES) {
      const from = path.join(src.dataDir, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest.dataDir, file));
    }

    if (includeHistory && fs.existsSync(src.chatDir)) {
      fs.cpSync(src.chatDir, dest.chatDir, { recursive: true });
    }

    const destDbPath = path.join(dest.dataDir, 'freeroam.db');
    await src.db.backup(destDbPath);
    if (!includeHistory) {
      // Wipe conversation history but keep relationships (curated world
      // data) and character_embeddings (derived from descriptions, not
      // from what happened — both belong to "the world," not "the story").
      const destDb = openDb(destDbPath);
      destDb.exec('DELETE FROM memory_participants; DELETE FROM memory_entries; DELETE FROM memories;');
      destDb.close();
    }

    if (fs.existsSync(src.avatarDir)) {
      fs.cpSync(src.avatarDir, dest.avatarDir, { recursive: true });
    }
    rewriteAvatarUrls(dest.dataDir, dest.id);
  }

  // Builds a new world's on-disk data and returns its registry entry —
  // does NOT touch registryData itself (create()/duplicate() do that),
  // so this stays reusable without ever double-registering a world.
  async function createEntry({ name, mode = 'seeded', cloneFromId, includeHistory = true }) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) throw httpError('A world name is required.', 400);
    if (trimmedName.length > 100) throw httpError('World name must be 100 characters or fewer.', 400);
    if (!['seeded', 'empty', 'clone'].includes(mode)) throw httpError('Invalid world mode.', 400);

    const id = crypto.randomUUID();
    const dest = contextFor(id); // mkdirs chats/avatarDir/personaAvatarDir

    if (mode === 'empty') {
      fs.writeFileSync(dest.paths.characters, '[]');
      fs.writeFileSync(dest.paths.places, '[]');
      fs.writeFileSync(dest.paths.world, JSON.stringify({ placements: {} }));
      // personas.json/presets.json need no seed file — loadPersonas/
      // loadPresets already default to an empty list on a missing file.
    } else if (mode === 'clone') {
      if (!cloneFromId) throw httpError('cloneFromId is required for mode "clone".', 400);
      const src = get(cloneFromId);
      if (!src) throw httpError('Unknown source world id.', 400);
      await cloneWorldInto(src, dest, includeHistory);
    }
    // mode 'seeded': write nothing — the app's existing lazy seed-on-catch
    // (SEED_PLACES / BUILTIN_CHARACTERS / DEFAULT_PLACEMENTS) fires on the
    // first request that reads this world's data.

    const now = new Date().toISOString();
    return { id, name: trimmedName, createdAt: now, lastPlayedAt: now };
  }

  async function create(opts) {
    const entry = await createEntry(opts);
    registryData = loadRegistryFile() || registryData; // guard the one interleave (concurrent POSTs)
    registryData.worlds.push(entry);
    saveRegistryFile();
    return entry;
  }

  async function duplicate(id, { name, includeHistory = true } = {}) {
    const src = registryData.worlds.find((w) => w.id === id);
    if (!src) throw httpError('Unknown world id.', 404);
    return create({ name: name || `${src.name} (copy)`, mode: 'clone', cloneFromId: id, includeHistory });
  }

  function rename(id, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw httpError('A world name is required.', 400);
    if (trimmed.length > 100) throw httpError('World name must be 100 characters or fewer.', 400);
    const entry = registryData.worlds.find((w) => w.id === id);
    if (!entry) throw httpError('Unknown world id.', 404);
    entry.name = trimmed;
    saveRegistryFile();
    return { ...entry };
  }

  // Throttled to ~once/minute per world so a chatty session doesn't rewrite
  // worlds.json on every single request.
  function touch(id) {
    const entry = registryData.worlds.find((w) => w.id === id);
    if (!entry) return;
    const now = Date.now();
    if (now - (lastTouchAt.get(id) || 0) < 60_000) return;
    lastTouchAt.set(id, now);
    entry.lastPlayedAt = new Date(now).toISOString();
    saveRegistryFile();
  }

  async function removeDirWithRetry(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('world', `rmSync(${dir}) failed (${err.message}), retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err2) {
        logger.error('world', `could not remove ${dir} after retry: ${err2.message} — orphaned but inert (already deregistered)`);
      }
    }
  }

  async function remove(id) {
    if (!registryData.worlds.some((w) => w.id === id)) throw httpError('Unknown world id.', 404);
    if (registryData.worlds.length <= 1) throw httpError('Cannot delete the only world.', 400);

    // Deregister (and close the db handle) BEFORE touching the filesystem —
    // new requests 400 immediately, and Windows needs the sqlite handle
    // closed before its file can be deleted.
    const remaining = registryData.worlds.filter((w) => w.id !== id);
    const defaultWorldId = registryData.defaultWorldId === id ? remaining[0].id : registryData.defaultWorldId;
    registryData = { worlds: remaining, defaultWorldId };
    saveRegistryFile();

    const ctx = contexts.get(id);
    if (ctx?._db) { try { ctx._db.close(); } catch { /* already closed */ } }
    contexts.delete(id);

    await removeDirWithRetry(path.join(worldsRoot, id));
    await removeDirWithRetry(path.join(avatarsRoot, id));

    return { defaultWorldId };
  }

  function closeAll() {
    for (const ctx of contexts.values()) {
      if (ctx._db) { try { ctx._db.close(); } catch { /* already closed */ } }
    }
    contexts.clear();
  }

  async function init() {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(avatarsRoot, { recursive: true });

    let migrated = null;
    if (!fs.existsSync(worldsRoot)) {
      fs.mkdirSync(worldsRoot, { recursive: true });
      migrated = migrateLegacyLayout({ dataRoot, worldsRoot, avatarsRoot });
    } else {
      const staleMarkers = fs.readdirSync(worldsRoot)
        .map((id) => path.join(worldsRoot, id, '.migrating'))
        .filter((p) => fs.existsSync(p));
      if (staleMarkers.length) {
        throw new Error(
          `World migration did not finish cleanly (found: ${staleMarkers.join(', ')}). `
          + 'Restore backend/data and backend/uploads from backup before restarting.'
        );
      }
    }

    registryData = migrated || loadRegistryFile() || { worlds: [], defaultWorldId: null };

    if (!registryData.worlds.length) {
      const entry = await createEntry({ name: 'My World', mode: 'seeded' });
      registryData.worlds.push(entry);
      registryData.defaultWorldId = entry.id;
    }
    saveRegistryFile();
  }

  return { init, list, get, getDefault, create, duplicate, rename, touch, remove, closeAll };
}
