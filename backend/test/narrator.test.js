import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNarrate, isNarratorSilent, buildNarratorMessages, NARRATOR_SILENCE } from '../lib/narrator.js';

describe('shouldNarrate', () => {
  test('an empty place always narrates — it\'s the only thing that can respond', () => {
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 0, backgroundCount: 0, log: [] }), true);
    assert.equal(shouldNarrate({ placeType: 'private', presentCount: 0, backgroundCount: 0, log: [] }), true);
  });

  test('a private place with exactly one person present never narrates, even if that person is background', () => {
    assert.equal(shouldNarrate({ placeType: 'private', presentCount: 1, backgroundCount: 0, log: [] }), false);
    assert.equal(shouldNarrate({ placeType: 'private', presentCount: 1, backgroundCount: 1, log: [] }), false);
  });

  test('anyone present-but-background always narrates, regardless of cadence', () => {
    const recentLog = [{ type: 'narrator', text: 'Just narrated.' }, { type: 'user', text: 'Hi' }];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 1, backgroundCount: 1, log: recentLog }), true);
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 3, backgroundCount: 2, log: recentLog }), true);
  });

  test('a solo active conversation (public, no background cast) is throttled to every 3rd round', () => {
    const justNarrated = [{ type: 'narrator', text: 'x' }];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 1, backgroundCount: 0, log: justNarrated }), false);

    const oneRoundSince = [{ type: 'narrator', text: 'x' }, { type: 'user', text: 'a' }];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 1, backgroundCount: 0, log: oneRoundSince }), false);

    const threeRoundsSince = [
      { type: 'narrator', text: 'x' },
      { type: 'user', text: 'a' }, { type: 'user', text: 'b' }, { type: 'user', text: 'c' },
    ];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 1, backgroundCount: 0, log: threeRoundsSince }), true);
  });

  test('a fully-active group (2+ present, none background) is throttled the same way as a solo chat', () => {
    const justNarrated = [{ type: 'narrator', text: 'x' }];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 4, backgroundCount: 0, log: justNarrated }), false);
  });

  test('with no narrator entry ever in the log, cadence counts from the start', () => {
    const twoUserLines = [{ type: 'user', text: 'a' }, { type: 'user', text: 'b' }];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 1, backgroundCount: 0, log: twoUserLines }), false);
    const threeUserLines = [...twoUserLines, { type: 'user', text: 'c' }];
    assert.equal(shouldNarrate({ placeType: 'communal', presentCount: 1, backgroundCount: 0, log: threeUserLines }), true);
  });

  test('a private place with 2+ present always narrates, unthrottled, background or not', () => {
    assert.equal(shouldNarrate({ placeType: 'private', presentCount: 2, backgroundCount: 0, log: [{ type: 'narrator', text: 'x' }] }), false);
    // ^ no background cast in a private multi-person scene still falls back to cadence, same as public — confirms
    // "private" only changes the solo-present rule, not the crowd rule.
  });
});

describe('isNarratorSilent', () => {
  test('treats empty, whitespace-only, and the sentinel (case/whitespace-insensitive) as silent', () => {
    assert.equal(isNarratorSilent(''), true);
    assert.equal(isNarratorSilent('   '), true);
    assert.equal(isNarratorSilent(undefined), true);
    assert.equal(isNarratorSilent(NARRATOR_SILENCE), true);
    assert.equal(isNarratorSilent(`  ${NARRATOR_SILENCE.toUpperCase()}  `), true);
  });

  test('treats real narration as not silent', () => {
    assert.equal(isNarratorSilent('A bell tolls somewhere distant.'), false);
  });
});

describe('buildNarratorMessages', () => {
  const basePlace = { name: 'Town Square', area: 'Old Quarter', desc: 'A cobbled plaza.', type: 'communal', ownerName: null };

  test('returns a two-message [system, user] array', () => {
    const messages = buildNarratorMessages({ place: basePlace, transcript: '' });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
  });

  test('the system message includes the place name/desc and the silence-sentinel instruction', () => {
    const [system] = buildNarratorMessages({ place: basePlace, transcript: '' });
    assert.ok(system.content.includes('Town Square'));
    assert.ok(system.content.includes('A cobbled plaza.'));
    assert.ok(system.content.includes(NARRATOR_SILENCE));
  });

  test('communal vs private wording, with an owner name when given', () => {
    const [communal] = buildNarratorMessages({ place: basePlace, transcript: '' });
    assert.match(communal.content, /communal space/i);

    const privatePlace = { ...basePlace, type: 'private', ownerName: 'Mireille' };
    const [private_] = buildNarratorMessages({ place: privatePlace, transcript: '' });
    assert.match(private_.content, /Mireille's private place/i);
  });

  test('lists background characters with their snippets when given', () => {
    const [system] = buildNarratorMessages({
      place: basePlace, transcript: '',
      backgroundChars: [{ name: 'Wren', snippet: 'Blue eyes, sharp grin.' }],
    });
    assert.ok(system.content.includes('Wren'));
    assert.ok(system.content.includes('Blue eyes, sharp grin.'));
  });

  test('omits the background-cast block entirely when there is none', () => {
    const [system] = buildNarratorMessages({ place: basePlace, transcript: '' });
    assert.ok(!system.content.includes('not currently part of the conversation'));
  });

  test('the user message carries the transcript when given, or a fresh-scene prompt when empty', () => {
    const [, withTranscript] = buildNarratorMessages({ place: basePlace, transcript: 'Kael: Hello?\nEzra: Ah.' });
    assert.ok(withTranscript.content.includes('Kael: Hello?'));

    const [, empty] = buildNarratorMessages({ place: basePlace, transcript: '' });
    assert.match(empty.content, /nothing has happened here yet/i);
  });

  test('includes the in-world day/weekday/time-of-day when given', () => {
    const [system] = buildNarratorMessages({ place: basePlace, transcript: '', time: { day: 3, timeOfDay: 'evening' } });
    assert.match(system.content, /Day 3 \(Wednesday\), evening/);
  });

  test('includes world setting text when given', () => {
    const [system] = buildNarratorMessages({ place: basePlace, transcript: '', worldSetting: 'A rain-soaked port city.' });
    assert.ok(system.content.includes('A rain-soaked port city.'));
  });
});
