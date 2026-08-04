import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  characterSnippet,
  characterIdentityText,
  getCharacterEmbeddingChunks,
  refreshCharacterEmbedding,
  deleteCharacterEmbedding,
  rebuildAllCharacterEmbeddings,
} from '../lib/characterEmbeddings.js';
import { MAX_CHUNKS_PER_TEXT } from '../lib/textChunks.js';
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

  test('does not truncate long descriptions — chunking (see chunkText) handles length instead', () => {
    const longDescription = 'A vivid trait sentence. '.repeat(50); // ~1200 chars
    const snippet = characterSnippet({ description: longDescription });
    assert.equal(snippet, longDescription.replace(/\s+/g, ' ').trim());
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

describe('getCharacterEmbeddingChunks', () => {
  test('computes and stores one chunk for a short description, reuses the stored rows after', () => withDb(async (db) => {
    const char = { id: 'wren', name: 'Wren', description: 'Blue eyes.' };
    const first = await getCharacterEmbeddingChunks({ db, embedFn, char });
    assert.equal(first.length, 1);
    assert.deepEqual(first[0], await embedFn('Wren. Blue eyes.'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings').get().n, 1);

    // A second call must read the stored rows, not re-embed: prove it by
    // passing an embedFn that would produce a different vector if called.
    const second = await getCharacterEmbeddingChunks({ db, embedFn: async () => [9, 9], char });
    assert.deepEqual(second, first);
  }));

  test('two concurrent calls for the same not-yet-embedded character compute only once', () => withDb(async (db) => {
    const char = { id: 'wren', name: 'Wren', description: 'Blue eyes.' };
    let calls = 0;
    const countingEmbedFn = async (t) => { calls += 1; return fakeEmbed(t); };

    const [first, second] = await Promise.all([
      getCharacterEmbeddingChunks({ db, embedFn: countingEmbedFn, char }),
      getCharacterEmbeddingChunks({ db, embedFn: countingEmbedFn, char }),
    ]);

    assert.deepEqual(first, second);
    assert.equal(calls, 1, `expected the embedder to run once (shared in-flight computation), ran ${calls} time(s)`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings WHERE character_id = ?').get('wren').n, 1);
  }));

  test('a fresh call after the in-flight one has settled computes again (the guard only covers overlap, not caching)', () => withDb(async (db) => {
    const char = { id: 'wren', name: 'Wren', description: 'Blue eyes.' };
    await getCharacterEmbeddingChunks({ db, embedFn, char });
    deleteCharacterEmbedding(db, 'wren'); // simulate the stored rows being gone again
    let calls = 0;
    const countingEmbedFn = async (t) => { calls += 1; return fakeEmbed(t); };
    await getCharacterEmbeddingChunks({ db, embedFn: countingEmbedFn, char });
    assert.equal(calls, 1);
  }));

  test('a long description is split into multiple stored chunk rows, capped at MAX_CHUNKS_PER_TEXT', () => withDb(async (db) => {
    const sentence = 'She has a distinctive trait worth describing in some detail here. ';
    const char = { id: 'lindsey', name: 'Lindsey', description: sentence.repeat(20) }; // forces multiple chunks
    const chunks = await getCharacterEmbeddingChunks({ db, embedFn, char });
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assert.ok(chunks.length <= MAX_CHUNKS_PER_TEXT);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_embeddings WHERE character_id = ?').get('lindsey').n, chunks.length);
  }));
});

describe('refreshCharacterEmbedding', () => {
  test('overwrites the stored chunk rows with ones for the current fields', () => withDb(async (db) => {
    const char = { id: 'wren', name: 'Wren', description: 'Brown eyes.' };
    await getCharacterEmbeddingChunks({ db, embedFn, char });

    await refreshCharacterEmbedding({ db, embedFn, char: { ...char, description: 'Blue eyes.' } });
    const rows = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').all('wren');
    assert.equal(rows.length, 1);
    assert.deepEqual(decodeEmbedding(rows[0].embedding), await embedFn('Wren. Blue eyes.'));
  }));

  test('replaces the whole chunk set, not just appends — a shorter description leaves fewer rows', () => withDb(async (db) => {
    const sentence = 'She has a distinctive trait worth describing in some detail here. ';
    const char = { id: 'lindsey', name: 'Lindsey', description: sentence.repeat(20) };
    await getCharacterEmbeddingChunks({ db, embedFn, char });
    const before = db.prepare('SELECT COUNT(*) AS n FROM character_embeddings WHERE character_id = ?').get('lindsey').n;
    assert.ok(before > 1);

    await refreshCharacterEmbedding({ db, embedFn, char: { ...char, description: 'Short now.' } });
    const after = db.prepare('SELECT COUNT(*) AS n FROM character_embeddings WHERE character_id = ?').get('lindsey').n;
    assert.equal(after, 1);
  }));
});

describe('deleteCharacterEmbedding', () => {
  test('removes every one of the character\'s chunk rows', () => withDb(async (db) => {
    const sentence = 'She has a distinctive trait worth describing in some detail here. ';
    await getCharacterEmbeddingChunks({ db, embedFn, char: { id: 'lindsey', name: 'Lindsey', description: sentence.repeat(20) } });
    deleteCharacterEmbedding(db, 'lindsey');
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
    const ezra = db.prepare('SELECT embedding FROM character_embeddings WHERE character_id = ?').all('ezra');
    assert.equal(ezra.length, 1);
    assert.deepEqual(decodeEmbedding(ezra[0].embedding), await embedFn('Ezra. A meticulous archivist.'));
  }));
});
