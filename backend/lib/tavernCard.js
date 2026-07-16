import zlib from 'zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file.');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);
    chunks.push({ type, data });
    offset = dataStart + length + 4; // skip CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

// Reads tEXt / zTXt / iTXt chunks into a { keyword: text } map.
function readTextChunks(buffer) {
  const result = {};
  for (const chunk of readChunks(buffer)) {
    try {
      if (chunk.type === 'tEXt') {
        const nul = chunk.data.indexOf(0);
        const keyword = chunk.data.toString('latin1', 0, nul);
        result[keyword] = chunk.data.toString('latin1', nul + 1);
      } else if (chunk.type === 'zTXt') {
        const nul = chunk.data.indexOf(0);
        const keyword = chunk.data.toString('latin1', 0, nul);
        const compressed = chunk.data.subarray(nul + 2); // skip null + compression-method byte
        result[keyword] = zlib.inflateSync(compressed).toString('utf8');
      } else if (chunk.type === 'iTXt') {
        let idx = chunk.data.indexOf(0);
        const keyword = chunk.data.toString('utf8', 0, idx);
        idx += 1;
        const compressed = chunk.data[idx] === 1;
        idx += 2; // compression flag + compression method
        const langEnd = chunk.data.indexOf(0, idx);
        idx = langEnd + 1;
        const translatedEnd = chunk.data.indexOf(0, idx);
        idx = translatedEnd + 1;
        const rest = chunk.data.subarray(idx);
        result[keyword] = compressed ? zlib.inflateSync(rest).toString('utf8') : rest.toString('utf8');
      }
    } catch {
      // skip unreadable chunk, keep looking at the rest
    }
  }
  return result;
}

// Extracts and normalizes a TavernCard (v1 or v2/v3) embedded in a character PNG.
export function extractCharacterCard(buffer) {
  const texts = readTextChunks(buffer);
  const raw = texts['chara'] || texts['ccv3'];
  if (!raw) {
    throw new Error('No character data found in this PNG — is it a TavernCard-format export?');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error('Character data in this PNG could not be decoded as JSON.');
  }

  // v2/v3 cards wrap fields in `.data`; legacy v1 cards have them at the root.
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;

  const name = (data.name || 'Unnamed').trim();
  const description = (data.description || '').trim();
  const personality = (data.personality || '').trim();
  const scenario = (data.scenario || '').trim();
  const exampleDialogue = (data.mes_example || '').trim();
  const firstMes = (data.first_mes || '').trim();
  const alternateGreetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim())
    : [];

  // greetings[0] is the card's default first message, if any; the rest are alternates.
  const greetings = [];
  if (firstMes) greetings.push(firstMes);
  greetings.push(...alternateGreetings);

  // Fields stay separate rather than merged into one blob: each becomes its
  // own optional, opt-in-only prompt slot (see context.js's charDescription/
  // charPersonality/charScenario/dialogueExamples markers) instead of always
  // being sent whether relevant or not. The card's own system_prompt field
  // isn't imported — Freeroam has its own preset/system-prompt mechanism, and
  // a per-card override of it isn't a concept this app supports.
  return {
    name,
    description: description || (personality || scenario || exampleDialogue ? '' : `${name}, a character with no further details provided.`),
    personality,
    scenario,
    exampleDialogue,
    greetings,
    tags: Array.isArray(data.tags) ? data.tags : [],
    creator: data.creator || '',
    spec: parsed.spec || 'v1',
  };
}
