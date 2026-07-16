import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeContextNumber,
  normalizePromptList,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_REPLY_TOKENS,
} from '../lib/presets.js';

describe('normalizeContextNumber', () => {
  test('accepts a positive number', () => {
    assert.equal(normalizeContextNumber(4096, DEFAULT_CONTEXT_LENGTH), 4096);
  });

  test('accepts a numeric string', () => {
    assert.equal(normalizeContextNumber('8192', DEFAULT_CONTEXT_LENGTH), 8192);
  });

  test('floors a fractional value', () => {
    assert.equal(normalizeContextNumber(300.7, DEFAULT_MAX_REPLY_TOKENS), 300);
  });

  test('falls back on zero', () => {
    assert.equal(normalizeContextNumber(0, DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
  });

  test('falls back on a negative number', () => {
    assert.equal(normalizeContextNumber(-500, DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
  });

  test('falls back on undefined/null/non-numeric', () => {
    assert.equal(normalizeContextNumber(undefined, DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
    assert.equal(normalizeContextNumber(null, DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
    assert.equal(normalizeContextNumber('not a number', DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
    assert.equal(normalizeContextNumber(NaN, DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
    assert.equal(normalizeContextNumber(Infinity, DEFAULT_CONTEXT_LENGTH), DEFAULT_CONTEXT_LENGTH);
  });
});

describe('normalizePromptList', () => {
  test('returns an empty array for non-array input', () => {
    assert.deepEqual(normalizePromptList(undefined), []);
    assert.deepEqual(normalizePromptList(null), []);
    assert.deepEqual(normalizePromptList('nope'), []);
  });

  test('fills in a fallback identifier and name when missing', () => {
    const [p] = normalizePromptList([{}]);
    assert.equal(p.identifier, 'prompt-0');
    assert.equal(p.name, 'Prompt 1');
  });

  test('preserves a given identifier and name', () => {
    const [p] = normalizePromptList([{ identifier: 'main', name: 'Main Prompt' }]);
    assert.equal(p.identifier, 'main');
    assert.equal(p.name, 'Main Prompt');
  });

  test('coerces an invalid role to "system"', () => {
    const [p] = normalizePromptList([{ role: 'narrator' }]);
    assert.equal(p.role, 'system');
  });

  test('accepts valid roles as-is', () => {
    const [a, b, c] = normalizePromptList([{ role: 'system' }, { role: 'user' }, { role: 'assistant' }]);
    assert.equal(a.role, 'system');
    assert.equal(b.role, 'user');
    assert.equal(c.role, 'assistant');
  });

  test('defaults content to an empty string', () => {
    const [p] = normalizePromptList([{}]);
    assert.equal(p.content, '');
  });

  test('coerces marker to a boolean', () => {
    const [a, b] = normalizePromptList([{ marker: 'yes' }, {}]);
    assert.equal(a.marker, true);
    assert.equal(b.marker, false);
  });

  test('enabled defaults to true unless explicitly false', () => {
    const [a, b, c] = normalizePromptList([{}, { enabled: false }, { enabled: 'nope' }]);
    assert.equal(a.enabled, true);
    assert.equal(b.enabled, false);
    assert.equal(c.enabled, true); // only the literal value false disables a block
  });
});
