import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presentCharIds, activeCharIds } from '../lib/presence.js';

const charactersById = { ezra: { id: 'ezra' }, wren: { id: 'wren' }, dara: { id: 'dara' } };

describe('presentCharIds', () => {
  test('returns everyone placed at the given place', () => {
    const placements = {
      ezra: { placeId: 'square' },
      wren: { placeId: 'square' },
      dara: { placeId: 'library' },
    };
    assert.deepEqual(presentCharIds(placements, charactersById, 'square'), ['ezra', 'wren']);
  });

  test('includes characters regardless of active state — presence is about location, not participation', () => {
    const placements = {
      ezra: { placeId: 'square', active: false },
      wren: { placeId: 'square' },
    };
    assert.deepEqual(presentCharIds(placements, charactersById, 'square'), ['ezra', 'wren']);
  });

  test('excludes placements pointing at unknown/deleted characters', () => {
    const placements = { ghost: { placeId: 'square' }, ezra: { placeId: 'square' } };
    assert.deepEqual(presentCharIds(placements, charactersById, 'square'), ['ezra']);
  });

  test('returns an empty array for a place with no placements, or missing placements object', () => {
    assert.deepEqual(presentCharIds({ ezra: { placeId: 'square' } }, charactersById, 'empty-place'), []);
    assert.deepEqual(presentCharIds(undefined, charactersById, 'square'), []);
  });
});

describe('activeCharIds', () => {
  test('excludes anyone explicitly demoted (active: false)', () => {
    const placements = {
      ezra: { placeId: 'square', active: false },
      wren: { placeId: 'square' },
    };
    assert.deepEqual(activeCharIds(placements, charactersById, 'square'), ['wren']);
  });

  test('a missing `active` field counts as active — the default for every pre-existing placement', () => {
    const placements = { ezra: { placeId: 'square' } };
    assert.deepEqual(activeCharIds(placements, charactersById, 'square'), ['ezra']);
  });

  test('active: true is equivalent to the default (redundant but explicit)', () => {
    const placements = { ezra: { placeId: 'square', active: true } };
    assert.deepEqual(activeCharIds(placements, charactersById, 'square'), ['ezra']);
  });

  test('is always a subset of presentCharIds for the same inputs', () => {
    const placements = {
      ezra: { placeId: 'square', active: false },
      wren: { placeId: 'square' },
      dara: { placeId: 'square', active: false },
    };
    const present = presentCharIds(placements, charactersById, 'square');
    const active = activeCharIds(placements, charactersById, 'square');
    assert.deepEqual(active, ['wren']);
    assert.ok(active.every((id) => present.includes(id)));
  });

  test('everyone present can be inactive at once', () => {
    const placements = { ezra: { placeId: 'square', active: false } };
    assert.deepEqual(activeCharIds(placements, charactersById, 'square'), []);
    assert.deepEqual(presentCharIds(placements, charactersById, 'square'), ['ezra']);
  });
});
