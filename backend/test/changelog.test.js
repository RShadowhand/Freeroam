import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { readChangelog } from '../lib/changelog.js';

describe('readChangelog', () => {
  test('reads real entries from this repo\'s own git history', () => {
    const entries = readChangelog();
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length > 0, 'this repo has real commit history — expected at least one entry');

    for (const entry of entries) {
      assert.match(entry.hash, /^[0-9a-f]{40}$/, 'hash should be a full 40-char SHA');
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, 'date should be YYYY-MM-DD');
      assert.equal(typeof entry.subject, 'string');
      assert.ok(entry.subject.length > 0, 'subject should never be empty');
    }
  });

  test('entries come back newest-first (non-increasing dates)', () => {
    const entries = readChangelog();
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1].date >= entries[i].date, `expected ${entries[i - 1].date} >= ${entries[i].date} at index ${i}`);
    }
  });

  test('limit caps the number of returned entries', () => {
    const all = readChangelog({ limit: 1000 });
    assert.ok(all.length > 3, 'expected more than 3 real commits to make this test meaningful');
    const limited = readChangelog({ limit: 3 });
    assert.equal(limited.length, 3);
    // The limited set should be exactly the 3 newest, not an arbitrary slice.
    assert.deepEqual(limited, all.slice(0, 3));
  });

  test('a directory with no git history returns an empty array, not a throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-no-git-'));
    try {
      assert.deepEqual(readChangelog({ cwd: tmpDir }), []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
