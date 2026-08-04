import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS, nextCondition, rollAutoWeather, setManualWeather, setAutoWeather } from '../lib/weather.js';

describe('nextCondition', () => {
  test('always returns one of the known conditions', () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(CONDITIONS.includes(nextCondition('sunny')));
    }
  });

  test('falls back to a valid condition for an unrecognized/missing current condition', () => {
    assert.ok(CONDITIONS.includes(nextCondition('not-a-real-condition')));
    assert.ok(CONDITIONS.includes(nextCondition(undefined)));
  });

  test('is weighted deterministically at the roll boundaries', () => {
    // TRANSITIONS.clear = { clear: 4, sunny: 3, overcast: 2, windy: 1 }, total weight 10
    mock.method(Math, 'random', () => 0);
    assert.equal(nextCondition('clear'), 'clear');
    mock.method(Math, 'random', () => 0.99);
    assert.equal(nextCondition('clear'), 'windy');
    mock.restoreAll();
  });

  test('snowy is reachable from another condition, not just itself (no longer a one-way trap)', () => {
    // TRANSITIONS.overcast = { overcast: 3, clear: 2, rainy: 2, foggy: 1, windy: 1, snowy: 1 }, total weight 10 —
    // snowy is last, so a near-1.0 roll (weight-sum 9 exhausted, tipping into snowy's own slice) lands on it.
    mock.method(Math, 'random', () => 0.99);
    assert.equal(nextCondition('overcast'), 'snowy');
    mock.restoreAll();
  });
});

describe('rollAutoWeather', () => {
  test('seeds a fresh entry for an area with no prior weather', () => {
    const result = rollAutoWeather({}, ['Downtown'], 3);
    assert.equal(result.Downtown.mode, 'auto');
    assert.equal(result.Downtown.updatedDay, 3);
    assert.ok(CONDITIONS.includes(result.Downtown.condition));
  });

  test('re-rolls an auto area whose last roll was a different day', () => {
    const before = { Downtown: { mode: 'auto', condition: 'sunny', updatedDay: 1 } };
    const result = rollAutoWeather(before, ['Downtown'], 2);
    assert.equal(result.Downtown.updatedDay, 2);
  });

  test('never touches a manual area, regardless of day', () => {
    const before = { Downtown: { mode: 'manual', condition: 'stormy', updatedDay: 1 } };
    const result = rollAutoWeather(before, ['Downtown'], 5);
    assert.deepEqual(result.Downtown, before.Downtown);
  });

  test('leaves an area already rolled for this exact day untouched (no flicker on retreat/re-advance)', () => {
    const before = { Downtown: { mode: 'auto', condition: 'foggy', updatedDay: 4 } };
    const result = rollAutoWeather(before, ['Downtown'], 4);
    assert.deepEqual(result.Downtown, before.Downtown);
  });

  test('handles multiple areas independently in one call', () => {
    const before = {
      Downtown: { mode: 'manual', condition: 'rainy', updatedDay: 1 },
      Uptown: { mode: 'auto', condition: 'clear', updatedDay: 1 },
    };
    const result = rollAutoWeather(before, ['Downtown', 'Uptown', 'Suburbs'], 2);
    assert.equal(result.Downtown.condition, 'rainy');
    assert.equal(result.Uptown.updatedDay, 2);
    assert.ok(result.Suburbs);
  });

  test('does not mutate the input map', () => {
    const before = { Downtown: { mode: 'auto', condition: 'clear', updatedDay: 1 } };
    rollAutoWeather(before, ['Downtown'], 2);
    assert.equal(before.Downtown.updatedDay, 1);
  });
});

describe('setManualWeather', () => {
  test('sets mode to manual with the given condition', () => {
    const result = setManualWeather({}, 'Downtown', 'stormy', 3);
    assert.deepEqual(result.Downtown, { mode: 'manual', condition: 'stormy', updatedDay: 3 });
  });

  test('throws on an unknown condition', () => {
    assert.throws(() => setManualWeather({}, 'Downtown', 'apocalyptic', 3));
  });

  test('does not mutate the input map', () => {
    const before = { Downtown: { mode: 'auto', condition: 'clear', updatedDay: 1 } };
    setManualWeather(before, 'Downtown', 'rainy', 2);
    assert.equal(before.Downtown.mode, 'auto');
  });
});

describe('setAutoWeather', () => {
  test('hands an area back to auto, keeping its current condition (no immediate re-roll)', () => {
    const before = { Downtown: { mode: 'manual', condition: 'stormy', updatedDay: 1 } };
    const result = setAutoWeather(before, 'Downtown', 5);
    assert.deepEqual(result.Downtown, { mode: 'auto', condition: 'stormy', updatedDay: 5 });
  });

  test('seeds a condition for an area with no prior entry', () => {
    const result = setAutoWeather({}, 'Downtown', 1);
    assert.equal(result.Downtown.mode, 'auto');
    assert.ok(CONDITIONS.includes(result.Downtown.condition));
  });
});
