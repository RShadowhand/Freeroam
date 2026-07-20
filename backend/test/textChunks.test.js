import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, MAX_CHUNKS_PER_TEXT } from '../lib/textChunks.js';

describe('chunkText', () => {
  test('empty or blank text produces no chunks', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   '), []);
    assert.deepEqual(chunkText(null), []);
  });

  test('short text stays as a single chunk, unchanged', () => {
    assert.deepEqual(chunkText('Loves cats.'), ['Loves cats.']);
  });

  test('a handful of short sentences merges back into one chunk (no over-splitting)', () => {
    const chunks = chunkText('One sentence here. Another sentence here. A third one.');
    assert.equal(chunks.length, 1);
  });

  test('long multi-sentence text splits into more than one chunk, none far over the target size', () => {
    const sentence = 'This is a moderately long sentence about nothing in particular that repeats itself. ';
    const longText = sentence.repeat(10); // ~870 chars
    const chunks = chunkText(longText);
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    chunks.forEach((c) => assert.ok(c.length <= 450, `chunk too long: ${c.length} chars`));
  });

  test('never exceeds MAX_CHUNKS_PER_TEXT — overflow merges into the last chunk', () => {
    const sentence = 'Short sentence marker here. ';
    const veryLongText = sentence.repeat(50); // far more sentences than MAX_CHUNKS_PER_TEXT chunks could hold 1:1
    const chunks = chunkText(veryLongText);
    assert.ok(chunks.length <= MAX_CHUNKS_PER_TEXT);
  });

  test('splits on newlines (paragraph/entry boundaries) as well as sentences, without losing content', () => {
    const chunks = chunkText('Line one.\nLine two.\nLine three.');
    const joined = chunks.join(' ');
    assert.ok(joined.includes('Line one') && joined.includes('Line two') && joined.includes('Line three'));
  });
});
