import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Persisted per-place chat logs — one JSON file per place under
// data/chats/<placeId>.json. Place ids are slugs (or UUIDs), so they're
// filename-safe as-is. A log is an ordered array of entries in the same
// shape the frontend renders: { type: 'system'|'user'|'char', text, ... }.

function chatFilePath(chatDir, placeId) {
  return path.join(chatDir, `${placeId}.json`);
}

export function loadChatLog(chatDir, placeId) {
  try {
    return JSON.parse(fs.readFileSync(chatFilePath(chatDir, placeId), 'utf-8'));
  } catch {
    return [];
  }
}

export function saveChatLog(chatDir, placeId, log) {
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(chatFilePath(chatDir, placeId), JSON.stringify(log, null, 2));
}

// Entries get a stable id on append (unless they already carry one) so
// they can be referenced later — e.g. by the regenerate-message route.
export function appendChatEntries(chatDir, placeId, entries) {
  const log = loadChatLog(chatDir, placeId);
  entries.forEach((e) => { if (!e.id) e.id = crypto.randomUUID(); });
  log.push(...entries);
  saveChatLog(chatDir, placeId, log);
  return log;
}

export function deleteChatLog(chatDir, placeId) {
  fs.rmSync(chatFilePath(chatDir, placeId), { force: true });
}
