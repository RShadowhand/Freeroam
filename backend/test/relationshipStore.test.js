import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_HINTS,
  relationshipFactText,
  upsertRelationship,
  retrieveRelevantRelationships,
  queryCharacterRelationships,
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
    lower.includes('blue') ? 1 : 0,
    lower.includes('friend') ? 1 : 0,
  ];
}
const embedFn = async (t) => fakeEmbed(t);

function withDb(fn) {
  const db = openDb(':memory:');
  return Promise.resolve(fn(db)).finally(() => db.close());
}

describe('relationshipFactText', () => {
  test('joins the labels — no names, relation semantics only', () => {
    assert.equal(relationshipFactText(['sister', 'best friend']), 'sister, best friend');
  });
});

describe('upsertRelationship', () => {
  test('writes a row with a computed embedding', () => withDb(async (db) => {
    const result = await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: ['sister'] });
    assert.deepEqual(result.labels, ['sister']);
    const row = db.prepare('SELECT labels, embedding FROM relationships WHERE character_id = ? AND target_id = ?').get('ezra', 'mireille');
    assert.deepEqual(JSON.parse(row.labels), ['sister']);
    assert.ok(row.embedding); // a real BLOB, not null
  }));

  test('dedupes and trims labels', () => withDb(async (db) => {
    const result = await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: [' sister ', 'sister', 'friend', ''] });
    assert.deepEqual(result.labels, ['sister', 'friend']);
  }));

  test('an empty label list deletes the row instead of writing one', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: ['sister'] });
    const result = await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: [] });
    assert.equal(result.removed, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relationships').get().n, 0);
  }));

  test('re-upserting recomputes the embedding for the new labels', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: ['acquaintance'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: ['mother'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild business' });
    assert.deepEqual(rows[0].labels, ['mother']); // family label makes it "core" regardless of query
  }));
});

describe('retrieveRelevantRelationships', () => {
  test('returns nothing for a speaker with no relationships', () => withDb(async (db) => {
    assert.deepEqual(await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'anything' }), []);
  }));

  test('the user\'s own relation to the speaker is always included, regardless of query relevance', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'user', labels: ['mentor'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'completely unrelated thief business' });
    assert.deepEqual(rows, [{ direction: 'forward', otherId: 'user', labels: ['mentor'] }]);
  }));

  test('family-labeled relationships are always included ("core"), even when the query doesn\'t match them', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: ['mother'] });
    assert.ok(FAMILY_HINTS.includes('mother'));
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild business, nothing about family' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].otherId, 'mireille');
  }));

  test('non-core relationships are ranked by relevance to the query and bounded to topK', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', labels: ['guild contact'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'b', labels: ['guild rival'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'c', labels: ['old thief acquaintance'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'd', labels: ['neighbor'] }); // matches nothing

    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'tell me about the guild', topK: 2 });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.labels.some((l) => l.includes('guild'))));
  }));

  test('reverse relationships (someone else names the speaker as their relation) are included, correctly directioned', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'mireille', targetId: 'ezra', labels: ['brother'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'anything' });
    assert.deepEqual(rows, [{ direction: 'reverse', otherId: 'mireille', labels: ['brother'] }]);
  }));

  test('a topK of 0 still returns the core set', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'user', labels: ['friend'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', labels: ['guild contact'] });
    const rows = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild', topK: 0 });
    assert.deepEqual(rows, [{ direction: 'forward', otherId: 'user', labels: ['friend'] }]);
  }));

  test('a relationship can be found by describing the person, via their identity embedding', () => withDb(async (db) => {
    // Two friends with identical labels — indistinguishable by relation
    // vector alone; only the identity-embedding cross-check can tell
    // "that friend of yours with the blue eyes" points at Wren.
    const charactersById = {
      wren: { id: 'wren', name: 'Wren', description: 'Blue eyes, sharp grin.' },
      dara: { id: 'dara', name: 'Dara', description: 'Brown eyes, soft-spoken.' },
    };
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'wren', labels: ['friend'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'dara', labels: ['friend'] });

    const rows = await retrieveRelevantRelationships({
      db, embedFn, speakerId: 'ezra', charactersById,
      query: 'that friend of yours with the blue eyes', topK: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].otherId, 'wren');
  }));

  test('identity scoring works for reverse rows too — it describes the other party, not the row target', () => withDb(async (db) => {
    // Both rows name ezra as target; from ezra's perspective the person to
    // describe is each row's *owner*.
    const charactersById = {
      wren: { id: 'wren', name: 'Wren', description: 'Blue eyes, sharp grin.' },
      dara: { id: 'dara', name: 'Dara', description: 'Brown eyes, soft-spoken.' },
    };
    await upsertRelationship({ db, embedFn, characterId: 'wren', targetId: 'ezra', labels: ['coworker'] });
    await upsertRelationship({ db, embedFn, characterId: 'dara', targetId: 'ezra', labels: ['coworker'] });

    const rows = await retrieveRelevantRelationships({
      db, embedFn, speakerId: 'ezra', charactersById,
      query: 'your coworker with the blue eyes', topK: 1,
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { direction: 'reverse', otherId: 'wren', labels: ['coworker'] });
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

describe('queryCharacterRelationships', () => {
  test('returns nothing for an empty query', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', labels: ['guild contact'] });
    assert.deepEqual(await queryCharacterRelationships({ db, embedFn, speakerId: 'ezra', query: '' }), []);
    assert.deepEqual(await queryCharacterRelationships({ db, embedFn, speakerId: 'ezra', query: '   ' }), []);
  }));

  test('returns nothing for a speaker with no relationships', () => withDb(async (db) => {
    assert.deepEqual(await queryCharacterRelationships({ db, embedFn, speakerId: 'ezra', query: 'anything' }), []);
  }));

  test('ranks EVERY relationship, not just the topK winners, with a score for each', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', labels: ['guild contact'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'b', labels: ['guild rival'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'd', labels: ['neighbor'] }); // matches nothing

    const rows = await queryCharacterRelationships({ db, embedFn, speakerId: 'ezra', query: 'tell me about the guild', topK: 1 });
    assert.equal(rows.length, 3); // every candidate, including the ones that wouldn't win
    rows.forEach((r) => assert.equal(typeof r.score, 'number'));
    // Sorted by score, descending.
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score);
  }));

  test('flags which rows the real retrieveRelevantRelationships call would have picked, and why', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'user', labels: ['mentor'] }); // core: user
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'mireille', labels: ['mother'] }); // core: family
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'a', labels: ['guild contact'] }); // semantic winner
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'd', labels: ['neighbor'] }); // not selected

    const rows = await queryCharacterRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild business', topK: 1 });
    const byId = Object.fromEntries(rows.map((r) => [r.otherId, r]));

    assert.equal(byId.user.selected, true);
    assert.equal(byId.user.selectionReason, 'core');
    assert.equal(byId.mireille.selected, true);
    assert.equal(byId.mireille.selectionReason, 'core');
    assert.equal(byId.a.selected, true);
    assert.equal(byId.a.selectionReason, 'semantic');
    assert.equal(byId.d.selected, false);
    assert.equal(byId.d.selectionReason, null);

    // Cross-check against the real selection function for the same inputs.
    const selected = await retrieveRelevantRelationships({ db, embedFn, speakerId: 'ezra', query: 'guild business', topK: 1 });
    const selectedIds = new Set(selected.map((r) => r.otherId));
    rows.forEach((r) => assert.equal(r.selected, selectedIds.has(r.otherId)));
  }));

  test('reports a label-score / character-score split, and finds a person by description like the real path does', () => withDb(async (db) => {
    const charactersById = {
      wren: { id: 'wren', name: 'Wren', description: 'Blue eyes, sharp grin.' },
      dara: { id: 'dara', name: 'Dara', description: 'Brown eyes, soft-spoken.' },
    };
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'wren', labels: ['friend'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'dara', labels: ['friend'] });

    const rows = await queryCharacterRelationships({
      db, embedFn, speakerId: 'ezra', charactersById, query: 'that friend of yours with the blue eyes',
    });
    const byId = Object.fromEntries(rows.map((r) => [r.otherId, r]));
    assert.equal(typeof byId.wren.labelScore, 'number');
    assert.equal(typeof byId.wren.characterScore, 'number');
    assert.ok(byId.wren.characterScore > byId.dara.characterScore); // blue eyes match Wren, not Dara
    assert.equal(byId.wren.otherName, 'Wren');
    // Same identical label vector for both -> label scores tie; only the
    // identity cross-check should separate them, matching real retrieval.
    assert.equal(byId.wren.labelScore, byId.dara.labelScore);
  }));

  test('otherName resolves to "User" for the user target and falls back to the id for an unknown character', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'user', labels: ['mentor'] });
    await upsertRelationship({ db, embedFn, characterId: 'ezra', targetId: 'ghost-id', labels: ['acquaintance'] });
    const rows = await queryCharacterRelationships({ db, embedFn, speakerId: 'ezra', query: 'anything', charactersById: {} });
    const byId = Object.fromEntries(rows.map((r) => [r.otherId, r]));
    assert.equal(byId.user.otherName, 'User');
    assert.equal(byId['ghost-id'].otherName, 'ghost-id');
  }));
});

// A pooling-style fake embedder — like the one in memoryStore.test.js,
// this normalizes by total word count (real pooling behavior) instead of
// simple keyword presence, so a short, specific detail buried in a long,
// mostly-shared description genuinely gets diluted. Reproduces the actual
// reported bug: three "employee" relationships whose target characters
// share near-identical filler text (same workplace, same role) and differ
// only in one early word (their age).
function poolingEmbed(text) {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const vocab = ['twentythree', 'nineteen', 'twentysix', 'employee'];
  const total = words.length || 1;
  return vocab.map((w) => words.filter((x) => x === w).length / total);
}
const poolingEmbedFn = async (t) => poolingEmbed(t);

describe('relationship ranking survives a diluted identity detail (character chunking)', () => {
  const filler = 'She works long shifts at the restaurant and knows every regular by name and order, rarely missing a beat during the rush. ';
  const longDescription = (ageWord) => `${ageWord} year old waitress who has worked here for a while. ${filler.repeat(6)}`;

  const charactersById = {
    a: { id: 'a', name: 'CorrectAge', description: longDescription('twentythree') },
    b: { id: 'b', name: 'WrongAgeOne', description: longDescription('nineteen') },
    c: { id: 'c', name: 'WrongAgeTwo', description: longDescription('twentysix') },
  };

  test('a long character description is split into multiple stored identity chunks', () => withDb(async (db) => {
    const { getCharacterEmbeddingChunks } = await import('../lib/characterEmbeddings.js');
    const chunks = await getCharacterEmbeddingChunks({ db, embedFn: poolingEmbedFn, char: charactersById.a });
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  }));

  test('the debug query correctly ranks the matching age at the top', () => withDb(async (db) => {
    await upsertRelationship({ db, embedFn: poolingEmbedFn, characterId: 'ezra', targetId: 'a', labels: ['employee'] });
    await upsertRelationship({ db, embedFn: poolingEmbedFn, characterId: 'ezra', targetId: 'b', labels: ['employee'] });
    await upsertRelationship({ db, embedFn: poolingEmbedFn, characterId: 'ezra', targetId: 'c', labels: ['employee'] });

    const rows = await queryCharacterRelationships({
      db, embedFn: poolingEmbedFn, speakerId: 'ezra', charactersById, query: 'twentythree year old employee',
    });
    const byId = Object.fromEntries(rows.map((r) => [r.otherId, r]));

    // All three share the identical "employee" label, so labelScore ties
    // exactly — the identity-chunk match is the only thing that can (and
    // must) break the tie, and it must break it correctly.
    assert.equal(byId.a.labelScore, byId.b.labelScore);
    assert.equal(byId.a.labelScore, byId.c.labelScore);
    assert.ok(byId.a.characterScore > byId.b.characterScore);
    assert.ok(byId.a.characterScore > byId.c.characterScore);
    assert.equal(rows[0].otherId, 'a'); // ranked #1 overall
  }));
});
