import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_HINTS,
  relationshipFactText,
  upsertRelationship,
  retrieveRelevantRelationships,
} from '../lib/relationshipStore.js';
import { openDb } from '../lib/db.js';
import { logger } from '../lib/log.js';

logger.setLevel('error'); // keep test output clean

// A deterministic fake embedder: encodes only whether the text contains
// given keywords, so similarity is fully predictable without a real model.
function fakeEmbed(text) {
  const lower = text.toLowerCase();
  return [
    lower.includes('mother') ? 1 : 0,
    lower.includes('guild') ? 1 : 0,
    lower.includes('thief') ? 1 : 0,
  ];
}
const embedFn = async (t) => fakeEmbed(t);

function withDb(fn) {
  const db = openDb(':memory:');
  return Promise.resolve(fn(db)).finally(() => db.close());
}

describe('relationshipFactText', () => {
  test('joins the other party\'s name with their labels', () => {
    assert.equal(relationshipFactText('Mireille', ['sister', 'best friend']), 'Mireille: sister, best friend');
  });
});

describe('upsertRelationship', () => {
  test('writes a row with a computed embedding', () => withDb(async (db) => {
    const result = await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: ['sister'] });
    assert.deepEqual(result.labels, ['sister']);
    const row = db.prepare('SELECT labels, embedding FROM relationships WHERE character_id = ? AND target_id = ?').get('ezra', 'mireille');
    assert.deepEqual(JSON.parse(row.labels), ['sister']);
    assert.ok(row.embedding); // a real BLOB, not null
  }));

  test('dedupes and trims labels', () => withDb(async (db) => {
    const result = await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: [' sister ', 'sister', 'friend', ''] });
    assert.deepEqual(result.labels, ['sister', 'friend']);
  }));

  test('an empty label list deletes the row instead of writing one', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: ['sister'] });
    const result = await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: [] });
    assert.equal(result.removed, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relationships').get().n, 0);
  }));

  test('re-upserting recomputes the embedding for the new labels', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: ['acquaintance'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: ['mother'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild business' });
    assert.deepEqual(rows[0].labels, ['mother']); // family label makes it "core" regardless of query
  }));
});

describe('retrieveRelevantRelationships', () => {
  test('returns nothing for a speaker with no relationships', () => withDb(async (db) => {
    assert.deepEqual(await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'anything' }), []);
  }));

  test('the user\'s own relation to the speaker is always included, regardless of query relevance', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'user', targetName: 'the visitor', labels: ['mentor'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'completely unrelated thief business' });
    assert.deepEqual(rows, [{ direction: 'forward', otherId: 'user', labels: ['mentor'] }]);
  }));

  test('family-labeled relationships are always included ("core"), even when the query doesn\'t match them', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', targetName: 'Mireille', labels: ['mother'] });
    assert.ok(FAMILY_HINTS.includes('mother'));
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild business, nothing about family' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].otherId, 'mireille');
  }));

  test('non-core relationships are ranked by relevance to the query and bounded to topK', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', targetName: 'A', labels: ['guild contact'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'b', targetName: 'B', labels: ['guild rival'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'c', targetName: 'C', labels: ['old thief acquaintance'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'd', targetName: 'D', labels: ['neighbor'] }); // matches nothing

    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'tell me about the guild', topK: 2 });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.labels.some((l) => l.includes('guild'))));
  }));

  test('reverse relationships (someone else names the speaker as their relation) are included, correctly directioned', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'mireille', targetId: 'ezra', targetName: 'Ezra', labels: ['brother'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'anything' });
    assert.deepEqual(rows, [{ direction: 'reverse', otherId: 'mireille', labels: ['brother'] }]);
  }));

  test('a topK of 0 still returns the core set', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'user', targetName: 'the visitor', labels: ['friend'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', targetName: 'A', labels: ['guild contact'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild', topK: 0 });
    assert.deepEqual(rows, [{ direction: 'forward', otherId: 'user', labels: ['friend'] }]);
  }));

  test('lazily backfills an embedding for a row saved before this feature existed', () => withDb(async (db) => {
    // Simulate a legacy row written without ever computing an embedding.
    db.prepare('INSERT INTO relationships (character_id, target_id, labels, embedding) VALUES (?, ?, ?, NULL)')
      .run('ezra', 'mireille', JSON.stringify(['old friend']));

    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'old friend' });
    assert.equal(rows.length, 1);
    const row = db.prepare('SELECT embedding FROM relationships WHERE character_id = ? AND target_id = ?').get('ezra', 'mireille');
    assert.ok(row.embedding); // backfilled in place
  }));
});
