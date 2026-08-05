import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CASCADE_BASE_CHANCE, DEFAULT_CASCADE_DECAY_RATE, DEFAULT_CASCADE_PER_CHARACTER_CAP, MAX_CASCADE_REPLIES,
  nextCascadeChance, rollContinues, eligibleReplierIds, pickReplier, nextCascadeStep,
} from '../lib/textCascade.js';

describe('nextCascadeChance', () => {
  test('returns the base chance unmodified for the first reply (repliesSoFar=0)', () => {
    assert.equal(nextCascadeChance(0.85, 0.98, 0), 0.85);
  });

  test('decays multiplicatively with each additional reply', () => {
    const base = 0.8, decay = 0.5;
    assert.equal(nextCascadeChance(base, decay, 1), base * decay);
    assert.equal(nextCascadeChance(base, decay, 2), base * decay * decay);
    assert.equal(nextCascadeChance(base, decay, 3), base * Math.pow(decay, 3));
  });

  test('monotonically decreases as repliesSoFar grows (for decay < 1)', () => {
    let prev = nextCascadeChance(0.9, 0.9, 0);
    for (let i = 1; i < 10; i++) {
      const next = nextCascadeChance(0.9, 0.9, i);
      assert.ok(next < prev, `expected chance to shrink at step ${i}`);
      prev = next;
    }
  });
});

describe('rollContinues', () => {
  test('continues when the roll is below chance', () => {
    assert.equal(rollContinues(0.5, () => 0.49), true);
  });
  test('stops when the roll is at or above chance', () => {
    assert.equal(rollContinues(0.5, () => 0.5), false);
    assert.equal(rollContinues(0.5, () => 0.9), false);
  });
  test('a chance of 0 never continues, regardless of the roll', () => {
    assert.equal(rollContinues(0, () => 0), false);
  });
});

describe('eligibleReplierIds', () => {
  test('everyone is eligible when nobody has spoken yet', () => {
    assert.deepEqual(eligibleReplierIds(['a', 'b', 'c'], null, 0, 2), ['a', 'b', 'c']);
  });

  test('everyone is eligible while the streak is under the cap', () => {
    assert.deepEqual(eligibleReplierIds(['a', 'b', 'c'], 'a', 1, 2), ['a', 'b', 'c']);
  });

  test('excludes the current streak-holder once the cap is reached', () => {
    assert.deepEqual(eligibleReplierIds(['a', 'b', 'c'], 'a', 2, 2), ['b', 'c']);
  });

  test('excludes at a cap of 1 (no back-to-back repeats at all)', () => {
    assert.deepEqual(eligibleReplierIds(['a', 'b'], 'a', 1, 1), ['b']);
  });

  test('falls back to the full pool rather than returning empty when excluding would leave nobody', () => {
    assert.deepEqual(eligibleReplierIds(['a'], 'a', 5, 2), ['a']);
  });
});

describe('pickReplier', () => {
  test('picks deterministically from a fixed rng', () => {
    assert.equal(pickReplier(['a', 'b', 'c'], () => 0), 'a');
    assert.equal(pickReplier(['a', 'b', 'c'], () => 0.99), 'c');
    assert.equal(pickReplier(['a', 'b', 'c'], () => 0.5), 'b');
  });
});

// nextCascadeStep is the primitive the manual-response-approval feature
// pauses between (server.js's beginGroupCascade/pendingCascadeSteps) — it
// has to answer "who's next?" without the caller needing to inline the
// roll+eligibility+pick sequence itself, so these tests pin its contract
// directly rather than only through the full-auto simulation below.
describe('nextCascadeStep', () => {
  const base = { participantIds: ['a', 'b', 'c'], cascadeBaseChance: 0.85, cascadeDecayRate: 0.98, cascadePerCharacterCap: 2 };

  test('returns null once repliesSoFar has hit MAX_CASCADE_REPLIES, without even rolling', () => {
    let rolled = false;
    const rng = () => { rolled = true; return 0; };
    const result = nextCascadeStep({ ...base, lastSpeakerId: null, lastSpeakerStreak: 0, repliesSoFar: MAX_CASCADE_REPLIES }, rng);
    assert.equal(result, null);
    assert.equal(rolled, false);
  });

  test('returns null when the continue-roll fails', () => {
    // rollContinues(chance) is chance > rng() would be true only for rng < chance;
    // 0.999999 fails against any chance <= 1.
    const result = nextCascadeStep({ ...base, lastSpeakerId: null, lastSpeakerStreak: 0, repliesSoFar: 0 }, () => 0.999999);
    assert.equal(result, null);
  });

  test('returns null when there are no participants to pick from at all', () => {
    // eligibleReplierIds falls back to the full candidate pool whenever
    // excluding the streak-holder would leave it empty (see its own
    // comment) — a single-member group is never actually "nobody eligible"
    // for that reason. The only genuinely empty case is an empty pool.
    const result = nextCascadeStep({
      participantIds: [], cascadeBaseChance: 1, cascadeDecayRate: 1, cascadePerCharacterCap: 1,
      lastSpeakerId: null, lastSpeakerStreak: 0, repliesSoFar: 0,
    }, () => 0); // roll always continues at chance=1
    assert.equal(result, null);
  });

  test('returns the picked replier when the roll succeeds and someone is eligible', () => {
    // First rng() call feeds rollContinues (0 < 0.85 -> continues), second feeds pickReplier (index 0 of 3 -> 'a').
    const rng = (() => { let i = 0; const seq = [0, 0]; return () => seq[i++]; })();
    const result = nextCascadeStep({ ...base, lastSpeakerId: null, lastSpeakerStreak: 0, repliesSoFar: 0 }, rng);
    assert.deepEqual(result, { replierId: 'a' });
  });

  test('excludes the current streak-holder from the pick once they are at the cap', () => {
    const rng = (() => { let i = 0; const seq = [0, 0]; return () => seq[i++]; })(); // continue, then pick index 0 of the *remaining* pool
    const result = nextCascadeStep({ ...base, lastSpeakerId: 'a', lastSpeakerStreak: 2, repliesSoFar: 1 }, rng);
    assert.notEqual(result.replierId, 'a');
    assert.equal(result.replierId, 'b'); // eligibleReplierIds(['a','b','c'], 'a', 2, 2) -> ['b','c'], index 0
  });
});

// Full cascade simulation, mirroring exactly what runGroupCascade in
// server.js does with these same building blocks — a statistical check
// against the plan's two anchors, not an exact-count assertion (this is
// inherently probabilistic). Uses a large trial count and a wide tolerance
// band so this doesn't flake on an unlucky run.
function simulateCascade({ baseChance, decayRate, perCharacterCap, numOthers, maxReplies = 50 }) {
  const candidateIds = Array.from({ length: numOthers }, (_, i) => `char-${i}`);
  let lastSpeakerId = null;
  let lastSpeakerStreak = 0;
  let repliesSoFar = 0;
  const perCharCounts = Object.fromEntries(candidateIds.map((id) => [id, 0]));

  while (repliesSoFar < maxReplies) {
    const chance = nextCascadeChance(baseChance, decayRate, repliesSoFar);
    if (!rollContinues(chance)) break;
    const eligible = eligibleReplierIds(candidateIds, lastSpeakerId, lastSpeakerStreak, perCharacterCap);
    const replierId = pickReplier(eligible);
    perCharCounts[replierId] += 1;
    lastSpeakerStreak = replierId === lastSpeakerId ? lastSpeakerStreak + 1 : 1;
    lastSpeakerId = replierId;
    repliesSoFar += 1;
  }
  return { total: repliesSoFar, perCharCounts };
}

describe('cascade anchors (default constants, statistical)', () => {
  test('a 2-others group averages roughly 3-5 total cascade replies', () => {
    const trials = 4000;
    let totalSum = 0;
    for (let i = 0; i < trials; i++) {
      totalSum += simulateCascade({
        baseChance: DEFAULT_CASCADE_BASE_CHANCE, decayRate: DEFAULT_CASCADE_DECAY_RATE,
        perCharacterCap: DEFAULT_CASCADE_PER_CHARACTER_CAP, numOthers: 2,
      }).total;
    }
    const avg = totalSum / trials;
    assert.ok(avg >= 2.5 && avg <= 5.5, `expected ~3-5 average total replies for 2 others, got ${avg.toFixed(2)}`);
  });

  test('a 5-others group averages roughly 0.7-0.8 replies per character', () => {
    const trials = 4000;
    let totalSum = 0;
    for (let i = 0; i < trials; i++) {
      totalSum += simulateCascade({
        baseChance: DEFAULT_CASCADE_BASE_CHANCE, decayRate: DEFAULT_CASCADE_DECAY_RATE,
        perCharacterCap: DEFAULT_CASCADE_PER_CHARACTER_CAP, numOthers: 5,
      }).total;
    }
    const avgPerChar = totalSum / trials / 5;
    assert.ok(avgPerChar >= 0.55 && avgPerChar <= 1.0, `expected ~0.7-0.8 average replies/character for 5 others, got ${avgPerChar.toFixed(2)}`);
  });

  test('every cascade terminates within a bounded number of replies (no infinite loop)', () => {
    for (let i = 0; i < 200; i++) {
      const { total } = simulateCascade({
        baseChance: DEFAULT_CASCADE_BASE_CHANCE, decayRate: DEFAULT_CASCADE_DECAY_RATE,
        perCharacterCap: DEFAULT_CASCADE_PER_CHARACTER_CAP, numOthers: 5, maxReplies: 200,
      });
      assert.ok(total < 200, 'cascade ran to the simulation ceiling — decay math may not be shrinking chance to near-zero');
    }
  });

  test('no character ever replies more than the cap in a row', () => {
    for (let i = 0; i < 500; i++) {
      const candidateIds = ['a', 'b', 'c'];
      let lastSpeakerId = null, lastSpeakerStreak = 0, repliesSoFar = 0;
      const cap = 2;
      const sequence = [];
      while (repliesSoFar < 30) {
        const chance = nextCascadeChance(0.9, 0.95, repliesSoFar); // slower decay to stress-test the cap over a longer run
        if (!rollContinues(chance)) break;
        const eligible = eligibleReplierIds(candidateIds, lastSpeakerId, lastSpeakerStreak, cap);
        const replierId = pickReplier(eligible);
        sequence.push(replierId);
        lastSpeakerStreak = replierId === lastSpeakerId ? lastSpeakerStreak + 1 : 1;
        lastSpeakerId = replierId;
        repliesSoFar += 1;
      }
      let run = 1;
      for (let j = 1; j < sequence.length; j++) {
        run = sequence[j] === sequence[j - 1] ? run + 1 : 1;
        assert.ok(run <= cap, `character replied ${run} times in a row, exceeding cap ${cap}: ${sequence.join(',')}`);
      }
    }
  });
});
