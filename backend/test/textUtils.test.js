import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinNames, colorForId, characterAliases, characterMentionedIn, firstMentionedCharacter, orderByMentionIn,
} from '../lib/textUtils.js';

describe('joinNames', () => {
  test('handles 0/1/2/3+ names', () => {
    assert.equal(joinNames([]), '');
    assert.equal(joinNames(['Ezra']), 'Ezra');
    assert.equal(joinNames(['Ezra', 'Mireille']), 'Ezra and Mireille');
    assert.equal(joinNames(['Ezra', 'Mireille', 'Soot']), 'Ezra, Mireille, and Soot');
  });
});

describe('colorForId', () => {
  test('is deterministic for the same id', () => {
    assert.equal(colorForId('ezra'), colorForId('ezra'));
  });
  test('differs for different ids (not guaranteed, but true for these)', () => {
    assert.notEqual(colorForId('ezra'), colorForId('mireille'));
  });
});

describe('characterAliases', () => {
  test('includes the full name and first name', () => {
    const aliases = characterAliases({ name: 'Ezra Vane', nicknames: [] });
    assert.deepEqual(aliases, ['Ezra Vane', 'Ezra']);
  });

  test('a single-word name is not duplicated', () => {
    assert.deepEqual(characterAliases({ name: 'Soot', nicknames: [] }), ['Soot']);
  });

  test('includes nicknames, deduped and blank-filtered', () => {
    const aliases = characterAliases({ name: 'Ezra Vane', nicknames: ['Vane', '  ', 'Ez', 'Ezra'] });
    assert.deepEqual(aliases, ['Ezra Vane', 'Ezra', 'Vane', 'Ez']);
  });

  test('missing nicknames field is treated as none', () => {
    assert.deepEqual(characterAliases({ name: 'Soot' }), ['Soot']);
  });
});

describe('characterMentionedIn', () => {
  test('matches the full name, whole-word, case-insensitive', () => {
    assert.ok(characterMentionedIn('good little KITTY, Soot!', { name: 'Soot', nicknames: [] }));
  });

  test('matches a nickname even when the full name is absent', () => {
    assert.ok(characterMentionedIn('hey Vane, over here', { name: 'Ezra Vane', nicknames: ['Vane'] }));
  });

  test('does not match a name that only appears as a substring of another word', () => {
    assert.equal(characterMentionedIn('Sooty smoke filled the room', { name: 'Soot', nicknames: [] }), false);
  });

  test('a name with regex-special characters does not throw and matches literally', () => {
    assert.ok(characterMentionedIn('Dr. Vane (Ret.) walked in', { name: 'Dr. Vane (Ret.)', nicknames: [] }));
  });

  test('returns false when nothing matches', () => {
    assert.equal(characterMentionedIn('nothing relevant here', { name: 'Soot', nicknames: ['Sooty'] }), false);
  });
});

describe('firstMentionedCharacter', () => {
  const soot = { id: 'soot', name: 'Soot', nicknames: [] };
  const erza = { id: 'erza', name: 'Erza', nicknames: [] };

  test('returns the earliest-mentioned character, not just the first in the list', () => {
    const text = '*pets Soot* good little kitty *then turns to look at Erza*';
    assert.equal(firstMentionedCharacter(text, [erza, soot]).id, 'soot');
  });

  test('returns null when none of the characters are mentioned', () => {
    assert.equal(firstMentionedCharacter('a quiet moment passes', [soot, erza]), null);
  });

  test('matches by nickname', () => {
    const vane = { id: 'ezra', name: 'Ezra Vane', nicknames: ['Vane'] };
    assert.equal(firstMentionedCharacter('Vane, you around?', [vane]).id, 'ezra');
  });
});

describe('orderByMentionIn', () => {
  const soot = { id: 'soot', name: 'Soot', nicknames: [] };
  const erza = { id: 'erza', name: 'Erza', nicknames: [] };
  const dara = { id: 'dara', name: 'Dara', nicknames: [] };

  test('mentioned characters come first, in mention order', () => {
    const text = '*pets Soot* good little kitty *then turns to look at Erza* left the book over there';
    const ordered = orderByMentionIn(text, [erza, soot, dara]).map((c) => c.id);
    assert.deepEqual(ordered, ['soot', 'erza', 'dara']);
  });

  test('unmentioned characters keep their original relative order, at the end', () => {
    const ordered = orderByMentionIn('hey Dara', [soot, erza, dara]).map((c) => c.id);
    assert.deepEqual(ordered, ['dara', 'soot', 'erza']);
  });

  test('with no mentions at all, the original order is preserved exactly', () => {
    const ordered = orderByMentionIn('nothing relevant here', [soot, erza, dara]).map((c) => c.id);
    assert.deepEqual(ordered, ['soot', 'erza', 'dara']);
  });

  test('an empty character list returns an empty array', () => {
    assert.deepEqual(orderByMentionIn('hey Soot', []), []);
  });
});
