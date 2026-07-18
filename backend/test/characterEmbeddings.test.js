import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  characterSnippet,
  characterIdentityText,
  getCharacterEmbedding,
  refreshCharacterEmbedding,
  deleteCharacterEmbedding,
  rebuildAllCharacterEmbeddings,
} from '../lib/characterEmbeddings.js';
import { openDb, decodeEmbedding } from '../lib/db.js';
import { logger } from '../lib/log.js';

logger.setLevel('error'); // keep test output clean

// Deterministic fake embedder — same idea as relationshipStore.test.js.
function fakeEmbed(text) {
  const lower = text.toLowerCase();
  return [
    lower.includes('blue') ? 1 : 0,
    lower.includes('archivist') ? 1 : 0,
  ];
}
const embedFn = async (t) => fakeEmbed(t);

function withDb(fn) {
  const db = openDb(':memory:');
  return Promise.resolve(fn(db)).finally(() => db.close());
}

describe('characterSnippet', () => {
  test('joins description and personality, collapsing whitespace', () => {
    const char = { name: 'Mireille', description: 'Blue  eyes,\n\nred hair.', personality: 'Quick to  laugh.' };
    assert.equal(characterSnippet(char), 'Blue eyes, red hair. Quick to laugh.');
  });

  test('returns an empty string for a missing character or empty fields', () => {
    assert.equal(characterSnippet(null), '');
    assert.equal(characterSnippet({ name: 'X' }), '');
  });

  test('truncates very long descriptions', () => {
    const snippet = characterSnippet({ description: 'x'.repeat(2000) });
    assert.ok(snippet.length < 700);
    assert.ok(snippet.endsWith('…'));
  });
});

describe('characterIdentityText', () => {
  test('prefixes the snippet with the character\'s name', () => {
    assert.equal(
      characterIdentityText({ name: 'Wren', description: 'Blue eyes.' }),
      'Wren. Blue eyes.'
    );
  });

  test('is just the name when there\'s no description or personality', () => {
    assert.equal(characterIdentityText({ name: 'Wren' }), 'Wren');
  });
});

describe('getCharacterEmbedding', () => {
  test('computes and stores the vector on first call, reuses the stored row after', () => withDb(async (db) => {
    const char = { id: 'wren', name: 'Wren', description: 'Blue eyes.' };
    const first = await getCharacterEmbedding({ db, embedFn, char });
    assert.deepEqual(first, await embedFn('Wren. Blue eyes.'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings').get().n, 1);

    // A second call must read the stored row, not re-embed: prove it by
    // passing an embedFn that would produce a different vector if called.
    const second = await getCharacterEmbedding({ db, embedFn: async () => [9, 9], char });
    assert.deepEqual(second, first);
  }));
});

describe('refreshCharacterEmbedding', () => {
  test('overwrites the stored vector with one for the current fields', () => withDb(async (db) => {
    const char = { id: 'wren', name: 'Wren', description: 'Brown eyes.' };
    await getCharacterEmbedding({ db, embedFn, char });

    await refreshCharacterEmbedding({ db, embedFn, char: { ...char, description: 'Blue eyes.' } });
    const row = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').get('wren');
    assert.deepEqual(decodeEmbedding(row.embedding), await embedFn('Wren. Blue eyes.'));
  }));
});

describe('deleteCharacterEmbedding', () => {
  test('removes the character\'s row', () => withDb(async (db) => {
    await getCharacterEmbedding({ db, embedFn, char: { id: 'wren', name: 'Wren' } });
    deleteCharacterEmbedding(db, 'wren');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings').get().n, 0);
  }));
});

describe('rebuildAllCharacterEmbeddings', () => {
  test('re-embeds every passed character and returns the count', () => withDb(async (db) => {
    const characters = [
      { id: 'wren', name: 'Wren', description: 'Blue eyes.' },
      { id: 'ezra', name: 'Ezra', description: 'A meticulous archivist.' },
    ];
    const count = await rebuildAllCharacterEmbeddings({ db, embedFn, characters });
    assert.equal(count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings').get().n, 2);
    const ezra = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').get('ezra');
    assert.deepEqual(decodeEmbedding(ezra.embedding), await embedFn('Ezra. A meticulous archivist.'));
  }));
});
