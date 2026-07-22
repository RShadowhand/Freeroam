import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { WORLD_EXPORT_FILES, rewriteAvatarUrls } from './worldRegistry.js';
import { dumpMemoriesForExport, restoreMemoriesFromExport } from './db.js';

// Whole-world export/import — a full-fidelity backup/restore (zip bundle),
// distinct in intent from cloneWorldInto (worldRegistry.js), which only
// branches a variant within the same install and never needs to leave the
// filesystem. Bundle layout:
//   <WORLD_EXPORT_FILES entries>  characters.json, places.json, etc.
//   chats/**, texts/**            (only when includeHistory)
//   avatars/**
//   db.json                       dumpMemoriesForExport(w.db) — see db.js
//   manifest.json                 { formatVersion, exportedAt, worldName, includeHistory, embeddingModel }
const FORMAT_VERSION = 1;

function addDirToZip(zip, dir, zipPrefix) {
  if (!fs.existsSync(dir)) return;
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const zipPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, zipPath);
      else zip.file(zipPath, fs.readFileSync(full));
    }
  };
  walk(dir, zipPrefix);
}

export async function buildWorldExportBundle(w, { includeHistory = true, worldName = '', embeddingModel = null } = {}) {
  const zip = new JSZip();

  for (const file of WORLD_EXPORT_FILES) {
    const from = path.join(w.dataDir, file);
    if (fs.existsSync(from)) zip.file(file, fs.readFileSync(from));
  }

  if (includeHistory) {
    addDirToZip(zip, w.chatDir, 'chats');
    addDirToZip(zip, w.textsDir, 'texts');
  }
  addDirToZip(zip, w.avatarDir, 'avatars');

  zip.file('db.json', JSON.stringify(dumpMemoriesForExport(w.db)));
  zip.file('manifest.json', JSON.stringify({
    formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), worldName, includeHistory, embeddingModel,
  }));

  return zip.generateAsync({ type: 'nodebuffer' });
}

// Extracts a subtree of the zip (every entry under `zipPrefix/`) into
// `destDir` on disk. Uses zip.forEach + a manual prefix check rather than
// JSZip's folder()/file(regex) helpers, whose relative-path semantics for
// nested folders aren't precisely documented — this is unambiguous.
async function restoreDirFromZip(zip, zipPrefix, destDir) {
  const jobs = [];
  zip.forEach((relPath, file) => {
    if (file.dir || !relPath.startsWith(`${zipPrefix}/`)) return;
    const rel = relPath.slice(zipPrefix.length + 1);
    jobs.push(file.async('nodebuffer').then((buf) => {
      const target = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
    }));
  });
  await Promise.all(jobs);
}

// Reads just manifest.json out of a bundle without touching the filesystem —
// used to resolve a default world name before the caller creates the
// destination world (import needs a name up front; the bundle's own name is
// only known after opening it).
export async function peekManifest(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const manifestFile = zip.file('manifest.json');
  return manifestFile ? JSON.parse(await manifestFile.async('string')) : {};
}

// Imports a bundle built by buildWorldExportBundle into `dest` — a
// brand-new, already-created empty world context (from
// registry.create({ mode: 'empty' })), never an existing/populated one; this
// overwrites files, it doesn't merge. Only handles files + the raw db dump —
// relationships/character_embeddings re-embedding is the caller's job (it
// needs the live embed function, a server.js-level concern this module
// deliberately doesn't import). Returns { manifest, warnings }.
export async function importWorldBundle(zipBuffer, dest) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const warnings = [];

  const manifestFile = zip.file('manifest.json');
  const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : {};
  if (!manifestFile) warnings.push('No manifest.json found in the bundle — this may not be a Freeroam world export.');

  for (const file of WORLD_EXPORT_FILES) {
    const entry = zip.file(file);
    if (entry) fs.writeFileSync(path.join(dest.dataDir, file), await entry.async('nodebuffer'));
  }

  await restoreDirFromZip(zip, 'chats', dest.chatDir);
  await restoreDirFromZip(zip, 'texts', dest.textsDir);
  await restoreDirFromZip(zip, 'avatars', dest.avatarDir);
  rewriteAvatarUrls(dest.dataDir, dest.id);

  const dbFile = zip.file('db.json');
  if (dbFile) {
    restoreMemoriesFromExport(dest.db, JSON.parse(await dbFile.async('string')));
  }

  return { manifest, warnings };
}
