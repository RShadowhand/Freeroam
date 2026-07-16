import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSuggestedActions } from '../lib/suggestedActions.js';

const places = [
  { id: 'p1', name: 'Market Square' },
  { id: 'p2', name: 'The Rusty Anchor' },
];
const characters = [
  { id: 'c1', name: 'Ezra' },
  { id: 'c2', name: 'Mireille' },
];

describe('detectSuggestedActions — regex mode (default)', () => {
  test('returns nothing for plain text', async () => {
    assert.deepEqual(await detectSuggestedActions('Hello there, how are you?', { places, characters }), []);
  });

  test('detects an invite to a known place', async () => {
    const hits = await detectSuggestedActions('Let\'s go to the Market Square, it\'s lively today.', { places, characters });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { type: 'destination', known: true, placeId: 'p1', placeName: 'Market Square' });
  });

  test('matches a partial known-place phrase', async () => {
    const hits = await detectSuggestedActions('Follow me to the Rusty Anchor tonight.', { places, characters });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].known, true);
    assert.equal(hits[0].placeId, 'p2');
  });

  test('does not suggest the place the speaker is already at', async () => {
    const hits = await detectSuggestedActions('Let\'s go to the Market Square.', { places, characters, currentPlaceId: 'p1' });
    assert.deepEqual(hits, []);
  });

  test('flags an unknown destination for "add place"', async () => {
    const hits = await detectSuggestedActions('Come with me to the Old Lighthouse.', { places, characters });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { type: 'destination', known: false, placeName: 'Old Lighthouse' });
  });

  test('detects a newly mentioned character', async () => {
    const hits = await detectSuggestedActions('My sister, named Odalys, lives nearby.', { places, characters });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { type: 'new-character', name: 'Odalys' });
  });

  test('does not flag an already-known character name', async () => {
    const hits = await detectSuggestedActions('My friend called Ezra should be along shortly.', { places, characters });
    assert.deepEqual(hits, []);
  });

  test('caps suggestions at 3 and can combine destination + character hits', async () => {
    const hits = await detectSuggestedActions(
      'Let\'s go to the Old Lighthouse — my cousin, named Odalys, will meet us there.',
      { places, characters },
    );
    assert.equal(hits.length, 2);
    assert.equal(hits[0].type, 'destination');
    assert.equal(hits[1].type, 'new-character');
  });

  test('handles empty/missing text gracefully', async () => {
    assert.deepEqual(await detectSuggestedActions('', { places, characters }), []);
    assert.deepEqual(await detectSuggestedActions(undefined, { places, characters }), []);
  });

  test('never calls the ML functions in regex mode', async () => {
    let called = false;
    await detectSuggestedActions('Let\'s go to the Market Square.', {
      places, characters,
      extractEntitiesFn: async () => { called = true; return []; },
      classifyIntentFn: async () => { called = true; return []; },
    });
    assert.equal(called, false);
  });

  test('does not flag a family address term as a new character', async () => {
    const hits = await detectSuggestedActions('A girl called Mommy waves from across the square.', { places, characters });
    assert.deepEqual(hits, []);
  });

  test('does not flag the active persona\'s own name as a new character', async () => {
    const hits = await detectSuggestedActions('He turns to face someone named Kael.', { places, characters, personaName: 'Kael' });
    assert.deepEqual(hits, []);
  });
});

// Deterministic fakes standing in for lib/nlp.js's real NER + zero-shot
// pipelines — keeps these tests instant and offline instead of pulling
// down real models.
function fakeExtractEntities(entities) {
  return async () => entities;
}
function fakeClassifyIntent(labelsInOrder) {
  return async (text, labels) => labelsInOrder.map((label, i) => ({ label, score: 1 - i * 0.2 })).filter((r) => labels.includes(r.label));
}

describe('detectSuggestedActions — ml mode', () => {
  test('surfaces a destination when intent + a LOC entity agree', async () => {
    const hits = await detectSuggestedActions('She heads for the market with a grin.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Market Square', score: 0.9 }]),
      classifyIntentFn: fakeClassifyIntent(['invites the user to go to another place', 'none of the above']),
    });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { type: 'destination', known: true, placeId: 'p1', placeName: 'Market Square' });
  });

  test('does not surface a *known* destination when intent is not confidently "invite"', async () => {
    const hits = await detectSuggestedActions('The market was busy last week.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Market Square', score: 0.9 }]),
      classifyIntentFn: fakeClassifyIntent(['none of the above', 'invites the user to go to another place']),
    });
    assert.deepEqual(hits, []);
  });

  test('surfaces an *unknown* place regardless of intent — mirrors new-character detection, which is not intent-gated either', async () => {
    const hits = await detectSuggestedActions('Someone mentions the old lighthouse ruins in passing.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Old Lighthouse', score: 0.9 }]),
      classifyIntentFn: fakeClassifyIntent(['none of the above']),
    });
    assert.deepEqual(hits, [{ type: 'destination', known: false, placeName: 'Old Lighthouse' }]);
  });

  test('does not call the intent classifier at all for an unknown place (only known-place suggestions need it)', async () => {
    let intentCalled = false;
    await detectSuggestedActions('Someone mentions the old lighthouse ruins in passing.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Old Lighthouse', score: 0.9 }]),
      classifyIntentFn: async () => { intentCalled = true; return []; },
    });
    assert.equal(intentCalled, false);
  });

  test('does not flag a family address term as a new character', async () => {
    const hits = await detectSuggestedActions('Someone waves at Mommy from across the room.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Mommy', score: 0.9 }]),
      classifyIntentFn: fakeClassifyIntent(['none of the above']),
    });
    assert.deepEqual(hits, []);
  });

  test('does not flag the active persona\'s own name as a new character', async () => {
    const hits = await detectSuggestedActions('Someone waves at Kael from across the room.', {
      places, characters, mode: 'ml', personaName: 'Kael',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Kael', score: 0.9 }]),
      classifyIntentFn: fakeClassifyIntent(['none of the above']),
    });
    assert.deepEqual(hits, []);
  });

  test('flags an unrecognized PER entity as a new character', async () => {
    const hits = await detectSuggestedActions('He mentions his cousin Odalys in passing.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Odalys', score: 0.95 }]),
      classifyIntentFn: fakeClassifyIntent(['none of the above']),
    });
    assert.deepEqual(hits, [{ type: 'new-character', name: 'Odalys' }]);
  });

  test('does not flag an already-known PER entity', async () => {
    const hits = await detectSuggestedActions('Ezra waves from across the room.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Ezra', score: 0.95 }]),
      classifyIntentFn: fakeClassifyIntent(['none of the above']),
    });
    assert.deepEqual(hits, []);
  });

  test('degrades to no suggestions if the NER call throws', async () => {
    const hits = await detectSuggestedActions('Let\'s go to the market.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: async () => { throw new Error('model not loaded'); },
      classifyIntentFn: fakeClassifyIntent(['invites the user to go to another place']),
    });
    assert.deepEqual(hits, []);
  });
});

describe('detectSuggestedActions — hybrid mode', () => {
  test('merges regex and ml hits, deduping overlaps with regex taking priority', async () => {
    const hits = await detectSuggestedActions('Let\'s go to the Market Square — my cousin, named Odalys, will meet us.', {
      places, characters, mode: 'hybrid',
      extractEntitiesFn: fakeExtractEntities([
        { type: 'LOC', text: 'Market Square', score: 0.9 },
        { type: 'PER', text: 'Odalys', score: 0.9 },
      ]),
      classifyIntentFn: fakeClassifyIntent(['invites the user to go to another place']),
    });
    // regex already finds both (destination + new-character); ml would find
    // the same two — the merge should dedupe down to 2, not stack 4.
    assert.equal(hits.length, 2);
    assert.equal(hits[0].type, 'destination');
    assert.equal(hits[1].type, 'new-character');
  });

  test('ml catches a destination the regex phrasing misses', async () => {
    const hits = await detectSuggestedActions('She wanders over toward the market, humming.', {
      places, characters, mode: 'hybrid',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Market Square', score: 0.9 }]),
      classifyIntentFn: fakeClassifyIntent(['invites the user to go to another place']),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'destination');
    assert.equal(hits[0].placeId, 'p1');
  });
});
