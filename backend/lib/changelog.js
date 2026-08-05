import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

// A unit separator (0x1f), not a printable delimiter like '|' — a commit
// subject can contain literally any character, including whatever a naive
// delimiter choice might be. No record separator needed: git's %s (subject)
// is always exactly one line, so one git-log line is one commit.
const FIELD_SEP = '\x1f';

// Reads recent commit subjects straight from the repo's own git log — no
// separate changelog file to keep in sync by hand, so it can never drift
// from what actually shipped. Requires the deployed copy to still have its
// .git directory (true for the normal "git clone and run" self-hosted setup
// this app assumes); a stripped export with no git history just gets an
// empty changelog back, not an error — same "degrade quietly" philosophy
// the rest of this app uses for optional/environment-dependent features.
export function readChangelog({ limit = 200, cwd = REPO_ROOT } = {}) {
  let raw;
  try {
    raw = execFileSync('git', [
      'log', `-n${limit}`, '--no-merges',
      `--pretty=format:%H${FIELD_SEP}%ad${FIELD_SEP}%s`,
      '--date=short',
    ], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    return [];
  }

  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, date, subject] = line.split(FIELD_SEP);
    return { hash, date, subject };
  });
}
