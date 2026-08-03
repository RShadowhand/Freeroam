import fs from 'fs';
import path from 'path';

// One-time, automatic move of backend-local runtime data (data/, uploads/,
// config.json) out to an external data root (repo-root/data by default —
// see server.js's DATA_ROOT), plus folding the old separate uploads/avatars
// tree into each world's own folder and consolidating what used to be
// per-world presets.json files into one global data/presets.json.
//
// Both functions below are skipped entirely when FREEROAM_TEST_ROOT is set
// (see server.js) — the test suite must never touch real backend/data, and
// relocateDataRoot's source paths are intentionally hardcoded relative to
// the real backend directory, never respecting that env override, so the
// guard at the call site is a hard safety requirement, not a nicety.

// Purely mechanical — moves backend/data, backend/uploads, and
// backend/config.json to the new external root, with no semantic changes
// to their contents. Each check is independently idempotent (a prior
// successful run leaves nothing at the source), so a crash partway through
// just leaves the remaining steps to run on next boot — no marker file
// needed.
export function relocateDataRoot({ backendDir, dataRoot }) {
  const oldData = path.join(backendDir, 'data');
  const oldUploads = path.join(backendDir, 'uploads');
  const oldConfig = path.join(backendDir, 'config.json');

  if (fs.existsSync(oldData)) {
    fs.mkdirSync(path.dirname(dataRoot), { recursive: true });
    fs.renameSync(oldData, dataRoot);
  }
  if (fs.existsSync(oldUploads)) {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.renameSync(oldUploads, path.join(dataRoot, 'uploads'));
  }
  if (fs.existsSync(oldConfig)) {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.renameSync(oldConfig, path.join(dataRoot, 'config.json'));
  }
}

// Run after registry.init() — needs the world list to know which per-world
// folders exist. Folds any leftover uploads/avatars/<worldId> (staged by
// relocateDataRoot above) into that world's own avatarDir, then merges any
// leftover per-world presets.json files (from before presets became
// global) into one data/presets.json.
export function consolidatePerWorldExtras({ registry, dataRoot }) {
  const legacyAvatarsRoot = path.join(dataRoot, 'uploads', 'avatars');
  const { worlds, defaultWorldId } = registry.list();

  if (fs.existsSync(legacyAvatarsRoot)) {
    for (const { id } of worlds) {
      const src = path.join(legacyAvatarsRoot, id);
      if (!fs.existsSync(src)) continue;
      // registry.get() lazily provisions this world's context, which itself
      // mkdirs avatarDir/personaAvatarDir (e.g. an empty "personas" folder)
      // — so the destination already exists by the time we get here, and a
      // straight renameSync of the whole src dir onto it fails on Windows
      // (renaming onto an existing directory isn't allowed). Move contents
      // instead, merging into whatever contextFor already created.
      const world = registry.get(id);
      fs.mkdirSync(world.avatarDir, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        const from = path.join(src, entry);
        const to = path.join(world.avatarDir, entry);
        if (fs.existsSync(to) && fs.statSync(from).isDirectory()) {
          // e.g. "personas" — dest already exists (empty, from contextFor), merge contents
          for (const inner of fs.readdirSync(from)) {
            fs.renameSync(path.join(from, inner), path.join(to, inner));
          }
          fs.rmSync(from, { recursive: true, force: true });
        } else {
          fs.rmSync(to, { force: true });
          fs.renameSync(from, to);
        }
      }
      fs.rmSync(src, { recursive: true, force: true });
    }
    fs.rmSync(path.join(dataRoot, 'uploads'), { recursive: true, force: true });
  }

  const globalPresetsPath = path.join(dataRoot, 'presets.json');
  if (fs.existsSync(globalPresetsPath)) return; // already consolidated — idempotent

  const mergedPresets = [];
  const seenIds = new Set();
  let activePresetId = null;
  let defaultWorldActivePresetId = null;
  let foundAny = false;

  for (const { id } of worlds) {
    const perWorldPath = path.join(dataRoot, 'worlds', id, 'presets.json');
    if (!fs.existsSync(perWorldPath)) continue;
    foundAny = true;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(perWorldPath, 'utf-8'));
    } catch {
      fs.rmSync(perWorldPath, { force: true });
      continue;
    }
    (data.presets || []).forEach((p) => {
      if (seenIds.has(p.id)) return; // ids are crypto.randomUUID() — collision across worlds isn't expected, but stay safe
      seenIds.add(p.id);
      mergedPresets.push(p);
      if (activePresetId === null) activePresetId = p.id; // fallback: first migrated preset
    });
    if (id === defaultWorldId && data.activePresetId) defaultWorldActivePresetId = data.activePresetId;
    fs.rmSync(perWorldPath, { force: true });
  }

  if (!foundAny) return; // nothing to migrate — a fresh/empty-presets install
  if (defaultWorldActivePresetId && seenIds.has(defaultWorldActivePresetId)) {
    activePresetId = defaultWorldActivePresetId; // prefer the default world's own active pointer
  }

  fs.writeFileSync(globalPresetsPath, JSON.stringify({ presets: mergedPresets, activePresetId }, null, 2));
}
