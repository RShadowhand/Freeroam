// LLM-mode suggested-action detection — the '.kanbn' research task's Branch
// B, implemented. Unlike 'regex'/'ml'/'hybrid' (lib/suggestedActions.js),
// this asks an LLM to classify intents as plain, grammar-constrained JSON —
// NOT native tool-calling. The research (same task) found grammar-
// constrained JSON via node-llama-cpp's createGrammarForJsonSchema
// noticeably more reliable than native tool-calling for this exact task
// (doesn't depend on the model choosing to emit a <tool_call> trigger
// token) and meaningfully faster (no handler-execution loop). Three model
// sources (cfg.suggestedActionsLlmSource): 'builtin' (this file, local GGUF
// via node-llama-cpp — see detectViaBuiltinLlm), 'same'/'custom' (server.js
// — see detectLlmSuggestedActions there, via the configured/custom
// OpenRouter-compatible endpoint with lenient prompt-based JSON, since a
// remote endpoint's grammar support can't be assumed).
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline as streamPipeline } from 'stream/promises';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import { logger } from './log.js';
import { characterAliases } from './textUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors backend/lib/context.js's own TIMES_OF_DAY exactly (duplicated
// rather than imported — context.js pulls in a much larger prompt-building
// surface this module has no other reason to depend on).
export const TIMES_OF_DAY = ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night'];

const INTENT_TYPES = ['destination', 'new-character', 'promote', 'demote', 'text-someone', 'call-to-scene', 'scheduled-text'];

export const INTENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { enum: INTENT_TYPES },
          to: { type: 'string' },
          when: { enum: ['now', 'later', 'unspecified'] },
          day: { type: 'number' },
          timeOfDay: { enum: TIMES_OF_DAY },
          reason: { type: 'string' },
        },
        required: ['type', 'to', 'when'],
      },
    },
  },
  required: ['intents'],
};

// Bare enum values carry no meaning on their own — the research found the
// model needs each type spelled out (especially text-someone vs.
// scheduled-text, which differ only by "when") or it defaults to whichever
// type it saw first.
const TYPE_MEANINGS = [
  '"destination" = the speaker suggests/invites going to another named place (to = the place name).',
  '"new-character" = the speaker introduces someone not yet known by name (to = the new name).',
  '"promote" = the speaker draws an already-present-but-quiet/background character into the conversation (to = that character\'s name).',
  '"demote" = the speaker excuses themselves or steps back from the conversation (to = the speaker\'s own name).',
  '"text-someone" = sends a text message RIGHT NOW, when: "now" (to = recipient\'s name, or "persona" for the user).',
  '"scheduled-text" = PROMISES to send a text LATER, when: "later", with day/timeOfDay filled in (to = recipient\'s name, or "persona").',
  '"call-to-scene" = physically summons/beckons a character who is not currently present to come to the current location in person — not texting (to = that character\'s name).',
].join(' ');

// The persona's real name is deliberately never included here (see
// buildIntentPrompt) — the research found that showing it invites the model
// to write it back as "to" instead of the literal word "persona", even with
// an explicit instruction not to. Omitting it entirely is more reliable
// than telling the model to ignore something it can see.
export function buildIntentPrompt(text, ctx) {
  const { places = [], characters = [], backgroundCharacters = [], speakerName, precedingUserText, worldDay, worldTimeOfDay } = ctx;
  const knownPlaces = places.map((p) => p.name).join(', ') || 'none';
  const knownChars = characters.map((c) => c.name).filter((n) => n !== speakerName).join(', ') || 'none';
  const bgChars = backgroundCharacters.map((c) => c.name).join(', ') || 'none';

  const systemPrompt = 'You classify intents in a roleplay app. You will see a message from the user (the "persona") and the '
    + 'in-character REPLY that follows it. List every distinct actionable intent the REPLY implies as JSON — a reply can imply '
    + 'more than one intent (e.g. one immediate action and one later action, or actions toward two different people). '
    + `Intent types, exact meanings: ${TYPE_MEANINGS} `
    + 'When an intent is directed at the persona, always write the literal word "persona" as "to" — never a real name. '
    + `Known places: ${knownPlaces}. Known characters: ${knownChars}. Present but quiet (only these can be "promote" targets): ${bgChars}. `
    + 'If the reply implies nothing actionable, return an empty intents array. '
    + 'Output ONLY a single JSON object of the shape {"intents":[...]}, no prose, no markdown fences.';

  const userLines = [];
  if (worldDay != null && worldTimeOfDay) userLines.push(`World: day ${worldDay}, ${worldTimeOfDay}.`);
  if (precedingUserText) userLines.push(`The persona said: "${precedingUserText}"`);
  userLines.push(`${speakerName} (character) replied: "${text}"`);
  userLines.push(`\nList the REPLY's intents as JSON. Speaking character's name: ${speakerName}.`);

  return { systemPrompt, userPrompt: userLines.join('\n') };
}

// Same lenient-extraction contract as the rest of this app's LLM-facing
// parsing (see lib/suggestedActions.js's header comment): a remote endpoint
// can't be trusted to emit bare JSON even when asked to, so this pulls the
// first fenced or balanced-brace JSON object out of whatever text comes
// back, rather than requiring the whole response to be valid JSON.
export function extractJsonLenient(raw) {
  if (!raw) return null;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function matchPlace(name, places) {
  const norm = (name || '').trim().toLowerCase();
  if (!norm) return null;
  return places.find((p) => {
    const pn = p.name.trim().toLowerCase();
    return pn === norm || norm.includes(pn) || pn.includes(norm);
  }) || null;
}

function resolveCharacterByName(name, characters) {
  const norm = (name || '').trim().toLowerCase();
  if (!norm) return null;
  return characters.find((c) => characterAliases(c).some((a) => a.toLowerCase() === norm)) || null;
}

// Turns the model's raw intent list into this app's real suggestion shapes
// (matching lib/suggestedActions.js's existing 4 types exactly, so the
// frontend's existing destination/new-character/promote/demote chip
// handling needs no changes). Never trusts a name as already being an id —
// every reference is re-resolved against the real cast/place list passed in
// via ctx. A malformed single item is skipped, not fatal to the batch
// (per-item try/catch, matching this app's established "worst case is zero
// suggestions, never an error" philosophy for suggestion detection).
export function parseIntents(rawIntents, ctx) {
  const { places = [], characters = [], backgroundCharacters = [], personaName, speakerId, speakerName, currentPlaceId } = ctx;
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(rawIntents) ? rawIntents : []) {
    try {
      if (!raw || typeof raw !== 'object' || !INTENT_TYPES.includes(raw.type)) continue;
      const to = typeof raw.to === 'string' ? raw.to.trim() : '';

      if (raw.type === 'destination') {
        if (!to) continue;
        const place = matchPlace(to, places);
        const key = place ? `dest:${place.id}` : `dest:${to.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (place && place.id !== currentPlaceId) out.push({ type: 'destination', known: true, placeId: place.id, placeName: place.name });
        else if (!place) out.push({ type: 'destination', known: false, placeName: to });
        continue;
      }

      if (raw.type === 'new-character') {
        if (!to) continue;
        const lower = to.toLowerCase();
        if (characters.some((c) => c.name.trim().toLowerCase() === lower)) continue; // already known — not new
        if (personaName && lower === personaName.trim().toLowerCase()) continue;
        const key = `char:${lower}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: 'new-character', name: to });
        continue;
      }

      if (raw.type === 'promote') {
        const match = resolveCharacterByName(to, backgroundCharacters);
        if (!match) continue;
        const key = `promote:${match.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: 'promote', charId: match.id, name: match.name });
        continue;
      }

      if (raw.type === 'demote') {
        if (!speakerId) continue;
        const key = `demote:${speakerId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: 'demote', charId: speakerId, name: speakerName });
        continue;
      }

      // text-someone / scheduled-text / call-to-scene share target resolution.
      if (!to) continue;
      const isPersona = to.toLowerCase() === 'persona';
      const targetChar = isPersona ? null : resolveCharacterByName(to, characters);

      if (raw.type === 'call-to-scene') {
        // An unresolved name isn't callable yet — the research's own schema
        // notes this should prompt "+ Add character" first, which is
        // already what a 'new-character' suggestion offers; no separate
        // handling needed here, this one just doesn't fire without a match.
        if (!targetChar) continue;
        const key = `cts:${targetChar.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: 'call-to-scene', charId: targetChar.id, name: targetChar.name });
        continue;
      }

      const targetKind = isPersona ? 'persona' : 'character';
      const targetName = isPersona ? (personaName || 'the persona') : (targetChar ? targetChar.name : to);
      const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '';

      if (raw.type === 'text-someone') {
        const key = `text:${targetKind}:${targetChar ? targetChar.id : targetName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: 'text-someone', targetKind, charId: targetChar ? targetChar.id : null, targetName, summary: reason });
      } else if (raw.type === 'scheduled-text') {
        const day = Number.isFinite(raw.day) ? raw.day : null;
        const timeOfDay = TIMES_OF_DAY.includes(raw.timeOfDay) ? raw.timeOfDay : null;
        if (day == null || !timeOfDay) continue; // can't schedule without a when
        const key = `sched:${targetKind}:${targetChar ? targetChar.id : targetName.toLowerCase()}:${day}:${timeOfDay}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: 'scheduled-text', targetKind, charId: targetChar ? targetChar.id : null, targetName, day, timeOfDay, reason });
      }
    } catch (err) {
      logger.warn('suggest', `llm intent item skipped: ${err.message}`);
    }
  }

  return out;
}

// --- Built-in local model (node-llama-cpp + Gemma4-E2B-QAT) ---------------
// Same local-first pattern as lib/nlp.js's ONNX models: downloaded once
// (internet-requiring), then run in-process forever after — no per-message
// network call, no dependency on the configured LLM. GGUF/llama.cpp instead
// of ONNX/transformers.js specifically because the research found
// node-llama-cpp's native GBNF-grammar-constrained JSON generation
// (createGrammarForJsonSchema) meaningfully more reliable for this task
// than anything available through transformers.js.

const BUILTIN_MODEL_URL = 'https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B_q4_0-it.gguf';
export const BUILTIN_MODEL_PATH = path.join(__dirname, '..', '.cache', 'llama-models', 'gemma-4-E2B-it-qat-q4_0.gguf');

// Downloads to a `.download` sibling and only renames onto the real path
// once the transfer completes — an interrupted download never leaves a
// partial file where ensureBuiltinModel's existsSync check would mistake it
// for a finished one (same atomic-write convention as this app's config/
// world JSON writes).
async function ensureBuiltinModel() {
  if (fs.existsSync(BUILTIN_MODEL_PATH)) return BUILTIN_MODEL_PATH;
  fs.mkdirSync(path.dirname(BUILTIN_MODEL_PATH), { recursive: true });
  logger.info('suggest', 'downloading built-in LLM model (~3.3GB, one-time)…');
  const res = await fetch(BUILTIN_MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
  const tmpPath = `${BUILTIN_MODEL_PATH}.download`;
  await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, BUILTIN_MODEL_PATH);
  logger.info('suggest', 'built-in LLM model downloaded');
  return BUILTIN_MODEL_PATH;
}

let llamaPromise = null;
let modelPromise = null;
let grammarPromise = null;

async function getBuiltinPieces() {
  if (!llamaPromise) llamaPromise = getLlama();
  const llama = await llamaPromise;
  if (!modelPromise) modelPromise = ensureBuiltinModel().then((modelPath) => llama.loadModel({ modelPath }));
  const model = await modelPromise;
  if (!grammarPromise) grammarPromise = llama.createGrammarForJsonSchema(INTENT_JSON_SCHEMA);
  const grammar = await grammarPromise;
  return { model, grammar };
}

// Never throws — a failed/unavailable local model degrades to "no
// suggestions," same as every other mode in this app.
export async function detectViaBuiltinLlm(text, ctx) {
  let context;
  try {
    const { model, grammar } = await getBuiltinPieces();
    const { systemPrompt, userPrompt } = buildIntentPrompt(text, ctx);
    context = await model.createContext();
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });
    const raw = await session.prompt(userPrompt, { grammar, maxTokens: 700 });
    const parsed = grammar.parse(raw);
    return parseIntents(parsed?.intents, ctx);
  } catch (err) {
    logger.warn('suggest', `built-in LLM suggestion detection failed: ${err.message}`);
    return [];
  } finally {
    if (context) await context.dispose().catch(() => {});
  }
}
