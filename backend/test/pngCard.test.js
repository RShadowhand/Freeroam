import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32, buildPlaceholderPng, buildCharacterCardPng, buildPersonaCardPng, buildPlaceCardPng, appendOrReplaceTextChunk,
} from '../lib/pngCard.js';
import { extractCharacterCard, extractPersonaCard, extractPlaceCard, readChunks } from '../lib/tavernCard.js';

describe('crc32', () => {
  test('matches the standard CRC-32 test vector for "123456789"', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });
});

describe('buildPlaceholderPng', () => {
  test('produces a structurally valid PNG (IHDR, IDAT, IEND) readable by readChunks', () => {
    const png = buildPlaceholderPng({ color: 'hsl(200, 55%, 62%)' });
    const types = readChunks(png).map((c) => c.type);
    assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  });

  test('IHDR encodes the requested width/height', () => {
    const png = buildPlaceholderPng({ width: 64, height: 32, color: 'hsl(0, 0%, 0%)' });
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR');
    assert.equal(ihdr.data.readUInt32BE(0), 64);
    assert.equal(ihdr.data.readUInt32BE(4), 32);
  });

  test('falls back to a neutral color when given an unparsable color string', () => {
    assert.doesNotThrow(() => buildPlaceholderPng({ color: 'not-a-color' }));
    assert.doesNotThrow(() => buildPlaceholderPng({}));
  });
});

describe('appendOrReplaceTextChunk', () => {
  test('a re-export never leaves a stale duplicate keyword behind', () => {
    const first = appendOrReplaceTextChunk(buildPlaceholderPng({ color: 'hsl(0,50%,50%)' }), 'chara', Buffer.from('v1').toString('base64'));
    const second = appendOrReplaceTextChunk(first, 'chara', Buffer.from('v2').toString('base64'));
    const keyworded = readChunks(second).filter((c) => (c.type === 'tEXt' || c.type === 'zTXt'));
    assert.equal(keyworded.length, 1);
  });

  test('leaves an unrelated keyword untouched', () => {
    const withPersona = appendOrReplaceTextChunk(buildPlaceholderPng({ color: 'hsl(0,50%,50%)' }), 'persona', Buffer.from('p').toString('base64'));
    const withBoth = appendOrReplaceTextChunk(withPersona, 'chara', Buffer.from('c').toString('base64'));
    const keyworded = readChunks(withBoth).filter((c) => (c.type === 'tEXt' || c.type === 'zTXt'));
    assert.equal(keyworded.length, 2);
  });

  // Builds a raw (uncompressed) iTXt chunk by hand — tavernCard.js's reader
  // already supports cards stored this way, but until now appendOrReplace-
  // TextChunk's same-keyword strip only recognized tEXt/zTXt.
  function rawChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
  }
  function buildRawITXtChunk(keyword, text) {
    const data = Buffer.concat([
      Buffer.from(keyword, 'utf8'), Buffer.from([0]), // keyword + NUL
      Buffer.from([0, 0]),                             // compression flag + method (both 0 — not compressed)
      Buffer.from([0]),                                 // language tag (empty) + NUL
      Buffer.from([0]),                                 // translated keyword (empty) + NUL
      Buffer.from(text, 'utf8'),
    ]);
    return rawChunk('iTXt', data);
  }
  function insertBeforeIEND(pngBuffer, chunkBuffer) {
    const parts = [pngBuffer.subarray(0, 8)]; // PNG signature
    for (const chunk of readChunks(pngBuffer)) {
      if (chunk.type === 'IEND') parts.push(chunkBuffer);
      parts.push(rawChunk(chunk.type, chunk.data));
    }
    return Buffer.concat(parts);
  }

  test('also strips a same-keyword iTXt chunk, not just tEXt/zTXt', () => {
    const base = buildPlaceholderPng({ color: 'hsl(0,50%,50%)' });
    const withStaleITXt = insertBeforeIEND(base, buildRawITXtChunk('chara', 'stale-itxt-payload'));
    assert.ok(readChunks(withStaleITXt).some((c) => c.type === 'iTXt'), 'test setup sanity check');

    const result = appendOrReplaceTextChunk(withStaleITXt, 'chara', Buffer.from('fresh').toString('base64'));
    const keyworded = readChunks(result).filter((c) => c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt');
    assert.equal(keyworded.length, 1, 'the stale iTXt chunk should have been stripped, leaving only the fresh zTXt chunk');
    assert.equal(keyworded[0].type, 'zTXt');
  });
});

describe('buildCharacterCardPng / extractCharacterCard round trip', () => {
  test('recovers every field, using a generated placeholder when there is no avatar', () => {
    const character = {
      id: 'ezra', name: 'Ezra Vane', description: 'An archivist.', personality: 'Dry-witted.',
      scenario: 'Mid-inventory.', exampleDialogue: '"Records first."', greetings: ['Ah, a visitor.', 'You again.'],
      tags: ['archivist'], creator: 'test-author',
    };
    const png = buildCharacterCardPng({ character });
    const decoded = extractCharacterCard(png);
    assert.equal(decoded.name, character.name);
    assert.equal(decoded.description, character.description);
    assert.equal(decoded.personality, character.personality);
    assert.equal(decoded.scenario, character.scenario);
    assert.equal(decoded.exampleDialogue, character.exampleDialogue);
    assert.deepEqual(decoded.greetings, character.greetings);
    assert.deepEqual(decoded.tags, character.tags);
    assert.equal(decoded.creator, character.creator);
    assert.equal(decoded.spec, 'chara_card_v2');
  });

  test('embeds the chunk into an existing avatar image rather than a placeholder when baseImageBuffer is given', () => {
    const baseImage = buildPlaceholderPng({ width: 16, height: 16, color: 'hsl(90, 40%, 40%)' });
    const png = buildCharacterCardPng({ character: { id: 'a', name: 'A', greetings: [] }, baseImageBuffer: baseImage });
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR');
    assert.equal(ihdr.data.readUInt32BE(0), 16); // the base image's dimensions survived, not a fresh 256x256 placeholder
  });

  test('re-exporting a card built from a previous card does not duplicate the chara chunk', () => {
    const first = buildCharacterCardPng({ character: { id: 'ezra', name: 'Ezra', greetings: [] } });
    const second = buildCharacterCardPng({ character: { id: 'ezra', name: 'Ezra Vane', greetings: [] }, baseImageBuffer: first });
    const keyworded = readChunks(second).filter((c) => c.type === 'tEXt' || c.type === 'zTXt');
    assert.equal(keyworded.length, 1);
    assert.equal(extractCharacterCard(second).name, 'Ezra Vane');
  });
});

describe('buildPersonaCardPng / extractPersonaCard round trip', () => {
  test('recovers name/description', () => {
    const png = buildPersonaCardPng({ persona: { id: 'p1', name: 'Kael', description: 'A quiet wanderer.' } });
    assert.deepEqual(extractPersonaCard(png), { name: 'Kael', description: 'A quiet wanderer.' });
  });

  test('falls back to a placeholder when no baseImageBuffer is given (e.g. a jpg/webp avatar)', () => {
    const png = buildPersonaCardPng({ persona: { id: 'p1', name: 'Kael', description: '' } });
    assert.deepEqual(readChunks(png).map((c) => c.type).filter((t) => t === 'IHDR' || t === 'IDAT' || t === 'IEND'), ['IHDR', 'IDAT', 'IEND']);
  });
});

describe('buildPlaceCardPng / extractPlaceCard round trip', () => {
  test('recovers name/desc/type/area (ownerNames are embedded but not part of the place shape decoded elsewhere)', () => {
    const png = buildPlaceCardPng({
      place: { id: 'home', name: "Shad's Living Room", desc: 'Cozy.', type: 'private', area: "Shad's Home" },
      ownerNames: ['Shad'],
    });
    assert.deepEqual(extractPlaceCard(png), { name: "Shad's Living Room", desc: 'Cozy.', type: 'private', area: "Shad's Home" });
  });

  test('a communal place round-trips its type correctly', () => {
    const png = buildPlaceCardPng({ place: { id: 'square', name: 'Town Square', desc: '', type: 'communal', area: 'Downtown' } });
    assert.equal(extractPlaceCard(png).type, 'communal');
  });
});
