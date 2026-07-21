import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractCharacterCard } from './lib/tavernCard.js';
import {
  normalizePromptList,
  normalizeContextNumber,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_REPLY_TOKENS,
} from './lib/presets.js';
import {
  recordTurn,
  retrieveMemories,
  queryCharacterMemories,
  listCharacterMemories,
  countCharacterMemories,
  addCharacterMemory,
  updateCharacterMemory,
  deleteCharacterMemory,
  deleteAllCharacterMemories,
  syncMemoriesForEntry,
  findMemoriesWitnessing,
  detachEntryFromMemories,
  attachEntriesToMemories,
  pruneReplylessMemories,
  rebuildAllMemoryEmbeddings,
} from './lib/memoryStore.js';
import {
  upsertRelationship,
  retrieveRelevantRelationships,
  queryCharacterRelationships,
  rebuildAllRelationshipEmbeddings,
  FAMILY_HINTS,
} from './lib/relationshipStore.js';
import {
  refreshCharacterEmbedding,
  deleteCharacterEmbedding,
  rebuildAllCharacterEmbeddings,
} from './lib/characterEmbeddings.js';
import {
  presentCharIds as presentCharIdsFor,
  activeCharIds as activeCharIdsFor,
} from './lib/presence.js';
import { shouldNarrate, buildNarratorMessages, isNarratorSilent } from './lib/narrator.js';
import { characterSnippet } from './lib/characterEmbeddings.js';
import { detectSuggestedActions } from './lib/suggestedActions.js';
import { embed, MODEL_ID as EMBEDDING_MODEL_ID } from './lib/embeddings.js';
import {
  estimateTokens,
  contextSettingsFor,
  historyBudget,
  formatLogEntry,
  buildHistoryTranscript,
  buildHistoryMessages,
  sliceSinceLastArrival,
  assemblePresetMessages,
  defaultSystemPrompt,
  parseCharacterTurn,
  importSillyTavernPreset,
  exportSillyTavernPreset,
  TIMES_OF_DAY,
  WEEKDAYS,
  weekdayFor,
  nextTimeSlot,
  scheduledPlaceFor,
  STANDARD_PROMPT_BLOCKS,
  STANDARD_LABEL,
  normalizeUsage,
  buildGenerationStats,
  substituteMacros,
} from './lib/context.js';
import { loadChatLog, saveChatLog, appendChatEntries, deleteChatLog } from './lib/chatStore.js';
import { createWorldRegistry } from './lib/worldRegistry.js';
import { CONDITIONS as WEATHER_CONDITIONS, loadWeather, saveWeather, rollAutoWeather, setManualWeather, setAutoWeather } from './lib/weather.js';
import { buildTextingMessages, historyFromLog, groupHistoryFromLog } from './lib/texting.js';
import { loadCalls, saveCalls } from './lib/calls.js';
import { loadGroups, saveGroups, createGroup } from './lib/groups.js';
import {
  DEFAULT_CASCADE_BASE_CHANCE, DEFAULT_CASCADE_DECAY_RATE, DEFAULT_CASCADE_PER_CHARACTER_CAP, MAX_CASCADE_REPLIES,
  nextCascadeChance, rollContinues, eligibleReplierIds, pickReplier,
} from './lib/textCascade.js';
import { logger } from './lib/log.js';
logger.setLevel("debug")

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Overridable so the test suite can point a real (but disposable) Express
// app at a temp directory instead of this project's actual data/config —
// tests must never read the real OpenRouter key or write into real data.
const ROOT_DIR = process.env.FREEROAM_TEST_ROOT || __dirname;

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const AVATAR_ROOT = path.join(ROOT_DIR, 'uploads', 'avatars');

// Every world (save slot) gets its own characters/places/world-state/
// personas/presets, its own chat logs, and its own SQLite db — resolved
// per-request from the X-World-Id header (see the middleware below), never
// from a server-side "current world" pointer, so different browsers/users
// can be in different worlds on the same running instance at once.
// config.json (API key/model/narrator/memory settings) stays global.
const registry = createWorldRegistry({ rootDir: ROOT_DIR });
await registry.init();

// --- Config (endpoint + model) ---------------------------------------------

const DEFAULT_API_BASE = 'https://openrouter.ai/api/v1';

// Same {{macro}} vocabulary as everywhere else (see lib/context.js) —
// {{char}} is the one that matters most here (the name being drafted),
// but {{world}}/{{user}}/{{persona}}/{{day}}/{{time}}/{{weekday}} all
// resolve too, in case a customized prompt wants to lean on them.
const DEFAULT_DRAFT_PERSONA_PROMPT = 'You are a character-sheet writing assistant for a roleplay app. Based on the world setting and scene excerpt below, write a short persona description for the character named "{{char}}": 2 to 4 sentences, factual character-sheet voice covering personality, manner of speaking, and role in the scene. No dialogue, no first person, no meta-commentary — output only the description text.';

// No {{macro}} substitution here (unlike DEFAULT_DRAFT_PERSONA_PROMPT) —
// this is a pure style instruction, not something that needs to reference
// the character/world by name; identity is already injected separately
// by buildTextingMessages.
const DEFAULT_TEXTING_PROMPT_TEMPLATE = "You are texting, not narrating a scene. Reply the way a real person texts: short, casual lines of dialogue only — no *action descriptions*, no third-person narration, no scene-setting. Emoji are fine occasionally if they fit your character's voice, but don't overuse them. Stay fully in character.";

const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'anthropic/claude-3.5-sonnet',
  apiBase: DEFAULT_API_BASE,          // any OpenAI-spec-compliant endpoint
  streaming: false,                    // opt-in; some endpoints don't support SSE
  reasoning: 'off',                    // off | low | medium | high (OpenRouter reasoning effort)
  providers: [],                       // pin one or more OpenRouter providers, tried in this order ([] = let it route)
  memoryMinScore: 0.35,                 // cosine-similarity floor for memory recall (see retrieveMemories)
  suggestedActionsMode: 'regex',        // regex | hybrid | ml — see lib/suggestedActions.js
  draftPersonaPrompt: '',              // '' = use DEFAULT_DRAFT_PERSONA_PROMPT; see /api/characters/draft
  narratorEnabled: true,                // ambient world-voice for empty/solo/background scenes — see lib/narrator.js
  textingPromptTemplate: '',            // '' = use DEFAULT_TEXTING_PROMPT_TEMPLATE; see lib/texting.js
  textingTypingIndicator: false,        // opt-in; only does anything when streaming is also on
  cascadeBaseChance: DEFAULT_CASCADE_BASE_CHANCE,       // Phase 4 — see lib/textCascade.js
  cascadeDecayRate: DEFAULT_CASCADE_DECAY_RATE,
  cascadePerCharacterCap: DEFAULT_CASCADE_PER_CHARACTER_CAP,
};

// The model in use before embeddingModelVersion existed — configs saved
// before this feature have no record of what built their stored vectors,
// so absence of the field is treated as "built with this."
const LEGACY_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function isOpenRouter(cfg) {
  return (cfg.apiBase || DEFAULT_API_BASE).includes('openrouter.ai');
}

function loadConfig() {
  let cfg;
  try {
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
  // Migrate the old single `provider` string (pre-multi-provider) into the
  // new `providers` array the first time an old config.json is read.
  if (!cfg.providers?.length && cfg.provider) cfg.providers = [cfg.provider];
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
if (!fs.existsSync(CONFIG_PATH)) saveConfig(DEFAULT_CONFIG);

// --- Places ---------------------------------------------------------------

// Places are the actual navigable locations — communal (open to anyone) or
// a resident's private space. `area` is a free-text label used only for
// loose visual grouping in the UI (e.g. a neighborhood or district name);
// it's not a separate entity, so new areas appear automatically as soon as
// a place uses one. None of this is hardcoded into the app's logic — it's
// just the starting data, fully editable through /api/places.
const SEED_PLACES = [
  { id: 'town-square', name: 'Town Square', type: 'communal', ownerId: null, area: 'Downtown',
    desc: 'The open square where every path in the neighborhood eventually crosses.' },
  { id: 'archive-house', name: 'The Archive House', type: 'communal', ownerId: null, area: 'Downtown',
    desc: 'A public reading room, shelves stacked floor to ceiling with old records.' },
  { id: 'ezras-apartment', name: "Ezra's Apartment", type: 'private', ownerId: 'ezra', area: 'Downtown',
    desc: 'A cramped, meticulously organized apartment above the Archive House.' },

  { id: 'greenhouse-park', name: 'The Greenhouse', type: 'communal', ownerId: null, area: 'Garden District',
    desc: 'A public greenhouse gone half-wild, permanently smelling of autumn leaves.' },
  { id: 'mireilles-cottage', name: "Mireille's Cottage", type: 'private', ownerId: 'mireille', area: 'Garden District',
    desc: 'A small cottage tucked just behind the greenhouse ferns.' },
  { id: 'soots-alley', name: "Soot's Alley", type: 'private', ownerId: 'soot', area: 'Garden District',
    desc: 'A narrow alley that one particular cat has claimed as entirely his own.' },

  { id: 'old-ballroom', name: 'The Old Ballroom', type: 'communal', ownerId: null, area: 'Uptown',
    desc: 'A dusty, disused hall that still hosts the occasional gathering.' },
  { id: 'clocktower-roof', name: 'The Clocktower Roof', type: 'communal', ownerId: null, area: 'Uptown',
    desc: 'A rooftop lookout beside the neighborhood\'s old, stopped clocktower.' },
  { id: 'custodians-workshop', name: "The Custodian's Workshop", type: 'private', ownerId: 'custodian', area: 'Uptown',
    desc: "A locked workshop where the neighborhood's clockwork gets quietly repaired." },
];

function loadPlaces(w) {
  try {
    return JSON.parse(fs.readFileSync(w.paths.places, 'utf-8'));
  } catch {
    savePlaces(w, SEED_PLACES);
    return SEED_PLACES;
  }
}
function savePlaces(w, list) {
  fs.writeFileSync(w.paths.places, JSON.stringify(list, null, 2));
}

function slugify(name) {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'place';
  return base;
}
function uniquePlaceId(name, existing) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  const ids = new Set(existing.map((p) => p.id));
  while (ids.has(id)) { id = `${base}-${n}`; n += 1; }
  return id;
}

// --- Characters -------------------------------------------------------

const BUILTIN_CHARACTERS = [
  {
    id: 'ezra', name: 'Ezra Vane', source: 'builtin', avatarUrl: null, color: 'hsl(35, 65%, 62%)', greetings: [],
    persona: "Ezra Vane, the neighborhood's unofficial archivist. Precise, dry-witted, quietly lonely — he keeps meticulous records of everyone's comings and goings and takes fierce pride in it. Speaks in measured, faintly formal sentences. Masks curiosity about visitors behind procedure and small complaints about disorganization.",
  },
  {
    id: 'mireille', name: 'Mireille', source: 'builtin', avatarUrl: null, color: 'hsl(150, 22%, 62%)', greetings: [],
    persona: "Mireille, a gentle, slightly otherworldly gardener who tends the greenhouse like it's the only season that matters. Wistful and kind, she trails off mid-thought as if she's forgotten what year it is. Calls visitors 'traveler.' Speaks softly, in short dreamy sentences, sometimes describing plants that no longer exist anywhere else.",
  },
  {
    id: 'soot', name: 'Soot', source: 'builtin', avatarUrl: null, color: 'hsl(265, 22%, 62%)', greetings: [],
    persona: "Soot, a small black cat who is not quite a cat. Speaks in short, blunt, faintly sarcastic lines — never more than a sentence or two. Judgmental of nearly everyone. Secretly, obviously fond of Mireille, though he'd deny it.",
  },
  {
    id: 'custodian', name: 'Custodian', source: 'builtin', avatarUrl: null, color: 'hsl(345, 40%, 58%)', greetings: [],
    persona: "The Custodian, keeper of the neighborhood's old clocktower and the one who quietly keeps it from ever fully stopping. Speaks rarely and in short, oracular lines — never more than one or two sentences. Neither hostile nor warm. Simply a little outside of time, and faintly amused by those who are not.",
  },
];

// placements: { [characterId]: { placeId: string, greetingIndex: number|null } }
// greetingIndex null = no scripted greeting, arrival reaction is AI-improvised.
const DEFAULT_PLACEMENTS = {
  ezra: { placeId: 'ezras-apartment', greetingIndex: null },
  mireille: { placeId: 'mireilles-cottage', greetingIndex: null },
  soot: { placeId: 'soots-alley', greetingIndex: null },
  custodian: { placeId: 'custodians-workshop', greetingIndex: null },
};

// Migrates a character saved before fields were split out: an old single
// `persona` blob becomes `description`, and the newer fields default to
// empty rather than being absent. Lazy, like normalizeWorld() below — reads
// always see the new shape; the file only actually rewrites on next save.
// schedule: sparse { [weekday]: { [timeOfDay]: { placeId, reason } } } — a
// character with no entry for a given slot just isn't scheduled there;
// normal placement/movement is unaffected until a slot is actually set.
function normalizeCharacter(c) {
  const base = { description: '', personality: '', scenario: '', exampleDialogue: '', schedule: {}, ...c };
  if (typeof c.persona === 'string' && !c.description) base.description = c.persona;
  delete base.persona;
  return base;
}

function loadCharacters(w) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(w.paths.characters, 'utf-8'));
  } catch {
    raw = BUILTIN_CHARACTERS;
    saveCharacters(w, raw);
  }
  return raw.map(normalizeCharacter);
}
function saveCharacters(w, list) {
  fs.writeFileSync(w.paths.characters, JSON.stringify(list, null, 2));
}

// World state: placements + the in-world clock + the global setting text.
// Older world.json files predate time/setting, so defaults are merged in.
function normalizeWorld(world) {
  return {
    placements: world.placements || {},
    time: { day: 1, timeOfDay: 'morning', ...(world.time || {}) },
    setting: world.setting || '',
  };
}

function loadWorld(w) {
  try {
    return normalizeWorld(JSON.parse(fs.readFileSync(w.paths.world, 'utf-8')));
  } catch {
    const world = normalizeWorld({ placements: DEFAULT_PLACEMENTS });
    saveWorld(w, world);
    return world;
  }
}
function saveWorld(w, world) {
  fs.writeFileSync(w.paths.world, JSON.stringify(world, null, 2));
}

// Deterministic-ish color, spread around the wheel — keyed by the
// character/persona's own unique id, not their name. Two characters can
// share a name with no surname to tell them apart (nothing stops it, and
// it happens); hashing the name would give them the identical color too,
// defeating the one thing that's still supposed to disambiguate them at a
// glance (the Cast grid, relationship rows, chat avatars, ...).
function colorForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash}, 55%, 62%)`;
}

// --- Personas ---------------------------------------------------------
// A persona is the user's own in-world identity — the "{{user}}" side of
// the chat. Optional description gets folded into the system prompt the
// same way a character's persona does; the active one's name replaces the
// generic "the visitor" label in transcripts and prompts.

const DEFAULT_PERSONAS = { personas: [], activePersonaId: null };

function loadPersonas(w) {
  try {
    return { ...DEFAULT_PERSONAS, ...JSON.parse(fs.readFileSync(w.paths.personas, 'utf-8')) };
  } catch {
    savePersonas(w, DEFAULT_PERSONAS);
    return { ...DEFAULT_PERSONAS };
  }
}
function savePersonas(w, data) {
  fs.writeFileSync(w.paths.personas, JSON.stringify(data, null, 2));
}

const EXT_FOR_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// --- Prompt presets -----------------------------------------------------
// Presets mirror SillyTavern's Chat Completion "Prompt Manager": an ordered
// list of prompt blocks, each either real text (identifier/name/role/content)
// or a "marker" placeholder (identifier/name only) that stands in for a slot
// SillyTavern fills automatically. Freeroam understands three marker slots —
// charDescription, scenario, personaDescription — and fills the rest (world
// info, dialogue examples, chat history) with nothing, since this app has no
// equivalent concept. That keeps a straight SillyTavern preset export usable
// here without editing, and keeps a Freeroam-exported preset re-importable.

const DEFAULT_PRESETS = { presets: [], activePresetId: null };

function loadPresets(w) {
  try {
    return { ...DEFAULT_PRESETS, ...JSON.parse(fs.readFileSync(w.paths.presets, 'utf-8')) };
  } catch {
    savePresets(w, DEFAULT_PRESETS);
    return { ...DEFAULT_PRESETS };
  }
}
function savePresets(w, data) {
  fs.writeFileSync(w.paths.presets, JSON.stringify(data, null, 2));
}

// --- App ----------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());
// The frontend is now a Vue/Vite project (frontend/src) — this serves its
// production build (frontend/dist, built via `npm run build` in frontend/),
// not the source. For local development with hot-reload, run Vite's own
// dev server (`npm run dev` in frontend/) instead, which proxies /api and
// /avatars requests through to this server (see frontend/vite.config.js).
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));
// One static mount for every world's avatars — express.static happily
// serves nested paths, so /avatars/<worldId>/<file> and
// /avatars/<worldId>/personas/<file> both resolve here without any
// per-world route. World isolation for avatars is path-encoded rather than
// header-based because an <img src> can't send a custom header.
app.use('/avatars', express.static(AVATAR_ROOT));

// Resolves the active world for every /api request from the X-World-Id
// header — absent means the registry's default world (old tabs, curl, the
// test suite all keep working); present-but-unknown is a 400, never a
// silent fallback, since that could write into the wrong save. /api/worlds*
// manages the registry itself and is exempted: it must keep working even
// when the caller's stored world id no longer exists, since GET /api/worlds
// is exactly how the frontend recovers from that.
app.use('/api', (req, res, next) => {
  if (req.path === '/worlds' || req.path.startsWith('/worlds/')) return next();
  const headerId = req.get('X-World-Id');
  const world = headerId ? registry.get(headerId) : registry.getDefault();
  if (!world) return res.status(400).json({ error: 'Unknown world id.', code: 'UNKNOWN_WORLD' });
  req.world = world;
  registry.touch(world.id);
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/png') return cb(new Error('Only PNG character cards are supported.'));
    cb(null, true);
  },
});

const uploadPersonaAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXT_FOR_MIME[file.mimetype]) return cb(new Error('Avatar must be a PNG, JPEG, or WebP image.'));
    cb(null, true);
  },
});

// --- Settings routes ------------------------------------------------------

function publicConfig(cfg) {
  return {
    hasKey: !!cfg.apiKey,
    model: cfg.model,
    apiBase: cfg.apiBase || DEFAULT_API_BASE,
    streaming: !!cfg.streaming,
    reasoning: cfg.reasoning || 'off',
    providers: Array.isArray(cfg.providers) ? cfg.providers : [],
    memoryMinScore: Number.isFinite(cfg.memoryMinScore) ? cfg.memoryMinScore : DEFAULT_CONFIG.memoryMinScore,
    suggestedActionsMode: cfg.suggestedActionsMode || DEFAULT_CONFIG.suggestedActionsMode,
    draftPersonaPrompt: (cfg.draftPersonaPrompt || '').trim() || DEFAULT_DRAFT_PERSONA_PROMPT,
    draftPersonaPromptIsCustom: !!(cfg.draftPersonaPrompt || '').trim(),
    embeddingModel: EMBEDDING_MODEL_ID,
    embeddingsStale: (cfg.embeddingModelVersion || LEGACY_EMBEDDING_MODEL_ID) !== EMBEDDING_MODEL_ID,
    narratorEnabled: cfg.narratorEnabled !== false,
    textingPromptTemplate: (cfg.textingPromptTemplate || '').trim() || DEFAULT_TEXTING_PROMPT_TEMPLATE,
    textingPromptTemplateIsCustom: !!(cfg.textingPromptTemplate || '').trim(),
    textingTypingIndicator: !!cfg.textingTypingIndicator,
    cascadeBaseChance: Number.isFinite(cfg.cascadeBaseChance) ? cfg.cascadeBaseChance : DEFAULT_CASCADE_BASE_CHANCE,
    cascadeDecayRate: Number.isFinite(cfg.cascadeDecayRate) ? cfg.cascadeDecayRate : DEFAULT_CASCADE_DECAY_RATE,
    cascadePerCharacterCap: Number.isInteger(cfg.cascadePerCharacterCap) ? cfg.cascadePerCharacterCap : DEFAULT_CASCADE_PER_CHARACTER_CAP,
  };
}

app.get('/api/settings', (req, res) => {
  res.json(publicConfig(loadConfig()));
});

app.post('/api/settings', (req, res) => {
  const cfg = loadConfig();
  const {
    apiKey, model, apiBase, streaming, reasoning, providers, memoryMinScore, suggestedActionsMode,
    draftPersonaPrompt, narratorEnabled, textingPromptTemplate, textingTypingIndicator,
    cascadeBaseChance, cascadeDecayRate, cascadePerCharacterCap,
  } = req.body || {};
  if (typeof apiKey === 'string' && apiKey.trim()) cfg.apiKey = apiKey.trim();
  if (typeof model === 'string' && model.trim()) cfg.model = model.trim();
  if (typeof apiBase === 'string') cfg.apiBase = apiBase.trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
  if (typeof streaming === 'boolean') cfg.streaming = streaming;
  if (typeof narratorEnabled === 'boolean') cfg.narratorEnabled = narratorEnabled;
  if (['off', 'low', 'medium', 'high'].includes(reasoning)) cfg.reasoning = reasoning;
  if (Array.isArray(providers)) {
    cfg.providers = [...new Set(providers.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()))];
  }
  if (typeof memoryMinScore === 'number' && Number.isFinite(memoryMinScore)) {
    cfg.memoryMinScore = Math.max(0, Math.min(1, memoryMinScore));
  }
  if (['regex', 'hybrid', 'ml'].includes(suggestedActionsMode)) cfg.suggestedActionsMode = suggestedActionsMode;
  // '' is a valid, meaningful value here (reset to the built-in default —
  // see publicConfig), so this only guards the type, not truthiness.
  if (typeof draftPersonaPrompt === 'string') cfg.draftPersonaPrompt = draftPersonaPrompt.trim();
  if (typeof textingPromptTemplate === 'string') cfg.textingPromptTemplate = textingPromptTemplate.trim();
  if (typeof textingTypingIndicator === 'boolean') cfg.textingTypingIndicator = textingTypingIndicator;
  if (typeof cascadeBaseChance === 'number' && Number.isFinite(cascadeBaseChance)) {
    cfg.cascadeBaseChance = Math.max(0, Math.min(1, cascadeBaseChance));
  }
  if (typeof cascadeDecayRate === 'number' && Number.isFinite(cascadeDecayRate)) {
    cfg.cascadeDecayRate = Math.max(0, Math.min(1, cascadeDecayRate));
  }
  if (typeof cascadePerCharacterCap === 'number' && Number.isInteger(cascadePerCharacterCap)) {
    cfg.cascadePerCharacterCap = Math.max(1, cascadePerCharacterCap);
  }
  saveConfig(cfg);
  res.json(publicConfig(cfg));
});

app.post('/api/settings/clear-key', (req, res) => {
  const cfg = loadConfig();
  cfg.apiKey = '';
  saveConfig(cfg);
  res.json({ hasKey: false, model: cfg.model });
});

// Re-embeds every stored memory + relationship + character row with the
// current embedding model, across EVERY world — embeddingModelVersion is
// global config, so a rebuild should make every save consistent with it,
// not just whichever world happened to trigger the request. Never
// triggered automatically (see embeddings.js) — only this explicit,
// user-initiated action re-computes vectors, since it's a synchronous
// local-model pass over every world's whole DB and can take a while.
app.post('/api/settings/rebuild-embeddings', async (req, res) => {
  try {
    let memories = 0, relationships = 0, characters = 0;
    for (const { id } of registry.list().worlds) {
      const w = registry.get(id);
      memories += await rebuildAllMemoryEmbeddings({ db: w.db, embedFn: embed });
      relationships += await rebuildAllRelationshipEmbeddings({ db: w.db, embedFn: embed });
      characters += await rebuildAllCharacterEmbeddings({ db: w.db, embedFn: embed, characters: loadCharacters(w) });
    }
    const cfg = loadConfig();
    cfg.embeddingModelVersion = EMBEDDING_MODEL_ID;
    saveConfig(cfg);
    logger.info('memory', `rebuilt embeddings for ${memories} memories, ${relationships} relationships, ${characters} characters across all worlds (model ${EMBEDDING_MODEL_ID})`);
    res.json({ memories, relationships, characters, model: EMBEDDING_MODEL_ID });
  } catch (err) {
    logger.error('memory', `embedding rebuild failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Model list from whatever endpoint is configured (OpenAI /models spec).
// Pricing comes through when the endpoint provides it (OpenRouter does).
app.get('/api/models', async (req, res) => {
  const cfg = loadConfig();
  try {
    const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
    const r = await fetch(`${cfg.apiBase || DEFAULT_API_BASE}/models`, { headers });
    if (!r.ok) throw new Error(`Endpoint responded ${r.status}`);
    const data = await r.json();
    const models = (data.data || [])
      .map((m) => ({ id: m.id, name: m.name || m.id, context_length: m.context_length, pricing: m.pricing }))
      .sort((a, b) => a.id.localeCompare(b.id));
    res.json({ models });
  } catch (err) {
    logger.error('llm', `model list fetch failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// Providers serving a given model — OpenRouter-only (its endpoints API);
// other endpoints get an empty list, and the UI hides the picker.
app.get('/api/models/providers', async (req, res) => {
  const cfg = loadConfig();
  const model = req.query.model;
  if (!model || !isOpenRouter(cfg)) return res.json({ providers: [] });
  try {
    const r = await fetch(`${cfg.apiBase || DEFAULT_API_BASE}/models/${model}/endpoints`);
    if (!r.ok) throw new Error(`OpenRouter responded ${r.status}`);
    const data = await r.json();
    const providers = (data.data?.endpoints || []).map((e) => ({
      name: e.provider_name || e.name,
      pricing: e.pricing,
      context_length: e.context_length,
    }));
    res.json({ providers });
  } catch (err) {
    logger.warn('llm', `provider list fetch failed for ${model}: ${err.message}`);
    res.json({ providers: [] });
  }
});

// --- World (save-slot) management routes -----------------------------
// These manage the registry of worlds itself — exempted from the
// world-resolution middleware above (req.world is not set/needed here).

app.get('/api/worlds', (req, res) => {
  res.json(registry.list());
});

app.post('/api/worlds', async (req, res) => {
  const { name, mode, cloneFromId, includeHistory } = req.body || {};
  try {
    const world = await registry.create({ name, mode, cloneFromId, includeHistory });
    res.status(201).json({ world });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/worlds/:id', (req, res) => {
  const { name } = req.body || {};
  try {
    const world = registry.rename(req.params.id, name);
    res.json({ world });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/worlds/:id', async (req, res) => {
  try {
    const result = await registry.remove(req.params.id);
    res.json({ ok: true, defaultWorldId: result.defaultWorldId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/worlds/:id/duplicate', async (req, res) => {
  const { name, includeHistory } = req.body || {};
  try {
    const world = await registry.duplicate(req.params.id, { name, includeHistory });
    res.status(201).json({ world });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Character routes -------------------------------------------------

app.get('/api/characters', (req, res) => {
  res.json({ characters: loadCharacters(req.world) });
});

// Accepts either a multipart TavernCard PNG upload (field "card") or a
// plain JSON body { name, description, personality, scenario, exampleDialogue }
// for characters created without a card — e.g. an NPC introduced mid-scene
// and saved via the "Save as character" flow, or one entered from scratch.
app.post('/api/characters', upload.single('card'), (req, res) => {
  const w = req.world;
  if (req.file) {
    let card;
    try {
      card = extractCharacterCard(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(w.avatarDir, `${id}.png`), req.file.buffer);

    const character = {
      id,
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      exampleDialogue: card.exampleDialogue,
      greetings: card.greetings,
      source: 'upload',
      avatarUrl: `${w.avatarUrlBase}/${id}.png`,
      color: colorForId(id),
      tags: card.tags,
      creator: card.creator,
      spec: card.spec,
    };

    const characters = loadCharacters(w);
    characters.push(character);
    saveCharacters(w, characters);
    return res.status(201).json({ character });
  }

  const { name, description, personality, scenario, exampleDialogue } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A character name is required (or upload a card PNG).' });
  }

  const id = crypto.randomUUID();
  const character = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    personality: (personality || '').trim(),
    scenario: (scenario || '').trim(),
    exampleDialogue: (exampleDialogue || '').trim(),
    greetings: [],
    source: 'npc',
    avatarUrl: null,
    color: colorForId(id),
  };

  const characters = loadCharacters(w);
  characters.push(character);
  saveCharacters(w, characters);
  res.status(201).json({ character });
});

// Drafts a persona description for a new character from recent scene
// context, using the same OpenRouter proxy as /api/chat. Used by the
// "Save as character" modal's "Draft persona" button — the result is a
// starting point the user edits before saving, not a final answer.
app.post('/api/characters/draft', async (req, res) => {
  const w = req.world;
  const { name, log, userLabel } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A character name is required.' });
  }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return res.status(400).json({ error: 'No OpenRouter API key configured. Add one in Settings.' });
  }

  // The client sends its raw per-place log (chat isn't persisted
  // server-side); the transcript is built here rather than client-side, so
  // formatting/scoping logic lives in one place (backend/lib/context.js).
  const context = Array.isArray(log)
    ? buildHistoryTranscript(log, { userLabel: typeof userLabel === 'string' && userLabel.trim() ? userLabel.trim() : 'Visitor' })
    : '';

  // The world's global setting text (Settings > World, also fed into every
  // regular character turn as the worldInfoBefore block — see context.js)
  // can carry genre/tone/world-rules info a persona draft should respect
  // just as much as the scene excerpt does, so it goes in alongside it
  // rather than being left for the model to guess at.
  const world = loadWorld(w);
  const worldSetting = world.setting;
  const worldBlock = worldSetting && worldSetting.trim() ? `${STANDARD_LABEL.worldInfoBefore}:\n${worldSetting.trim()}\n\n` : '';

  // The system prompt itself is user-editable (Settings > Draft persona
  // prompt) and runs through the same {{macro}} vocabulary as every other
  // prompt block, so a custom prompt can reference {{char}}, {{world}},
  // {{user}}/{{persona}}, and {{day}}/{{time}}/{{weekday}} instead of only
  // ever describing the character being drafted by a hardcoded position.
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const macroCtx = {
    userName: activePersona ? activePersona.name : (typeof userLabel === 'string' && userLabel.trim() ? userLabel.trim() : 'Visitor'),
    charNames: [name.trim()],
    personaDescription: activePersona ? activePersona.description : '',
    worldSetting: worldSetting || '',
    timeOfDay: world.time?.timeOfDay || '',
    day: world.time?.day ?? null,
  };
  const template = (cfg.draftPersonaPrompt || '').trim() || DEFAULT_DRAFT_PERSONA_PROMPT;
  const system = substituteMacros(template, macroCtx);
  const userContent = context.trim()
    ? `${worldBlock}${context.trim()}`
    : `${worldBlock}${worldBlock ? 'No scene context was provided beyond the world setting above.' : 'No scene context was provided.'} Invent a short, plausible persona for a character named "${name.trim()}"${worldBlock ? ' that fits the world setting' : ''}.`;

  // 300 tokens covers the description itself, but a reasoning-enabled model
  // spends tokens "thinking" out of the same budget before it ever writes
  // the answer — too small a budget there means content can come back
  // empty having burned everything on the reasoning trace, with nothing
  // that looks like an error anywhere. Give reasoning room on top instead
  // of sharing the same small budget with the actual output.
  const maxTokens = cfg.reasoning && cfg.reasoning !== 'off' ? 1200 : 300;

  try {
    const { text: description } = await callOpenRouter(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ], maxTokens, `persona draft for "${name.trim()}"`);
    const trimmed = description.trim();
    if (!trimmed) {
      return res.status(502).json({ error: 'The model returned an empty response. If reasoning is enabled in Settings, try turning it off for this, or try again.' });
    }
    res.json({ description: trimmed });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.delete('/api/characters/:id', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const characters = loadCharacters(w);
  const target = characters.find((c) => c.id === id);
  if (!target) return res.status(404).json({ error: 'Character not found.' });

  const remaining = characters.filter((c) => c.id !== id);
  saveCharacters(w, remaining);

  if (target.avatarUrl) {
    const avatarPath = path.join(w.avatarDir, path.basename(target.avatarUrl));
    fs.rm(avatarPath, { force: true }, () => {});
  }

  const world = loadWorld(w);
  if (world.placements[id] !== undefined) {
    delete world.placements[id];
    saveWorld(w, world);
  }

  const places = loadPlaces(w);
  let placesChanged = false;
  places.forEach((p) => {
    if (p.ownerId === id) { p.ownerId = null; placesChanged = true; }
  });
  if (placesChanged) savePlaces(w, places);

  // Clean up the character's memories, relationships either way, and
  // identity embedding.
  deleteAllCharacterMemories(w.db, id);
  w.db.prepare('DELETE FROM relationships WHERE character_id = ? OR target_id = ?').run(id, id);
  deleteCharacterEmbedding(w.db, id);

  res.json({ ok: true });
});

// Edit a character's fields directly (any source, including builtin).
app.put('/api/characters/:id', async (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const characters = loadCharacters(w);
  const character = characters.find((c) => c.id === id);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const { name, description, personality, scenario, exampleDialogue } = req.body || {};
  const identityChanged =
    (typeof name === 'string' && name.trim() && name.trim() !== character.name) ||
    (typeof description === 'string' && description.trim() !== character.description) ||
    (typeof personality === 'string' && personality.trim() !== character.personality);
  if (typeof name === 'string' && name.trim()) character.name = name.trim();
  if (typeof description === 'string') character.description = description.trim();
  if (typeof personality === 'string') character.personality = personality.trim();
  if (typeof scenario === 'string') character.scenario = scenario.trim();
  if (typeof exampleDialogue === 'string') character.exampleDialogue = exampleDialogue.trim();

  saveCharacters(w, characters);
  // The identity embedding (characterEmbeddings.js) is built from name +
  // description/personality — recompute the character's one row when any
  // of those changed.
  if (identityChanged) {
    await refreshCharacterEmbedding({ db: w.db, embedFn: embed, char: character });
    logger.info('memory', `refreshed identity embedding for ${character.name}`);
  }
  res.json({ character });
});

// Sets or clears one day/time-of-day slot in a character's weekly schedule
// (empty/missing placeId clears it). Used both by the schedule editor and
// by nothing else — movement itself happens automatically in
// POST /api/world/time, not through this route.
app.put('/api/characters/:id/schedule/:day/:timeOfDay', (req, res) => {
  const w = req.world;
  const { id, day, timeOfDay } = req.params;
  if (!WEEKDAYS.includes(day)) {
    return res.status(400).json({ error: `day must be one of: ${WEEKDAYS.join(', ')}` });
  }
  if (!TIMES_OF_DAY.includes(timeOfDay)) {
    return res.status(400).json({ error: `timeOfDay must be one of: ${TIMES_OF_DAY.join(', ')}` });
  }

  const characters = loadCharacters(w);
  const character = characters.find((c) => c.id === id);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const { placeId, reason } = req.body || {};
  if (!character.schedule) character.schedule = {};

  if (!placeId) {
    if (character.schedule[day]) delete character.schedule[day][timeOfDay];
  } else {
    if (!loadPlaces(w).some((p) => p.id === placeId)) {
      return res.status(404).json({ error: 'Place not found.' });
    }
    if (!character.schedule[day]) character.schedule[day] = {};
    character.schedule[day][timeOfDay] = { placeId, reason: typeof reason === 'string' ? reason.trim() : '' };
  }

  saveCharacters(w, characters);
  res.json({ character });
});

// --- Persona routes -----------------------------------------------------

app.get('/api/personas', (req, res) => {
  res.json(loadPersonas(req.world));
});

// Accepts multipart (name, description, optional "avatar" file) or plain JSON.
app.post('/api/personas', uploadPersonaAvatar.single('avatar'), (req, res) => {
  const w = req.world;
  const { name, description } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A persona name is required.' });
  }

  const id = crypto.randomUUID();
  let avatarUrl = null;
  if (req.file) {
    const ext = EXT_FOR_MIME[req.file.mimetype];
    fs.writeFileSync(path.join(w.personaAvatarDir, `${id}.${ext}`), req.file.buffer);
    avatarUrl = `${w.avatarUrlBase}/personas/${id}.${ext}`;
  }

  const persona = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    avatarUrl,
    color: colorForId(id),
  };

  const data = loadPersonas(w);
  data.personas.push(persona);
  savePersonas(w, data);
  res.status(201).json({ persona });
});

app.put('/api/personas/:id', uploadPersonaAvatar.single('avatar'), (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const data = loadPersonas(w);
  const persona = data.personas.find((p) => p.id === id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });

  const { name, description } = req.body || {};
  if (typeof name === 'string' && name.trim()) persona.name = name.trim();
  if (typeof description === 'string') persona.description = description.trim();

  if (req.file) {
    if (persona.avatarUrl) {
      fs.rm(path.join(w.personaAvatarDir, path.basename(persona.avatarUrl)), { force: true }, () => {});
    }
    const ext = EXT_FOR_MIME[req.file.mimetype];
    fs.writeFileSync(path.join(w.personaAvatarDir, `${id}.${ext}`), req.file.buffer);
    persona.avatarUrl = `${w.avatarUrlBase}/personas/${id}.${ext}`;
  }

  savePersonas(w, data);
  res.json({ persona });
});

app.delete('/api/personas/:id', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const data = loadPersonas(w);
  const target = data.personas.find((p) => p.id === id);
  if (!target) return res.status(404).json({ error: 'Persona not found.' });

  data.personas = data.personas.filter((p) => p.id !== id);
  if (data.activePersonaId === id) data.activePersonaId = null;
  savePersonas(w, data);

  if (target.avatarUrl) {
    fs.rm(path.join(w.personaAvatarDir, path.basename(target.avatarUrl)), { force: true }, () => {});
  }

  res.json({ ok: true });
});

app.post('/api/personas/active', (req, res) => {
  const w = req.world;
  const { id } = req.body || {};
  const data = loadPersonas(w);
  if (id !== null && id !== undefined && !data.personas.some((p) => p.id === id)) {
    return res.status(400).json({ error: 'Unknown persona id.' });
  }
  data.activePersonaId = id || null;
  savePersonas(w, data);
  res.json({ activePersonaId: data.activePersonaId });
});

// --- Prompt preset routes -------------------------------------------------

app.get('/api/presets', (req, res) => {
  res.json(loadPresets(req.world));
});

// Catalog for the Prompts view's "insert standard block" dropdown — see
// STANDARD_PROMPT_BLOCKS in lib/context.js for what each entry does.
app.get('/api/prompts/standard-blocks', (req, res) => {
  res.json({ blocks: STANDARD_PROMPT_BLOCKS });
});

function createPreset(w, { name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage }) {
  const preset = {
    id: crypto.randomUUID(),
    name: name.trim(),
    contextLength: normalizeContextNumber(contextLength, DEFAULT_CONTEXT_LENGTH),
    maxReplyTokens: normalizeContextNumber(maxReplyTokens, DEFAULT_MAX_REPLY_TOKENS),
    prompts: normalizePromptList(prompts),
    memoryAsSeparateMessage: !!memoryAsSeparateMessage,
  };
  const data = loadPresets(w);
  data.presets.push(preset);
  savePresets(w, data);
  return preset;
}

app.post('/api/presets', (req, res) => {
  const w = req.world;
  const { name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A preset name is required.' });
  }
  res.status(201).json({ preset: createPreset(w, { name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage }) });
});

// Transforms a raw SillyTavern Chat Completion preset export into a
// Freeroam preset and saves it — the client just uploads the parsed JSON
// it read from a dropped file plus a fallback name (from the filename,
// since ST presets don't carry their own "name" field).
app.post('/api/presets/import', (req, res) => {
  const w = req.world;
  const { raw, fallbackName } = req.body || {};
  if (!raw || typeof raw !== 'object') {
    return res.status(400).json({ error: 'A raw SillyTavern preset object is required.' });
  }
  try {
    const parsed = importSillyTavernPreset(raw, fallbackName);
    res.status(201).json({ preset: createPreset(w, parsed) });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not import this preset.' });
  }
});

// Stateless transform (not tied to a saved preset id) so the client can
// export its current in-progress draft, including unsaved edits.
app.post('/api/presets/export', (req, res) => {
  const { name, prompts, contextLength, maxReplyTokens } = req.body || {};
  if (!Array.isArray(prompts)) {
    return res.status(400).json({ error: 'prompts array is required.' });
  }
  res.json(exportSillyTavernPreset({
    name,
    prompts: normalizePromptList(prompts),
    contextLength: normalizeContextNumber(contextLength, DEFAULT_CONTEXT_LENGTH),
    maxReplyTokens: normalizeContextNumber(maxReplyTokens, DEFAULT_MAX_REPLY_TOKENS),
  }));
});

app.put('/api/presets/:id', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const data = loadPresets(w);
  const preset = data.presets.find((p) => p.id === id);
  if (!preset) return res.status(404).json({ error: 'Preset not found.' });

  const { name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage } = req.body || {};
  if (typeof name === 'string' && name.trim()) preset.name = name.trim();
  if (prompts !== undefined) preset.prompts = normalizePromptList(prompts);
  if (contextLength !== undefined) preset.contextLength = normalizeContextNumber(contextLength, preset.contextLength || DEFAULT_CONTEXT_LENGTH);
  if (maxReplyTokens !== undefined) preset.maxReplyTokens = normalizeContextNumber(maxReplyTokens, preset.maxReplyTokens || DEFAULT_MAX_REPLY_TOKENS);
  if (typeof memoryAsSeparateMessage === 'boolean') preset.memoryAsSeparateMessage = memoryAsSeparateMessage;

  savePresets(w, data);
  res.json({ preset });
});

app.delete('/api/presets/:id', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const data = loadPresets(w);
  if (!data.presets.some((p) => p.id === id)) return res.status(404).json({ error: 'Preset not found.' });

  data.presets = data.presets.filter((p) => p.id !== id);
  if (data.activePresetId === id) data.activePresetId = null;
  savePresets(w, data);
  res.json({ ok: true });
});

app.post('/api/presets/active', (req, res) => {
  const w = req.world;
  const { id } = req.body || {};
  const data = loadPresets(w);
  if (id !== null && id !== undefined && !data.presets.some((p) => p.id === id)) {
    return res.status(400).json({ error: 'Unknown preset id.' });
  }
  data.activePresetId = id || null;
  savePresets(w, data);
  res.json({ activePresetId: data.activePresetId });
});

// --- Places routes ----------------------------------------------------

app.get('/api/places', (req, res) => {
  res.json({ places: loadPlaces(req.world) });
});

app.post('/api/places', (req, res) => {
  const w = req.world;
  const { name, desc, type, ownerId, area } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A place name is required.' });
  }
  const placeType = type === 'private' ? 'private' : 'communal';
  if (placeType === 'private' && ownerId) {
    const characters = loadCharacters(w);
    if (!characters.some((c) => c.id === ownerId)) {
      return res.status(400).json({ error: 'Unknown owner character id.' });
    }
  }

  const places = loadPlaces(w);
  const place = {
    id: uniquePlaceId(name.trim(), places),
    name: name.trim(),
    desc: (desc || '').trim(),
    type: placeType,
    ownerId: placeType === 'private' ? (ownerId || null) : null,
    area: (area || '').trim(),
  };
  places.push(place);
  savePlaces(w, places);
  res.status(201).json({ place });
});

app.put('/api/places/:id', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const places = loadPlaces(w);
  const place = places.find((p) => p.id === id);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const { name, desc, type, ownerId, area } = req.body || {};
  if (typeof name === 'string' && name.trim()) place.name = name.trim();
  if (typeof desc === 'string') place.desc = desc.trim();
  if (type === 'private' || type === 'communal') place.type = type;
  if (typeof area === 'string') place.area = area.trim();
  if (place.type === 'private') {
    if (ownerId !== undefined) {
      if (ownerId) {
        const characters = loadCharacters(w);
        if (!characters.some((c) => c.id === ownerId)) {
          return res.status(400).json({ error: 'Unknown owner character id.' });
        }
      }
      place.ownerId = ownerId || null;
    }
  } else {
    place.ownerId = null;
  }

  savePlaces(w, places);
  res.json({ place });
});

app.delete('/api/places/:id', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const places = loadPlaces(w);
  if (!places.some((p) => p.id === id)) return res.status(404).json({ error: 'Place not found.' });

  savePlaces(w, places.filter((p) => p.id !== id));

  const world = loadWorld(w);
  let changed = false;
  Object.entries(world.placements).forEach(([charId, placement]) => {
    if (placement.placeId === id) { delete world.placements[charId]; changed = true; }
  });
  if (changed) saveWorld(w, world);

  deleteChatLog(w.chatDir, id);

  res.json({ ok: true });
});

// --- Weather routes ------------------------------------------------------

app.get('/api/weather', (req, res) => {
  const w = req.world;
  res.json({ weather: loadWeather(w), areas: knownAreas(w), conditions: WEATHER_CONDITIONS });
});

app.post('/api/weather/:area', (req, res) => {
  const w = req.world;
  const { area } = req.params;
  const { mode, condition } = req.body || {};
  if (!knownAreas(w).includes(area)) return res.status(404).json({ error: 'Unknown area.' });

  const day = loadWorld(w).time.day;
  const weather = loadWeather(w);
  let updated;
  if (mode === 'manual') {
    if (!WEATHER_CONDITIONS.includes(condition)) {
      return res.status(400).json({ error: `condition must be one of: ${WEATHER_CONDITIONS.join(', ')}` });
    }
    updated = setManualWeather(weather, area, condition, day);
  } else if (mode === 'auto') {
    updated = setAutoWeather(weather, area, day);
  } else {
    return res.status(400).json({ error: "mode must be 'auto' or 'manual'." });
  }
  saveWeather(w, updated);
  res.json({ weather: updated });
});

// --- Texting routes --------------------------------------------------------

// Generates one texting reply from `character` to the active persona,
// appending it to their conversation log. Mirrors runReactionRound's
// single-character branch (context-gathering, the streaming/non-streaming
// OpenRouter call, memory recording) but through buildTextingMessages
// instead of the physical-scene prompt pipeline — see lib/texting.js for
// why. onEvent (when given) streams speaker/delta/turn events, the same
// shape /say's SSE path uses. placeId is null for texting memories (no
// physical place involved) — recordTurn already treats that as "no place."
async function runTextingReply({ w, cfg, characterId, character, onEvent = null }) {
  if (!cfg.apiKey) return { error: 'No API key configured. Add one in Settings.' };

  try {
    const { personas, activePersonaId } = loadPersonas(w);
    const activePersona = personas.find((p) => p.id === activePersonaId) || null;
    const personaLabel = activePersona ? activePersona.name : 'Visitor';
    const world = loadWorld(w);
    const log = loadChatLog(w.textsDir, characterId);

    const latestUserEntry = [...log].reverse().find((m) => m.type === 'user');
    const memoryQuery = latestUserEntry ? latestUserEntry.text : `${personaLabel} texts ${character.name}.`;

    let memories = [];
    try {
      memories = await retrieveMemories({
        db: w.db, embedFn: embed, characterIds: [characterId], query: memoryQuery, minScore: cfg.memoryMinScore,
      });
    } catch (err) {
      logger.warn('memory', `texting retrieval failed, continuing without memories: ${err.message}`);
    }

    const charactersById = {};
    loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
    const placesById = {};
    loadPlaces(w).forEach((p) => { placesById[p.id] = p; });
    const relationships = await relationshipKnowledge(w, characterId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery);

    const messages = buildTextingMessages({
      char: character,
      persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
      memories, relationships, time: world.time,
      textingPromptTemplate: publicConfig(cfg).textingPromptTemplate,
    }, historyFromLog(log));

    if (onEvent) onEvent({ type: 'speaker', charId: characterId, name: character.name });

    let text, usage, timing;
    if (onEvent && cfg.streaming) {
      ({ text, usage, timing } = await streamOpenRouter(cfg, messages, undefined, `${character.name} (text)`,
        (delta) => onEvent({ type: 'delta', ...delta })));
    } else {
      ({ text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (text)`));
    }

    const entry = { type: 'char', charId: characterId, name: character.name, text: (text || '').trim() };
    const stats = buildGenerationStats(usage, timing);
    if (stats) entry.stats = stats;
    appendChatEntries(w.textsDir, characterId, [entry]);
    if (onEvent) onEvent({ type: 'turn', entries: [entry] });

    recordTurn({
      db: w.db, embedFn: embed, characterIds: [characterId], personaId: activePersonaId || null,
      text: `${personaLabel}: ${latestUserEntry ? latestUserEntry.text : ''}\n${character.name}: ${entry.text}`,
      placeId: null, entryIds: [latestUserEntry?.id, entry.id].filter(Boolean),
      day: world.time.day, timeOfDay: world.time.timeOfDay,
    }).catch((err) => logger.error('memory', `texting round recording failed: ${err.message}`));

    return { entries: [entry] };
  } catch (err) {
    return { error: err.message };
  }
}

app.get('/api/texts/:characterId', (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });
  res.json({ log: loadChatLog(w.textsDir, characterId) });
});

// Sending a text: appends the user's line, then generates the character's
// reply — as SSE when streaming is enabled in Settings, as one JSON
// response otherwise. Mirrors /api/places/:placeId/say's shape exactly so
// the frontend's SSE-consuming logic can be reused as-is. The user's line
// persists even when generation fails.
app.post('/api/texts/:characterId/send', async (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  appendChatEntries(w.textsDir, characterId, [{ type: 'user', text: text.trim() }]);
  logger.info('chat', `text -> ${character.name}`);

  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.textsDir, characterId) });

    const result = await runTextingReply({ w, cfg, characterId, character, onEvent: send });
    send({ type: 'done', log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runTextingReply({ w, cfg, characterId, character });
  res.json({ log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error } : {}) });
});

// Re-runs generation for the trailing user message when nothing replied —
// mirrors /api/places/:placeId/retry and /api/groups/:groupId/retry
// exactly. Reuses the same trigger entry (rather than re-appending it) so
// a second retry after another all-replies-deleted round doesn't leave
// yet another stale "just the user's words" memory row behind —
// pruneReplylessMemories clears the previous attempt's memory first.
app.post('/api/texts/:characterId/retry', async (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const log = loadChatLog(w.textsDir, characterId);
  let lastUserIdx = -1;
  for (let i = log.length - 1; i >= 0; i--) { if (log[i].type === 'user') { lastUserIdx = i; break; } }
  if (lastUserIdx === -1) return res.status(400).json({ error: 'Nothing to retry — say something first.' });
  if (log.slice(lastUserIdx + 1).some((e) => e.type === 'char')) {
    return res.status(400).json({ error: 'The last message already has a reply.' });
  }

  const userEntryId = log[lastUserIdx].id;
  if (userEntryId) {
    pruneReplylessMemories(w.db, findMemoriesWitnessing(w.db, userEntryId), log);
  }

  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log });

    const result = await runTextingReply({ w, cfg, characterId, character, onEvent: send });
    send({ type: 'done', log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runTextingReply({ w, cfg, characterId, character });
  res.json({ log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error } : {}) });
});

// Deletes one message from a 1-on-1 texting conversation — mirrors
// /api/places/:placeId/messages/:entryId's DELETE and
// /api/groups/:groupId/messages/:entryId exactly, just against
// w.textsDir keyed by characterId instead of a place or group id.
app.delete('/api/texts/:characterId/messages/:entryId', async (req, res) => {
  const w = req.world;
  const { characterId, entryId } = req.params;
  if (!loadCharacters(w).some((c) => c.id === characterId)) return res.status(404).json({ error: 'Character not found.' });

  const log = loadChatLog(w.textsDir, characterId);
  const idx = log.findIndex((e) => e.id === entryId);
  if (idx === -1) return res.status(404).json({ error: 'Message not found.' });

  log.splice(idx, 1);
  saveChatLog(w.textsDir, characterId, log);
  logger.info('chat', `deleted text message ${entryId} @ ${characterId}`);

  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  await syncMemoriesForEntry({
    db: w.db, embedFn: embed, entryId, newEntryIds: [],
    log, userLabel: activePersona ? activePersona.name : 'Visitor',
    formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `text delete memory sync failed: ${err.message}`));

  res.json({ log });
});

// --- Group texting routes ------------------------------------------------
// A group conversation is the same stored-log shape 1-on-1 texting already
// uses (w.textsDir/<id>.json), just keyed by a group id instead of a
// character id, with participantIds/name tracked separately in
// groups.json. Sending a message runs the reply cascade — see
// lib/textCascade.js for the decay math this is built on.

app.get('/api/groups', (req, res) => {
  res.json({ groups: loadGroups(req.world) });
});

app.post('/api/groups', (req, res) => {
  const w = req.world;
  const { name, participantIds } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'A group name is required.' });
  if (!Array.isArray(participantIds) || new Set(participantIds).size < 2) {
    return res.status(400).json({ error: 'At least 2 participants are required.' });
  }
  const characters = loadCharacters(w);
  const unknown = participantIds.filter((id) => !characters.some((c) => c.id === id));
  if (unknown.length) return res.status(400).json({ error: `Unknown character id(s): ${unknown.join(', ')}` });

  const { groups, group } = createGroup(loadGroups(w), { name, participantIds });
  saveGroups(w, groups);
  logger.info('chat', `group created: ${group.name} (${group.participantIds.length} participants)`);
  res.status(201).json({ group });
});

app.get('/api/groups/:groupId', (req, res) => {
  const w = req.world;
  const group = loadGroups(w).find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  res.json({ group, log: loadChatLog(w.textsDir, group.id) });
});

app.delete('/api/groups/:groupId', (req, res) => {
  const w = req.world;
  const groups = loadGroups(w);
  const group = groups.find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  saveGroups(w, groups.filter((g) => g.id !== group.id));
  deleteChatLog(w.textsDir, group.id);
  res.json({ ok: true });
});

// One cascade reply, generation-wise close to runTextingReply but scoped to
// whichever member is replying within the group — see groupHistoryFromLog
// for why the history shaping differs from 1-on-1 (a plain chat-completion
// API has no "third party" role, so everyone else's lines, including the
// user's, fold into 'user' turns; only the replying character's own past
// lines come back as 'assistant').
async function generateGroupReply({ w, cfg, group, replierId, character, charactersById, onEvent = null }) {
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const personaLabel = activePersona ? activePersona.name : 'Visitor';
  const world = loadWorld(w);
  const log = loadChatLog(w.textsDir, group.id);

  const latestEntry = [...log].reverse().find((m) => m.type === 'user' || m.type === 'char');
  const memoryQuery = latestEntry ? latestEntry.text : `${personaLabel} texts the group.`;

  let memories = [];
  try {
    memories = await retrieveMemories({ db: w.db, embedFn: embed, characterIds: [replierId], query: memoryQuery, minScore: cfg.memoryMinScore });
  } catch (err) {
    logger.warn('memory', `group retrieval failed, continuing without memories: ${err.message}`);
  }

  const placesById = {};
  loadPlaces(w).forEach((p) => { placesById[p.id] = p; });
  const relationships = await relationshipKnowledge(w, replierId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery);
  const groupMembers = group.participantIds.filter((id) => id !== replierId).map((id) => charactersById[id]?.name).filter(Boolean);

  const messages = buildTextingMessages({
    char: character,
    persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
    memories, relationships, time: world.time, groupMembers,
    textingPromptTemplate: publicConfig(cfg).textingPromptTemplate,
  }, groupHistoryFromLog(log, replierId, personaLabel));

  if (onEvent) onEvent({ type: 'speaker', charId: replierId, name: character.name });

  let text, usage, timing;
  if (onEvent && cfg.streaming) {
    ({ text, usage, timing } = await streamOpenRouter(cfg, messages, undefined, `${character.name} (group)`,
      (delta) => onEvent({ type: 'delta', ...delta })));
  } else {
    ({ text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (group)`));
  }

  const entry = { type: 'char', charId: replierId, name: character.name, text: (text || '').trim() };
  const stats = buildGenerationStats(usage, timing);
  if (stats) entry.stats = stats;
  appendChatEntries(w.textsDir, group.id, [entry]);
  if (onEvent) onEvent({ type: 'turn', entries: [entry] });
  return entry;
}

// Runs the reply cascade after any message lands in a group text — the
// user's own message today, or (once Phase 5 exists) a character's
// proactive one, which is why triggerSpeakerId isn't hardcoded to 'user'.
// Each additional reply is an independent roll whose odds decay with every
// reply already landed this cascade (nextCascadeChance); who replies is
// picked at random from group members not currently at the consecutive-
// reply cap (eligibleReplierIds). Stops on the first failed roll, on
// running out of eligible repliers, or at MAX_CASCADE_REPLIES regardless
// of how the dice keep landing.
async function runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId, onEvent = null }) {
  if (!cfg.apiKey) return { entries: [], error: 'No API key configured. Add one in Settings.' };

  const cascadeEntries = [];
  let lastSpeakerId = charactersById[triggerSpeakerId] ? triggerSpeakerId : null;
  let lastSpeakerStreak = lastSpeakerId ? 1 : 0;
  let repliesSoFar = 0;

  while (repliesSoFar < MAX_CASCADE_REPLIES) {
    const chance = nextCascadeChance(cfg.cascadeBaseChance, cfg.cascadeDecayRate, repliesSoFar);
    if (!rollContinues(chance)) break;

    const eligible = eligibleReplierIds(group.participantIds, lastSpeakerId, lastSpeakerStreak, cfg.cascadePerCharacterCap);
    if (!eligible.length) break;
    const replierId = pickReplier(eligible);
    const character = charactersById[replierId];
    if (!character) break; // shouldn't happen — participantIds are validated at creation

    let entry;
    try {
      entry = await generateGroupReply({ w, cfg, group, replierId, character, charactersById, onEvent });
    } catch (err) {
      logger.warn('chat', `group cascade reply failed, stopping the cascade here: ${err.message}`);
      break;
    }
    cascadeEntries.push(entry);

    lastSpeakerStreak = replierId === lastSpeakerId ? lastSpeakerStreak + 1 : 1;
    lastSpeakerId = replierId;
    repliesSoFar += 1;
  }

  return { entries: cascadeEntries };
}

// One shared memory row for the whole round (trigger + every cascade
// reply), same "one row, many participants" pattern recordRound uses for a
// physical-scene round — everyone in a group text conversation sees every
// message in it, so unlike Phase 3's call bystanders there's no redaction
// to do here.
function recordGroupRound(w, { group, triggerEntry, cascadeEntries, userLabel, activePersonaId, time }) {
  const relevant = [triggerEntry, ...cascadeEntries].filter(Boolean);
  const text = relevant.map((e) => (e.type === 'user' ? `${userLabel}: ${e.text}` : `${e.name}: ${e.text}`)).join('\n');
  if (!text.trim()) return;
  recordTurn({
    db: w.db, embedFn: embed, characterIds: group.participantIds, personaId: activePersonaId || null,
    text, placeId: null, entryIds: relevant.map((e) => e.id).filter(Boolean),
    day: time?.day ?? null, timeOfDay: time?.timeOfDay ?? null,
  }).catch((err) => logger.error('memory', `group round recording failed: ${err.message}`));
}

app.post('/api/groups/:groupId/send', async (req, res) => {
  const w = req.world;
  const { groupId } = req.params;
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required.' });

  const group = loadGroups(w).find((g) => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });

  const userEntry = { type: 'user', text: text.trim() };
  appendChatEntries(w.textsDir, groupId, [userEntry]);
  logger.info('chat', `group text -> ${group.name}`);

  const cfg = loadConfig();
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const userLabel = activePersona ? activePersona.name : 'Visitor';
  const time = loadWorld(w).time;

  const finish = (result) => recordGroupRound(w, {
    group, triggerEntry: userEntry, cascadeEntries: result.entries, userLabel, activePersonaId, time,
  });

  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.textsDir, groupId) });

    const result = await runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId: 'user', onEvent: send });
    finish(result);
    send({ type: 'done', log: loadChatLog(w.textsDir, groupId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId: 'user' });
  finish(result);
  res.json({ log: loadChatLog(w.textsDir, groupId), ...(result.error ? { error: result.error } : {}) });
});

// Re-runs the cascade for the trailing user message when nothing replied —
// mirrors /api/places/:placeId/retry exactly. Reuses the same trigger
// entry (rather than re-appending it) so a second retry after another
// all-replies-deleted round doesn't leave yet another stale "just the
// user's words" memory row behind — pruneReplylessMemories clears the
// previous attempt's memory (if any) first.
app.post('/api/groups/:groupId/retry', async (req, res) => {
  const w = req.world;
  const { groupId } = req.params;
  const group = loadGroups(w).find((g) => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const log = loadChatLog(w.textsDir, groupId);
  let lastUserIdx = -1;
  for (let i = log.length - 1; i >= 0; i--) { if (log[i].type === 'user') { lastUserIdx = i; break; } }
  if (lastUserIdx === -1) return res.status(400).json({ error: 'Nothing to retry — say something first.' });
  if (log.slice(lastUserIdx + 1).some((e) => e.type === 'char')) {
    return res.status(400).json({ error: 'The last message already has a reply.' });
  }

  const triggerEntry = log[lastUserIdx];
  if (triggerEntry.id) {
    pruneReplylessMemories(w.db, findMemoriesWitnessing(w.db, triggerEntry.id), log);
  }

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });

  const cfg = loadConfig();
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const userLabel = activePersona ? activePersona.name : 'Visitor';
  const time = loadWorld(w).time;

  const finish = (result) => recordGroupRound(w, {
    group, triggerEntry, cascadeEntries: result.entries, userLabel, activePersonaId, time,
  });

  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log });

    const result = await runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId: 'user', onEvent: send });
    finish(result);
    send({ type: 'done', log: loadChatLog(w.textsDir, groupId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId: 'user' });
  finish(result);
  res.json({ log: loadChatLog(w.textsDir, groupId), ...(result.error ? { error: result.error } : {}) });
});

// Deletes one message from a group's log — mirrors
// /api/places/:placeId/messages/:entryId's DELETE exactly, just against
// w.textsDir instead of w.chatDir.
app.delete('/api/groups/:groupId/messages/:entryId', async (req, res) => {
  const w = req.world;
  const { groupId, entryId } = req.params;
  if (!loadGroups(w).some((g) => g.id === groupId)) return res.status(404).json({ error: 'Group not found.' });

  const log = loadChatLog(w.textsDir, groupId);
  const idx = log.findIndex((e) => e.id === entryId);
  if (idx === -1) return res.status(404).json({ error: 'Message not found.' });

  log.splice(idx, 1);
  saveChatLog(w.textsDir, groupId, log);
  logger.info('chat', `deleted group message ${entryId} @ ${groupId}`);

  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  await syncMemoriesForEntry({
    db: w.db, embedFn: embed, entryId, newEntryIds: [],
    log, userLabel: activePersona ? activePersona.name : 'Visitor',
    formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `group delete memory sync failed: ${err.message}`));

  res.json({ log });
});

// Renames a group and/or changes its participants — at least 2 must
// remain. Removing a participant only drops them from the roster; their
// past lines stay in the log (deleting the messages themselves is a
// separate, explicit action).
app.put('/api/groups/:groupId', (req, res) => {
  const w = req.world;
  const { groupId } = req.params;
  const groups = loadGroups(w);
  const group = groups.find((g) => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const { name, participantIds } = req.body || {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'A group name is required.' });
    group.name = name.trim();
  }
  if (participantIds !== undefined) {
    if (!Array.isArray(participantIds) || new Set(participantIds).size < 2) {
      return res.status(400).json({ error: 'At least 2 participants are required.' });
    }
    const characters = loadCharacters(w);
    const unknown = participantIds.filter((id) => !characters.some((c) => c.id === id));
    if (unknown.length) return res.status(400).json({ error: `Unknown character id(s): ${unknown.join(', ')}` });
    group.participantIds = [...new Set(participantIds)];
  }

  saveGroups(w, groups);
  res.json({ group });
});

// --- Call routes -------------------------------------------------------
// A call is appended into the CALLER's current place's own chat log (not a
// separate thread, unlike texting) so it stays part of one continuous scene
// history — see phase3-calls.md. The callee's replies reuse Phase 2's
// texting-mode generation (buildTextingMessages), but fed only the call's
// own transcript (calls[placeId].transcript), never the physical scene's
// history around it — a call is generation-wise closer to a text exchange
// than a physical scene. Everyone present in the caller's place when the
// call starts becomes a bystander for its duration: demoted (silenced) like
// any inactive character, restored to their exact prior active state
// (including "never explicitly set") on hangup, and — per the "hear only
// your side" rule — their memory of each round contains only the user's own
// words, never the callee's reply.

function normalizeActiveForCallSnapshot(active) {
  return active === undefined ? null : active;
}
function restoreActiveFromCallSnapshot(placement, snapshotValue) {
  if (snapshotValue === null) delete placement.active;
  else placement.active = snapshotValue;
}
function publicActiveCall(callState) {
  return callState ? { charId: callState.charId, name: callState.name } : null;
}

app.post('/api/calls/:characterId/start', (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const { placeId } = req.body || {};

  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });
  const place = loadPlaces(w).find((p) => p.id === placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const calls = loadCalls(w);
  if (calls[placeId]) return res.status(409).json({ error: 'A call is already in progress here.' });

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const presentIds = presentCharIds(w, placeId, charactersById);
  if (presentIds.includes(characterId)) {
    return res.status(400).json({ error: `${character.name} is right here — no need to call them.` });
  }

  const world = loadWorld(w);
  const bystanders = {};
  presentIds.forEach((cid) => {
    bystanders[cid] = normalizeActiveForCallSnapshot(world.placements[cid]?.active);
    world.placements[cid] = { ...world.placements[cid], active: false };
  });
  saveWorld(w, world);

  calls[placeId] = { charId: characterId, name: character.name, bystanders, transcript: [], roundCount: 0 };
  saveCalls(w, calls);

  appendChatEntries(w.chatDir, placeId, [{ type: 'system', text: `📞 You call ${character.name}.`, call: true }]);
  logger.info('chat', `call started: ${character.name} @ ${place.name} (${presentIds.length} bystander(s))`);

  res.json({ log: loadChatLog(w.chatDir, placeId), placements: world.placements, callee: { id: character.id, name: character.name } });
});

// One call round: appends the user's line, generates the callee's reply,
// records full memory for the callee and redacted (user-only) memory for
// bystanders, and — mirroring how present-but-inactive characters already
// get ambient narration in a normal reaction round — gives the existing
// narrator mechanism a turn for the bystanders, explicitly told they're
// overhearing one side of a call rather than part of it. Mutates
// callState.transcript/roundCount in place; the caller persists it.
async function runCallReply({ w, cfg, placeId, place, characterId, character, callState, onEvent = null }) {
  if (!cfg.apiKey) return { error: 'No API key configured. Add one in Settings.' };

  try {
    const { personas, activePersonaId } = loadPersonas(w);
    const activePersona = personas.find((p) => p.id === activePersonaId) || null;
    const personaLabel = activePersona ? activePersona.name : 'Visitor';
    const world = loadWorld(w);

    const latestUserEntry = [...callState.transcript].reverse().find((m) => m.type === 'user');
    const memoryQuery = latestUserEntry ? latestUserEntry.text : `${personaLabel} calls ${character.name}.`;

    let memories = [];
    try {
      memories = await retrieveMemories({
        db: w.db, embedFn: embed, characterIds: [characterId], query: memoryQuery, minScore: cfg.memoryMinScore,
      });
    } catch (err) {
      logger.warn('memory', `call retrieval failed, continuing without memories: ${err.message}`);
    }

    const charactersById = {};
    loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
    const placesById = {};
    loadPlaces(w).forEach((p) => { placesById[p.id] = p; });
    const relationships = await relationshipKnowledge(w, characterId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery);

    const messages = buildTextingMessages({
      char: character,
      persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
      memories, relationships, time: world.time, mode: 'call',
      textingPromptTemplate: publicConfig(cfg).textingPromptTemplate,
    }, historyFromLog(callState.transcript));

    if (onEvent) onEvent({ type: 'speaker', charId: characterId, name: character.name });

    let text, usage, timing;
    if (onEvent && cfg.streaming) {
      ({ text, usage, timing } = await streamOpenRouter(cfg, messages, undefined, `${character.name} (call)`,
        (delta) => onEvent({ type: 'delta', ...delta })));
    } else {
      ({ text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (call)`));
    }

    const entry = { type: 'char', charId: characterId, name: character.name, text: (text || '').trim(), call: true };
    const stats = buildGenerationStats(usage, timing);
    if (stats) entry.stats = stats;
    appendChatEntries(w.chatDir, placeId, [entry]);
    if (onEvent) onEvent({ type: 'turn', entries: [entry] });

    callState.transcript.push({ type: 'char', text: entry.text });
    callState.roundCount += 1;

    // Callee: the full exchange. placeId: null, same as texting (Phase 2)
    // and for the same reason — they weren't physically anywhere.
    recordTurn({
      db: w.db, embedFn: embed, characterIds: [characterId], personaId: activePersonaId || null,
      text: `${personaLabel}: ${latestUserEntry ? latestUserEntry.text : ''}\n${character.name}: ${entry.text}`,
      placeId: null, entryIds: [latestUserEntry?.entryId, entry.id].filter(Boolean),
      day: world.time.day, timeOfDay: world.time.timeOfDay,
    }).catch((err) => logger.error('memory', `call recording (callee) failed: ${err.message}`));

    // Bystanders: only the user's own words, tied to the real place — they
    // really were physically there, even if they never heard the other end.
    const bystanderIds = Object.keys(callState.bystanders);
    if (bystanderIds.length && latestUserEntry) {
      recordTurn({
        db: w.db, embedFn: embed, characterIds: bystanderIds, personaId: activePersonaId || null,
        text: `${personaLabel}: ${latestUserEntry.text}`,
        placeId, entryIds: [latestUserEntry.entryId].filter(Boolean),
        day: world.time.day, timeOfDay: world.time.timeOfDay,
      }).catch((err) => logger.error('memory', `call recording (bystanders) failed: ${err.message}`));
    }

    // Ambient bystander narration — the same "present but not part of the
    // conversation" case a normal round always narrates for background
    // characters, just told this is a call so the wording doesn't treat
    // them as part of it. The transcript strips the callee's own lines —
    // bystanders can hear the user's half only, never what comes back.
    if (bystanderIds.length && cfg.narratorEnabled !== false) {
      const log = loadChatLog(w.chatDir, placeId);
      const callVisibleLog = log.filter((e) => !(e.type === 'char' && e.call));
      const narration = await attemptNarratorTurn({
        w, cfg, place, presentIds: bystanderIds, backgroundIds: bystanderIds, charactersById, log: callVisibleLog,
        callContext: { calleeName: character.name },
      });
      if (narration) {
        const narratorEntry = { ...narration, call: true };
        appendChatEntries(w.chatDir, placeId, [narratorEntry]);
        if (onEvent) onEvent({ type: 'turn', entries: [narratorEntry] });
      }
    }

    return { entries: [entry] };
  } catch (err) {
    return { error: err.message };
  }
}

app.post('/api/calls/:characterId/say', async (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const { placeId, text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  const calls = loadCalls(w);
  const callState = calls[placeId];
  if (!callState || callState.charId !== characterId) {
    return res.status(400).json({ error: 'No active call with this character here.' });
  }

  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });
  const place = loadPlaces(w).find((p) => p.id === placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const userEntry = { type: 'user', text: text.trim(), call: true };
  appendChatEntries(w.chatDir, placeId, [userEntry]);
  callState.transcript.push({ type: 'user', text: userEntry.text, entryId: userEntry.id });
  saveCalls(w, calls);
  logger.info('chat', `call say -> ${character.name}`);

  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.chatDir, placeId) });

    const result = await runCallReply({ w, cfg, placeId, place, characterId, character, callState, onEvent: send });
    saveCalls(w, calls);
    send({ type: 'done', log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runCallReply({ w, cfg, placeId, place, characterId, character, callState });
  saveCalls(w, calls);
  res.json({ log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error } : {}) });
});

app.post('/api/calls/:characterId/end', (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const { placeId } = req.body || {};

  const calls = loadCalls(w);
  const callState = calls[placeId];
  if (!callState || callState.charId !== characterId) {
    return res.status(400).json({ error: 'No active call with this character here.' });
  }

  const character = loadCharacters(w).find((c) => c.id === characterId);
  const place = loadPlaces(w).find((p) => p.id === placeId);

  const world = loadWorld(w);
  Object.entries(callState.bystanders).forEach(([cid, snapshotValue]) => {
    if (world.placements[cid]) restoreActiveFromCallSnapshot(world.placements[cid], snapshotValue);
  });
  saveWorld(w, world);

  delete calls[placeId];
  saveCalls(w, calls);

  const calleeName = character ? character.name : callState.name;
  appendChatEntries(w.chatDir, placeId, [{ type: 'system', text: `📞 Call with ${calleeName} ended.`, call: true }]);
  logger.info('chat', `call ended: ${calleeName} @ ${place ? place.name : placeId}`);

  res.json({ log: loadChatLog(w.chatDir, placeId), placements: world.placements });
});

// --- World / placement routes ------------------------------------------

// Every character id that has ever spoken (a type:'char' entry) in any
// place's chat log — used by the Phone contacts list to only surface
// characters the user has actually met in a scene, rather than every
// character that exists in the world (see PhoneContacts.vue).
function metCharacterIds(w) {
  const ids = new Set();
  for (const place of loadPlaces(w)) {
    for (const entry of loadChatLog(w.chatDir, place.id)) {
      if (entry.type === 'char' && entry.charId) ids.add(entry.charId);
    }
  }
  return [...ids];
}

app.get('/api/world', (req, res) => {
  const w = req.world;
  const world = loadWorld(w);
  res.json({
    places: loadPlaces(w), placements: world.placements, time: world.time, setting: world.setting,
    metCharacterIds: metCharacterIds(w),
  });
});

// Place (or unplace, with placeId: null) a character, set which greeting
// they open with, and/or set whether they're an active participant (see
// activeCharIds above) — active defaults to true and resets to true
// whenever a character is (re)placed, so moving someone to a new place
// never leaves them silently stuck inactive there. Fields not included in
// the body are left as-is.
app.post('/api/characters/:id/place', (req, res) => {
  const w = req.world;
  const { id } = req.params;
  const { placeId, greetingIndex, active } = req.body || {};

  const characters = loadCharacters(w);
  const character = characters.find((c) => c.id === id);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const world = loadWorld(w);
  const placeIds = loadPlaces(w).map((p) => p.id);

  if (placeId === null) {
    delete world.placements[id];
    saveWorld(w, world);
    return res.json({ placements: world.placements });
  }

  const existing = world.placements[id] || { placeId: undefined, greetingIndex: null };

  if (placeId !== undefined) {
    if (!placeIds.includes(placeId)) return res.status(400).json({ error: `Unknown place id: ${placeId}` });
    existing.placeId = placeId;
    existing.active = true;
  }

  if (greetingIndex !== undefined) {
    const greetingCount = (character.greetings || []).length;
    if (greetingIndex !== null && (typeof greetingIndex !== 'number' || greetingIndex < 0 || greetingIndex >= greetingCount)) {
      return res.status(400).json({ error: `Invalid greeting index for ${character.name}.` });
    }
    existing.greetingIndex = greetingIndex;
  }

  if (typeof active === 'boolean') existing.active = active;

  if (existing.placeId === undefined) {
    return res.status(400).json({ error: 'placeId is required the first time a character is placed.' });
  }

  world.placements[id] = existing;
  saveWorld(w, world);
  res.json({ placements: world.placements });
});

// Scatter every known character across the places at random.
// Randomized placements always start with no scripted greeting (AI-improvised arrival).
app.post('/api/world/randomize', (req, res) => {
  const w = req.world;
  const { placeIds } = req.body || {};
  const allIds = loadPlaces(w).map((p) => p.id);
  const pool = Array.isArray(placeIds) && placeIds.length ? placeIds.filter((p) => allIds.includes(p)) : allIds;
  if (!pool.length) return res.status(400).json({ error: 'No valid places to place characters in.' });

  const characters = loadCharacters(w);
  const placements = {};
  characters.forEach((c) => {
    placements[c.id] = { placeId: pool[Math.floor(Math.random() * pool.length)], greetingIndex: null };
  });

  const world = loadWorld(w);
  world.placements = placements;
  saveWorld(w, world);
  res.json({ placements });
});

// --- World time & setting ---------------------------------------------------
// The in-world clock never advances on its own — only these endpoints move
// it. `advance`/`retreat: true` step one time-of-day forward or backward
// (wrapping into the next/previous day at night/sunrise); explicit
// day/timeOfDay jump straight to any point, including backward — for
// time-travel scenarios, not just always moving forward.

// Snaps every scheduled character onto their slot for the world's current
// (already-updated) day/time-of-day, mutating world.placements in place.
// A character with nothing scheduled for this exact slot just keeps
// whatever placement they already had — schedules are opt-in per slot, not
// a full replacement for manual placement.
function applyScheduledPlacements(world, characters) {
  const weekday = weekdayFor(world.time.day);
  characters.forEach((c) => {
    const slot = c.schedule?.[weekday]?.[world.time.timeOfDay];
    if (!slot || !slot.placeId) return;
    const existing = world.placements[c.id];
    world.placements[c.id] = { placeId: slot.placeId, greetingIndex: existing ? existing.greetingIndex : null };
  });
}

// Every distinct non-blank area currently in use by a place — the roll
// target set for weather's daily auto-reroll.
function knownAreas(w) {
  return [...new Set(loadPlaces(w).map((p) => p.area).filter(Boolean))];
}

app.post('/api/world/time', (req, res) => {
  const w = req.world;
  const { advance, retreat, day, timeOfDay } = req.body || {};
  const world = loadWorld(w);
  const dayBefore = world.time.day;

  if (advance) {
    const idx = TIMES_OF_DAY.indexOf(world.time.timeOfDay);
    const next = (idx + 1) % TIMES_OF_DAY.length;
    world.time.timeOfDay = TIMES_OF_DAY[next];
    if (next === 0) world.time.day += 1;
  }
  if (retreat) {
    const idx = TIMES_OF_DAY.indexOf(world.time.timeOfDay);
    const prev = (idx - 1 + TIMES_OF_DAY.length) % TIMES_OF_DAY.length;
    world.time.timeOfDay = TIMES_OF_DAY[prev];
    if (prev === TIMES_OF_DAY.length - 1) world.time.day = Math.max(1, world.time.day - 1);
  }
  if (timeOfDay !== undefined) {
    if (!TIMES_OF_DAY.includes(timeOfDay)) {
      return res.status(400).json({ error: `timeOfDay must be one of: ${TIMES_OF_DAY.join(', ')}` });
    }
    world.time.timeOfDay = timeOfDay;
  }
  if (day !== undefined) {
    const n = Number(day);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'day must be a positive integer.' });
    world.time.day = n;
  }

  if (world.time.day !== dayBefore) {
    saveWeather(w, rollAutoWeather(loadWeather(w), knownAreas(w), world.time.day));
  }

  applyScheduledPlacements(world, loadCharacters(w));
  saveWorld(w, world);
  res.json({ time: world.time, placements: world.placements });
});

app.post('/api/world/setting', (req, res) => {
  const w = req.world;
  const { setting } = req.body || {};
  if (typeof setting !== 'string') return res.status(400).json({ error: 'setting must be a string.' });
  const world = loadWorld(w);
  world.setting = setting.trim();
  saveWorld(w, world);
  res.json({ setting: world.setting });
});

// --- Memory routes ---------------------------------------------------------
// Per-(character, persona) semantic memory, embedded locally (lib/embeddings.js)
// and stored in lib/memoryStore.js's flat per-pair JSON files. The frontend
// calls /retrieve before building a system prompt (feeding results into the
// characterMemory preset marker) and /record after a turn completes.

app.post('/api/memory/record', async (req, res) => {
  const w = req.world;
  const { text, placeId, personaId, characterIds, entryIds, day, timeOfDay } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  if (!Array.isArray(characterIds) || !characterIds.length) {
    return res.status(400).json({ error: 'characterIds must be a non-empty array.' });
  }

  try {
    const result = await recordTurn({
      db: w.db,
      embedFn: embed,
      characterIds,
      personaId: personaId || null,
      text,
      placeId,
      entryIds: Array.isArray(entryIds) ? entryIds : [],
      day: Number.isInteger(day) ? day : null,
      timeOfDay: typeof timeOfDay === 'string' ? timeOfDay : null,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/memory/retrieve', async (req, res) => {
  const w = req.world;
  const { query, characterIds, topKPerCharacter } = req.body || {};
  if (typeof query !== 'string' || !query.trim() || !Array.isArray(characterIds) || !characterIds.length) {
    return res.json({ memories: [] });
  }

  try {
    const memories = await retrieveMemories({
      db: w.db,
      embedFn: embed,
      characterIds,
      query,
      topKPerCharacter: normalizeContextNumber(topKPerCharacter, 3),
    });
    res.json({ memories });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Memory management routes ----------------------------------------------
// View/add/edit/delete a character's own memories — distinct from the
// automatic record/retrieve path above. Registered after the literal
// /record and /retrieve routes so those aren't shadowed by :characterId.

// Newest-first, paginated (?limit=&offset=, default 50/0, capped at 200) —
// a long-running roleplay can pile up hundreds of memories per character,
// so the management UI never pulls the whole set (embeddings included) in
// one response. `total` lets the client know whether there's more to page.
app.get('/api/memory/:characterId', (req, res) => {
  const w = req.world;
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
  const rawOffset = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const memories = listCharacterMemories(w.db, req.params.characterId, { limit, offset });
  const total = countCharacterMemories(w.db, req.params.characterId);
  res.json({ memories, total, limit, offset });
});

app.post('/api/memory/:characterId', async (req, res) => {
  const w = req.world;
  const { text, personaId, placeId } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  try {
    const memory = await addCharacterMemory({
      db: w.db,
      embedFn: embed,
      characterId: req.params.characterId,
      personaId: personaId || null,
      text,
      placeId,
    });
    res.status(201).json({ memory });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.put('/api/memory/:characterId/:entryId', async (req, res) => {
  const w = req.world;
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  try {
    const memory = await updateCharacterMemory({
      db: w.db,
      embedFn: embed,
      characterId: req.params.characterId,
      entryId: req.params.entryId,
      text,
    });
    if (!memory) return res.status(404).json({ error: 'Memory not found.' });
    res.json({ memory });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.delete('/api/memory/:characterId/:entryId', (req, res) => {
  const ok = deleteCharacterMemory(req.world.db, req.params.characterId, req.params.entryId);
  if (!ok) return res.status(404).json({ error: 'Memory not found.' });
  res.json({ ok: true });
});

// Debugging aid: ranks EVERY one of a character's memories against a query
// (not just the winners retrieveMemories would hand to generation) so a
// human can see near-misses and understand why something was or wasn't
// recalled. Mirrors the real selection knobs (topK=3, recency=2 — the same
// unoverridden defaults buildTurnRequest uses) and defaults minScore to
// the user's actual configured Settings > Memory threshold, so "would this
// be recalled in a real turn" is a faithful answer — with an optional
// override to test "what if the threshold were different" without
// actually changing settings.
app.post('/api/memory/:characterId/query', async (req, res) => {
  const w = req.world;
  const { query, minScore, limit } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required.' });
  }
  const cfg = loadConfig();
  const effectiveMinScore = typeof minScore === 'number' && Number.isFinite(minScore) ? minScore : cfg.memoryMinScore;
  try {
    const results = await queryCharacterMemories({
      db: w.db,
      embedFn: embed,
      characterId: req.params.characterId,
      query,
      minScore: effectiveMinScore,
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50,
    });
    res.json({ results, minScoreUsed: effectiveMinScore });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Relationship routes -----------------------------------------------------
// Directed, multi-label relations: (characterId, targetId, labels) reads as
// "target is character's {labels}" — e.g. (ezra, mireille, [sister]) means
// Mireille is Ezra's sister. targetId 'user' means the visitor. Labels are
// free strings; the standard gendered/neutral sets live in the UI, custom
// ones are just typed in.

app.get('/api/relationships', (req, res) => {
  const relationships = req.world.db.prepare('SELECT character_id, target_id, labels FROM relationships').all()
    .map((r) => ({ characterId: r.character_id, targetId: r.target_id, labels: JSON.parse(r.labels || '[]') }));
  res.json({ relationships });
});

app.put('/api/relationships/:characterId/:targetId', async (req, res) => {
  const w = req.world;
  const { characterId, targetId } = req.params;
  const { labels } = req.body || {};
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string')) {
    return res.status(400).json({ error: 'labels must be an array of strings.' });
  }

  const characters = loadCharacters(w);
  if (!characters.some((c) => c.id === characterId)) {
    return res.status(404).json({ error: 'Character not found.' });
  }
  const targetChar = characters.find((c) => c.id === targetId);
  if (targetId !== 'user' && !targetChar) {
    return res.status(404).json({ error: 'Target not found (use a character id or "user").' });
  }
  if (characterId === targetId) {
    return res.status(400).json({ error: 'A character cannot have a relationship with themselves.' });
  }

  const result = await upsertRelationship({ db: w.db, embedFn: embed, characterId, targetId, labels });
  if (result.removed) return res.json({ ok: true, removed: true });
  res.json({ ok: true, labels: result.labels });
});

// Debugging aid: ranks EVERY one of a character's relationships (forward
// and reverse) against a free-text description — "your friend with the
// blue eyes" — using the same two-signal (label + other-party identity)
// scoring retrieveRelevantRelationships uses for real generation, so a
// human can see the score breakdown and why a relationship would or
// wouldn't surface. No LLM call, just the local embedding model.
app.post('/api/relationships/:characterId/query', async (req, res) => {
  const w = req.world;
  const { query, limit } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required.' });
  }
  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  try {
    const results = await queryCharacterRelationships({
      db: w.db,
      embedFn: embed,
      speakerId: req.params.characterId,
      query,
      charactersById,
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50,
    });
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Chat -----------------------------------------------------------------

// Shared by /api/chat and /api/characters/draft. Throws on failure (with a
// .status set when OpenRouter itself returned a non-OK response) rather
// than writing to `res` directly, so callers can shape their own error body.
function completionPayload(cfg, messages, maxTokens, stream = false) {
  const payload = {
    model: cfg.model,
    messages,
    max_tokens: normalizeContextNumber(maxTokens, DEFAULT_MAX_REPLY_TOKENS),
  };
  if (stream) {
    payload.stream = true;
    // Standard OpenAI Chat Completions field — asks for a final usage-only
    // chunk so streamed replies get real token counts too, not just
    // non-streamed ones.
    payload.stream_options = { include_usage: true };
  }
  // OpenRouter-specific knobs are only sent to OpenRouter — a custom
  // OpenAI-spec endpoint may reject unknown fields.
  if (isOpenRouter(cfg)) {
    if (cfg.reasoning && cfg.reasoning !== 'off') payload.reasoning = { effort: cfg.reasoning };
    // order is a preference list, tried in this sequence; allow_fallbacks:
    // false keeps OpenRouter from reaching outside it, not from trying the
    // next entry within it — so picking several providers here means "try
    // these, in this order," not "pin to exactly one."
    if (cfg.providers?.length) payload.provider = { order: cfg.providers, allow_fallbacks: false };
  }
  return payload;
}

function completionHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'HTTP-Referer': 'http://localhost',
    'X-Title': 'Freeroam',
  };
}

// Non-streaming completion. `meta` is logging context only (who/where).
// Returns { text, reasoning, usage, timing } — reasoning is present when the
// endpoint returned a reasoning/thinking trace (OpenRouter normalizes it);
// usage is token counts (null fields if the endpoint didn't report them);
// timing is wall-clock duration for tokens/sec display.
async function callOpenRouter(cfg, messages, maxTokens, meta = '') {
  const payload = completionPayload(cfg, messages, maxTokens);
  logger.info('llm', `→ ${cfg.apiBase || DEFAULT_API_BASE} model=${cfg.model}${cfg.providers?.length ? ` providers=${cfg.providers.join(',')}` : ''}${meta ? ` — ${meta}` : ''}`);
  logger.debug('llm', 'request payload', payload);

  const startedAt = Date.now();
  let r;
  try {
    r = await fetch(`${cfg.apiBase || DEFAULT_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: completionHeaders(cfg),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error('llm', `endpoint unreachable: ${err.message}`);
    throw new Error(`Endpoint unreachable: ${err.message}`);
  }

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = data?.error?.message || `Endpoint responded ${r.status}`;
    logger.error('llm', `request failed (${r.status}): ${message}`);
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  const msg = data?.choices?.[0]?.message || {};
  return {
    text: msg.content ?? '',
    reasoning: msg.reasoning || null,
    usage: normalizeUsage(data.usage),
    timing: { totalMs: Date.now() - startedAt, ttftMs: null }, // no meaningful "first token" without streaming
  };
}

// Streaming completion (SSE). Calls onDelta({ text?, reasoning? }) per
// chunk and resolves with the accumulated { text, reasoning, usage, timing }
// — usage comes from the final chunk (stream_options.include_usage above);
// timing includes time-to-first-token alongside total duration, since
// that's only observable while actually streaming.
async function streamOpenRouter(cfg, messages, maxTokens, meta, onDelta) {
  const payload = completionPayload(cfg, messages, maxTokens, true);
  logger.info('llm', `→ ${cfg.apiBase || DEFAULT_API_BASE} model=${cfg.model} (streaming)${meta ? ` — ${meta}` : ''}`);
  logger.debug('llm', 'request payload', payload);

  const startedAt = Date.now();
  let r;
  try {
    r = await fetch(`${cfg.apiBase || DEFAULT_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: completionHeaders(cfg),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error('llm', `endpoint unreachable: ${err.message}`);
    throw new Error(`Endpoint unreachable: ${err.message}`);
  }

  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const message = data?.error?.message || `Endpoint responded ${r.status}`;
    logger.error('llm', `stream request failed (${r.status}): ${message}`);
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let firstTokenAt = null;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const body = line.slice(5).trim();
      if (body === '[DONE]') continue;
      let json;
      try { json = JSON.parse(body); } catch { continue; }
      if (json.usage) usage = normalizeUsage(json.usage);
      const delta = json?.choices?.[0]?.delta || {};
      if (delta.content) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        text += delta.content;
        onDelta({ text: delta.content });
      }
      if (delta.reasoning) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        reasoning += delta.reasoning;
        onDelta({ reasoning: delta.reasoning });
      }
    }
  }
  return {
    text,
    reasoning: reasoning || null,
    usage,
    timing: { totalMs: Date.now() - startedAt, ttftMs: firstTokenAt ? firstTokenAt - startedAt : null },
  };
}

app.post('/api/chat', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return res.status(400).json({ error: 'No OpenRouter API key configured. Add one in Settings.' });
  }
  const { system, messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const { text } = await callOpenRouter(cfg, [...(system ? [{ role: 'system', content: system }] : []), ...messages], max_tokens, 'direct /api/chat');
    res.json({ text, model: cfg.model });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Consolidated, backend-owned generation endpoint. Chat isn't persisted
// server-side, so the frontend still owns and sends its per-place `log`
// array — but everything about what goes into the model request (present
// characters, active persona/preset, relevant memories, the system prompt,
// the token budget, and how much history fits) is decided here, not by the
// browser. The frontend just renders whatever text comes back.
// --- Persisted chat routes -------------------------------------------------
// The backend owns chat entirely: logs live in data/worlds/<id>/chats/<placeId>.json,
// survive page reloads, and every mutation (arrival markers, greetings,
// user lines, generated replies) happens here. The frontend renders
// whatever log these routes return.

function presentCharIds(w, placeId, charactersById) {
  return presentCharIdsFor(loadWorld(w).placements, charactersById, placeId);
}

// The subset of presentCharIds who actually take a turn each round. Active
// is the default (missing `active` on a placement == active) so existing
// saves and every current call site keep behaving exactly as before until
// someone is explicitly demoted — this is what makes a crowd's replies
// trimmable rather than everyone always talking.
function activeCharIds(w, placeId, charactersById) {
  return activeCharIdsFor(loadWorld(w).placements, charactersById, placeId);
}

// What the speaking character knows about the people relevant to `query`
// right now: who they are to them, and — with a randomized roll per
// generation — whether they currently know where that person is. Same-area
// presence and family ties raise the odds ("we live close / we talk"), so a
// mother in the same district is usually locatable while a distant
// acquaintance often isn't. Which relationships are even considered is
// itself bounded — see retrieveRelevantRelationships — so a character who
// knows a hundred people doesn't dump all hundred into every prompt.
// Separately from moment-to-moment location, a target's own *schedule* for
// the next time-of-day slot — routine, not real-time tracking — is always
// mentioned when it differs from where they are now, so characters can
// answer "where will they be" as well as "where are they."
async function relationshipKnowledge(w, speakerId, charactersById, placesById, world, personaName, query) {
  const lines = [];
  const speakerPlaceId = world.placements[speakerId]?.placeId;
  const speakerArea = speakerPlaceId && placesById[speakerPlaceId] ? placesById[speakerPlaceId].area : null;
  const upcoming = nextTimeSlot(world.time);

  const rows = await retrieveRelevantRelationships({ db: w.db, embedFn: embed, speakerId, query, charactersById });

  rows.forEach((row) => {
    const rel = row.labels.join(', ');
    if (!rel) return;

    if (row.direction === 'forward') {
      if (row.otherId === 'user') {
        lines.push(`${personaName || 'The visitor'} is your ${rel}.`);
        return;
      }
      const target = charactersById[row.otherId];
      if (!target) return;
      const placement = world.placements[row.otherId];
      const targetPlace = placement && placesById[placement.placeId];

      let chance = 0.45;
      if (targetPlace && speakerArea && targetPlace.area === speakerArea) chance += 0.35;
      if (FAMILY_HINTS.some((h) => rel.toLowerCase().includes(h))) chance += 0.2;
      const knows = targetPlace && Math.random() < Math.min(chance, 0.95);

      const nextPlace = scheduledPlaceFor(target, upcoming.day, upcoming.timeOfDay, placesById);
      const nextNote = (nextPlace && (!targetPlace || nextPlace.id !== targetPlace.id))
        ? ` They're expected to be at ${nextPlace.name}${nextPlace.area ? ` (${nextPlace.area})` : ''} by ${upcoming.timeOfDay}.`
        : '';

      lines.push((knows
        ? `${target.name} is your ${rel}. You happen to know they are currently at ${targetPlace.name}${targetPlace.area ? ` (${targetPlace.area})` : ''}.`
        : `${target.name} is your ${rel}. You are not sure exactly where they are right now.`) + nextNote);
    } else {
      // reverse: someone else considers the speaker their ___
      const other = charactersById[row.otherId];
      if (other) lines.push(`You are ${other.name}'s ${rel}.`);
    }
  });

  if (lines.length) logger.debug('memory', `relationship context for ${speakerId}`, lines);
  return lines;
}

// Assembles everything needed for one character's turn — system prompt
// (persona + relationships + memories + scene/time/world setting), the
// budget-trimmed transcript, and token limits. Shared by the non-streaming
// and streaming generation paths and by regenerate.
async function buildTurnRequest({ w, place, speakerId, presentIds, charactersById, log }) {
  const cfg = loadConfig();
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const { presets, activePresetId } = loadPresets(w);
  const activePreset = presets.find((p) => p.id === activePresetId) || null;
  const world = loadWorld(w);
  const placesById = {};
  loadPlaces(w).forEach((p) => { placesById[p.id] = p; });

  const speaker = charactersById[speakerId];
  const userLabel = activePersona ? activePersona.name : 'Visitor';
  const latestUserEntry = [...log].reverse().find((m) => m.type === 'user');
  const memoryQuery = latestUserEntry ? latestUserEntry.text : `${userLabel} arrives at ${place.name}.`;

  // The current interaction's own entries are already going into the
  // messages array as real chat history below — excluding them here stops
  // memory from re-quoting the same lines back in the system prompt (memory
  // is for recall *outside* what's already directly visible in this window).
  const currentInteractionIds = sliceSinceLastArrival(log).map((e) => e.id).filter(Boolean);

  let memories = [];
  try {
    memories = await retrieveMemories({
      db: w.db,
      embedFn: embed,
      characterIds: [speakerId],
      query: memoryQuery,
      excludeEntryIds: currentInteractionIds,
      minScore: cfg.memoryMinScore,
    });
  } catch (err) {
    logger.warn('memory', `retrieval failed, continuing without memories: ${err.message}`);
    memories = []; // memory is best-effort — never block generation on it
  }

  const scene = {
    chars: [{
      name: speaker.name,
      description: speaker.description,
      personality: speaker.personality,
      scenario: speaker.scenario,
      exampleDialogue: speaker.exampleDialogue,
    }],
    othersPresent: presentIds.filter((cid) => cid !== speakerId).map((cid) => charactersById[cid].name),
    place: {
      name: place.name,
      area: place.area,
      desc: place.desc,
      type: place.type,
      ownerName: place.ownerId && charactersById[place.ownerId] ? charactersById[place.ownerId].name : null,
      weather: place.area ? loadWeather(w)[place.area]?.condition || null : null,
    },
    persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
    memories,
    time: world.time,
    worldSetting: world.setting,
    relationships: await relationshipKnowledge(w, speakerId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery),
  };

  // Real role-tagged prompt messages — no active preset falls back to
  // Freeroam's own built-in prompt as a single system message; an active
  // preset's blocks keep whatever role each was configured with (system/
  // user/assistant) instead of everything being flattened into one system
  // string, so a block explicitly set to "user" actually arrives as a user
  // turn rather than getting lumped into the system message.
  const promptMessages = (!activePreset || !activePreset.prompts.length)
    ? [{ role: 'system', content: defaultSystemPrompt(scene) }]
    : assemblePresetMessages(activePreset, scene);
  const tail = `Continue the scene. Respond to the most recent line in the scene. Write ${speaker.name}'s next turn only — do not write for ${userLabel} or for the other characters present.`;

  const { contextLength, maxReplyTokens } = contextSettingsFor(activePreset);
  const systemPromptTokens = promptMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const budget = historyBudget({
    contextLength,
    maxReplyTokens,
    systemPromptTokens,
    instructionTokens: estimateTokens(tail),
  });
  // Everything else (prompts, world/area info, relationships, memories) is
  // already spent from the context budget above; whatever's left over gets
  // filled with as much of the current scene's history as fits, as real
  // role-tagged messages (not one flattened blob) so the model can actually
  // tell user turns from character turns.
  const history = buildHistoryMessages(log, { userLabel, speakerId, tokenBudget: budget });
  logger.debug('llm', `history: ${history.length} message(s), ~${systemPromptTokens} prompt tokens, budget ${budget}`);

  const messages = [...promptMessages, ...history];
  const last = messages[messages.length - 1];
  if (last.role === 'user') last.content += '\n\n' + tail;
  else messages.push({ role: 'user', content: tail });

  return {
    messages,
    maxReplyTokens,
    speaker: { id: speakerId, name: speaker.name },
    present: presentIds.map((cid) => ({ id: cid, name: charactersById[cid].name })),
    userLabel,
    activePersonaId,
    time: world.time,
  };
}

// Attaches reasoning + generation stats (tokens, tokens/sec, timing) to the
// entry the speaker's own line ends up as. usage/timing are whatever
// callOpenRouter/streamOpenRouter reported — buildGenerationStats (lib/
// context.js) handles either being partially or fully null when the
// endpoint doesn't report token counts.
async function turnEntriesFrom(w, text, reasoning, request, usage, timing, place, charactersById, suggestedActionsMode, backgroundIds = []) {
  const entries = parseCharacterTurn((text || '').trim(), request.speaker, request.present);
  if (!entries.length || entries[0].type !== 'char') return entries;
  if (reasoning) entries[0].reasoning = reasoning;
  const stats = buildGenerationStats(usage, timing);
  if (stats) entries[0].stats = stats;
  const backgroundCharacters = backgroundIds
    .map((cid) => charactersById[cid])
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name }));
  const suggestions = await detectSuggestedActions(entries[0].text, {
    places: loadPlaces(w),
    characters: Object.values(charactersById || {}),
    currentPlaceId: place?.id ?? null,
    mode: suggestedActionsMode,
    personaName: request.userLabel,
    backgroundCharacters,
    speakerId: request.speaker.id,
    speakerName: request.speaker.name,
  });
  if (suggestions.length) entries[0].suggestions = suggestions;
  return entries;
}

// Generates ONE character's turn. Returns { entries } or { error }; the
// caller decides whether to append or splice. Streams via onEvent — called
// with { type: 'speaker', ... } once buildTurnRequest resolves and then
// { type: 'delta', text?, reasoning? } per chunk — when cfg.streaming and an
// onEvent callback are both given; otherwise falls back to a single
// non-streaming completion call. Mirrors runReactionRound's per-character
// branch (used by /say) so /regenerate gets the same live text+reasoning
// streaming instead of only ever waiting for the full reply.
async function generateCharacterTurn({ w, cfg, place, speakerId, presentIds, charactersById, log, onEvent = null, backgroundIds = [] }) {
  const request = await buildTurnRequest({ w, place, speakerId, presentIds, charactersById, log });
  if (onEvent) onEvent({ type: 'speaker', charId: speakerId, name: request.speaker.name });
  try {
    let text, reasoning, usage, timing;
    if (onEvent && cfg.streaming) {
      ({ text, reasoning, usage, timing } = await streamOpenRouter(cfg, request.messages, request.maxReplyTokens,
        `${request.speaker.name} @ ${place.name}`, (delta) => onEvent({ type: 'delta', ...delta })));
    } else {
      ({ text, reasoning, usage, timing } = await callOpenRouter(cfg, request.messages, request.maxReplyTokens,
        `${request.speaker.name} @ ${place.name}`));
    }
    return { entries: await turnEntriesFrom(w, text, reasoning, request, usage, timing, place, charactersById, cfg.suggestedActionsMode, backgroundIds) };
  } catch (err) {
    return { error: err.message };
  }
}

// Records a completed round into each present character's memory, tagged
// with the in-world time and linked to the chat entries that formed it (so
// later edits/deletes/regens can rebuild exactly these memories).
function recordRound(w, { placeId, presentIds, turnEntries, userLabel, activePersonaId, time }) {
  const relevant = turnEntries.filter((e) => e.type === 'system' || e.type === 'user' || e.type === 'char' || e.type === 'narrator');
  const turnText = relevant.map((e) => formatLogEntry(e, userLabel)).join('\n');
  if (!turnText.trim()) return;
  recordTurn({
    db: w.db,
    embedFn: embed,
    characterIds: presentIds,
    personaId: activePersonaId || null,
    text: turnText,
    placeId,
    entryIds: relevant.map((e) => e.id).filter(Boolean),
    day: time?.day ?? null,
    timeOfDay: time?.timeOfDay ?? null,
  }).catch((err) => logger.error('memory', `round recording failed: ${err.message}`));
}

// Attempts one narrator turn — ambient world-voice, never streamed (it's
// short and supplementary, not worth the SSE plumbing). Always best-effort:
// a missing key, a failed request, or the model choosing NARRATOR_SILENCE
// all just mean "no narration this round" (null) rather than an error, so
// callers never let a narrator hiccup block or fail an otherwise-fine round.
async function attemptNarratorTurn({ w, cfg, place, presentIds, backgroundIds, charactersById, log, callContext = null }) {
  if (!cfg.apiKey) return null;
  try {
    const { personas, activePersonaId } = loadPersonas(w);
    const activePersona = personas.find((p) => p.id === activePersonaId) || null;
    const userLabel = activePersona ? activePersona.name : 'Visitor';
    const world = loadWorld(w);

    const backgroundChars = backgroundIds
      .map((cid) => charactersById[cid])
      .filter(Boolean)
      .map((c) => ({ name: c.name, snippet: characterSnippet(c) }));

    const messages = buildNarratorMessages({
      place: {
        name: place.name, area: place.area, desc: place.desc, type: place.type,
        ownerName: place.ownerId && charactersById[place.ownerId] ? charactersById[place.ownerId].name : null,
        weather: place.area ? loadWeather(w)[place.area]?.condition || null : null,
      },
      worldSetting: world.setting,
      time: world.time,
      backgroundChars,
      transcript: buildHistoryTranscript(log, { userLabel, tokenBudget: 1200 }),
      callContext,
    });

    const { text } = await callOpenRouter(cfg, messages, 150, `Narrator @ ${place.name}`);
    if (isNarratorSilent(text)) return null;
    return { type: 'narrator', text: text.trim() };
  } catch (err) {
    logger.warn('chat', `narrator turn failed, skipping: ${err.message}`);
    return null;
  }
}

// Nobody's present at all: tries a narrator line describing the empty
// scene before falling back to the flat echo note. No characters means
// nothing to record into memory either way.
async function narrateEmptyPlaceOrEcho({ w, placeId, place }) {
  const cfg = loadConfig();
  let note = null;
  if (cfg.narratorEnabled !== false) {
    const log = loadChatLog(w.chatDir, placeId);
    if (shouldNarrate({ placeType: place.type, presentCount: 0, backgroundCount: 0, log })) {
      note = await attemptNarratorTurn({ w, cfg, place, presentIds: [], backgroundIds: [], charactersById: {}, log });
    }
  }
  if (!note) note = { type: 'system', text: 'Your words echo. No one is here to answer.' };
  appendChatEntries(w.chatDir, placeId, [note]);
}

// Present characters can all be inactive at once (everyone's in the room
// but nobody's an active participant right now) — no turns get generated,
// but the room still "hears" what was said. Tries a narrator line first
// (describing the scene/background cast is exactly this situation's use
// case); falls back to a flat note if the narrator is off, unavailable, or
// has nothing to add. Either way the round is recorded into every present
// character's memory, same as a normal round would, minus any replies.
async function recordSilentRound({ w, placeId, place, presentIds, charactersById, turnEntries }) {
  const cfg = loadConfig();
  let note = null;
  if (cfg.narratorEnabled !== false) {
    const log = loadChatLog(w.chatDir, placeId);
    if (shouldNarrate({ placeType: place.type, presentCount: presentIds.length, backgroundCount: presentIds.length, log })) {
      note = await attemptNarratorTurn({ w, cfg, place, presentIds, backgroundIds: presentIds, charactersById, log });
    }
  }
  if (!note) note = { type: 'system', text: 'No one reacts.' };

  appendChatEntries(w.chatDir, placeId, [note]);
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  recordRound(w, {
    placeId, presentIds,
    turnEntries: [...turnEntries, note],
    userLabel: activePersona ? activePersona.name : 'Visitor',
    activePersonaId,
    time: loadWorld(w).time,
  });
}

// A full reaction round: every reacting character takes their own turn, in
// order, each seeing the previous speakers' turns from this round (the log
// is re-read per turn). Afterward the whole round (trigger entries +
// everyone's turns) is recorded once into each present character's memory.
// `onEvent`, when provided, streams progress (speaker/delta/turn events)
// — the SSE path of /say. Returns { error } from the first failed turn;
// earlier turns stay persisted.
async function runReactionRound({ w, placeId, place, reactIds, presentIds, charactersById, turnEntriesSoFar, onEvent = null }) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { error: 'No API key configured. Add one in Settings.' };
  }

  const roundEntries = [];
  let error = null;
  let userLabel = 'Visitor';
  let activePersonaId = null;
  let time = null;
  const backgroundIds = presentIds.filter((id) => !reactIds.includes(id));

  for (const speakerId of reactIds) {
    const log = loadChatLog(w.chatDir, placeId);
    const request = await buildTurnRequest({ w, place, speakerId, presentIds, charactersById, log });
    userLabel = request.userLabel;
    activePersonaId = request.activePersonaId;
    time = request.time;

    if (onEvent) onEvent({ type: 'speaker', charId: speakerId, name: request.speaker.name });

    let text, reasoning, usage, timing;
    try {
      if (onEvent && cfg.streaming) {
        ({ text, reasoning, usage, timing } = await streamOpenRouter(cfg, request.messages, request.maxReplyTokens,
          `${request.speaker.name} @ ${place.name}`, (delta) => onEvent({ type: 'delta', ...delta })));
      } else {
        ({ text, reasoning, usage, timing } = await callOpenRouter(cfg, request.messages, request.maxReplyTokens,
          `${request.speaker.name} @ ${place.name}`));
      }
    } catch (err) {
      error = err.message;
      break;
    }

    const entries = await turnEntriesFrom(w, text, reasoning, request, usage, timing, place, charactersById, cfg.suggestedActionsMode, backgroundIds);
    appendChatEntries(w.chatDir, placeId, entries);
    roundEntries.push(...entries);
    if (onEvent) onEvent({ type: 'turn', entries });
  }

  // Ambient narrator addendum, after the active cast has spoken — describes
  // whoever's present but not part of the conversation, or (throttled)
  // adds scene texture even when everyone present is active. Skipped
  // entirely if a character turn already failed above: don't compound a
  // generation problem with another likely-to-fail call.
  if (!error && cfg.narratorEnabled !== false) {
    const log = loadChatLog(w.chatDir, placeId);
    if (shouldNarrate({ placeType: place.type, presentCount: presentIds.length, backgroundCount: backgroundIds.length, log })) {
      const narration = await attemptNarratorTurn({ w, cfg, place, presentIds, backgroundIds, charactersById, log });
      if (narration) {
        appendChatEntries(w.chatDir, placeId, [narration]);
        roundEntries.push(narration);
        if (onEvent) onEvent({ type: 'turn', entries: [narration] });
      }
    }
  }

  if (roundEntries.length) {
    recordRound(w, {
      placeId, presentIds,
      turnEntries: [...turnEntriesSoFar, ...roundEntries],
      userLabel, activePersonaId, time,
    });
  }

  return error ? { error } : {};
}

app.get('/api/places/:placeId/chat', (req, res) => {
  const w = req.world;
  const { placeId } = req.params;
  if (!loadPlaces(w).some((p) => p.id === placeId)) return res.status(404).json({ error: 'Place not found.' });
  res.json({ log: loadChatLog(w.chatDir, placeId), activeCall: publicActiveCall(loadCalls(w)[placeId]) });
});

// Entering a place: on the first-ever arrival (empty log), persists the
// arrival marker and scripted greetings. Revisits append NOTHING — a
// misclicked room shouldn't pollute the history. Instead the response
// carries returnMarkerPending; the client passes announceArrival on its
// next /say and the "You return to X." marker is inserted just before the
// user's line, only once they actually engage. Arrivals never generate.
app.post('/api/places/:placeId/enter', (req, res) => {
  const w = req.world;
  const { placeId } = req.params;
  const place = loadPlaces(w).find((p) => p.id === placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const charIds = presentCharIds(w, placeId, charactersById);

  const existingLog = loadChatLog(w.chatDir, placeId);
  const first = existingLog.length === 0;

  if (!first) {
    return res.json({ log: existingLog, returnMarkerPending: true, activeCall: publicActiveCall(loadCalls(w)[placeId]) });
  }

  const turnEntries = [{ type: 'system', text: `You arrive at ${place.name}.` }];

  const world = loadWorld(w);
  const greetedIds = new Set();
  charIds.forEach((cid) => {
    const placement = world.placements[cid];
    const idx = placement ? placement.greetingIndex : null;
    const greetings = charactersById[cid].greetings || [];
    if (idx !== null && idx !== undefined && greetings[idx] !== undefined) {
      turnEntries.push({ type: 'char', charId: cid, name: charactersById[cid].name, text: greetings[idx] });
      greetedIds.add(cid);
    }
  });

  appendChatEntries(w.chatDir, placeId, turnEntries);
  logger.info('chat', `first arrival at ${place.name} (${greetedIds.size} greeting${greetedIds.size === 1 ? '' : 's'})`);

  if (greetedIds.size) {
    // Scripted greetings are still this turn's memory for those characters.
    const { personas, activePersonaId } = loadPersonas(w);
    const activePersona = personas.find((p) => p.id === activePersonaId) || null;
    const userLabel = activePersona ? activePersona.name : 'Visitor';
    recordTurn({
      db: w.db,
      embedFn: embed,
      characterIds: [...greetedIds],
      personaId: activePersonaId || null,
      text: turnEntries.map((e) => formatLogEntry(e, userLabel)).join('\n'),
      placeId,
      entryIds: turnEntries.map((e) => e.id).filter(Boolean),
      day: world.time.day,
      timeOfDay: world.time.timeOfDay,
    }).catch((err) => logger.error('memory', `greeting recording failed: ${err.message}`));
  }

  res.json({ log: loadChatLog(w.chatDir, placeId), returnMarkerPending: false, activeCall: null });
});

// Saying something: appends the user's line (preceded by the deferred
// "You return to X." marker when announceArrival is set), then generates
// the present characters' response — as SSE when streaming is enabled in
// Settings, as one JSON response otherwise. The user's line persists even
// when generation fails.
app.post('/api/places/:placeId/say', async (req, res) => {
  const w = req.world;
  const { placeId } = req.params;
  const { text, announceArrival } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  const place = loadPlaces(w).find((p) => p.id === placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  if (loadCalls(w)[placeId]) return res.status(409).json({ error: 'A call is in progress here — hang up first.' });

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const charIds = presentCharIds(w, placeId, charactersById);
  const activeIds = activeCharIds(w, placeId, charactersById);

  const turnEntries = [];
  if (announceArrival && loadChatLog(w.chatDir, placeId).length > 0) {
    turnEntries.push({ type: 'system', text: `You return to ${place.name}.` });
  }
  turnEntries.push({ type: 'user', text: text.trim() });
  appendChatEntries(w.chatDir, placeId, turnEntries);
  logger.info('chat', `say @ ${place.name}: ${charIds.length} character(s) present, ${activeIds.length} active`);

  if (!charIds.length) {
    await narrateEmptyPlaceOrEcho({ w, placeId, place });
    return res.json({ log: loadChatLog(w.chatDir, placeId) });
  }

  if (!activeIds.length) {
    await recordSilentRound({ w, placeId, place, presentIds: charIds, charactersById, turnEntries });
    return res.json({ log: loadChatLog(w.chatDir, placeId) });
  }

  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    // SSE: speaker/delta/turn events per character, then a final done event
    // with the authoritative log (and the error, if a turn failed midway).
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.chatDir, placeId) });

    const result = await runReactionRound({
      w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById,
      turnEntriesSoFar: turnEntries, onEvent: send,
    });
    send({ type: 'done', log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runReactionRound({
    w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById, turnEntriesSoFar: turnEntries,
  });
  res.json({ log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error } : {}) });
});

// Re-runs generation for the trailing user message when nobody replied —
// either every reply under it was deleted, or the endpoint errored before
// producing anything. Unlike /say, no new user entry is appended; the
// existing dangling one is the trigger. 400s if the last user message
// already has at least one character reply after it (that's what /say or
// per-message regenerate are for) or if there's no user message at all yet.
app.post('/api/places/:placeId/retry', async (req, res) => {
  const w = req.world;
  const { placeId } = req.params;
  const place = loadPlaces(w).find((p) => p.id === placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  if (loadCalls(w)[placeId]) return res.status(409).json({ error: 'A call is in progress here — hang up first.' });

  const log = loadChatLog(w.chatDir, placeId);
  let lastUserIdx = -1;
  for (let i = log.length - 1; i >= 0; i--) { if (log[i].type === 'user') { lastUserIdx = i; break; } }
  if (lastUserIdx === -1) {
    return res.status(400).json({ error: 'Nothing to retry — say something first.' });
  }
  if (log.slice(lastUserIdx + 1).some((e) => e.type === 'char')) {
    return res.status(400).json({ error: 'The last message already has a reply.' });
  }

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const charIds = presentCharIds(w, placeId, charactersById);
  const activeIds = activeCharIds(w, placeId, charactersById);
  logger.info('chat', `retry @ ${place.name}: ${charIds.length} character(s) present, ${activeIds.length} active`);

  // Retry reuses this same trigger message across attempts rather than
  // deleting it — if an earlier attempt's replies were all deleted, that
  // round's memory rows are still linked to this message with no reply
  // left in them. Clear those out before recording the fresh round, or
  // every retry leaves one more stale "just the user's words" row behind.
  const userEntryId = log[lastUserIdx].id;
  if (userEntryId) {
    pruneReplylessMemories(w.db, findMemoriesWitnessing(w.db, userEntryId), log);
  }

  if (!charIds.length) {
    await narrateEmptyPlaceOrEcho({ w, placeId, place });
    return res.json({ log: loadChatLog(w.chatDir, placeId) });
  }

  const turnEntriesSoFar = [log[lastUserIdx]];

  if (!activeIds.length) {
    await recordSilentRound({ w, placeId, place, presentIds: charIds, charactersById, turnEntries: turnEntriesSoFar });
    return res.json({ log: loadChatLog(w.chatDir, placeId) });
  }

  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log });

    const result = await runReactionRound({
      w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById, turnEntriesSoFar, onEvent: send,
    });
    send({ type: 'done', log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error } : {}) });
    return res.end();
  }

  const result = await runReactionRound({
    w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById, turnEntriesSoFar,
  });
  res.json({ log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error } : {}) });
});

// Regenerates one generated message in place: rebuilds the speaking
// character's turn from everything before that entry, and splices the
// result in where the old entry was (later entries are preserved). Every
// memory that witnessed the original message is rebuilt around the new
// text — for all present characters, not just the speaker.
app.post('/api/places/:placeId/regenerate', async (req, res) => {
  const w = req.world;
  const { placeId } = req.params;
  const { entryId } = req.body || {};
  if (typeof entryId !== 'string' || !entryId) {
    return res.status(400).json({ error: 'entryId is required.' });
  }

  const place = loadPlaces(w).find((p) => p.id === placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const log = loadChatLog(w.chatDir, placeId);
  const idx = log.findIndex((e) => e.id === entryId);
  if (idx === -1) return res.status(404).json({ error: 'Message not found.' });
  const target = log[idx];
  if (target.type !== 'char' || !target.charId) {
    return res.status(400).json({ error: 'Only generated character messages can be regenerated.' });
  }

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  if (!charactersById[target.charId]) {
    return res.status(400).json({ error: 'This character no longer exists.' });
  }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return res.status(400).json({ error: 'No API key configured. Add one in Settings.' });
  }

  // Whoever's present *now* frames the regeneration; the speaker is always
  // included even if they've since been moved elsewhere.
  const presentIds = presentCharIds(w, placeId, charactersById);
  if (!presentIds.includes(target.charId)) presentIds.push(target.charId);
  // Background cast for promote-suggestion detection — the character being
  // regenerated is always the speaker here regardless of their stored
  // active flag (a background character's old message can still be
  // regenerated), so they're never counted as background themselves.
  const activeIds = activeCharIds(w, placeId, charactersById);
  const backgroundIds = presentIds.filter((id) => id !== target.charId && !activeIds.includes(id));

  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const userLabel = activePersona ? activePersona.name : 'Visitor';

  // The reply being replaced may share a round-memory row with the user's
  // message that prompted it (and with other characters' turns from the
  // same round) — strip its contribution from those rows *before*
  // generating the replacement, otherwise this very generation's memory
  // retrieval would surface a "memory" quoting the exact reply about to be
  // discarded.
  const memoryIds = findMemoriesWitnessing(w.db, entryId);
  await detachEntryFromMemories({
    db: w.db, embedFn: embed, memoryIds, entryId,
    log: log.slice(0, idx).concat(log.slice(idx + 1)),
    userLabel, formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `regen pre-detach failed: ${err.message}`));

  // SSE mirrors /say's streaming branch: speaker/delta as the reply comes
  // in, then a final turn/done pair once the log is spliced and memories
  // are reattached.
  const send = cfg.streaming
    ? (() => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    })()
    : null;

  const result = await generateCharacterTurn({
    w, cfg, place, speakerId: target.charId, presentIds, charactersById,
    log: log.slice(0, idx), onEvent: send, backgroundIds,
  });
  if (result.error) {
    if (send) { send({ type: 'done', log, error: result.error }); return res.end(); }
    return res.status(502).json({ error: result.error });
  }

  result.entries.forEach((e) => { if (!e.id) e.id = crypto.randomUUID(); });
  log.splice(idx, 1, ...result.entries);
  saveChatLog(w.chatDir, placeId, log);
  logger.info('chat', `regenerated message ${entryId} @ ${place.name}`);

  await attachEntriesToMemories({
    db: w.db, embedFn: embed, memoryIds,
    newEntryIds: result.entries.map((e) => e.id),
    log, userLabel, formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `regen memory sync failed: ${err.message}`));

  if (send) {
    send({ type: 'turn', entries: result.entries });
    send({ type: 'done', log });
    return res.end();
  }
  res.json({ log });
});

// --- Message edit / delete ---------------------------------------------------
// Both rewrite the persisted log AND rebuild every memory (for every
// character) that witnessed the affected entry, so the characters'
// recollection matches what the history now says.

app.put('/api/places/:placeId/messages/:entryId', async (req, res) => {
  const w = req.world;
  const { placeId, entryId } = req.params;
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  if (!loadPlaces(w).some((p) => p.id === placeId)) return res.status(404).json({ error: 'Place not found.' });

  const log = loadChatLog(w.chatDir, placeId);
  const entry = log.find((e) => e.id === entryId);
  if (!entry) return res.status(404).json({ error: 'Message not found.' });
  if (entry.type !== 'char' && entry.type !== 'user' && entry.type !== 'narrator') {
    return res.status(400).json({ error: 'Only character, user, and narrator messages can be edited.' });
  }

  entry.text = text.trim();
  saveChatLog(w.chatDir, placeId, log);
  logger.info('chat', `edited message ${entryId} @ ${placeId}`);

  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  await syncMemoriesForEntry({
    db: w.db, embedFn: embed, entryId, newEntryIds: null,
    log, userLabel: activePersona ? activePersona.name : 'Visitor',
    formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `edit memory sync failed: ${err.message}`));

  res.json({ log });
});

app.delete('/api/places/:placeId/messages/:entryId', async (req, res) => {
  const w = req.world;
  const { placeId, entryId } = req.params;
  if (!loadPlaces(w).some((p) => p.id === placeId)) return res.status(404).json({ error: 'Place not found.' });

  const log = loadChatLog(w.chatDir, placeId);
  const idx = log.findIndex((e) => e.id === entryId);
  if (idx === -1) return res.status(404).json({ error: 'Message not found.' });

  log.splice(idx, 1);
  saveChatLog(w.chatDir, placeId, log);
  logger.info('chat', `deleted message ${entryId} @ ${placeId}`);

  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  await syncMemoriesForEntry({
    db: w.db, embedFn: embed, entryId, newEntryIds: [],
    log, userLabel: activePersona ? activePersona.name : 'Visitor',
    formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `delete memory sync failed: ${err.message}`));

  res.json({ log });
});

// Multer errors (bad file type, too large) land here instead of crashing.
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

// Only bind a real port when run directly (`node server.js` / `npm start`),
// not when imported by the test suite as `{ app }`.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Freeroam backend running at http://localhost:${PORT}`);
  });
}

export { app, registry };
