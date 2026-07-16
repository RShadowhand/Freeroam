import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChatLog, saveChatLog, appendChatEntries, deleteChatLog } from '../lib/chatStore.js';
import { parseReplyLines } from '../lib/context.js';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-chat-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('chatStore', () => {
  test('loadChatLog returns [] for a place with no log yet', () => withTempDir((dir) => {
    assert.deepEqual(loadChatLog(dir, 'town-square'), []);
  }));

  test('appendChatEntries creates the file and returns the full log', () => withTempDir((dir) => {
    const log = appendChatEntries(dir, 'town-square', [{ type: 'system', text: 'You arrive.' }]);
    assert.equal(log.length, 1);
    assert.deepEqual(loadChatLog(dir, 'town-square'), log);
  }));

  test('appendChatEntries assigns a stable id to entries that lack one', () => withTempDir((dir) => {
    const log = appendChatEntries(dir, 'town-square', [
      { type: 'system', text: 'You arrive.' },
      { type: 'char', charId: 'ezra', name: 'Ezra', text: 'Hm.', id: 'pre-set-id' },
    ]);
    assert.ok(log[0].id); // generated
    assert.equal(log[1].id, 'pre-set-id'); // preserved
    assert.deepEqual(loadChatLog(dir, 'town-square').map((e) => e.id), log.map((e) => e.id));
  }));

  test('appendChatEntries accumulates across calls in order', () => withTempDir((dir) => {
    appendChatEntries(dir, 'town-square', [{ type: 'system', text: 'You arrive.' }]);
    appendChatEntries(dir, 'town-square', [{ type: 'user', text: 'Hello?' }, { type: 'char', charId: 'ezra', name: 'Ezra', text: 'Ah.' }]);
    const log = loadChatLog(dir, 'town-square');
    assert.deepEqual(log.map((e) => e.type), ['system', 'user', 'char']);
  }));

  test('logs are isolated per place', () => withTempDir((dir) => {
    appendChatEntries(dir, 'town-square', [{ type: 'user', text: 'In the square.' }]);
    appendChatEntries(dir, 'greenhouse', [{ type: 'user', text: 'In the greenhouse.' }]);
    assert.equal(loadChatLog(dir, 'town-square').length, 1);
    assert.equal(loadChatLog(dir, 'greenhouse').length, 1);
    assert.equal(loadChatLog(dir, 'town-square')[0].text, 'In the square.');
  }));

  test('deleteChatLog removes the log; deleting a nonexistent one is a no-op', () => withTempDir((dir) => {
    appendChatEntries(dir, 'town-square', [{ type: 'user', text: 'Hi.' }]);
    deleteChatLog(dir, 'town-square');
    assert.deepEqual(loadChatLog(dir, 'town-square'), []);
    deleteChatLog(dir, 'never-existed'); // must not throw
  }));

  test('saveChatLog overwrites wholesale', () => withTempDir((dir) => {
    appendChatEntries(dir, 'town-square', [{ type: 'user', text: 'Old.' }]);
    saveChatLog(dir, 'town-square', [{ type: 'system', text: 'Fresh start.' }]);
    const log = loadChatLog(dir, 'town-square');
    assert.equal(log.length, 1);
    assert.equal(log[0].text, 'Fresh start.');
  }));
});

describe('parseReplyLines', () => {
  const present = [
    { id: 'ezra', name: 'Ezra Vane' },
    { id: 'mireille', name: 'Mireille' },
  ];

  test('attributes lines to present characters by full name or first name', () => {
    const entries = parseReplyLines('Ezra Vane: Records, always.\nMireille: The ferns agree.', present);
    assert.deepEqual(entries.map((e) => e.charId), ['ezra', 'mireille']);
    assert.equal(entries[0].text, 'Records, always.');
  });

  test('first-name-only labels resolve', () => {
    const [entry] = parseReplyLines('Ezra: Hm.', present);
    assert.equal(entry.charId, 'ezra');
    assert.equal(entry.name, 'Ezra Vane'); // canonical name, not the label used
  });

  test('an unrecognized speaker becomes an NPC entry, not a misattribution', () => {
    const [entry] = parseReplyLines('The Lamplighter: Mind the wick.', present);
    assert.equal(entry.isNPC, true);
    assert.equal(entry.charId, null);
    assert.equal(entry.name, 'The Lamplighter');
  });

  test('a format-breaking line falls back to the first present character', () => {
    const [entry] = parseReplyLines('*a long silence*', present);
    assert.equal(entry.charId, 'ezra');
  });

  test('empty reply produces a single error entry', () => {
    const entries = parseReplyLines('   ', present);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'error');
  });

  test('name matching is case-insensitive', () => {
    const [entry] = parseReplyLines('ezra vane: Indeed.', present);
    assert.equal(entry.charId, 'ezra');
  });
});
