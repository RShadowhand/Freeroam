// Leveled, categorized console logging. Level comes from the FREEROAM_LOG
// env var (error | warn | info | debug), defaulting to info. Categories tag
// each line so specific subsystems can be grepped while debugging:
//   llm     — outbound completion requests (debug adds the full payload)
//   embed   — embedding computations
//   memory  — memory hits / records / updates / deletes
//   chat    — chat log mutations
//   suggest — suggested-action detection (regex/ML), NER + intent-classifier results
// debug is the "verbose mode": full request payloads, retrieval hit lists,
// and per-call embedding traces all land there.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = LEVELS[(process.env.FREEROAM_LOG || 'info').toLowerCase()];
if (threshold === undefined) threshold = LEVELS.info;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function emit(level, category, message, extra) {
  if (LEVELS[level] > threshold) return;
  const line = `[${stamp()}] [${category}] ${level}: ${message}`;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](line);
  if (extra !== undefined && threshold >= LEVELS.debug) {
    console[method](typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
  }
}

export const logger = {
  error: (category, message, extra) => emit('error', category, message, extra),
  warn: (category, message, extra) => emit('warn', category, message, extra),
  info: (category, message, extra) => emit('info', category, message, extra),
  debug: (category, message, extra) => emit('debug', category, message, extra),
  // Test hook: silence or adjust at runtime.
  setLevel(level) { if (LEVELS[level] !== undefined) threshold = LEVELS[level]; },
};
