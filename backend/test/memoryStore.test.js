import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cosineSimilarity,
  rankBySimilarity,
  topKSimilar,
  timePrefix,
  recordTurn,
  retrieveMemories,
  queryCharacterMemories,
  listCharacterMemories,
  countCharacterMemories,
  addCharacterMemory,
  updateCharacterMemory,
  deleteCharacterMemory,
  deleteAllCharacterMemories,
  syncMemoriesForEntry,
  findMemoriesWitnessing,
  detachEntryFromMemories,
  attachEntriesToMemories,
  pruneReplylessMemories,
} from '../lib/memoryStore.js';
import { openDb } from '../lib/db.js';
import { logger } from '../lib/log.js';

logger.setLevel('error'); // keep test output clean

// A deterministic fake embedder: encodes only whether the text contains
// given keywords, so similarity is fully predictable without any real model.
function fakeEmbed(text) {
  const lower = text.toLowerCase();
  return [
    lower.includes('records') ? 1 : 0,
    lower.includes('weather') ? 1 : 0,
    lower.includes('cats') ? 1 : 0,
  ];
}
const embedFn = async (t) => fakeEmbed(t);

// Each test gets a throwaway in-memory SQLite database.
function withDb(fn) {
  const db = openDb(':memory:');
  return Promise.resolve(fn(db)).finally(() => db.close());
}

// Test-side stand-in for context.js's formatLogEntry (imported separately
// in the server; the store takes it as an injected formatter).
function formatEntry(e, userLabel) {
  if (e.type === 'system') return `(${e.text})`;
  if (e.type === 'user') return `${userLabel}: ${e.text}`;
  return `${e.name}: ${e.text}`;
}

describe('cosineSimilarity', () => {
  test('identical vectors score 1', () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  });

  test('orthogonal vectors score 0', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  test('opposite vectors score -1', () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  test('is insensitive to magnitude (only direction matters)', () => {
    assert.equal(cosineSimilarity([2, 0], [5, 0]), 1);
  });

  test('returns 0 for mismatched lengths, empty, or non-array input', () => {
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
    assert.equal(cosineSimilarity([1], undefined), 0);
  });

  test('returns 0 for a zero vector (no division by zero)', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe('rankBySimilarity / topKSimilar', () => {
  const entries = [
    { id: 'a', embedding: [1, 0] },
    { id: 'b', embedding: [0.9, 0.1] },
    { id: 'c', embedding: [0, 1] },
    { id: 'd', embedding: [-1, 0] },
  ];
  const query = [1, 0];

  test('ranks most similar first', () => {
    assert.deepEqual(rankBySimilarity(query, entries).map((r) => r.entry.id), ['a', 'b', 'c', 'd']);
  });

  test('topKSimilar returns just the top K entries, unwrapped', () => {
    assert.deepEqual(topKSimilar(query, entries, 2).map((e) => e.id), ['a', 'b']);
  });

  test('topKSimilar with k=0 returns nothing', () => {
    assert.deepEqual(topKSimilar(query, entries, 0), []);
  });
});

describe('timePrefix', () => {
  test('renders day (with weekday) and time of day', () => {
    // Day 1 is a Monday (see context.js weekdayFor) — Day 3 is a Wednesday.
    assert.equal(timePrefix(3, 'evening'), '(Day 3 (Wednesday), evening)\n');
  });
  test('empty when neither is set', () => {
    assert.equal(timePrefix(null, null), '');
  });
});

describe('recordTurn + retrieveMemories (SQLite)', () => {
  test('recordTurn writes ONE shared row for the whole round, not one per character', () => withDb(async (db) => {
    let embedCalls = 0;
    const countingEmbed = async (t) => { embedCalls += 1; return fakeEmbed(t); };

    const result = await recordTurn({
      db, embedFn: countingEmbed,
      characterIds: ['ezra', 'mireille'],
      personaId: 'kael',
      text: 'Visitor: Do you keep records?\nEzra: Always.',
      placeId: 'archive-house',
      entryIds: ['e1', 'e2'],
      day: 2, timeOfDay: 'evening',
    });

    assert.equal(result.count, 2); // count = characters covered, not rows written
    assert.equal(embedCalls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1); // exactly one physical row

    const ezraMems = listCharacterMemories(db, 'ezra');
    assert.equal(ezraMems.length, 1);
    assert.deepEqual(ezraMems[0].participants, ['mireille']); // self excluded, matching the old shape
    assert.equal(ezraMems[0].day, 2);
    assert.equal(ezraMems[0].timeOfDay, 'evening');
    assert.ok(ezraMems[0].text.startsWith('(Day 2 (Tuesday), evening)'));

    // Both characters see the SAME row (same id), and each entry links to
    // it exactly once — not once per character.
    const mireilleMems = listCharacterMemories(db, 'mireille');
    assert.equal(mireilleMems[0].id, ezraMems[0].id);
    assert.deepEqual(mireilleMems[0].participants, ['ezra']);
    const links = db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get();
    assert.equal(links.n, 2); // 1 memory × 2 entries, not 2×2
  }));

  test('recordTurn is a no-op for empty text or no characters', () => withDb(async (db) => {
    assert.deepEqual(await recordTurn({ db, embedFn, characterIds: ['ezra'], text: '   ' }), { count: 0 });
    assert.deepEqual(await recordTurn({ db, embedFn, characterIds: [], text: 'hi' }), { count: 0 });
    assert.equal(listCharacterMemories(db, 'ezra').length, 0);
  }));

  test('retrieveMemories merges semantic matches across present characters', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', text: 'Visitor: About the records.\nEzra: They are all logged.' });
    await recordTurn({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', text: 'Visitor: Nice weather.\nEzra: Indeed.' });
    await recordTurn({ db, embedFn, characterIds: ['soot'], personaId: 'kael', text: 'Visitor: Do you like cats?\nSoot: I am a cat.' });

    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      query: 'Tell me about the records and the cats.',
      topKPerCharacter: 1, recentPerCharacter: 0,
    });
    assert.equal(memories.length, 2);
    assert.ok(memories.some((m) => m.includes('records')));
    assert.ok(memories.some((m) => m.includes('cat')));
  }));

  test('retrieveMemories includes recent entries even when semantically unrelated', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', text: 'Visitor: About the records.\nEzra: Logged.' });
    await new Promise((r) => setTimeout(r, 5));
    await recordTurn({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', text: 'Visitor: Nice weather.\nEzra: Indeed.' });

    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra'], personaId: 'kael',
      query: 'Tell me about the records.',
      topKPerCharacter: 1, recentPerCharacter: 1,
    });
    assert.equal(memories.length, 2);
    assert.ok(memories[0].includes('records'));
    assert.ok(memories[1].includes('weather'));
  }));

  test('memory is global, not persona-scoped — a memory formed with one persona is recalled under another', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], personaId: 'persona-A', text: 'About the records.' });
    const memories = await retrieveMemories({ db, embedFn, characterIds: ['ezra'], query: 'records' });
    assert.deepEqual(memories, ['About the records.']);
  }));

  test('retrieveMemories dedupes the same turn recorded into multiple characters\' rows', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael', text: 'Visitor: About the records.\nEzra: Logged.' });
    const memories = await retrieveMemories({ db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael', query: 'records' });
    assert.equal(memories.length, 1);
  }));

  test('excludeEntryIds skips memories formed from those entries, semantic or recent, without affecting others', () => withDb(async (db) => {
    await recordTurn({
      db, embedFn, characterIds: ['ezra'], personaId: 'kael',
      text: 'Visitor: About the records.\nEzra: They are all logged.',
      entryIds: ['usr-1', 'msg-1'],
    });
    await new Promise((r) => setTimeout(r, 5));
    await recordTurn({
      db, embedFn, characterIds: ['ezra'], personaId: 'kael',
      text: 'Visitor: Nice weather.\nEzra: Indeed.',
      entryIds: ['usr-2', 'msg-2'],
    });

    // Excluding the still-visible current-interaction entries should drop
    // that memory even though it would otherwise win on both semantic
    // similarity (topK) and recency.
    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra'], personaId: 'kael',
      query: 'Tell me about the records.',
      topKPerCharacter: 2, recentPerCharacter: 2,
      excludeEntryIds: ['usr-1', 'msg-1'],
    });
    assert.equal(memories.length, 1);
    assert.ok(memories[0].includes('weather'));
  }));

  test('excludeEntryIds with an id that touches nothing changes nothing', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', text: 'About the records.', entryIds: ['msg-1'] });
    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra'], personaId: 'kael', query: 'records', excludeEntryIds: ['ghost'],
    });
    assert.equal(memories.length, 1);
  }));

  test('retrieveMemories short-circuits (no embed call) for empty query or no characters', () => withDb(async (db) => {
    let embedCalls = 0;
    const countingEmbed = async (t) => { embedCalls += 1; return fakeEmbed(t); };
    await retrieveMemories({ db, embedFn: countingEmbed, characterIds: ['ezra'], query: '' });
    await retrieveMemories({ db, embedFn: countingEmbed, characterIds: [], query: 'hi' });
    assert.equal(embedCalls, 0);
  }));
});

describe('retrieveMemories minScore', () => {
  // A richer fake embedder than the top-level one: several independent
  // "topic" weights, with "hand" deliberately given a low weight (0.3) —
  // simulating a common word that shows up across many unrelated memories
  // in a real embedding model and inflates similarity on its own. This is
  // what lets the test distinguish "shares one throwaway word" (low score)
  // from "actually about the same topic" (high score), which a one-hot
  // fakeEmbed can't do.
  function gradedEmbed(text) {
    const lower = text.toLowerCase();
    return [
      /\bhand\b/.test(lower) ? 0.3 : 0,
      /\brain\b/.test(lower) ? 1 : 0,
      /\bmarket\b/.test(lower) ? 1 : 0,
    ];
  }
  const embedFn = async (t) => gradedEmbed(t);

  test('without a threshold, a memory that only shares a low-signal word still gets returned', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], text: 'A hand-carved wooden toy on the shelf.' });
    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra'], query: 'He offers his hand and heads to the market.',
      topKPerCharacter: 3, recentPerCharacter: 0,
    });
    assert.equal(memories.length, 1); // included despite being unrelated in topic
  }));

  test('minScore filters out weak shared-word matches while keeping genuinely relevant ones', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], text: 'A hand-carved wooden toy on the shelf.' }); // weak: only "hand"
    await new Promise((r) => setTimeout(r, 5));
    await recordTurn({ db, embedFn, characterIds: ['ezra'], text: 'They haggle over prices at the market stall.' }); // strong: "market"

    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra'], query: 'He offers his hand and heads to the market.',
      topKPerCharacter: 3, recentPerCharacter: 0, minScore: 0.35,
    });
    assert.equal(memories.length, 1);
    assert.ok(memories[0].includes('market'));
  }));

  test('minScore of 0 (the default) behaves exactly like no threshold at all', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], text: 'A hand-carved wooden toy on the shelf.' });
    const withDefault = await retrieveMemories({ db, embedFn, characterIds: ['ezra'], query: 'his hand', topKPerCharacter: 3, recentPerCharacter: 0 });
    const withExplicitZero = await retrieveMemories({ db, embedFn, characterIds: ['ezra'], query: 'his hand', topKPerCharacter: 3, recentPerCharacter: 0, minScore: 0 });
    assert.deepEqual(withDefault, withExplicitZero);
  }));

  test('minScore does not filter the recency pass — recent memories still surface regardless of topical relevance', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra'], text: 'Completely unrelated small talk about the weather.' });
    const memories = await retrieveMemories({
      db, embedFn, characterIds: ['ezra'], query: 'He offers his hand and heads to the market.',
      topKPerCharacter: 0, recentPerCharacter: 1, minScore: 0.9,
    });
    assert.equal(memories.length, 1); // recency bypasses minScore entirely
  }));
});

describe('management: list / add / update / delete', () => {
  test('empty for an unknown character', () => withDb((db) => {
    assert.deepEqual(listCharacterMemories(db, 'nobody'), []);
  }));

  test('addCharacterMemory creates a row and never exposes the embedding', () => withDb(async (db) => {
    const memory = await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: 'Loves cats.', placeId: 'archive-house', day: 1, timeOfDay: 'noon' });
    assert.ok(memory.text.includes('Loves cats.'));
    assert.equal(memory.personaId, 'kael');
    assert.equal(memory.placeId, 'archive-house');
    assert.equal('embedding' in memory, false);
  }));

  test('addCharacterMemory returns null for empty text', () => withDb(async (db) => {
    assert.equal(await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: '  ' }), null);
  }));

  test('updateCharacterMemory edits text and re-embeds it', () => withDb(async (db) => {
    const created = await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: 'About the weather.' });
    const updated = await updateCharacterMemory({ db, embedFn, characterId: 'ezra', entryId: created.id, text: 'About the records instead.' });
    assert.equal(updated.text, 'About the records instead.');

    const memories = await retrieveMemories({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', query: 'records', recentPerCharacter: 0, topKPerCharacter: 1 });
    assert.equal(memories[0], 'About the records instead.');
  }));

  test('updateCharacterMemory returns null for unknown id or wrong character', () => withDb(async (db) => {
    const created = await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: 'Mine.' });
    assert.equal(await updateCharacterMemory({ db, embedFn, characterId: 'ezra', entryId: 'nope', text: 'x' }), null);
    assert.equal(await updateCharacterMemory({ db, embedFn, characterId: 'soot', entryId: created.id, text: 'x' }), null);
  }));

  test('deleteCharacterMemory removes the row; repeat delete returns false', () => withDb(async (db) => {
    const created = await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: 'Delete me.' });
    assert.equal(deleteCharacterMemory(db, 'ezra', created.id), true);
    assert.equal(deleteCharacterMemory(db, 'ezra', created.id), false);
    assert.deepEqual(listCharacterMemories(db, 'ezra'), []);
  }));

  test('deleteCharacterMemory on a shared memory only removes this character\'s participation — others keep it', () => withDb(async (db) => {
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: 'Shared turn about cats.', entryIds: ['e1'],
    });
    const [ezraMem] = listCharacterMemories(db, 'ezra');

    assert.equal(deleteCharacterMemory(db, 'ezra', ezraMem.id), true);
    assert.deepEqual(listCharacterMemories(db, 'ezra'), []); // gone for ezra
    const [sootMem] = listCharacterMemories(db, 'soot');
    assert.ok(sootMem); // soot still remembers it — same row, one fewer participant
    assert.deepEqual(sootMem.participants, []); // ezra no longer listed as a co-participant

    // The underlying row is still very much alive (not orphaned/deleted).
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n, 1);
  }));

  test('deleteCharacterMemory removes the row entirely once the last participant leaves', () => withDb(async (db) => {
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: 'Shared turn about cats.', entryIds: ['e1'],
    });
    const [ezraMem] = listCharacterMemories(db, 'ezra');
    deleteCharacterMemory(db, 'ezra', ezraMem.id);
    deleteCharacterMemory(db, 'soot', ezraMem.id); // the last one out

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_participants').get().n, 0);
  }));

  test('deleteCharacterMemory returns false for a character who was never a participant', () => withDb(async (db) => {
    const created = await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: 'Only mine.' });
    assert.equal(deleteCharacterMemory(db, 'soot', created.id), false);
    assert.equal(listCharacterMemories(db, 'ezra').length, 1); // untouched
  }));

  test('deleteAllCharacterMemories wipes one character without touching others', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael', text: 'Shared turn about cats.' });
    deleteAllCharacterMemories(db, 'ezra');
    assert.equal(listCharacterMemories(db, 'ezra').length, 0);
    assert.equal(listCharacterMemories(db, 'soot').length, 1);
    // The row survives — soot's still there to remember it.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
  }));

  test('deleteAllCharacterMemories removes rows outright once nobody is left to witness them', () => withDb(async (db) => {
    await addCharacterMemory({ db, embedFn, characterId: 'ezra', personaId: 'kael', text: 'Solo memory.' });
    deleteAllCharacterMemories(db, 'ezra');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  }));
});

describe('listCharacterMemories / countCharacterMemories pagination', () => {
  async function seedMany(db, characterId, n) {
    for (let i = 0; i < n; i++) {
      await addCharacterMemory({ db, embedFn, characterId, personaId: 'kael', text: `Memory number ${i}.` });
      await new Promise((r) => setTimeout(r, 1)); // distinct timestamps, so newest-first order is deterministic
    }
  }

  test('defaults to newest-first, capped at 50, without needing explicit pagination args', () => withDb(async (db) => {
    await seedMany(db, 'ezra', 5);
    const memories = listCharacterMemories(db, 'ezra');
    assert.equal(memories.length, 5);
    assert.ok(memories[0].text.includes('number 4')); // newest first
    assert.ok(memories[4].text.includes('number 0'));
  }));

  test('limit caps the page size; offset walks through subsequent pages without gaps or repeats', () => withDb(async (db) => {
    await seedMany(db, 'ezra', 12);
    const page1 = listCharacterMemories(db, 'ezra', { limit: 5, offset: 0 });
    const page2 = listCharacterMemories(db, 'ezra', { limit: 5, offset: 5 });
    const page3 = listCharacterMemories(db, 'ezra', { limit: 5, offset: 10 });

    assert.equal(page1.length, 5);
    assert.equal(page2.length, 5);
    assert.equal(page3.length, 2); // only 2 left of 12
    const allIds = [...page1, ...page2, ...page3].map((m) => m.id);
    assert.equal(new Set(allIds).size, 12); // no duplicates, nothing skipped
  }));

  test('countCharacterMemories reflects the true total regardless of page size', () => withDb(async (db) => {
    await seedMany(db, 'ezra', 7);
    assert.equal(countCharacterMemories(db, 'ezra'), 7);
    listCharacterMemories(db, 'ezra', { limit: 2 }); // paging doesn't affect the count
    assert.equal(countCharacterMemories(db, 'ezra'), 7);
  }));

  test('a shared memory counts once per participant, not once per row', () => withDb(async (db) => {
    await recordTurn({ db, embedFn, characterIds: ['ezra', 'soot'], text: 'One shared round.' });
    assert.equal(countCharacterMemories(db, 'ezra'), 1);
    assert.equal(countCharacterMemories(db, 'soot'), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1); // still just one physical row
  }));

  test('countCharacterMemories is 0 for an unknown character', () => withDb((db) => {
    assert.equal(countCharacterMemories(db, 'nobody'), 0);
  }));
});

describe('queryCharacterMemories (debug tool)', () => {
  test('ranks every memory by relevance, annotating which the real algorithm would select', () => withDb(async (db) => {
    await addCharacterMemory({ db, embedFn, characterId: 'ezra', text: 'About the records in the archive.' });
    await new Promise((r) => setTimeout(r, 5));
    await addCharacterMemory({ db, embedFn, characterId: 'ezra', text: 'Nice weather today.' });

    const results = await queryCharacterMemories({
      db, embedFn, characterId: 'ezra', query: 'Tell me about the records.',
      topK: 3, recentCount: 0, minScore: 0.5,
    });

    assert.equal(results.length, 2); // every memory is returned and ranked, not just the winners
    const records = results.find((r) => r.text.includes('records'));
    const weather = results.find((r) => r.text.includes('weather'));
    assert.ok(records.score > weather.score); // ranked by relevance
    assert.equal(records.selected, true);
    assert.equal(records.selectionReason, 'semantic');
    assert.equal(weather.selected, false); // below minScore, correctly shown as a non-match
    assert.equal(weather.selectionReason, null);
  }));

  test('a memory can be selected for recency alone, correctly labeled', () => withDb(async (db) => {
    await addCharacterMemory({ db, embedFn, characterId: 'ezra', text: 'Something totally unrelated.' });

    const results = await queryCharacterMemories({
      db, embedFn, characterId: 'ezra', query: 'records',
      topK: 0, recentCount: 1, minScore: 0.9,
    });
    assert.equal(results[0].selected, true);
    assert.equal(results[0].selectionReason, 'recent');
  }));

  test('a memory hitting both semantic and recency passes is labeled as both', () => withDb(async (db) => {
    await addCharacterMemory({ db, embedFn, characterId: 'ezra', text: 'About the records.' });
    const results = await queryCharacterMemories({
      db, embedFn, characterId: 'ezra', query: 'records',
      topK: 3, recentCount: 3, minScore: 0,
    });
    assert.equal(results[0].selectionReason, 'semantic + recent');
  }));

  test('returns [] for an empty query or a character with no memories', () => withDb(async (db) => {
    await addCharacterMemory({ db, embedFn, characterId: 'ezra', text: 'Something.' });
    assert.deepEqual(await queryCharacterMemories({ db, embedFn, characterId: 'ezra', query: '' }), []);
    assert.deepEqual(await queryCharacterMemories({ db, embedFn, characterId: 'nobody', query: 'anything' }), []);
  }));

  test('limit caps how many ranked results come back', () => withDb(async (db) => {
    for (let i = 0; i < 5; i++) await addCharacterMemory({ db, embedFn, characterId: 'ezra', text: `Memory ${i}.` });
    const results = await queryCharacterMemories({ db, embedFn, characterId: 'ezra', query: 'memory', limit: 2 });
    assert.equal(results.length, 2);
  }));
});

describe('syncMemoriesForEntry (edit / delete / regenerate)', () => {
  const log = [
    { id: 'sys-1', type: 'system', text: 'You arrive at the archive.' },
    { id: 'usr-1', type: 'user', text: 'Do you keep records?' },
    { id: 'msg-1', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Always. Every arrival, logged.' },
  ];

  async function seed(db) {
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: log.map((e) => formatEntry(e, 'Kael')).join('\n'),
      placeId: 'archive-house',
      entryIds: log.map((e) => e.id),
      day: 1, timeOfDay: 'morning',
    });
  }

  test('editing an entry rebuilds every witnessing character\'s memory with the new text', () => withDb(async (db) => {
    await seed(db);
    const edited = log.map((e) => e.id === 'msg-1' ? { ...e, text: 'I burned the records years ago.' } : e);

    const rebuilt = await syncMemoriesForEntry({ db, embedFn, entryId: 'msg-1', newEntryIds: null, log: edited, userLabel: 'Kael', formatEntry });
    assert.equal(rebuilt, 1); // one shared row, witnessed by both — updating it updates both at once

    for (const cid of ['ezra', 'soot']) {
      const [mem] = listCharacterMemories(db, cid);
      assert.ok(mem.text.includes('burned the records'));
      assert.ok(!mem.text.includes('Every arrival, logged'));
      assert.ok(mem.text.startsWith('(Day 1 (Monday), morning)')); // time prefix preserved
    }
  }));

  test('deleting an entry removes it from the rebuilt memories', () => withDb(async (db) => {
    await seed(db);
    const without = log.filter((e) => e.id !== 'msg-1');

    await syncMemoriesForEntry({ db, embedFn, entryId: 'msg-1', newEntryIds: [], log: without, userLabel: 'Kael', formatEntry });
    const [mem] = listCharacterMemories(db, 'ezra');
    assert.ok(!mem.text.includes('logged'));
    assert.ok(mem.text.includes('Do you keep records?')); // the rest of the turn survives
  }));

  test('a memory whose every entry is deleted is removed outright', () => withDb(async (db) => {
    await seed(db);
    let current = [...log];
    for (const id of ['sys-1', 'usr-1', 'msg-1']) {
      current = current.filter((e) => e.id !== id);
      await syncMemoriesForEntry({ db, embedFn, entryId: id, newEntryIds: [], log: current, userLabel: 'Kael', formatEntry });
    }
    assert.deepEqual(listCharacterMemories(db, 'ezra'), []);
    assert.deepEqual(listCharacterMemories(db, 'soot'), []);
  }));

  test('regeneration relinks memories to the replacement entries and rebuilds text', () => withDb(async (db) => {
    await seed(db);
    const regenerated = [
      ...log.filter((e) => e.id !== 'msg-1'),
      { id: 'msg-2', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Naturally. Though some volumes went missing.' },
    ];

    await syncMemoriesForEntry({ db, embedFn, entryId: 'msg-1', newEntryIds: ['msg-2'], log: regenerated, userLabel: 'Kael', formatEntry });

    for (const cid of ['ezra', 'soot']) {
      const [mem] = listCharacterMemories(db, cid);
      assert.ok(mem.text.includes('volumes went missing'));
      assert.ok(!mem.text.includes('Every arrival, logged'));
    }
    // Junction now points at msg-2, not msg-1 — one link, not one per character.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE entry_id = ?').get('msg-1').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE entry_id = ?').get('msg-2').n, 1);
  }));

  test('no-op when the entry has no linked memories', () => withDb(async (db) => {
    assert.equal(await syncMemoriesForEntry({ db, embedFn, entryId: 'ghost', newEntryIds: [], log: [], userLabel: 'Kael', formatEntry }), 0);
  }));

  test('a rebuild preserves a linked narrator entry\'s contribution, not just system/user/char', () => withDb(async (db) => {
    const withNarrator = [
      { id: 'sys-1', type: 'system', text: 'You arrive at the archive.' },
      { id: 'usr-1', type: 'user', text: 'Do you keep records?' },
      { id: 'msg-1', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Always.' },
      { id: 'narr-1', type: 'narrator', text: 'A bell tolls somewhere distant.' },
    ];
    await recordTurn({
      db, embedFn, characterIds: ['ezra'], personaId: 'kael',
      text: withNarrator.map((e) => formatEntry(e, 'Kael')).join('\n'),
      entryIds: withNarrator.map((e) => e.id),
    });

    // Editing an unrelated entry in the same round triggers rebuildMemories
    // — the narrator's line must survive that rebuild, not get silently
    // dropped for not being system/user/char.
    const edited = withNarrator.map((e) => e.id === 'msg-1' ? { ...e, text: 'Always, without fail.' } : e);
    await syncMemoriesForEntry({ db, embedFn, entryId: 'msg-1', newEntryIds: null, log: edited, userLabel: 'Kael', formatEntry });

    const [mem] = listCharacterMemories(db, 'ezra');
    assert.ok(mem.text.includes('bell tolls somewhere distant'));
    assert.ok(mem.text.includes('without fail'));
  }));
});

describe('detachEntryFromMemories / attachEntriesToMemories (regenerate\'s two-phase update)', () => {
  const log = [
    { id: 'sys-1', type: 'system', text: 'You arrive at the archive.' },
    { id: 'usr-1', type: 'user', text: 'Do you keep records?' },
    { id: 'msg-1', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Always. Every arrival, logged.' },
  ];

  async function seed(db) {
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: log.map((e) => formatEntry(e, 'Kael')).join('\n'),
      placeId: 'archive-house',
      entryIds: log.map((e) => e.id),
      day: 1, timeOfDay: 'morning',
    });
  }

  test('findMemoriesWitnessing finds the shared row linked to an entry; nothing for an unlinked one', () => withDb(async (db) => {
    await seed(db);
    assert.equal(findMemoriesWitnessing(db, 'msg-1').length, 1); // one shared row, not one per character
    assert.equal(findMemoriesWitnessing(db, 'usr-1').length, 1); // same shared round row
    assert.deepEqual(findMemoriesWitnessing(db, 'ghost'), []);
  }));

  test('detachEntryFromMemories strips the reply\'s own contribution but keeps the rest of the round (e.g. the user\'s message)', () => withDb(async (db) => {
    await seed(db);
    const memoryIds = findMemoriesWitnessing(db, 'msg-1');
    const withoutTarget = log.filter((e) => e.id !== 'msg-1');

    const rebuilt = await detachEntryFromMemories({ db, embedFn, memoryIds, entryId: 'msg-1', log: withoutTarget, userLabel: 'Kael', formatEntry });
    assert.equal(rebuilt, 1);

    for (const cid of ['ezra', 'soot']) {
      const [mem] = listCharacterMemories(db, cid);
      assert.ok(!mem.text.includes('Every arrival, logged'));
      assert.ok(mem.text.includes('Do you keep records?'));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE entry_id = ?').get('msg-1').n, 0);
  }));

  test('a stale reply is gone from retrieval the moment it is detached — before any replacement exists', () => withDb(async (db) => {
    await seed(db);
    const memoryIds = findMemoriesWitnessing(db, 'msg-1');
    await detachEntryFromMemories({ db, embedFn, memoryIds, entryId: 'msg-1', log: log.filter((e) => e.id !== 'msg-1'), userLabel: 'Kael', formatEntry });

    // This mirrors what a regeneration's own memory retrieval would see in
    // between the detach and the new reply existing — it must never surface
    // text quoting the reply that's about to be thrown away.
    const memories = await retrieveMemories({ db, embedFn, characterIds: ['ezra'], personaId: 'kael', query: 'records', recentPerCharacter: 1, topKPerCharacter: 1 });
    assert.ok(!memories.some((m) => m.includes('Every arrival, logged')));
  }));

  test('attachEntriesToMemories relinks the same rows to the new entries and rebuilds text', () => withDb(async (db) => {
    await seed(db);
    const memoryIds = findMemoriesWitnessing(db, 'msg-1');
    await detachEntryFromMemories({ db, embedFn, memoryIds, entryId: 'msg-1', log: log.filter((e) => e.id !== 'msg-1'), userLabel: 'Kael', formatEntry });

    const regenerated = [
      ...log.filter((e) => e.id !== 'msg-1'),
      { id: 'msg-2', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Naturally. Though some volumes went missing.' },
    ];
    const rebuilt = await attachEntriesToMemories({ db, embedFn, memoryIds, newEntryIds: ['msg-2'], log: regenerated, userLabel: 'Kael', formatEntry });
    assert.equal(rebuilt, 1);

    for (const cid of ['ezra', 'soot']) {
      const [mem] = listCharacterMemories(db, cid);
      assert.ok(mem.text.includes('volumes went missing'));
      assert.ok(!mem.text.includes('Every arrival, logged'));
      assert.ok(mem.text.includes('Do you keep records?')); // the user's message survived both phases
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE entry_id = ?').get('msg-2').n, 1);
  }));

  test('both helpers are no-ops when there is nothing to detach/attach', () => withDb(async (db) => {
    assert.equal(await detachEntryFromMemories({ db, embedFn, memoryIds: [], entryId: 'ghost', log: [], userLabel: 'Kael', formatEntry }), 0);
    assert.equal(await attachEntriesToMemories({ db, embedFn, memoryIds: [], newEntryIds: ['x'], log: [], userLabel: 'Kael', formatEntry }), 0);
    await seed(db);
    const memoryIds = findMemoriesWitnessing(db, 'msg-1');
    assert.equal(await attachEntriesToMemories({ db, embedFn, memoryIds, newEntryIds: [], log, userLabel: 'Kael', formatEntry }), 0);
  }));
});

describe('pruneReplylessMemories (/retry cleanup)', () => {
  const log = [
    { id: 'usr-1', type: 'user', text: 'Do you keep records?' },
    { id: 'msg-1', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Always. Every arrival, logged.' },
  ];

  async function seed(db) {
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: log.map((e) => formatEntry(e, 'Kael')).join('\n'),
      entryIds: log.map((e) => e.id),
    });
  }

  test('deletes rows whose only surviving entry is the user\'s message', () => withDb(async (db) => {
    await seed(db);
    const memoryIds = findMemoriesWitnessing(db, 'usr-1');
    assert.equal(memoryIds.length, 1); // one shared row, not one per character

    // The character reply is gone from the log (deleted, as "remove every
    // character message" does) — only the user's message survives.
    const withoutReply = log.filter((e) => e.id !== 'msg-1');
    const pruned = pruneReplylessMemories(db, memoryIds, withoutReply);
    assert.equal(pruned, 1);
    assert.deepEqual(listCharacterMemories(db, 'ezra'), []);
    assert.deepEqual(listCharacterMemories(db, 'soot'), []);
  }));

  test('leaves rows alone that still have a surviving character reply', () => withDb(async (db) => {
    await seed(db);
    const memoryIds = findMemoriesWitnessing(db, 'usr-1');
    const pruned = pruneReplylessMemories(db, memoryIds, log); // msg-1 still present
    assert.equal(pruned, 0);
    assert.equal(listCharacterMemories(db, 'ezra').length, 1);
  }));

  test('a full delete-all-replies-then-retry cycle leaves exactly one memory row per character, not a stack of stale ones', () => withDb(async (db) => {
    await seed(db);

    // User deletes Ezra's only reply (mirrors the DELETE /messages route),
    // leaving a row with just the user's message linked.
    let current = log.filter((e) => e.id !== 'msg-1');

    // /retry: prune stale reply-less rows for the trigger message, then
    // record the fresh round exactly like recordRound would.
    pruneReplylessMemories(db, findMemoriesWitnessing(db, 'usr-1'), current);
    current = [...current, { id: 'msg-2', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Naturally, every visitor.' }];
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: current.map((e) => formatEntry(e, 'Kael')).join('\n'),
      entryIds: current.map((e) => e.id),
    });

    // Simulate a second delete-and-retry cycle on top of the first.
    current = current.filter((e) => e.id !== 'msg-2');
    pruneReplylessMemories(db, findMemoriesWitnessing(db, 'usr-1'), current);
    current = [...current, { id: 'msg-3', type: 'char', charId: 'ezra', name: 'Ezra', text: 'Every single one, without fail.' }];
    await recordTurn({
      db, embedFn, characterIds: ['ezra', 'soot'], personaId: 'kael',
      text: current.map((e) => formatEntry(e, 'Kael')).join('\n'),
      entryIds: current.map((e) => e.id),
    });

    for (const cid of ['ezra', 'soot']) {
      const memories = listCharacterMemories(db, cid);
      assert.equal(memories.length, 1); // not 2 or 3 — no stale echoes left over
      assert.ok(memories[0].text.includes('without fail'));
    }
  }));

  test('no-op when nothing is reply-less', () => withDb((db) => {
    assert.equal(pruneReplylessMemories(db, [], []), 0);
  }));
});
