import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntents, extractJsonLenient, buildIntentPrompt, TIMES_OF_DAY } from '../lib/llmSuggestedActions.js';

const places = [
  { id: 'p1', name: 'Market Square' },
  { id: 'p2', name: 'The Rusty Anchor' },
];
const characters = [
  { id: 'c1', name: 'Naomi' },
  { id: 'c2', name: 'Wren' },
];
const backgroundCharacters = [{ id: 'c3', name: 'Corwin' }];

const baseCtx = {
  places, characters, backgroundCharacters,
  currentPlaceId: null, personaName: 'Jordan',
  speakerId: 'c1', speakerName: 'Naomi',
};

describe('extractJsonLenient', () => {
  test('parses bare JSON', () => {
    assert.deepEqual(extractJsonLenient('{"intents":[]}'), { intents: [] });
  });
  test('extracts JSON from a markdown fence', () => {
    assert.deepEqual(extractJsonLenient('here you go:\n```json\n{"intents":[]}\n```\nthanks'), { intents: [] });
  });
  test('extracts JSON from surrounding prose without a fence', () => {
    assert.deepEqual(extractJsonLenient('Sure! {"intents":[]} let me know if you need more.'), { intents: [] });
  });
  test('returns null for unparseable text', () => {
    assert.equal(extractJsonLenient('no json here at all'), null);
  });
  test('returns null for empty input', () => {
    assert.equal(extractJsonLenient(''), null);
    assert.equal(extractJsonLenient(null), null);
  });
});

describe('parseIntents — destination', () => {
  test('resolves a known place', () => {
    const hits = parseIntents([{ type: 'destination', to: 'Market Square', when: 'now' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'destination', known: true, placeId: 'p1', placeName: 'Market Square' }]);
  });
  test('flags an unknown place', () => {
    const hits = parseIntents([{ type: 'destination', to: 'The Old Lighthouse', when: 'now' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'destination', known: false, placeName: 'The Old Lighthouse' }]);
  });
  test('drops the current place (already there)', () => {
    const hits = parseIntents([{ type: 'destination', to: 'Market Square', when: 'now' }], { ...baseCtx, currentPlaceId: 'p1' });
    assert.deepEqual(hits, []);
  });
});

describe('parseIntents — new-character', () => {
  test('flags a genuinely new name', () => {
    const hits = parseIntents([{ type: 'new-character', to: 'Selene', when: 'now' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'new-character', name: 'Selene' }]);
  });
  test('drops an already-known character', () => {
    const hits = parseIntents([{ type: 'new-character', to: 'Naomi', when: 'now' }], baseCtx);
    assert.deepEqual(hits, []);
  });
  test('drops the persona\'s own name', () => {
    const hits = parseIntents([{ type: 'new-character', to: 'Jordan', when: 'now' }], baseCtx);
    assert.deepEqual(hits, []);
  });
});

describe('parseIntents — promote / demote', () => {
  test('promote resolves a background character by name', () => {
    const hits = parseIntents([{ type: 'promote', to: 'Corwin', when: 'now' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'promote', charId: 'c3', name: 'Corwin' }]);
  });
  test('promote does nothing for a character not in the background list', () => {
    const hits = parseIntents([{ type: 'promote', to: 'Wren', when: 'now' }], baseCtx);
    assert.deepEqual(hits, []);
  });
  test('demote always targets the speaker, regardless of "to"', () => {
    const hits = parseIntents([{ type: 'demote', to: 'anything', when: 'now' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'demote', charId: 'c1', name: 'Naomi' }]);
  });
});

describe('parseIntents — text-someone / scheduled-text / call-to-scene', () => {
  test('text-someone resolves a known character target', () => {
    const hits = parseIntents([{ type: 'text-someone', to: 'Wren', when: 'now', reason: 'letting her know' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'text-someone', targetKind: 'character', charId: 'c2', targetName: 'Wren', summary: 'letting her know' }]);
  });

  test('text-someone resolves "persona" to the persona, never a resolved character', () => {
    const hits = parseIntents([{ type: 'text-someone', to: 'persona', when: 'now', reason: 'the address' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'text-someone', targetKind: 'persona', charId: null, targetName: 'Jordan', summary: 'the address' }]);
  });

  test('scheduled-text requires both day and a valid timeOfDay', () => {
    const missingDay = parseIntents([{ type: 'scheduled-text', to: 'persona', when: 'later', timeOfDay: 'evening' }], baseCtx);
    assert.deepEqual(missingDay, []);
    const badTimeOfDay = parseIntents([{ type: 'scheduled-text', to: 'persona', when: 'later', day: 2, timeOfDay: 'whenever' }], baseCtx);
    assert.deepEqual(badTimeOfDay, []);
  });

  test('scheduled-text with valid day/timeOfDay resolves cleanly', () => {
    const hits = parseIntents([{ type: 'scheduled-text', to: 'Wren', when: 'later', day: 3, timeOfDay: 'evening', reason: 'the plan' }], baseCtx);
    assert.deepEqual(hits, [{ type: 'scheduled-text', targetKind: 'character', charId: 'c2', targetName: 'Wren', day: 3, timeOfDay: 'evening', reason: 'the plan' }]);
  });

  test('call-to-scene only fires for a resolved character, not a free-text name', () => {
    const resolved = parseIntents([{ type: 'call-to-scene', to: 'Wren', when: 'now' }], baseCtx);
    assert.deepEqual(resolved, [{ type: 'call-to-scene', charId: 'c2', name: 'Wren' }]);
    const unresolved = parseIntents([{ type: 'call-to-scene', to: 'Someone New', when: 'now' }], baseCtx);
    assert.deepEqual(unresolved, []);
  });
});

describe('parseIntents — robustness', () => {
  test('a malformed single item is skipped, not fatal to the batch', () => {
    const hits = parseIntents([
      { type: 'text-someone', to: 'Wren', when: 'now', reason: 'hi' },
      { type: 'not-a-real-type', to: 'Wren', when: 'now' },
      null,
      'garbage',
      { type: 'destination' /* missing to/when */ },
    ], baseCtx);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'text-someone');
  });

  test('non-array input yields no suggestions rather than throwing', () => {
    assert.deepEqual(parseIntents(undefined, baseCtx), []);
    assert.deepEqual(parseIntents(null, baseCtx), []);
    assert.deepEqual(parseIntents('not an array', baseCtx), []);
  });

  test('duplicate intents for the same target are deduped', () => {
    const hits = parseIntents([
      { type: 'text-someone', to: 'Wren', when: 'now', reason: 'a' },
      { type: 'text-someone', to: 'Wren', when: 'now', reason: 'b' },
    ], baseCtx);
    assert.equal(hits.length, 1);
  });
});

describe('buildIntentPrompt', () => {
  test('never includes the persona\'s real name anywhere in the prompt', () => {
    const { systemPrompt, userPrompt } = buildIntentPrompt('Sure, texting Wren now.', {
      ...baseCtx, precedingUserText: 'Can you text Wren for me?', worldDay: 2, worldTimeOfDay: 'evening',
    });
    assert.ok(!systemPrompt.includes('Jordan'), 'persona name leaked into systemPrompt');
    assert.ok(!userPrompt.includes('Jordan'), 'persona name leaked into userPrompt');
  });

  test('includes the speaking character\'s name and the preceding persona line', () => {
    const { userPrompt } = buildIntentPrompt('Sure, texting Wren now.', {
      ...baseCtx, precedingUserText: 'Can you text Wren for me?',
    });
    assert.ok(userPrompt.includes('Naomi'));
    assert.ok(userPrompt.includes('Can you text Wren for me?'));
    assert.ok(userPrompt.includes('Sure, texting Wren now.'));
  });

  test('every TIMES_OF_DAY value is a valid schema enum entry', () => {
    assert.deepEqual(TIMES_OF_DAY, ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night']);
  });
});
