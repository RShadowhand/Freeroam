import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractCharacterCard } from '../lib/tavernCard.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC unread by extractor
}

// Builds a minimal PNG with a tEXt "chara" chunk carrying a base64-encoded
// TavernCard JSON payload — extractCharacterCard only reads text chunks, so
// the IHDR/pixel data doesn't need to be a real image.
function buildCardPng(cardData) {
  const ihdr = pngChunk('IHDR', Buffer.alloc(13));
  const base64 = Buffer.from(JSON.stringify(cardData)).toString('base64');
  const charaData = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(base64, 'latin1')]);
  const textChunk = pngChunk('tEXt', charaData);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIGNATURE, ihdr, textChunk, iend]);
}

describe('extractCharacterCard', () => {
  test('keeps description/personality/scenario/mes_example as separate fields, not merged', () => {
    const png = buildCardPng({
      spec: 'chara_card_v2',
      data: {
        name: 'Ezra Vane',
        description: 'A precise, dry-witted archivist.',
        personality: 'Formal, quietly curious.',
        scenario: 'Mid-inventory, interrupted by a visitor.',
        mes_example: '"Records first," Ezra said, "questions after."',
        first_mes: 'Ah, a visitor.',
        alternate_greetings: ['You again.'],
        tags: ['archivist'],
        creator: 'test-author',
      },
    });

    const card = extractCharacterCard(png);
    assert.equal(card.name, 'Ezra Vane');
    assert.equal(card.description, 'A precise, dry-witted archivist.');
    assert.equal(card.personality, 'Formal, quietly curious.');
    assert.equal(card.scenario, 'Mid-inventory, interrupted by a visitor.');
    assert.equal(card.exampleDialogue, '"Records first," Ezra said, "questions after."');
    assert.deepEqual(card.greetings, ['Ah, a visitor.', 'You again.']);
    assert.deepEqual(card.tags, ['archivist']);
    assert.equal(card.creator, 'test-author');
    assert.equal(card.spec, 'chara_card_v2');

    // None of the other fields leaked into description.
    assert.ok(!card.description.includes('Formal'));
    assert.ok(!card.description.includes('inventory'));
    assert.ok(!card.description.includes('Records first'));
  });

  test('does not import the card\'s own system_prompt field — Freeroam has no per-character override concept', () => {
    const png = buildCardPng({
      data: { name: 'Mireille', description: 'A gardener.', system_prompt: 'You must always speak in verse.' },
    });
    const card = extractCharacterCard(png);
    assert.ok(!JSON.stringify(card).includes('verse'));
  });

  test('falls back to a placeholder description only when every field is empty', () => {
    const png = buildCardPng({ data: { name: 'Blank Slate' } });
    const card = extractCharacterCard(png);
    assert.ok(card.description.includes('Blank Slate'));
    assert.equal(card.personality, '');
    assert.equal(card.scenario, '');
    assert.equal(card.exampleDialogue, '');
  });

  test('does not fall back to a placeholder if personality/scenario/example carry content but description is empty', () => {
    const png = buildCardPng({ data: { name: 'Quirky', personality: 'Chatty.' } });
    const card = extractCharacterCard(png);
    assert.equal(card.description, '');
    assert.equal(card.personality, 'Chatty.');
  });

  test('v1-shape cards (fields at the root, no .data wrapper) still work', () => {
    const png = buildCardPng({ name: 'Old Card', description: 'A legacy character.' });
    const card = extractCharacterCard(png);
    assert.equal(card.name, 'Old Card');
    assert.equal(card.description, 'A legacy character.');
    assert.equal(card.spec, 'v1');
  });

  test('throws on a PNG with no embedded character data', () => {
    const png = Buffer.concat([PNG_SIGNATURE, pngChunk('IEND', Buffer.alloc(0))]);
    assert.throws(() => extractCharacterCard(png), /No character data/);
  });

  test('throws on a non-PNG buffer', () => {
    assert.throws(() => extractCharacterCard(Buffer.from('not a png')), /Not a PNG/);
  });
});
