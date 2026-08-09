import fs from 'fs';
import { writeJsonAtomic, warnIfCorrupt } from './jsonStore.js';
import { TIMES_OF_DAY } from './context.js';

// Pending scheduled texts — promises a character made in scene ("I'll text
// you by this afternoon") that the user chose to hold them to via the
// scheduled-text suggestion chip. Each fires as a proactive text (with its
// `reason` as the generation hint) once world time reaches its day/
// timeOfDay — see server.js's fireDueScheduledTexts, hooked into the one
// place world time ever changes (POST /api/world/time), the same spot
// character schedule placements already apply. Not copied on world clone —
// like calls.json, this is transient runtime state, not curated world data
// (it IS included in full-fidelity exports; see worldRegistry.js).
//
// Entry shape: {
//   id,                          // crypto.randomUUID()
//   characterId, characterName,  // who sends it (name denormalized for display)
//   day, timeOfDay,              // when it comes due, in world-clock terms
//   reason,                      // what the text is about — becomes generateProactiveText's hint
//   createdAt,                   // ISO timestamp, display/debugging only
// }

export function loadScheduledTexts(w) {
  try {
    const raw = JSON.parse(fs.readFileSync(w.paths.scheduledTexts, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    warnIfCorrupt(w.paths.scheduledTexts, err);
    return [];
  }
}

export function saveScheduledTexts(w, list) {
  writeJsonAtomic(w.paths.scheduledTexts, list);
}

// Splits pending entries into due-now vs. still-pending against the current
// world time. Tuple comparison on (day, timeOfDay index), due at <= — a
// time jump straight past an entry's slot (advancing several steps, or the
// user setting the day directly) still fires it, just late, rather than
// stranding it forever. Entries with a timeOfDay the enum no longer knows
// count as due (fire, don't strand) — same lenient posture as the rest of
// this app's stored-data handling.
export function splitDueScheduledTexts(list, time) {
  const nowIdx = Math.max(0, TIMES_OF_DAY.indexOf(time.timeOfDay));
  const due = [];
  const remaining = [];
  for (const entry of list) {
    const entryIdx = TIMES_OF_DAY.indexOf(entry.timeOfDay);
    const isDue = entry.day < time.day
      || (entry.day === time.day && (entryIdx === -1 || entryIdx <= nowIdx));
    (isDue ? due : remaining).push(entry);
  }
  return { due, remaining };
}
