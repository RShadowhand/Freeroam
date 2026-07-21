// Context-management + system-prompt assembly. Was previously duplicated
// between frontend/lib/context.mjs (browser) and this file; it now lives
// backend-only — the browser sends { isArrival, log } and gets back reply
// text, with no say in what goes into the request. Kept pure/DOM-free (no
// fetch/express here) so it stays directly unit-testable.
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_REPLY_TOKENS } from './presets.js';

export { DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_REPLY_TOKENS };

// Reserve this fraction of the computed history budget as slack, since
// estimateTokens() is a heuristic, not a real tokenizer (see below).
const CONTEXT_SAFETY_MARGIN = 0.1;

// OpenRouter fronts many providers (Anthropic, OpenAI, Google, Meta, ...)
// that each tokenize differently, so no single exact count is possible here
// without calling every provider's own tokenizer. ~4 characters per token is
// a standard rough approximation for English text; CONTEXT_SAFETY_MARGIN
// compensates for the estimation error on top of this.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function contextSettingsFor(preset) {
  return {
    contextLength: preset && preset.contextLength ? preset.contextLength : DEFAULT_CONTEXT_LENGTH,
    maxReplyTokens: preset && preset.maxReplyTokens ? preset.maxReplyTokens : DEFAULT_MAX_REPLY_TOKENS,
  };
}

// How many tokens are left for chat history once the system prompt, the
// trailing instruction, and the reserved reply budget are accounted for.
export function historyBudget({ contextLength, maxReplyTokens, systemPromptTokens, instructionTokens = 0 }) {
  const reserved = systemPromptTokens + instructionTokens + maxReplyTokens;
  return Math.max(0, Math.floor((contextLength - reserved) * (1 - CONTEXT_SAFETY_MARGIN)));
}

// --- Generation stats (tokens, tokens/sec, timing) -----------------------

// Normalizes an OpenAI-shape `usage` object (present on a non-streaming
// response body, or the final chunk of a stream requesting
// stream_options.include_usage) into what the rest of the app stores.
// completion_tokens_details.reasoning_tokens is an OpenAI/OpenRouter
// extension some models/providers don't report — null when absent rather
// than 0, so callers can tell "no reasoning" apart from "unreported".
export function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    reasoningTokens: Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
      ? usage.completion_tokens_details.reasoning_tokens : null,
  };
}

// Combines a normalized usage object with request timing into the stats
// blob attached to a generated chat entry. tokensPerSec needs both a
// completion-token count and a duration to mean anything — null otherwise,
// rather than a misleading number from a partial reading.
export function buildGenerationStats(usage, timing) {
  if (!usage && !timing) return null;
  const completionTokens = usage?.completionTokens ?? null;
  const totalMs = timing?.totalMs ?? null;
  return {
    promptTokens: usage?.promptTokens ?? null,
    completionTokens,
    reasoningTokens: usage?.reasoningTokens ?? null,
    totalMs,
    ttftMs: timing?.ttftMs ?? null,
    tokensPerSec: (completionTokens && totalMs) ? +(completionTokens / (totalMs / 1000)).toFixed(1) : null,
  };
}

// Scopes a place's log to "this interaction" — everything since (and
// including) the most recent arrival/return system marker — so an old visit
// to the same place doesn't bleed into a fresh one. If there's no system
// marker at all, the whole log is treated as one interaction.
export function sliceSinceLastArrival(log) {
  let start = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === 'system') { start = i; break; }
  }
  return log.slice(start);
}

// Renders one log entry as a transcript line — shared by buildHistoryTranscript
// and by memory recording (which formats a specific slice of entries rather
// than a budget-trimmed window).
export function formatLogEntry(entry, userLabel) {
  if (entry.type === 'system') return `(${entry.text})`;
  if (entry.type === 'user') return `${userLabel}: ${entry.text}`;
  if (entry.type === 'narrator') return entry.text; // unprefixed — reads as scene prose, not a person speaking
  return `${entry.name}: ${entry.text}`;
}

// Builds the transcript sent to the model: scoped to the current
// interaction (see sliceSinceLastArrival), then filled from the most recent
// message backwards until tokenBudget is spent, then restored to
// chronological order. This keeps "now" and trims whatever's oldest, rather
// than truncating the most recent exchange. Always keeps at least the
// single most recent message, even if it alone exceeds budget — an empty
// transcript is worse than a slightly-over-budget one.
export function buildHistoryTranscript(log, { userLabel = 'Visitor', tokenBudget = Infinity } = {}) {
  const relevant = sliceSinceLastArrival(log)
    .filter(m => m.type === 'user' || m.type === 'char' || m.type === 'system' || m.type === 'narrator');

  const kept = [];
  let used = 0;
  for (let i = relevant.length - 1; i >= 0; i--) {
    const line = formatLogEntry(relevant[i], userLabel);
    const cost = estimateTokens(line) + 1; // +1 for the newline joining it to the next line
    if (kept.length > 0 && used + cost > tokenBudget) break;
    kept.push(line);
    used += cost;
  }
  kept.reverse();
  return kept.join('\n');
}

// Maps one log entry to a chat-completion {role, content} message for a
// given speaker's turn: the user's lines are 'user', the speaker's own past
// lines are 'assistant' (no name prefix — it's their own voice), and
// everything else (other characters' lines, system arrival/return markers)
// is folded into 'user' with the source named inline, since the completions
// API only has two conversational roles to work with.
function messageForEntry(entry, { userLabel, speakerId }) {
  if (entry.type === 'system') return { role: 'user', content: `(${entry.text})` };
  if (entry.type === 'user') return { role: 'user', content: `${userLabel}: ${entry.text}` };
  if (entry.type === 'narrator') return { role: 'user', content: entry.text };
  if (entry.charId === speakerId) return { role: 'assistant', content: entry.text };
  return { role: 'user', content: `${entry.name}: ${entry.text}` };
}

// Builds the actual messages[] array sent to the model for one character's
// turn: scoped to the current interaction and budget-trimmed exactly like
// buildHistoryTranscript (newest-first fill, then restored to chronological
// order, always keeping at least the single most recent message) — but
// instead of flattening everything into one blob, each log entry becomes
// its own role-tagged message. Adjacent entries that land on the same role
// are merged into one message afterward, since several providers reject (or
// mishandle) consecutive same-role turns.
export function buildHistoryMessages(log, { userLabel = 'Visitor', speakerId = null, tokenBudget = Infinity } = {}) {
  const relevant = sliceSinceLastArrival(log)
    .filter(m => m.type === 'user' || m.type === 'char' || m.type === 'system' || m.type === 'narrator');

  const kept = [];
  let used = 0;
  for (let i = relevant.length - 1; i >= 0; i--) {
    const message = messageForEntry(relevant[i], { userLabel, speakerId });
    const cost = estimateTokens(message.content) + 1; // +1 for the newline joining it to the next line
    if (kept.length > 0 && used + cost > tokenBudget) break;
    kept.push(message);
    used += cost;
  }
  kept.reverse();

  const merged = [];
  for (const m of kept) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

// --- {{macro}} substitution ---------------------------------------------
// A pared-down version of SillyTavern's macro system: a fixed, known set of
// {{name}} patterns get replaced from the current scene. A macro whose
// underlying value isn't set resolves to an empty string — never a
// placeholder like "the visitor" — so missing context quietly disappears
// instead of reading oddly. Anything not recognized is left as literal
// text, exactly like SillyTavern: this is a small vocabulary, not a
// generic template engine.
const STATIC_MACROS = {
  user: (ctx) => ctx.userName || '',
  char: (ctx) => (ctx.charNames && ctx.charNames.length ? ctx.charNames.join(', ') : ''),
  persona: (ctx) => ctx.personaDescription || '',
  description: (ctx) => ctx.charDescription || '',
  personality: (ctx) => ctx.charPersonality || '',
  scenario: (ctx) => ctx.sceneDescription || '',
  world: (ctx) => ctx.worldSetting || '',
  time: (ctx) => ctx.timeOfDay || '',
  day: (ctx) => (ctx.day === null || ctx.day === undefined ? '' : String(ctx.day)),
  weekday: (ctx) => weekdayFor(ctx.day) || '', // in-world weekday (Day 1 = Monday) — consistent with {{time}}/{{day}}, not the real-world clock
  date: () => new Date().toLocaleDateString(),
  newline: () => '\n',
};

// {{roll:2d6}} — sum of N M-sided dice. Malformed/absurd specs are left as
// literal text rather than silently becoming an empty string, since a typo
// here ("{{roll:xd6}}") is more useful visible than vanished.
function rollDice(spec) {
  const m = (spec || '').trim().match(/^(\d*)d(\d+)$/i);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  if (!count || !sides || count > 100 || sides > 1000) return null;
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total);
}

// {{random:a,b,c}} — one option chosen uniformly at random per generation.
function randomPick(spec) {
  const options = (spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!options.length) return null;
  return options[Math.floor(Math.random() * options.length)];
}

const MACRO_PATTERN = /\{\{([a-z_]+)(?::([^}]*))?\}\}/gi;

export function substituteMacros(text, ctx = {}) {
  if (!text) return text;
  return text.replace(MACRO_PATTERN, (whole, rawName, args) => {
    const name = rawName.toLowerCase();
    if (name === 'random') { const r = randomPick(args); return r === null ? whole : r; }
    if (name === 'roll') { const r = rollDice(args); return r === null ? whole : r; }
    if (args !== undefined) return whole; // "name:args" shape we don't recognize — leave it alone
    if (Object.prototype.hasOwnProperty.call(STATIC_MACROS, name)) return STATIC_MACROS[name](ctx);
    return whole;
  });
}

// The single source of truth for what {{user}}, {{char}}, etc. resolve to
// from a scene — shared by assemblePresetSections (per plain-text block)
// and buildSystemPrompt/defaultSystemPrompt's final pass (which catches
// macros embedded inside world setting / place description / character or
// persona text, however that text entered the prompt).
function macroContextFrom(scene) {
  const { chars = [], place, persona, worldSetting = '', time = null } = scene;
  const speaker = chars[0] || null;
  return {
    userName: persona ? persona.name : '',
    charNames: chars.map((c) => c.name),
    personaDescription: persona ? persona.description : '',
    charDescription: speaker ? speaker.description : '',
    charPersonality: speaker ? speaker.personality : '',
    sceneDescription: place ? place.desc : '',
    worldSetting,
    timeOfDay: time ? time.timeOfDay : '',
    day: time ? time.day : null,
  };
}

// Prompt-preset marker identifiers Freeroam knows how to fill — the same
// identifiers SillyTavern's own Chat Completion prompt manager uses for
// charDescription/charPersonality/scenario/personaDescription/
// worldInfoBefore/dialogueExamples, so a real ST preset import lines up
// slot-for-slot. Anything else (worldInfoAfter, chatHistory, ...) is a
// SillyTavern concept this app has no equivalent for, so it's rendered as
// nothing — harmless on import, and the preset still round-trips back out.
// characterMemory is Freeroam-native (SillyTavern has no matching marker):
// it's filled with retrieved, already-relevant memory snippets the caller
// fetched from the per-character/persona memory store before assembly.
// charPersonality, charScenario and dialogueExamples pull from a character
// card's own personality/scenario/example-dialogue fields — unlike
// charDescription/memories/worldInfoBefore, these are *not* auto-injected
// when a preset omits them: they're often situational or card-specific text
// that doesn't belong in every request, so each is opt-in, exactly like any
// other marker slot a preset can include or leave out.
export const SUPPORTED_MARKERS = {
  charDescription: "Speaking character's description, plus relationships and whereabouts knowledge",
  charPersonality: "Speaking character's personality traits, if set (opt-in)",
  charScenario: "Speaking character's own card scenario text, if set (opt-in)",
  scenario: 'Current place, date/time of day, and who else is present',
  personaDescription: 'Your persona description',
  characterMemory: 'Relevant memories the present characters have of this interaction',
  worldInfoBefore: 'Global world setting',
  dialogueExamples: "Speaking character's example dialogue from their character card, if set (opt-in)",
};

// Catalog backing the Prompts view's "insert standard block" control — one
// entry per marker Freeroam actually fills (see SUPPORTED_MARKERS above),
// in a sensible default order, plus one non-marker starting block with
// representative default text. This is the single source of truth the
// frontend fetches (GET /api/prompts/standard-blocks) rather than
// hand-duplicating marker names/identifiers — the whole point being that a
// user shouldn't have to know and type an exact identifier like
// "charDescription" from memory to get a working dynamic block back after
// removing it.
export const STANDARD_PROMPT_BLOCKS = [
  {
    identifier: 'main', name: 'Main Instructions', marker: false,
    description: "A starting instruction block, in Freeroam's own voice — edit freely.",
    defaultContent: 'You are running a moody, atmospheric roleplay. Stay fully in character for {{char}} — write their next turn only. Never break character, and never write dialogue or actions for {{user}} or for anyone not listed.',
  },
  { identifier: 'charDescription', name: 'Character Description', marker: true, description: SUPPORTED_MARKERS.charDescription },
  { identifier: 'charPersonality', name: 'Character Personality', marker: true, description: SUPPORTED_MARKERS.charPersonality },
  { identifier: 'charScenario', name: 'Character Scenario', marker: true, description: SUPPORTED_MARKERS.charScenario },
  { identifier: 'dialogueExamples', name: 'Dialogue Examples', marker: true, description: SUPPORTED_MARKERS.dialogueExamples },
  { identifier: 'scenario', name: 'World Info', marker: true, description: SUPPORTED_MARKERS.scenario },
  { identifier: 'worldInfoBefore', name: 'World Setting', marker: true, description: SUPPORTED_MARKERS.worldInfoBefore },
  { identifier: 'personaDescription', name: 'Persona Description', marker: true, description: SUPPORTED_MARKERS.personaDescription },
  { identifier: 'characterMemory', name: 'Character Memory', marker: true, description: SUPPORTED_MARKERS.characterMemory },
];

// identifier -> default label, used to prefix a marker block's content with
// its own name (e.g. "Scenario:\n...", "Character Memory:\n...") — a real
// preset block uses whatever the user named it instead (see nameOrDefault);
// this is the fallback for the auto-injected memory/world-setting content
// when the active preset never declared that marker at all.
export const STANDARD_LABEL = Object.fromEntries(STANDARD_PROMPT_BLOCKS.map(b => [b.identifier, b.name]));

// The in-world clock: time never passes on its own — the user advances it.
export const TIMES_OF_DAY = ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night'];

// Day 1 is a Monday; the weekday is purely derived from the day count, never
// stored separately, so setting the day directly (including for time-travel
// scenarios that go backward) always keeps a consistent weekday.
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function weekdayFor(day) {
  if (!Number.isInteger(day)) return null;
  const idx = ((day - 1) % 7 + 7) % 7; // safe for any integer, including <= 0
  return WEEKDAYS[idx];
}

// The next time-of-day slot after `time` (wrapping into the next day at
// night→sunrise) — used both by POST /api/world/time's `advance` and to
// describe where a scheduled character is headed next.
export function nextTimeSlot(time) {
  const idx = TIMES_OF_DAY.indexOf(time.timeOfDay);
  const nextIdx = (idx + 1) % TIMES_OF_DAY.length;
  return { day: nextIdx === 0 ? time.day + 1 : time.day, timeOfDay: TIMES_OF_DAY[nextIdx] };
}

// The place a character's own schedule (see normalizeCharacter in server.js:
// { [weekday]: { [timeOfDay]: { placeId, reason } } }) puts them at for a
// given day/time-of-day slot, or null if they have nothing scheduled then.
export function scheduledPlaceFor(character, day, timeOfDay, placesById) {
  const weekday = weekdayFor(day);
  const slot = character.schedule?.[weekday]?.[timeOfDay];
  if (!slot || !slot.placeId) return null;
  return placesById[slot.placeId] || null;
}

// scene = {
//   chars: [{ name, description, personality, scenario, exampleDialogue }], // the character(s) whose turn is being generated
//   othersPresent: string[],                           // names of other characters in the room (context only)
//   place: { name, area, desc, type, ownerName, weather }, // ownerName/weather resolved by the caller, or null
//   persona: { name, description } | null,             // active user persona, or null
//   memories: string[],                                // relevant memory snippets, already retrieved by the caller
//   time: { day, timeOfDay } | null,                   // in-world clock (user-advanced, never automatic)
//   worldSetting: string,                              // global world/setting text, user-provided
//   relationships: string[],                           // speaker's relations + whereabouts knowledge, resolved by caller
// }

function scenarioBlock(place, othersPresent = [], time = null) {
  const weekday = time ? weekdayFor(time.day) : null;
  const when = time ? `It is Day ${time.day}${weekday ? ` (${weekday})` : ''}, ${time.timeOfDay}.\n` : '';
  const weather = place.weather ? `Weather: ${place.weather}.\n` : '';
  const others = othersPresent.length ? `\nAlso present: ${othersPresent.join(', ')}.` : '';
  return `${when}${weather}Current place: ${place.name}${place.area ? ` (${place.area})` : ''}\n${place.desc}${others}`;
}

function relationshipsBlock(chars, relationships) {
  if (!relationships || !relationships.length) return '';
  const who = chars.length === 1 ? chars[0].name : 'the characters';
  return `\n\nWhat ${who} knows about people:\n${relationships.map((r) => `- ${r}`).join('\n')}`;
}

// Composes one marker identifier's raw (unprefixed) content from a scene —
// '' if it contributes nothing. Shared by assemblePresetMessages for both
// preset-declared markers and the two auto-injected fallbacks below.
function markerContent(identifier, scene) {
  const { chars = [], othersPresent = [], place, persona, memories = [], time = null, worldSetting = '', relationships = [] } = scene;
  if (identifier === 'charDescription') {
    const block = chars.map(c => `${c.name}:\n${c.description || ''}`).join('\n\n') + relationshipsBlock(chars, relationships);
    return block.trim() ? block : '';
  }
  if (identifier === 'charPersonality') {
    return chars.filter(c => c.personality && c.personality.trim()).map(c => `${c.name}'s personality: ${c.personality.trim()}`).join('\n');
  }
  if (identifier === 'charScenario') {
    return chars.filter(c => c.scenario && c.scenario.trim()).map(c => `${c.name}: ${c.scenario.trim()}`).join('\n');
  }
  if (identifier === 'dialogueExamples') {
    return chars.filter(c => c.exampleDialogue && c.exampleDialogue.trim())
      .map(c => `${c.name}'s example dialogue:\n${c.exampleDialogue.trim()}`).join('\n\n');
  }
  if (identifier === 'scenario') {
    return place ? scenarioBlock(place, othersPresent, time) : '';
  }
  if (identifier === 'personaDescription') {
    return persona && persona.description ? `${persona.name}:\n${persona.description}` : '';
  }
  if (identifier === 'characterMemory') {
    return memories.length ? memories.map(m => `- ${m}`).join('\n') : '';
  }
  if (identifier === 'worldInfoBefore') {
    return worldSetting && worldSetting.trim() ? worldSetting.trim() : '';
  }
  return '';
}

function nameOrDefault(p, fallback) {
  return (p && typeof p.name === 'string' && p.name.trim()) || fallback;
}

// Walks a preset's ordered prompt blocks into one {role, content, noMerge}
// entry per enabled block, filling recognized marker slots from `scene`
// (prefixed with the block's own name — "Scenario:\n...", "Character
// Memory:\n..." — so a renamed block's content still reads sensibly) and
// substituting macros throughout. Unsupported markers contribute nothing.
// Unmerged — one entry per block, in preset order — so callers that care
// about individual blocks (assemblePresetSections, tests) see them as such;
// assemblePresetMessages below merges adjacent same-role entries for the
// actual request.
function assemblePresetRawBlocks(preset, scene) {
  const { memories = [], worldSetting = '' } = scene;
  const macroCtx = macroContextFrom(scene);
  const memoryAsSeparateMessage = !!preset.memoryAsSeparateMessage;
  const raw = [];

  // Presets imported from SillyTavern have no notion of "characterMemory" or
  // "worldInfoBefore" — they're Freeroam-native — so most presets never
  // declare them. Track which markers the preset actually placed (regardless
  // of enabled state, so an explicit disable is still honored) and fall back
  // to injecting the content anyway below, rather than silently dropping
  // retrieved memories/world info a preset simply never learned to place.
  const declaredMarkers = new Set(preset.prompts.filter(p => p.marker).map(p => p.identifier));

  preset.prompts.forEach(p => {
    if (p.enabled === false) return;

    if (p.marker) {
      const content = markerContent(p.identifier, scene);
      if (!content) return;
      const label = nameOrDefault(p, STANDARD_LABEL[p.identifier] || p.identifier);
      raw.push({
        role: 'system',
        content: substituteMacros(`${label}:\n${content}`, macroCtx),
        noMerge: p.identifier === 'characterMemory' && memoryAsSeparateMessage,
      });
      return;
    }

    const content = (p.content || '').trim();
    if (content) {
      const role = ['system', 'user', 'assistant'].includes(p.role) ? p.role : 'system';
      raw.push({ role, content: substituteMacros(content, macroCtx) });
    }
  });

  if (!declaredMarkers.has('worldInfoBefore') && worldSetting && worldSetting.trim()) {
    raw.unshift({ role: 'system', content: substituteMacros(`${STANDARD_LABEL.worldInfoBefore}:\n${worldSetting.trim()}`, macroCtx) });
  }
  if (!declaredMarkers.has('characterMemory') && memories.length) {
    raw.push({
      role: 'system',
      content: substituteMacros(`${STANDARD_LABEL.characterMemory}:\n${memories.map(m => `- ${m}`).join('\n')}`, macroCtx),
      noMerge: memoryAsSeparateMessage,
    });
  }

  return raw;
}

// The real per-role messages for a request: assemblePresetRawBlocks, with
// adjacent blocks landing on the same role merged into one message
// (several providers reject alternating single-line role changes), except
// where a block requests to stand alone — currently only characterMemory,
// when the preset's memoryAsSeparateMessage flag is set, so it can arrive
// as its own system message instead of glued to its neighbors.
export function assemblePresetMessages(preset, scene) {
  const raw = assemblePresetRawBlocks(preset, scene);
  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && !last.noMerge && !m.noMerge) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  return merged.map(({ role, content }) => ({ role, content }));
}

// Back-compat / per-block convenience over assemblePresetRawBlocks — the
// system-role content pieces only, one array element per block, in order
// (unmerged, unlike assemblePresetMessages). Prefer assemblePresetMessages
// directly when the actual per-role messages matter (i.e. building a real
// request); this is for callers that want to inspect individual blocks
// (tests, and buildSystemPrompt below).
export function assemblePresetSections(preset, scene) {
  return assemblePresetRawBlocks(preset, scene).filter(m => m.role === 'system').map(m => m.content);
}

export function defaultSystemPrompt(scene) {
  const { chars = [], othersPresent = [], place, persona, memories = [], time = null, worldSetting = '', relationships = [] } = scene;
  const charNames = chars.map(c => c.name);
  const visitorLabel = persona ? persona.name : 'the visitor';

  const world = `You are running a moody, atmospheric roleplay. Stay fully in character for ${charNames.join(', ')} — write their next turn only. Never break character, and never write dialogue or actions for "${visitorLabel}" (the human) or for anyone not listed below. Keep the voice distinct and the reply grounded in the scene.`;

  const settingBlock = worldSetting && worldSetting.trim() ? `\n\n${worldSetting.trim()}` : '';

  const locationLine = place.type === 'private'
    ? `This is ${place.ownerName ? place.ownerName + "'s" : 'a resident\'s'} private place — treat ${visitorLabel} as a guest here, not someone who belongs by default.`
    : `This is a communal space, open to anyone.`;

  const sceneBlock = `\n\n${scenarioBlock(place, othersPresent, time)}\n${locationLine}`;
  const cast = chars.map(c => {
    const identity = [c.description || '', c.personality ? `Personality: ${c.personality}` : ''].filter(Boolean).join('\n');
    return `\n\n${c.name}:\n${identity}`;
  }).join('') + relationshipsBlock(chars, relationships);
  const personaBlock = persona && persona.description ? `\n\n${persona.name} (the visitor):\n${persona.description}` : '';
  const memoryBlock = memories.length ? `\n\nWhat's remembered so far:\n${memories.map(m => `- ${m}`).join('\n')}` : '';
  const built = world + settingBlock + sceneBlock + cast + personaBlock + memoryBlock;
  return substituteMacros(built, macroContextFrom(scene));
}

// Single-string view of the full prompt: from the active preset's prompt
// manager if one is set (falling back to Freeroam's built-in prompt
// otherwise), joining every block regardless of role. Macro substitution
// already happened per-block in assemblePresetMessages. Kept for callers
// that just want "the whole prompt as text" (token-budget estimation,
// tests) — building the actual request uses assemblePresetMessages
// directly so each block's role (system/user/assistant) reaches the model
// as a real separate message instead of being flattened here. The preset's
// content is otherwise used as-is — nothing else is appended to it; with
// per-character turn generation, replies don't need a forced output format.
export function buildSystemPrompt(preset, scene) {
  if (!preset || !preset.prompts.length) return defaultSystemPrompt(scene);
  return assemblePresetMessages(preset, scene).map(m => m.content).join('\n\n');
}

// Parses a model reply (expected "Name: line" format) into chat entries.
// Known speakers resolve to their character; an unrecognized speaker name
// becomes an NPC-tagged entry (charId null, isNPC true) rather than being
// misattributed — the model only introduces new speakers if the active
// preset invites it, and the frontend offers to save those as characters.
// Format-breaking lines fall back to the first present character.
export function parseReplyLines(text, presentChars) {
  const presentByName = {};
  presentChars.forEach((c) => {
    presentByName[c.name.toLowerCase()] = c;
    presentByName[c.name.split(' ')[0].toLowerCase()] = c;
  });

  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [{ type: 'error', text: '(silence — no response)' }];

  return lines.map((line) => {
    const m = line.match(/^([A-Za-z][A-Za-z' -]{1,30}):\s*(.+)$/);
    if (m) {
      const speaker = presentByName[m[1].trim().toLowerCase()];
      if (speaker) return { type: 'char', charId: speaker.id, name: speaker.name, text: m[2].trim() };
      return { type: 'char', charId: null, isNPC: true, name: m[1].trim(), text: m[2].trim() };
    }
    const fallback = presentChars[0];
    return { type: 'char', charId: fallback.id, name: fallback.name, text: line };
  });
}

const NAME_LINE = /^([A-Za-z][A-Za-z' -]{1,30}):\s*(.+)$/;

// Parses one character's generated turn. With per-character generation the
// whole reply belongs to the speaker by default (narrative/multi-paragraph
// text stays one entry, with any leading "TheirName:" prefix stripped).
// But if the model formatted the entire reply as "Name: line" rows —
// presets that ask for that style — fall back to the multiplex parser so
// other characters' lines attribute correctly and unknown speakers still
// get NPC-tagged.
export function parseCharacterTurn(text, speaker, presentChars) {
  let trimmed = (text || '').trim();
  if (!trimmed) return [{ type: 'error', text: '(silence — no response)' }];

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  const allNameLines = lines.length > 1 && lines.every((l) => NAME_LINE.test(l));
  if (allNameLines) {
    // Ensure the speaker wins fallback attribution by putting them first.
    const ordered = [speaker, ...presentChars.filter((c) => c.id !== speaker.id)];
    return parseReplyLines(trimmed, ordered);
  }

  const selfPrefix = new RegExp(`^(?:${speaker.name}|${speaker.name.split(' ')[0]}):\\s*`, 'i');
  trimmed = trimmed.replace(selfPrefix, '');
  return [{ type: 'char', charId: speaker.id, name: speaker.name, text: trimmed }];
}

// --- SillyTavern Chat Completion preset import/export ---------------------

// Reads a SillyTavern Chat Completion preset export: pulls the "prompts"
// array (Prompt Manager entries) and the fullest "prompt_order" block for
// ordering + enabled flags (SillyTavern keeps a separate order per character
// context — e.g. persona-aware vs not — so the richest one is preferred).
// SillyTavern preset files don't carry their own "name" field, so the
// imported filename is used as a fallback.
export function importSillyTavernPreset(raw, fallbackName) {
  const promptsById = {};
  (Array.isArray(raw.prompts) ? raw.prompts : []).forEach(p => {
    if (!p || typeof p.identifier !== 'string') return;
    promptsById[p.identifier] = {
      identifier: p.identifier,
      name: p.name || p.identifier,
      role: p.role || 'system',
      content: p.content || '',
      marker: !!p.marker,
      enabled: true,
    };
  });

  let orderBlock = null;
  if (Array.isArray(raw.prompt_order) && raw.prompt_order.length) {
    orderBlock = raw.prompt_order.reduce((best, cur) =>
      (cur.order || []).length > (best?.order || []).length ? cur : best, raw.prompt_order[0]);
  }

  let ordered = [];
  if (orderBlock) {
    orderBlock.order.forEach(o => {
      const p = promptsById[o.identifier];
      if (!p) return;
      p.enabled = o.enabled !== false;
      ordered.push(p);
    });
    const seen = new Set(ordered.map(p => p.identifier));
    Object.values(promptsById).forEach(p => { if (!seen.has(p.identifier)) ordered.push(p); });
  } else {
    ordered = Object.values(promptsById);
  }

  return {
    name: (raw.name && String(raw.name)) || fallbackName || 'Imported preset',
    contextLength: Number.isFinite(raw.openai_max_context) && raw.openai_max_context > 0
      ? Math.floor(raw.openai_max_context) : DEFAULT_CONTEXT_LENGTH,
    maxReplyTokens: Number.isFinite(raw.openai_max_tokens) && raw.openai_max_tokens > 0
      ? Math.floor(raw.openai_max_tokens) : DEFAULT_MAX_REPLY_TOKENS,
    prompts: ordered,
  };
}

// Reconstructs a minimal SillyTavern-compatible Chat Completion preset —
// prompts + prompt_order + the two context-length fields. Sampler/model
// settings aren't tracked by Freeroam, so a round-tripped preset falls back
// to SillyTavern's defaults for those; the prompt manager content, order,
// and context budget carry over.
export function exportSillyTavernPreset(preset) {
  const prompts = preset.prompts.map(p => {
    const obj = { identifier: p.identifier, name: p.name, system_prompt: true };
    if (p.marker) { obj.marker = true; }
    else { obj.role = p.role || 'system'; obj.content = p.content || ''; }
    return obj;
  });
  const order = preset.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));
  return {
    prompts,
    prompt_order: [{ character_id: 100001, order }],
    openai_max_context: preset.contextLength || DEFAULT_CONTEXT_LENGTH,
    openai_max_tokens: preset.maxReplyTokens || DEFAULT_MAX_REPLY_TOKENS,
  };
}
