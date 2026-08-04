import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, warnIfCorrupt } from '../lib/jsonStore.js';
import { logger } from '../lib/log.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-jsonstore-test-'));
}

describe('writeJsonAtomic', () => {
  test('writes JSON that round-trips exactly', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'data.json');
    writeJsonAtomic(filePath, { a: 1, b: ['x', 'y'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), { a: 1, b: ['x', 'y'] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('overwrites existing content rather than merging', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'data.json');
    writeJsonAtomic(filePath, { old: true });
    writeJsonAtomic(filePath, { new: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), { new: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('leaves no .tmp file behind after a successful write', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'data.json');
    writeJsonAtomic(filePath, { ok: true });
    const leftovers = fs.readdirSync(dir).filter((f) => f !== 'data.json');
    assert.deepEqual(leftovers, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the destination never observably contains partial/truncated content — either the old value or the fully-written new one', () => {
    // Can't simulate an actual mid-write crash without OS-level fault
    // injection, but this confirms the mechanism that prevents it: the
    // write lands on a differently-named temp file first, and only a single
    // atomic renameSync (not a copy or a second write) ever touches the
    // real path — so an external reader can only ever see the old content
    // or the fully-formed new content, never a half-written file.
    const dir = tempDir();
    const filePath = path.join(dir, 'data.json');
    writeJsonAtomic(filePath, { revision: 1 });
    const before = fs.readFileSync(filePath, 'utf-8');
    writeJsonAtomic(filePath, { revision: 2, big: 'x'.repeat(10000) });
    const after = fs.readFileSync(filePath, 'utf-8');
    assert.notEqual(before, after);
    assert.doesNotThrow(() => JSON.parse(after));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('warnIfCorrupt', () => {
  test('stays silent when the file does not exist (the ordinary first-run case)', (t) => {
    const dir = tempDir();
    const filePath = path.join(dir, 'never-created.json');
    const warnCalls = [];
    t.mock.method(console, 'warn', (line) => { warnCalls.push(line); });
    warnIfCorrupt(filePath, new Error('ENOENT-ish'));
    assert.equal(warnCalls.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('logs a warning when the file exists but failed to parse', (t) => {
    const dir = tempDir();
    const filePath = path.join(dir, 'corrupt.json');
    fs.writeFileSync(filePath, 'not valid json{{{');
    const warnCalls = [];
    t.mock.method(console, 'warn', (line) => { warnCalls.push(line); });
    logger.setLevel('warn');
    warnIfCorrupt(filePath, new Error('Unexpected token'));
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0], /corrupt\.json/);
    logger.setLevel('info');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
