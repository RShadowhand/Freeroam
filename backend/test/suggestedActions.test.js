import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSuggestedActions, resolveWhen } from '../lib/suggestedActions.js';

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
      classifyIntentsFn: async () => { called = true; return []; },
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
// down real models. The classifier fake mirrors the real multi-label
// contract: every requested label comes back with an independent score.
// Label strings here must match lib/suggestedActions.js's INTENT_FAMILIES
// (they're tuned values there, mirrored here by family key).
const LABELS = {
  invite: 'invites the user to go to another place',
  beckon: 'invites or calls someone over to join the conversation',
  leaving: 'the speaker announces that they are leaving',
  texting: 'the speaker promises to text someone',
};

function fakeExtractEntities(entities) {
  return async () => entities;
}

// High scores for the named families, floor scores for everything else —
// same shape for whole-text and per-sentence calls. Pass a `perText`
// function instead for tests that need sentence-localization to behave
// differently per input.
function fakeIntentScores(highFamilies, { high = 0.97, low = 0.05 } = {}) {
  const highLabels = new Set(highFamilies.map((f) => LABELS[f]));
  return async (text, labels) => labels.map((label) => ({ label, score: highLabels.has(label) ? high : low }));
}

describe('detectSuggestedActions — ml mode', () => {
  test('surfaces a destination when intent + a LOC entity agree', async () => {
    const hits = await detectSuggestedActions('She heads for the market with a grin.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Market Square', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores(['invite']),
    });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { type: 'destination', known: true, placeId: 'p1', placeName: 'Market Square' });
  });

  test('does not surface a *known* destination when the invite score is below threshold', async () => {
    const hits = await detectSuggestedActions('The market was busy last week.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Market Square', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores([]),
    });
    assert.deepEqual(hits, []);
  });

  test('a score just under the invite threshold does not fire (thresholds are per-label, not the old global 0.55)', async () => {
    const hits = await detectSuggestedActions('The market was busy last week.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Market Square', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores(['invite'], { high: 0.85 }), // ≥ old 0.55, < tuned 0.9
    });
    assert.deepEqual(hits, []);
  });

  test('surfaces an *unknown* place regardless of intent — mirrors new-character detection, which is not intent-gated either', async () => {
    const hits = await detectSuggestedActions('Someone mentions the old lighthouse ruins in passing.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'LOC', text: 'Old Lighthouse', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores([]),
    });
    assert.deepEqual(hits, [{ type: 'destination', known: false, placeName: 'Old Lighthouse' }]);
  });

  test('makes exactly one whole-text classifier call for a single-sentence reply', async () => {
    // The old design called the classifier per gate (destination, beckon,
    // step-back separately); the multi-label rework shares ONE call across
    // every family. Sentence localization would add calls, but only for
    // multi-sentence replies whose texting score fires.
    let calls = 0;
    await detectSuggestedActions('She waves Wren over to the table.', {
      places, characters, mode: 'ml', backgroundCharacters: [{ id: 'c3', name: 'Wren' }],
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: async (text, labels) => { calls++; return labels.map((label) => ({ label, score: 0.05 })); },
    });
    assert.equal(calls, 1);
  });

  test('does not flag a family address term as a new character', async () => {
    const hits = await detectSuggestedActions('Someone waves at Mommy from across the room.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Mommy', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores([]),
    });
    assert.deepEqual(hits, []);
  });

  test('does not flag the active persona\'s own name as a new character', async () => {
    const hits = await detectSuggestedActions('Someone waves at Kael from across the room.', {
      places, characters, mode: 'ml', personaName: 'Kael',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Kael', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores([]),
    });
    assert.deepEqual(hits, []);
  });

  test('flags an unrecognized PER entity as a new character', async () => {
    const hits = await detectSuggestedActions('He mentions his cousin Odalys in passing.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Odalys', score: 0.95 }]),
      classifyIntentsFn: fakeIntentScores([]),
    });
    assert.deepEqual(hits, [{ type: 'new-character', name: 'Odalys' }]);
  });

  test('does not flag an already-known PER entity', async () => {
    const hits = await detectSuggestedActions('Ezra waves from across the room.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Ezra', score: 0.95 }]),
      classifyIntentsFn: fakeIntentScores([]),
    });
    assert.deepEqual(hits, []);
  });

  test('degrades to no suggestions if the NER call throws', async () => {
    const hits = await detectSuggestedActions('Let\'s go to the market.', {
      places, characters, mode: 'ml',
      extractEntitiesFn: async () => { throw new Error('model not loaded'); },
      classifyIntentsFn: fakeIntentScores(['invite']),
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
      classifyIntentsFn: fakeIntentScores(['invite']),
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
      classifyIntentsFn: fakeIntentScores(['invite']),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'destination');
    assert.equal(hits[0].placeId, 'p1');
  });
});

// promote/demote — separate from destination/new-character detection
// (participationSuggestions), so a single message can carry both kinds at
// once and neither counts against the other's 3-suggestion cap.
const backgroundCharacters = [{ id: 'c3', name: 'Wren' }];

describe('detectSuggestedActions — promote/demote (regex)', () => {
  test('beckoning a background character by name suggests promoting them', async () => {
    const hits = await detectSuggestedActions('Hey Wren, come on over and join us!', { places, characters, backgroundCharacters });
    assert.deepEqual(hits, [{ type: 'promote', charId: 'c3', name: 'Wren' }]);
  });

  test('a beckon phrase with no matching background character suggests nothing', async () => {
    const hits = await detectSuggestedActions('Come on over and join us!', { places, characters, backgroundCharacters: [] });
    assert.deepEqual(hits, []);
  });

  test('a background character named without a beckon phrase suggests nothing', async () => {
    const hits = await detectSuggestedActions('Wren is doing paperwork by the window.', { places, characters, backgroundCharacters });
    assert.deepEqual(hits, []);
  });

  test('the speaker stepping back from the conversation suggests demoting them', async () => {
    const hits = await detectSuggestedActions('Sorry, duty calls — I\'ll be right back.', {
      places, characters, speakerId: 'c1', speakerName: 'Ezra',
    });
    assert.deepEqual(hits, [{ type: 'demote', charId: 'c1', name: 'Ezra' }]);
  });

  test('a step-back phrase with no speakerId suggests nothing (nothing to demote)', async () => {
    const hits = await detectSuggestedActions('Sorry, duty calls — I\'ll be right back.', { places, characters });
    assert.deepEqual(hits, []);
  });

  test('no step-back phrasing means no demote suggestion', async () => {
    const hits = await detectSuggestedActions('It\'s good to see you again.', { places, characters, speakerId: 'c1', speakerName: 'Ezra' });
    assert.deepEqual(hits, []);
  });

  test('promote and demote can both fire on the same message, alongside destination/new-character hits', async () => {
    const hits = await detectSuggestedActions(
      'Let\'s go to the Market Square — Wren, come join us! I have to step out for a moment though.',
      { places, characters, backgroundCharacters, speakerId: 'c1', speakerName: 'Ezra' },
    );
    assert.equal(hits.length, 3);
    assert.deepEqual(hits.find((h) => h.type === 'destination'), { type: 'destination', known: true, placeId: 'p1', placeName: 'Market Square' });
    assert.deepEqual(hits.find((h) => h.type === 'promote'), { type: 'promote', charId: 'c3', name: 'Wren' });
    assert.deepEqual(hits.find((h) => h.type === 'demote'), { type: 'demote', charId: 'c1', name: 'Ezra' });
  });
});

describe('detectSuggestedActions — promote/demote (ml)', () => {
  test('a confident "beckon" score plus a matching background name suggests promoting them', async () => {
    // Name matching is literal (same as regex mode) even in ml mode — the
    // classifier only earns its keep on the intent side (recognizing a
    // beckon regardless of exact phrasing), not on discovering *who*.
    const hits = await detectSuggestedActions('She waves Wren over to the table.', {
      places, characters, mode: 'ml', backgroundCharacters,
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['beckon']),
    });
    assert.deepEqual(hits, [{ type: 'promote', charId: 'c3', name: 'Wren' }]);
  });

  test('a "beckon" score with no matching background character suggests nothing', async () => {
    const hits = await detectSuggestedActions('She waves someone over to the table.', {
      places, characters, mode: 'ml', backgroundCharacters: [],
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['beckon']),
    });
    assert.deepEqual(hits, []);
  });

  test('a below-threshold beckon score suggests nothing', async () => {
    const hits = await detectSuggestedActions('Wren waves from the window.', {
      places, characters, mode: 'ml', backgroundCharacters,
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['beckon'], { high: 0.7 }), // < 0.9 threshold
    });
    assert.deepEqual(hits, []);
  });

  test('a confident "leaving" score on a first-person line suggests demoting the speaker', async () => {
    const hits = await detectSuggestedActions("Perhaps it's time I made my exit.", {
      places, characters, mode: 'ml', speakerId: 'c1', speakerName: 'Ezra',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['leaving']),
    });
    assert.deepEqual(hits, [{ type: 'demote', charId: 'c1', name: 'Ezra' }]);
  });

  test('a dismissal aimed at the listener cannot demote — no first-person sentence, no demote', async () => {
    // q8 calibration found dismissals ("Go.") scoring 0.98+ on the leaving
    // label — the first-person sentence filter is what makes this
    // structurally impossible rather than threshold-dependent.
    const hits = await detectSuggestedActions('Go on without me. Get moving.', {
      places, characters, mode: 'ml', speakerId: 'c1', speakerName: 'Ezra',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['leaving']),
    });
    assert.deepEqual(hits, []);
  });

  test('degrades to no participation suggestions if the classifier throws', async () => {
    const hits = await detectSuggestedActions('Wren, come join us — I should get going too.', {
      places, characters, mode: 'ml', backgroundCharacters, speakerId: 'c1', speakerName: 'Ezra',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: async () => { throw new Error('model not loaded'); },
    });
    assert.deepEqual(hits, []);
  });
});

describe('detectSuggestedActions — promote/demote (hybrid)', () => {
  test('regex and ml agreeing on a beckon dedupes to one promote (regex priority)', async () => {
    const hits = await detectSuggestedActions('Wren, come join us!', {
      places, characters, mode: 'hybrid', backgroundCharacters,
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['beckon']),
    });
    assert.deepEqual(hits, [{ type: 'promote', charId: 'c3', name: 'Wren' }]);
  });

  test('falls back to ml when regex phrasing misses a beckon', async () => {
    const hits = await detectSuggestedActions('She waves Wren over to the table.', {
      places, characters, mode: 'hybrid', backgroundCharacters,
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['beckon']),
    });
    assert.deepEqual(hits, [{ type: 'promote', charId: 'c3', name: 'Wren' }]);
  });
});

// Texting detection — ml/hybrid only (the regex layer has no texting
// patterns). Suggestion shapes deliberately match lib/llmSuggestedActions'
// parseIntents output so the frontend renders both modes identically.
describe('detectSuggestedActions — texting (ml)', () => {
  test('an immediate text to "you" resolves to the persona', async () => {
    const text = "Let me text you the address right now so you don't get lost.";
    const hits = await detectSuggestedActions(text, {
      places, characters, mode: 'ml', personaName: 'Kael', speakerId: 'c1', speakerName: 'Ezra',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['texting']),
    });
    assert.deepEqual(hits, [{ type: 'text-someone', targetKind: 'persona', charId: null, targetName: 'Kael', summary: text }]);
  });

  test('a promised later text to a known character schedules against world time', async () => {
    const text = "I'll text Mireille tomorrow morning once the ledgers are done.";
    const hits = await detectSuggestedActions(text, {
      places, characters, mode: 'ml', speakerId: 'c1', speakerName: 'Ezra',
      worldDay: 3, worldTimeOfDay: 'evening',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['texting']),
    });
    assert.deepEqual(hits, [{
      type: 'scheduled-text', targetKind: 'character', charId: 'c2', targetName: 'Mireille',
      day: 4, timeOfDay: 'morning', reason: text,
    }]);
  });

  test('localizes the trigger sentence in a multi-sentence reply — time rules and reason use the sentence, not the whole text', async () => {
    // Text-aware fake: only the sentence actually containing the promise
    // scores high, mirroring how the real per-sentence localization pass
    // behaves. The narration around it must not leak into `reason` — and
    // crucially its words must not hijack the time rules (the production
    // bug where "immediately" in narration flipped a later-promise to now).
    const classifyIntentsFn = async (text, labels) => labels.map((label) => ({
      label,
      score: label === LABELS.texting && /text you/.test(text) ? 0.95 : 0.05,
    }));
    const text = 'He answers immediately, without hesitation. "I\'ll text you tonight." The rain keeps falling outside.';
    const hits = await detectSuggestedActions(text, {
      places, characters, mode: 'ml', personaName: 'Kael', speakerId: 'c1', speakerName: 'Ezra',
      worldDay: 2, worldTimeOfDay: 'noon',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'scheduled-text'); // "tonight" from the trigger — NOT "immediately" from narration
    assert.equal(hits[0].day, 2);
    assert.equal(hits[0].timeOfDay, 'evening');
    assert.equal(hits[0].reason, '"I\'ll text you tonight."');
    assert.equal(hits[0].targetKind, 'persona');
  });

  test('an unresolvable named recipient stays as a free-text name via the NER fallback', async () => {
    const text = "I'll text Odalys when I know more.";
    const hits = await detectSuggestedActions(text, {
      places, characters, mode: 'ml', speakerId: 'c1', speakerName: 'Ezra',
      extractEntitiesFn: fakeExtractEntities([{ type: 'PER', text: 'Odalys', score: 0.9 }]),
      classifyIntentsFn: fakeIntentScores(['texting']),
    });
    // The unknown PER also (correctly) produces a new-character suggestion —
    // "add this character" is the natural companion to "text them".
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.find((h) => h.type === 'new-character'), { type: 'new-character', name: 'Odalys' });
    const sched = hits.find((h) => h.type === 'scheduled-text');
    assert.equal(sched.targetKind, 'character');
    assert.equal(sched.charId, null);
    assert.equal(sched.targetName, 'Odalys');
  });

  test('a vague promise with no time cue emits an immediate text-someone, never an invented schedule', async () => {
    const text = 'I\'ll text you about it.';
    const hits = await detectSuggestedActions(text, {
      places, characters, mode: 'ml', personaName: 'Kael', speakerId: 'c1', speakerName: 'Ezra',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['texting']),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'text-someone');
  });

  test('a below-threshold texting score suggests nothing', async () => {
    const hits = await detectSuggestedActions('He mentions texting in passing.', {
      places, characters, mode: 'ml', personaName: 'Kael',
      extractEntitiesFn: fakeExtractEntities([]),
      classifyIntentsFn: fakeIntentScores(['texting'], { high: 0.6 }), // < 0.85 threshold
    });
    assert.deepEqual(hits, []);
  });
});

describe('resolveWhen — deterministic now/later rules', () => {
  test('"right now" is now', () => {
    assert.deepEqual(resolveWhen('I will text you right now', 1, 'morning'), { when: 'now' });
  });

  test('"tonight" lands on evening from earlier in the day, night from night', () => {
    assert.deepEqual(resolveWhen("I'll message you tonight", 2, 'morning'), { when: 'later', day: 2, timeOfDay: 'evening' });
    assert.deepEqual(resolveWhen("I'll message you tonight", 2, 'night'), { when: 'later', day: 2, timeOfDay: 'night' });
  });

  test('"tomorrow evening" is day+1 with the named timeOfDay', () => {
    assert.deepEqual(resolveWhen('expect a text tomorrow evening', 5, 'noon'), { when: 'later', day: 6, timeOfDay: 'evening' });
  });

  test('"in an hour" advances a couple of steps, wrapping past night into the next day', () => {
    assert.deepEqual(resolveWhen("I'll text you in an hour", 1, 'afternoon'), { when: 'later', day: 1, timeOfDay: 'sunset' });
    assert.deepEqual(resolveWhen("I'll text you in an hour", 1, 'night'), { when: 'later', day: 2, timeOfDay: 'morning' });
  });

  test('no temporal cue at all is unspecified', () => {
    assert.deepEqual(resolveWhen('She smiled and said nothing.', 1, 'morning'), { when: 'unspecified' });
  });
});
