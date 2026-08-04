import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './log.js';

// Writes JSON atomically: to a temp file in the same directory, then
// renameSync over the real path. A crash/kill mid-write leaves the temp
// file orphaned — since its name is freshly randomized per call, a later
// write never reuses or cleans it up, so it just lingers on disk — but that
// cost is trivial and it's still strictly better than a plain writeFileSync
// truncating the real file if the process dies partway through.
export function writeJsonAtomic(filePath, data) {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// Call from inside an existing catch {} block whose try body was
// `JSON.parse(fs.readFileSync(filePath, 'utf-8'))` — logs a warning only
// when the file actually exists (a real parse/corruption failure, worth
// knowing about) rather than every time, since a missing file is the
// ordinary first-run/not-yet-created case every load already falls back
// for silently.
export function warnIfCorrupt(filePath, err) {
  if (fs.existsSync(filePath)) {
    logger.warn('io', `${filePath} exists but could not be read/parsed, falling back to defaults: ${err.message}`);
  }
}
