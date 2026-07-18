import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { embed } from '../lib/embeddings.js';
import { cosineSimilarity } from '../lib/memoryStore.js';

// These exercise the real local model (Xenova/bge-small-en-v1.5 via
// @huggingface/transformers), not a fake. The first run downloads and
// caches the model from the Hugging Face hub, so this needs network
// access once and is slower than the rest of the suite — hence the longer
// per-test timeout.
const MODEL_TIMEOUT_MS = 120_000;

describe('embed (real local model)', () => {
  test('returns a fixed-length array of finite numbers', async () => {
    const vector = await embed('The archivist keeps meticulous records.');
    assert.ok(Array.isArray(vector));
    assert.equal(vector.length, 384); // bge-small-en-v1.5 output dimension
    vector.forEach(n => assert.equal(Number.isFinite(n), true));
  }, { timeout: MODEL_TIMEOUT_MS });

  test('is deterministic for the same input', async () => {
    const a = await embed('A quiet wanderer who names stray cats.');
    const b = await embed('A quiet wanderer who names stray cats.');
    assert.deepEqual(a, b);
  }, { timeout: MODEL_TIMEOUT_MS });

  test('similar sentences score higher than unrelated ones', async () => {
    const query = await embed('The visitor asked Ezra about the old records.');
    const related = await embed('Ezra talked about his archive of old records.');
    const unrelated = await embed('Soot the cat ignored everyone and went to sleep.');

    const relatedScore = cosineSimilarity(query, related);
    const unrelatedScore = cosineSimilarity(query, unrelated);
    assert.ok(
      relatedScore > unrelatedScore,
      `expected related (${relatedScore}) > unrelated (${unrelatedScore})`
    );
  }, { timeout: MODEL_TIMEOUT_MS });
});
