import fs from 'fs';
import crypto from 'crypto';
import { writeJsonAtomic, warnIfCorrupt } from './jsonStore.js';

// Group text conversations: { id, name, participantIds, createdAt }. Curated
// authoring data (who's in the group, its name) — copied on world clone like
// characters/places, unlike weather.json/calls.json which are runtime state.
// Message history lives separately under w.textsDir/<groupId>.json, same
// generic log-file mechanism 1-on-1 texting (Phase 2) already uses, just
// keyed by group id instead of character id.

export function loadGroups(w) {
  try {
    return JSON.parse(fs.readFileSync(w.paths.groups, 'utf-8'));
  } catch (err) {
    warnIfCorrupt(w.paths.groups, err);
    return [];
  }
}

export function saveGroups(w, groups) {
  writeJsonAtomic(w.paths.groups, groups);
}

export function createGroup(groups, { name, participantIds }) {
  const group = {
    id: crypto.randomUUID(),
    name: name.trim(),
    participantIds: [...new Set(participantIds)],
    createdAt: new Date().toISOString(),
  };
  return { groups: [...groups, group], group };
}
