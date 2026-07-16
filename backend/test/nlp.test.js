import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEntities } from '../lib/nlp.js';

describe('aggregateEntities', () => {
  test('a single-piece entity passes through', () => {
    const out = aggregateEntities([
      { entity: 'B-PER', word: 'Ezra', score: 0.99 },
    ]);
    assert.deepEqual(out, [{ type: 'PER', text: 'Ezra', score: 0.99 }]);
  });

  test('merges wordpieces of one word split as B- then I- (the normal case)', () => {
    const out = aggregateEntities([
      { entity: 'B-PER', word: 'Sh', score: 0.8 },
      { entity: 'I-PER', word: '##adow', score: 0.6 },
    ]);
    assert.deepEqual(out, [{ type: 'PER', text: 'Shadow', score: 0.6 }]);
  });

  test('merges wordpieces even when the model re-predicts a fresh B- mid-word instead of I-', () => {
    // The bug that produced "S" + "##shad" as two separate entities: same
    // type, but the second piece got a "B-" instead of "I-". Word-level
    // grouping (by "##", a tokenizer fact) reconstructs the whole word
    // regardless of what tag its later pieces got.
    const out = aggregateEntities([
      { entity: 'B-PER', word: 'S', score: 0.7 },
      { entity: 'B-PER', word: '##had', score: 0.55 },
      { entity: 'I-PER', word: '##run', score: 0.65 },
    ]);
    assert.deepEqual(out, [{ type: 'PER', text: 'Shadrun', score: 0.55 }]); // score is the min across pieces
  });

  test('reconstructs a word whose interior wordpiece was tagged "O" (the "Fluffy" -> "Fffy" bug)', () => {
    // "Fluffy" tokenized as ["F", "##lu", "##ffy"], with the middle piece
    // mistagged "O". Without that piece present, "F" and "##ffy" look
    // adjacent and naively concatenate into "Fffy". Keeping the "O" token
    // (ignore_labels: []) means groupIntoWords still sees it and can
    // reconstruct the whole word using the "##" markers alone.
    const out = aggregateEntities([
      { entity: 'B-PER', word: 'F', score: 0.7 },
      { entity: 'O', word: '##lu', score: 0.9 },
      { entity: 'B-PER', word: '##ffy', score: 0.5 },
    ]);
    assert.deepEqual(out, [{ type: 'PER', text: 'Fluffy', score: 0.5 }]);
  });

  test('does not merge two distinct back-to-back entities of the same type ("B-" always starts fresh)', () => {
    const out = aggregateEntities([
      { entity: 'B-PER', word: 'Ezra', score: 0.9 },
      { entity: 'B-PER', word: 'Mireille', score: 0.85 },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.text), ['Ezra', 'Mireille']);
  });

  test('merges a legitimate multi-word name across a real word boundary via I-', () => {
    const out = aggregateEntities([
      { entity: 'B-PER', word: 'John', score: 0.95 },
      { entity: 'I-PER', word: 'Smith', score: 0.9 },
    ]);
    assert.deepEqual(out, [{ type: 'PER', text: 'John Smith', score: 0.9 }]);
  });

  test('drops ORG/MISC entities, keeps only PER/LOC', () => {
    const out = aggregateEntities([
      { entity: 'B-ORG', word: 'Acme', score: 0.9 },
      { entity: 'B-LOC', word: 'Market', score: 0.9 },
      { entity: 'B-MISC', word: 'Thing', score: 0.9 },
    ]);
    assert.deepEqual(out, [{ type: 'LOC', text: 'Market', score: 0.9 }]);
  });

  test('ignores plain "O" tokens with no entity at all', () => {
    const out = aggregateEntities([
      { entity: 'O', word: 'The', score: 0.99 },
      { entity: 'O', word: 'cat', score: 0.99 },
      { entity: 'B-PER', word: 'Ezra', score: 0.9 },
    ]);
    assert.deepEqual(out, [{ type: 'PER', text: 'Ezra', score: 0.9 }]);
  });

  test('handles an empty list', () => {
    assert.deepEqual(aggregateEntities([]), []);
  });
});
