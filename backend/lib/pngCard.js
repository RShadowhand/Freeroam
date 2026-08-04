import zlib from 'zlib';
import { readChunks } from './tavernCard.js';
import { colorForId } from './textUtils.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Encoder half of the PNG-card format tavernCard.js reads — kept dependency-
// free (only zlib) to match that file's style, rather than pulling in
// pngjs/png-chunks-*.

// Table-based CRC32 (standard 0xEDB88320 polynomial). Node's zlib.crc32()
// only exists from v20.12+, but backend/package.json declares
// engines: {"node": ">=18"}, so it can't be relied on here.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// zTXt (deflate-compressed), matching the read side's zTXt handling in
// tavernCard.js — a full character card (description/greetings/etc.) can
// run a few KB, and zTXt is the friendlier form for that among real PNG tools.
function buildTextChunk(keyword, text) {
  const compressed = zlib.deflateSync(Buffer.from(text, 'utf8'));
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), compressed]);
  return writeChunk('zTXt', data);
}

// Recognizes tEXt/zTXt/iTXt (matching tavernCard.js's own readTextChunks)
// so appendOrReplaceTextChunk's same-keyword filter below also catches and
// strips a same-keyword iTXt chunk, not just tEXt/zTXt — a card whose
// avatar PNG originally carried its data as iTXt (a form the reader side
// already supports) would otherwise keep that stale copy forever, growing
// the file with duplicate data on every re-export.
function chunkKeyword(chunk) {
  if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt' && chunk.type !== 'iTXt') return null;
  const nul = chunk.data.indexOf(0);
  if (nul === -1) return null;
  // iTXt's keyword is UTF-8; tEXt/zTXt's is latin1.
  return chunk.data.toString(chunk.type === 'iTXt' ? 'utf8' : 'latin1', 0, nul);
}

// Strips any existing chunk with the same keyword first, so a re-export
// never leaves a stale duplicate behind, then inserts the new chunk
// immediately before IEND.
export function appendOrReplaceTextChunk(pngBuffer, keyword, text) {
  const chunks = readChunks(pngBuffer).filter((c) => chunkKeyword(c) !== keyword);
  const newChunk = buildTextChunk(keyword, text);
  const parts = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    if (chunk.type === 'IEND') { parts.push(newChunk); }
    parts.push(writeChunk(chunk.type, chunk.data));
  }
  return Buffer.concat(parts);
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Minimal valid PNG (IHDR + one IDAT + IEND), solid-colored — used whenever
// there's no existing avatar image to embed the card chunk into.
export function buildPlaceholderPng({ width = 256, height = 256, color } = {}) {
  const match = (color || '').match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  const [r, g, b] = match ? hslToRgb(Number(match[1]), Number(match[2]), Number(match[3])) : [128, 128, 128];

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array(height).fill(row));
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', idat),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function baseImage(baseImageBuffer, idForColor) {
  return baseImageBuffer || buildPlaceholderPng({ color: colorForId(idForColor) });
}

// The chunk text is base64 of the JSON, matching real TavernCard convention
// (and what tavernCard.js's decoders expect: Buffer.from(raw, 'base64')).
function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// Same { spec: 'chara_card_v2', data: {...} } shape extractCharacterCard
// already decodes — round-trips with our own importer and real
// SillyTavern-style tools. baseImageBuffer is the character's existing
// avatar file (always literally .png — the only upload path that ever sets
// avatarUrl is the PNG-only card-upload multer) if avatarUrl is set, else a
// generated placeholder tinted with the character's own colorForId.
export function buildCharacterCardPng({ character, baseImageBuffer }) {
  const payload = {
    spec: 'chara_card_v2',
    data: {
      name: character.name,
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      mes_example: character.exampleDialogue || '',
      first_mes: character.greetings?.[0] || '',
      alternate_greetings: (character.greetings || []).slice(1),
      tags: character.tags || [],
      creator: character.creator || '',
    },
  };
  return appendOrReplaceTextChunk(baseImage(baseImageBuffer, character.id), 'chara', encodePayload(payload));
}

// New minimal spec — just the Step 2 plain-JSON export payload embedded in a
// chunk. A persona's avatar can be jpg/webp (unlike a character's, always
// png); embedding a chunk into an existing PNG is simple container-format
// work, but converting a JPEG/WebP into PNG pixel data is real codec work
// this app has no dependency for — baseImageBuffer should only be passed
// when the persona's avatar is already a PNG, otherwise omit it and this
// falls back to the placeholder.
export function buildPersonaCardPng({ persona, baseImageBuffer }) {
  const payload = { spec: 'tavernroam_persona_v1', data: { name: persona.name, description: persona.description || '' } };
  return appendOrReplaceTextChunk(baseImage(baseImageBuffer, persona.id), 'persona', encodePayload(payload));
}

// New minimal spec. ownerNames (resolved display strings), not ownerIds —
// a place card is meant to be shareable into an arbitrary world where the
// original character ids won't resolve (same reasoning as place JSON
// import's unresolvable-ownerIds handling in server.js). Places have no
// avatar concept at all today, so this always uses the placeholder.
export function buildPlaceCardPng({ place, ownerNames = [] }) {
  const payload = {
    spec: 'tavernroam_place_card_v1',
    data: { name: place.name, desc: place.desc || '', type: place.type, area: place.area || '', ownerNames },
  };
  return appendOrReplaceTextChunk(buildPlaceholderPng({ color: colorForId(place.id) }), 'freeroam_place', encodePayload(payload));
}
