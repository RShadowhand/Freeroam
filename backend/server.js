import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractCharacterCard, extractPersonaCard, extractPlaceCard } from './lib/tavernCard.js';
import { buildCharacterCardPng, buildPersonaCardPng, buildPlaceCardPng } from './lib/pngCard.js';
import { importCardFromUrl } from './lib/cardImport.js';
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
import { buildWorldExportBundle, importWorldBundle, peekManifest } from './lib/worldExport.js';
import { CONDITIONS as WEATHER_CONDITIONS, loadWeather, saveWeather, rollAutoWeather, setManualWeather, setAutoWeather } from './lib/weather.js';
import { buildTextingMessages, historyFromLog, groupHistoryFromLog } from './lib/texting.js';
import { colorForId } from './lib/textUtils.js';
import { loadCalls, saveCalls } from './lib/calls.js';
import { loadGroups, saveGroups, createGroup } from './lib/groups.js';
import {
  DEFAULT_CASCADE_BASE_CHANCE, DEFAULT_CASCADE_DECAY_RATE, DEFAULT_CASCADE_PER_CHARACTER_CAP, nextCascadeStep,
} from './lib/textCascade.js';
import { rollsProactiveText } from './lib/proactiveTexts.js';
import { logger } from './lib/log.js';
import { writeJsonAtomic, warnIfCorrupt } from './lib/jsonStore.js';
import { relocateDataRoot, consolidatePerWorldExtras } from './lib/externalDataRoot.js';
logger.setLevel("debug")

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Overridable so the test suite can point a real (but disposable) Express
// app at a temp directory instead of this project's actual data/config —
// tests must never read the real OpenRouter key or write into real data.
// Lives outside backend/ (a repo-root data/ folder) so the backend source
// tree stays free of runtime state — see lib/externalDataRoot.js for the
// one-time automatic migration off the old backend-local layout.
const DATA_ROOT = process.env.FREEROAM_TEST_ROOT || path.join(__dirname, '..', 'data');

const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const PRESETS_PATH = path.join(DATA_ROOT, 'presets.json'); // global — see loadPresets/savePresets below

// The migration is a no-op once already applied (each step checks whether
// its source still exists), and is skipped entirely under
// FREEROAM_TEST_ROOT — its source paths are hardcoded relative to this
// real backend directory and must never touch a test's scratch root.
if (!process.env.FREEROAM_TEST_ROOT) {
  relocateDataRoot({ backendDir: __dirname, dataRoot: DATA_ROOT });
}

// Every world (save slot) gets its own characters/places/world-state/
// personas/avatars, its own chat logs, and its own SQLite db — resolved
// per-request from the X-World-Id header (see the middleware below), never
// from a server-side "current world" pointer, so different browsers/users
// can be in different worlds on the same running instance at once.
// config.json/presets.json (API key/model/narrator/memory settings, prompt
// presets) stay global, shared across every world.
const registry = createWorldRegistry({ dataRoot: DATA_ROOT });
await registry.init();

if (!process.env.FREEROAM_TEST_ROOT) {
  consolidatePerWorldExtras({ registry, dataRoot: DATA_ROOT });
}

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
  groupCascadeManualApproval: false,    // opt-in — pause before every cascade reply for "X wants to respond, allow?"
  textingChancePerChar: 0.002,           // Phase 5 — per-character odds of a spontaneous text on each user input
  onboarded: false,                     // whether the first-run tour has been seen/skipped — global, not per-browser
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
  } catch (err) {
    warnIfCorrupt(CONFIG_PATH, err);
    cfg = { ...DEFAULT_CONFIG };
  }
  // Migrate the old single `provider` string (pre-multi-provider) into the
  // new `providers` array the first time an old config.json is read.
  if (!cfg.providers?.length && cfg.provider) cfg.providers = [cfg.provider];
  return cfg;
}
function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_PATH, cfg);
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
  { id: 'town-square', name: 'Town Square', type: 'communal', ownerIds: [], area: 'Downtown',
    desc: 'The open square where every path in the neighborhood eventually crosses.' },
  { id: 'archive-house', name: 'The Archive House', type: 'communal', ownerIds: [], area: 'Downtown',
    desc: 'A public reading room, shelves stacked floor to ceiling with old records.' },
  { id: 'ezras-apartment', name: "Ezra's Apartment", type: 'private', ownerIds: ['ezra'], area: 'Downtown',
    desc: 'A cramped, meticulously organized apartment above the Archive House.' },

  { id: 'greenhouse-park', name: 'The Greenhouse', type: 'communal', ownerIds: [], area: 'Garden District',
    desc: 'A public greenhouse gone half-wild, permanently smelling of autumn leaves.' },
  { id: 'mireilles-cottage', name: "Mireille's Cottage", type: 'private', ownerIds: ['mireille'], area: 'Garden District',
    desc: 'A small cottage tucked just behind the greenhouse ferns.' },
  { id: 'soots-alley', name: "Soot's Alley", type: 'private', ownerIds: ['soot'], area: 'Garden District',
    desc: 'A narrow alley that one particular cat has claimed as entirely his own.' },

  { id: 'old-ballroom', name: 'The Old Ballroom', type: 'communal', ownerIds: [], area: 'Uptown',
    desc: 'A dusty, disused hall that still hosts the occasional gathering.' },
  { id: 'clocktower-roof', name: 'The Clocktower Roof', type: 'communal', ownerIds: [], area: 'Uptown',
    desc: 'A rooftop lookout beside the neighborhood\'s old, stopped clocktower.' },
  { id: 'custodians-workshop', name: "The Custodian's Workshop", type: 'private', ownerIds: ['custodian'], area: 'Uptown',
    desc: "A locked workshop where the neighborhood's clockwork gets quietly repaired." },
];

// Older places.json files predate multi-owner support and store a single
// `ownerId: string|null` — folded into `ownerIds: string[]` on read, same
// lazy-migration approach normalizeCharacter uses for the persona->description
// rename above. No rewrite happens until the next save.
function normalizePlace(p) {
  if (Array.isArray(p.ownerIds)) return p;
  const { ownerId, ...rest } = p;
  return { ...rest, ownerIds: ownerId ? [ownerId] : [] };
}

function loadPlaces(w) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(w.paths.places, 'utf-8'));
  } catch (err) {
    warnIfCorrupt(w.paths.places, err);
    raw = SEED_PLACES;
    savePlaces(w, raw);
  }
  return raw.map(normalizePlace);
}
function savePlaces(w, list) {
  writeJsonAtomic(w.paths.places, list);
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
  } catch (err) {
    warnIfCorrupt(w.paths.characters, err);
    raw = BUILTIN_CHARACTERS;
    saveCharacters(w, raw);
  }
  return raw.map(normalizeCharacter);
}
function saveCharacters(w, list) {
  writeJsonAtomic(w.paths.characters, list);
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
  } catch (err) {
    warnIfCorrupt(w.paths.world, err);
    const world = normalizeWorld({ placements: DEFAULT_PLACEMENTS });
    saveWorld(w, world);
    return world;
  }
}
function saveWorld(w, world) {
  writeJsonAtomic(w.paths.world, world);
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
  } catch (err) {
    warnIfCorrupt(w.paths.personas, err);
    savePersonas(w, DEFAULT_PERSONAS);
    return { ...DEFAULT_PERSONAS };
  }
}
function savePersonas(w, data) {
  writeJsonAtomic(w.paths.personas, data);
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

// Global, not per-world (mirrors config.json) — shared across every save
// slot, so a world duplicate/export no longer carries its own presets.
function loadPresets() {
  try {
    return { ...DEFAULT_PRESETS, ...JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf-8')) };
  } catch (err) {
    warnIfCorrupt(PRESETS_PATH, err);
    savePresets(DEFAULT_PRESETS);
    return { ...DEFAULT_PRESETS };
  }
}
function savePresets(data) {
  writeJsonAtomic(PRESETS_PATH, data);
}

// --- App ----------------------------------------------------------------

const app = express();
app.use(cors());
// Default 100kb is too small for a bulk export/import payload (e.g. every
// character or place in a world at once) — this is a local single-user app,
// not a hardened public API, so a blanket bump is simpler than per-route limits.
app.use(express.json({ limit: '5mb' }));
// The frontend is now a Vue/Vite project (frontend/src) — this serves its
// production build (frontend/dist, built via `npm run build` in frontend/),
// not the source. For local development with hot-reload, run Vite's own
// dev server (`npm run dev` in frontend/) instead, which proxies /api and
// /avatars requests through to this server (see frontend/vite.config.js).
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));
// Avatars now live nested inside each world's own folder rather than one
// shared tree, so a single express.static(fixed root) mount no longer
// covers every world — dispatch to a lazily-built, per-world static
// handler instead, keyed off the :worldId path segment. World isolation
// for avatars is path-encoded rather than header-based because an <img
// src> can't send a custom header; the public URL shape (/avatars/<id>/…,
// /avatars/<id>/personas/…) is unchanged from before.
const avatarStatics = new Map(); // worldId -> express.static handler
app.use('/avatars/:worldId', (req, res, next) => {
  const world = registry.get(req.params.worldId);
  if (!world) return next();
  let handler = avatarStatics.get(world.id);
  if (!handler) {
    handler = express.static(world.avatarDir);
    avatarStatics.set(world.id, handler);
  }
  handler(req, res, next);
});

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

// Distinct from `upload` (PNG-only, expects a full TavernCard) — this is
// for attaching/replacing a plain picture on a character that already
// exists, same rules as uploadPersonaAvatar above.
const uploadCharacterAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXT_FOR_MIME[file.mimetype]) return cb(new Error('Avatar must be a PNG, JPEG, or WebP image.'));
    cb(null, true);
  },
});

const ZIP_MIMETYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const uploadWorldBundle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // chat history + avatars across a whole world can add up
  fileFilter: (req, file, cb) => {
    // Zip MIME-type reporting is inconsistent across browsers/OSes (some
    // report application/octet-stream for any unrecognized-by-sniffing
    // file) — fall back to the filename extension rather than mimetype
    // alone, or a legitimate .zip upload can get rejected on some clients.
    if (!ZIP_MIMETYPES.includes(file.mimetype) && !/\.zip$/i.test(file.originalname || '')) {
      return cb(new Error('A world bundle must be a .zip file.'));
    }
    cb(null, true);
  },
});

// PNG-only, same fileFilter shape as `upload` (character cards) above —
// personas and places each get their own new PNG card spec (see pngCard.js/
// tavernCard.js), imported via these two rather than reusing `upload`
// itself, so a wrong-resource upload 400s with a specific message.
const uploadPersonaCard = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/png') return cb(new Error('A persona card must be a PNG file.'));
    cb(null, true);
  },
});
const uploadPlaceCard = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/png') return cb(new Error('A place card must be a PNG file.'));
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
    groupCascadeManualApproval: !!cfg.groupCascadeManualApproval,
    textingChancePerChar: Number.isFinite(cfg.textingChancePerChar) ? cfg.textingChancePerChar : DEFAULT_CONFIG.textingChancePerChar,
    onboarded: !!cfg.onboarded,
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
    cascadeBaseChance, cascadeDecayRate, cascadePerCharacterCap, groupCascadeManualApproval, textingChancePerChar, onboarded,
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
  if (typeof groupCascadeManualApproval === 'boolean') cfg.groupCascadeManualApproval = groupCascadeManualApproval;
  if (typeof textingChancePerChar === 'number' && Number.isFinite(textingChancePerChar)) {
    cfg.textingChancePerChar = Math.max(0, Math.min(1, textingChancePerChar));
  }
  if (typeof onboarded === 'boolean') cfg.onboarded = onboarded;
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
    // Drop the cached avatar static handler and the two per-world caches
    // above too — otherwise all three grow by one entry per world ever
    // created-then-deleted, for the life of the process.
    avatarStatics.delete(req.params.id);
    metCharacterIdsCache.delete(req.params.id);
    unreadProactiveCountCache.delete(req.params.id);
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

// POST (not GET) so it can take { includeHistory } in the body, symmetric
// with /duplicate above — a full-fidelity backup/restore zip, distinct from
// /duplicate's in-app "branch a variant" (see worldExport.js).
app.post('/api/worlds/:id/export', async (req, res) => {
  const w = registry.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Unknown world id.' });
  const { includeHistory = true } = req.body || {};
  const entry = registry.list().worlds.find((e) => e.id === w.id);
  const cfg = loadConfig();
  try {
    const buffer = await buildWorldExportBundle(w, {
      includeHistory,
      worldName: entry?.name || '',
      embeddingModel: cfg.embeddingModelVersion || EMBEDDING_MODEL_ID,
    });
    const filename = `${(entry?.name || 'world').replace(/[^a-z0-9-_ ]/gi, '_')}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Creates a brand-new world from an uploaded bundle. relationships/
// character_embeddings are re-embedded from their (always-included) text
// rather than exported/imported as blobs — cheap to recompute, and avoids
// ever needing the embedding model during the zip-extraction step itself.
app.post('/api/worlds/import', uploadWorldBundle.single('bundle'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A world bundle (.zip) file is required.' });
  // Tracks the just-created empty world so a failure partway through (a
  // corrupt zip, an embedding rebuild error) can clean it up in the catch
  // below, rather than leaving an orphaned empty "Imported World" save slot
  // with no indication the import actually failed.
  let entry = null;
  try {
    const manifest = await peekManifest(req.file.buffer);
    const name = (req.body?.name || '').trim() || manifest.worldName || 'Imported World';
    entry = await registry.create({ name, mode: 'empty' });
    const dest = registry.get(entry.id);

    const { warnings } = await importWorldBundle(req.file.buffer, dest);
    if (manifest.embeddingModel && manifest.embeddingModel !== EMBEDDING_MODEL_ID) {
      warnings.push(
        `This world was exported using a different embedding model (${manifest.embeddingModel}) than this install `
        + `is currently using (${EMBEDDING_MODEL_ID}) — memory/relationship retrieval may be degraded until you `
        + 'rebuild embeddings in Settings.',
      );
    }

    await rebuildAllRelationshipEmbeddings({ db: dest.db, embedFn: embed });
    await rebuildAllCharacterEmbeddings({ db: dest.db, embedFn: embed, characters: loadCharacters(dest) });

    res.status(201).json({ world: entry, warnings });
  } catch (err) {
    if (entry) {
      await registry.remove(entry.id).catch((removeErr) => {
        logger.error('world', `failed to clean up orphaned world ${entry.id} after a failed import: ${removeErr.message}`);
      });
    }
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

// Same character shape the multipart TavernCard upload above produces —
// see importCardFromUrl in lib/cardImport.js for how the URL gets resolved
// down to actual card bytes (a chub.ai character page resolves to its
// underlying CDN PNG directly; other sites via the page's own og:image tag
// or a linked .png, since this app has no way to execute a source site's
// own client-side JS to reach any private API it might have).
app.post('/api/characters/import-url', async (req, res) => {
  const w = req.world;
  const { url } = req.body || {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'A URL is required.' });
  }

  let card, avatarBuffer;
  try {
    ({ card, avatarBuffer } = await importCardFromUrl(url.trim()));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(w.avatarDir, `${id}.png`), avatarBuffer);

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
  res.status(201).json({ character });
});

// Export/import always use the plural wire shape ({ characters: [...] }),
// even for a single character — one shape for import to handle, not two.
app.get('/api/characters/:id/export', (req, res) => {
  const character = loadCharacters(req.world).find((c) => c.id === req.params.id);
  if (!character) return res.status(404).json({ error: 'Character not found.' });
  res.json({ characters: [character] });
});

app.get('/api/characters/export', (req, res) => {
  res.json({ characters: loadCharacters(req.world) });
});

// TavernCard-style PNG export — embeds the same JSON shape /export produces
// into a chunk on the character's own avatar (always literally <id>.png,
// the only upload path that ever sets avatarUrl), or a generated
// placeholder tinted with their color if they have none.
app.get('/api/characters/:id/card.png', (req, res) => {
  const w = req.world;
  const character = loadCharacters(w).find((c) => c.id === req.params.id);
  if (!character) return res.status(404).json({ error: 'Character not found.' });
  const avatarPath = path.join(w.avatarDir, `${character.id}.png`);
  const baseImageBuffer = character.avatarUrl && fs.existsSync(avatarPath) ? fs.readFileSync(avatarPath) : null;
  const png = buildCharacterCardPng({ character, baseImageBuffer });
  res.set('Content-Type', 'image/png');
  res.set('Content-Disposition', `attachment; filename="${character.name.replace(/[^a-z0-9-_ ]/gi, '_')}.png"`);
  res.send(png);
});

// Imported rows always get a fresh id and no avatar (plain JSON carries no
// image bytes) — same normalization loadCharacters applies to every row, so
// an imported character round-trips through the same defaults as a native one.
app.post('/api/characters/import', (req, res) => {
  const w = req.world;
  const { characters: incoming } = req.body || {};
  if (!Array.isArray(incoming) || !incoming.length) {
    return res.status(400).json({ error: 'A characters array is required.' });
  }
  const characters = loadCharacters(w);
  const imported = incoming.map((c) => {
    const id = crypto.randomUUID();
    return normalizeCharacter({ ...c, id, avatarUrl: null, color: colorForId(id), source: c.source || 'upload' });
  });
  characters.push(...imported);
  saveCharacters(w, characters);
  res.status(201).json({ characters: imported });
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
    const idx = p.ownerIds.indexOf(id);
    if (idx !== -1) { p.ownerIds.splice(idx, 1); placesChanged = true; }
  });
  if (placesChanged) savePlaces(w, places);

  // Drop this character from every group's roster too — same 2-participant
  // minimum enforced at group creation/editing means a group left below
  // that floor no longer makes sense, so it's removed entirely (message log
  // included) rather than left in a state POST/PUT /api/groups would reject.
  const groups = loadGroups(w);
  const remainingGroups = [];
  let groupsChanged = false;
  groups.forEach((g) => {
    if (!g.participantIds.includes(id)) { remainingGroups.push(g); return; }
    groupsChanged = true;
    const trimmedParticipantIds = g.participantIds.filter((pid) => pid !== id);
    if (trimmedParticipantIds.length < 2) {
      deleteTextsLog(w, g.id);
      logger.info('chat', `deleted group "${g.name}" — dropped below 2 participants after removing ${target.name}`);
    } else {
      remainingGroups.push({ ...g, participantIds: trimmedParticipantIds });
    }
  });
  if (groupsChanged) saveGroups(w, remainingGroups);

  // Clean up the character's memories, relationships either way, and
  // identity embedding.
  deleteAllCharacterMemories(w.db, id);
  w.db.prepare('DELETE FROM relationships WHERE character_id = ? OR target_id = ?').run(id, id);
  deleteCharacterEmbedding(w.db, id);

  res.json({ ok: true });
});

// Edit a character's fields directly (any source, including builtin).
app.put('/api/characters/:id', uploadCharacterAvatar.single('avatar'), async (req, res) => {
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

  if (req.file) {
    const ext = EXT_FOR_MIME[req.file.mimetype];
    const newPath = path.join(w.avatarDir, `${id}.${ext}`);
    // Only delete the old file when it's actually a different path — when
    // the extension is unchanged, the write below overwrites in place, and
    // an async rm of the same path could race it and delete the NEW file.
    if (character.avatarUrl) {
      const oldPath = path.join(w.avatarDir, path.basename(character.avatarUrl));
      if (oldPath !== newPath) fs.rm(oldPath, { force: true }, () => {});
    }
    fs.writeFileSync(newPath, req.file.buffer);
    character.avatarUrl = `${w.avatarUrlBase}/${id}.${ext}`;
  }

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

// Export/import always use the plural wire shape ({ personas: [...] }), same
// convention as characters — one shape for import to handle, not two. Note
// this is just the persona array, not the { personas, activePersonaId }
// shape GET /api/personas returns — activePersonaId is world-specific and
// meaningless across an import boundary.
// lastPlaceId is meaningless across an import boundary — a place id from
// this world has no reason to exist (or mean the same thing) in whatever
// world eventually imports this persona — same reasoning the shape comment
// above already gives for leaving activePersonaId out of the export wrapper.
function stripPersonaForExport({ lastPlaceId, ...persona }) {
  return persona;
}

app.get('/api/personas/:id/export', (req, res) => {
  const persona = loadPersonas(req.world).personas.find((p) => p.id === req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });
  res.json({ personas: [stripPersonaForExport(persona)] });
});

app.get('/api/personas/export', (req, res) => {
  res.json({ personas: loadPersonas(req.world).personas.map(stripPersonaForExport) });
});

// New minimal PNG spec (tavernroam_persona_v1 — see pngCard.js/tavernCard.js).
// A persona's avatar can be jpg/webp, unlike a character's (always png) —
// embedding a chunk needs an existing PNG to embed it into, so a non-PNG
// avatar falls back to a generated placeholder rather than attempting an
// image-format conversion this app has no dependency for.
app.get('/api/personas/:id/card.png', (req, res) => {
  const w = req.world;
  const persona = loadPersonas(w).personas.find((p) => p.id === req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });
  const avatarPath = persona.avatarUrl && /\.png$/i.test(persona.avatarUrl) ? path.join(w.personaAvatarDir, `${persona.id}.png`) : null;
  const baseImageBuffer = avatarPath && fs.existsSync(avatarPath) ? fs.readFileSync(avatarPath) : null;
  const png = buildPersonaCardPng({ persona, baseImageBuffer });
  res.set('Content-Type', 'image/png');
  res.set('Content-Disposition', `attachment; filename="${persona.name.replace(/[^a-z0-9-_ ]/gi, '_')}.png"`);
  res.send(png);
});

// Accepts either a multipart persona-card PNG upload (field "card") or a
// plain JSON { personas: [...] } body — multer no-ops for a non-multipart
// request, so both branch cleanly off the same route, same pattern as
// POST /api/characters.
app.post('/api/personas/import', uploadPersonaCard.single('card'), (req, res) => {
  const w = req.world;
  const data = loadPersonas(w);

  if (req.file) {
    let card;
    try {
      card = extractPersonaCard(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const id = crypto.randomUUID();
    const persona = { id, name: card.name, description: card.description, avatarUrl: null, color: colorForId(id) };
    data.personas.push(persona);
    savePersonas(w, data);
    return res.status(201).json({ personas: [persona] });
  }

  const { personas: incoming } = req.body || {};
  if (!Array.isArray(incoming) || !incoming.length) {
    return res.status(400).json({ error: 'A personas array is required.' });
  }
  const imported = incoming.map((p) => {
    const id = crypto.randomUUID();
    return { id, name: (p.name || '').trim(), description: (p.description || '').trim(), avatarUrl: null, color: colorForId(id) };
  });
  data.personas.push(...imported);
  savePersonas(w, data);
  res.status(201).json({ personas: imported });
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
    const ext = EXT_FOR_MIME[req.file.mimetype];
    const newPath = path.join(w.personaAvatarDir, `${id}.${ext}`);
    // Only delete the old file when it's actually a different path — when
    // the extension is unchanged, the write below overwrites in place, and
    // an async rm of the same path could race it and delete the NEW file.
    if (persona.avatarUrl) {
      const oldPath = path.join(w.personaAvatarDir, path.basename(persona.avatarUrl));
      if (oldPath !== newPath) fs.rm(oldPath, { force: true }, () => {});
    }
    fs.writeFileSync(newPath, req.file.buffer);
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

// Remembers where the active persona left off, so returning to this world
// later (a fresh session hours later, or switching back from another world)
// resumes there instead of always landing on the first place in the list.
// Keyed by persona, not just by world — a browser-side "last place" (the
// old approach) couldn't tell personas apart and didn't survive a
// different browser/private window either. A no-op with no active persona;
// "Visitor" sessions have nothing to key the memory by.
function recordLastPlaceForActivePersona(w, placeId) {
  const data = loadPersonas(w);
  const persona = data.personas.find((p) => p.id === data.activePersonaId);
  if (!persona || persona.lastPlaceId === placeId) return;
  persona.lastPlaceId = placeId;
  savePersonas(w, data);
}

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
  res.json(loadPresets());
});

// Catalog for the Prompts view's "insert standard block" dropdown — see
// STANDARD_PROMPT_BLOCKS in lib/context.js for what each entry does.
app.get('/api/prompts/standard-blocks', (req, res) => {
  res.json({ blocks: STANDARD_PROMPT_BLOCKS });
});

function createPreset({ name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage }) {
  const preset = {
    id: crypto.randomUUID(),
    name: name.trim(),
    contextLength: normalizeContextNumber(contextLength, DEFAULT_CONTEXT_LENGTH),
    maxReplyTokens: normalizeContextNumber(maxReplyTokens, DEFAULT_MAX_REPLY_TOKENS),
    prompts: normalizePromptList(prompts),
    memoryAsSeparateMessage: !!memoryAsSeparateMessage,
  };
  const data = loadPresets();
  data.presets.push(preset);
  savePresets(data);
  return preset;
}

app.post('/api/presets', (req, res) => {
  const { name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A preset name is required.' });
  }
  res.status(201).json({ preset: createPreset({ name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage }) });
});

// Transforms a raw SillyTavern Chat Completion preset export into a
// Freeroam preset and saves it — the client just uploads the parsed JSON
// it read from a dropped file plus a fallback name (from the filename,
// since ST presets don't carry their own "name" field).
app.post('/api/presets/import', (req, res) => {
  const { raw, fallbackName } = req.body || {};
  if (!raw || typeof raw !== 'object') {
    return res.status(400).json({ error: 'A raw SillyTavern preset object is required.' });
  }
  try {
    const parsed = importSillyTavernPreset(raw, fallbackName);
    res.status(201).json({ preset: createPreset(parsed) });
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
  const { id } = req.params;
  const data = loadPresets();
  const preset = data.presets.find((p) => p.id === id);
  if (!preset) return res.status(404).json({ error: 'Preset not found.' });

  const { name, prompts, contextLength, maxReplyTokens, memoryAsSeparateMessage } = req.body || {};
  if (typeof name === 'string' && name.trim()) preset.name = name.trim();
  if (prompts !== undefined) preset.prompts = normalizePromptList(prompts);
  if (contextLength !== undefined) preset.contextLength = normalizeContextNumber(contextLength, preset.contextLength || DEFAULT_CONTEXT_LENGTH);
  if (maxReplyTokens !== undefined) preset.maxReplyTokens = normalizeContextNumber(maxReplyTokens, preset.maxReplyTokens || DEFAULT_MAX_REPLY_TOKENS);
  if (typeof memoryAsSeparateMessage === 'boolean') preset.memoryAsSeparateMessage = memoryAsSeparateMessage;

  savePresets(data);
  res.json({ preset });
});

app.delete('/api/presets/:id', (req, res) => {
  const { id } = req.params;
  const data = loadPresets();
  if (!data.presets.some((p) => p.id === id)) return res.status(404).json({ error: 'Preset not found.' });

  data.presets = data.presets.filter((p) => p.id !== id);
  if (data.activePresetId === id) data.activePresetId = null;
  savePresets(data);
  res.json({ ok: true });
});

app.post('/api/presets/active', (req, res) => {
  const { id } = req.body || {};
  const data = loadPresets();
  if (id !== null && id !== undefined && !data.presets.some((p) => p.id === id)) {
    return res.status(400).json({ error: 'Unknown preset id.' });
  }
  data.activePresetId = id || null;
  savePresets(data);
  res.json({ activePresetId: data.activePresetId });
});

// --- Places routes ----------------------------------------------------

app.get('/api/places', (req, res) => {
  res.json({ places: loadPlaces(req.world) });
});

// Three export granularities, one wire shape ({ places: [...] }) — a single
// place, a whole area (same filter idea as knownAreas below), or everything.
app.get('/api/places/:id/export', (req, res) => {
  const place = loadPlaces(req.world).find((p) => p.id === req.params.id);
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  res.json({ places: [place] });
});

app.get('/api/places/export', (req, res) => {
  const { area } = req.query;
  const places = loadPlaces(req.world);
  res.json({ places: area ? places.filter((p) => p.area === area) : places });
});

// New minimal PNG spec (tavernroam_place_card_v1 — see pngCard.js/
// tavernCard.js). Places have no avatar concept at all, so this always
// generates a placeholder. Carries ownerNames (resolved display strings),
// not ownerIds — a place card is meant to be shareable into an arbitrary
// world where the original character ids won't resolve.
app.get('/api/places/:id/card.png', (req, res) => {
  const w = req.world;
  const place = loadPlaces(w).find((p) => p.id === req.params.id);
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const ownerNames = place.ownerIds.map((id) => charactersById[id]?.name).filter(Boolean);
  const png = buildPlaceCardPng({ place, ownerNames });
  res.set('Content-Type', 'image/png');
  res.set('Content-Disposition', `attachment; filename="${place.name.replace(/[^a-z0-9-_ ]/gi, '_')}.png"`);
  res.send(png);
});

// Fresh ids via uniquePlaceId (same slugify/dedupe as native place creation);
// any ownerIds entry that doesn't resolve against the TARGET world's
// characters is dropped and surfaced as a warning rather than invented as a
// stub character — matches how ownerIds already tolerates unknown ids nowhere
// else in the app (they just wouldn't render a name). Also accepts a
// multipart place-card PNG (field "card") — that card only ever carries
// ownerNames (display strings, not ids), so a PNG-imported place always
// lands with no owners, same as any other unresolvable-ownerIds case.
app.post('/api/places/import', uploadPlaceCard.single('card'), (req, res) => {
  const w = req.world;
  const places = loadPlaces(w);

  if (req.file) {
    let card;
    try {
      card = extractPlaceCard(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const place = {
      id: uniquePlaceId(card.name, places), name: card.name, desc: card.desc, type: card.type, ownerIds: [], area: card.area,
    };
    places.push(place);
    savePlaces(w, places);
    return res.status(201).json({ places: [place], warnings: [] });
  }

  const { places: incoming } = req.body || {};
  if (!Array.isArray(incoming) || !incoming.length) {
    return res.status(400).json({ error: 'A places array is required.' });
  }
  const characterIds = new Set(loadCharacters(w).map((c) => c.id));
  const warnings = [];
  const imported = incoming.map((p) => {
    const name = (p.name || '').trim() || 'Imported place';
    const type = p.type === 'private' ? 'private' : 'communal';
    const requestedOwnerIds = Array.isArray(p.ownerIds) ? [...new Set(p.ownerIds)] : [];
    const ownerIds = type === 'private' ? requestedOwnerIds.filter((id) => characterIds.has(id)) : [];
    if (requestedOwnerIds.length > ownerIds.length) {
      warnings.push(`"${name}": ${requestedOwnerIds.length - ownerIds.length} owner(s) don't exist in this world and were dropped.`);
    }
    const place = {
      id: uniquePlaceId(name, places),
      name,
      desc: (p.desc || '').trim(),
      type,
      ownerIds,
      area: (p.area || '').trim(),
    };
    places.push(place);
    return place;
  });
  savePlaces(w, places);
  res.status(201).json({ places: imported, warnings });
});

app.post('/api/places', (req, res) => {
  const w = req.world;
  const { name, desc, type, ownerIds, area } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A place name is required.' });
  }
  const placeType = type === 'private' ? 'private' : 'communal';
  const uniqueOwnerIds = Array.isArray(ownerIds) ? [...new Set(ownerIds)] : [];
  if (placeType === 'private' && uniqueOwnerIds.length) {
    const characters = loadCharacters(w);
    if (!uniqueOwnerIds.every((oid) => characters.some((c) => c.id === oid))) {
      return res.status(400).json({ error: 'Unknown owner character id.' });
    }
  }

  const places = loadPlaces(w);
  const place = {
    id: uniquePlaceId(name.trim(), places),
    name: name.trim(),
    desc: (desc || '').trim(),
    type: placeType,
    ownerIds: placeType === 'private' ? uniqueOwnerIds : [],
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

  const { name, desc, type, ownerIds, area } = req.body || {};
  if (typeof name === 'string' && name.trim()) place.name = name.trim();
  if (typeof desc === 'string') place.desc = desc.trim();
  if (type === 'private' || type === 'communal') place.type = type;
  if (typeof area === 'string') place.area = area.trim();
  if (place.type === 'private') {
    if (ownerIds !== undefined) {
      const uniqueOwnerIds = Array.isArray(ownerIds) ? [...new Set(ownerIds)] : [];
      if (uniqueOwnerIds.length) {
        const characters = loadCharacters(w);
        if (!uniqueOwnerIds.every((oid) => characters.some((c) => c.id === oid))) {
          return res.status(400).json({ error: 'Unknown owner character id.' });
        }
      }
      place.ownerIds = uniqueOwnerIds;
    }
  } else {
    place.ownerIds = [];
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

  deletePlaceChatLog(w, id);

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
async function runTextingReply({ w, cfg, characterId, character, onEvent = null, signal }) {
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
        (delta) => onEvent({ type: 'delta', ...delta }), signal));
    } else {
      ({ text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (text)`, signal));
    }

    const entry = {
      type: 'char', charId: characterId, name: character.name, text: (text || '').trim(),
      day: world.time.day, timeOfDay: world.time.timeOfDay,
    };
    const stats = buildGenerationStats(usage, timing);
    if (stats) entry.stats = stats;
    appendTextsEntries(w, characterId, [entry]);
    if (onEvent) onEvent({ type: 'turn', entries: [entry] });

    recordTurn({
      db: w.db, embedFn: embed, characterIds: [characterId], personaId: activePersonaId || null,
      text: `${personaLabel}: ${latestUserEntry ? latestUserEntry.text : ''}\n${character.name}: ${entry.text}`,
      placeId: null, entryIds: [latestUserEntry?.id, entry.id].filter(Boolean),
      day: world.time.day, timeOfDay: world.time.timeOfDay,
    }).catch((err) => logger.error('memory', `texting round recording failed: ${err.message}`));

    return { entries: [entry] };
  } catch (err) {
    return { error: err.message, cancelled: !!err.cancelled };
  }
}

// A character spontaneously texting the user, unprompted — reuses the same
// texting-mode generation as runTextingReply, but there's no user line
// triggering it, so buildTextingMessages' proactive flag appends a final
// directive turn instead. Recorded as a single addCharacterMemory rather
// than recordTurn's shared-row-per-exchange — there's no "exchange" here,
// just one spontaneous message — per the plan's own call-out. Not
// streamed: this always runs as a background side effect of some other
// request, never behind a live SSE connection of its own.
async function generateProactiveText({ w, cfg, characterId, character }) {
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const personaLabel = activePersona ? activePersona.name : 'Visitor';
  const world = loadWorld(w);
  const log = loadChatLog(w.textsDir, characterId);

  const memoryQuery = `${character.name} decides to text ${personaLabel} out of the blue.`;
  let memories = [];
  try {
    memories = await retrieveMemories({
      db: w.db, embedFn: embed, characterIds: [characterId], query: memoryQuery, minScore: cfg.memoryMinScore,
    });
  } catch (err) {
    logger.warn('memory', `proactive text retrieval failed, continuing without memories: ${err.message}`);
  }

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const placesById = {};
  loadPlaces(w).forEach((p) => { placesById[p.id] = p; });
  const relationships = await relationshipKnowledge(w, characterId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery);

  const messages = buildTextingMessages({
    char: character,
    persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
    memories, relationships, time: world.time, proactive: true,
    textingPromptTemplate: publicConfig(cfg).textingPromptTemplate,
  }, historyFromLog(log));

  const { text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (proactive text)`);

  const entry = {
    type: 'char', charId: characterId, name: character.name, text: (text || '').trim(), proactive: true,
    day: world.time.day, timeOfDay: world.time.timeOfDay,
  };
  const stats = buildGenerationStats(usage, timing);
  if (stats) entry.stats = stats;
  appendTextsEntries(w, characterId, [entry]);

  await addCharacterMemory({
    db: w.db, embedFn: embed, characterId, personaId: activePersonaId || null,
    text: `${character.name} texted you out of the blue: ${entry.text}`,
    placeId: null, day: world.time.day, timeOfDay: world.time.timeOfDay,
  }).catch((err) => logger.error('memory', `proactive text memory failed: ${err.message}`));

  logger.info('chat', `proactive text: ${character.name} -> ${personaLabel}`);
  return entry;
}

// A world with many characters and a high textingChancePerChar could
// otherwise roll positive for most of them at once and burst that many
// concurrent OpenRouter calls off a single user input — cap how many
// actually fire per round regardless of how many rolled.
const MAX_PROACTIVE_TEXTS_PER_ROUND = 3;

// Rolls once per character not already part of the current exchange —
// present at the place being said in, or the one being texted — and
// kicks off (but doesn't await) generation for anyone who hits. Fire-and-
// forget on purpose: this is a spontaneous background event, not part of
// the request that triggered it, so it shouldn't add latency or let one
// character's generation failure affect the response the user is actually
// waiting on. A missing/zero chance or key is a cheap no-op.
function maybeSendProactiveTexts(w, excludeIds) {
  const cfg = loadConfig();
  if (!cfg.apiKey || !(cfg.textingChancePerChar > 0)) return;

  const characters = loadCharacters(w).filter((c) => !excludeIds.includes(c.id));
  const rolled = characters.filter((c) => rollsProactiveText(cfg.textingChancePerChar));
  // Shuffle before capping — loadCharacters returns a stable (creation-order)
  // list, so taking a plain slice(0, N) would let a world past the cap
  // permanently favor whichever characters happen to be oldest, starving
  // every character added after it of ever texting first.
  for (let i = rolled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rolled[i], rolled[j]] = [rolled[j], rolled[i]];
  }
  rolled.slice(0, MAX_PROACTIVE_TEXTS_PER_ROUND).forEach((character) => {
    generateProactiveText({ w, cfg, characterId: character.id, character })
      .catch((err) => logger.warn('chat', `proactive text failed for ${character.name}: ${err.message}`));
  });
}

// Cached per-world rather than reading + parsing every texting/group log
// file on every GET /api/texts/unread, which the frontend polls every 20s
// (see FreeroamView.vue) — invalidated by every texts/group-log write below,
// same idea (and same "invalidate rather than incrementally track" tradeoff)
// as metCharacterIds above.
const unreadProactiveCountCache = new Map(); // worldId -> { total, byCharacterId }
function invalidateUnreadProactiveCount(w) {
  unreadProactiveCountCache.delete(w.id);
}
// Every texting/group-log mutation goes through one of these three instead
// of calling chatStore.js's append/save/delete directly against
// w.textsDir, so the cache above can never go stale. Param named `key`
// (not characterId/groupId) since it's shared by both.
function appendTextsEntries(w, key, entries) {
  appendChatEntries(w.textsDir, key, entries);
  invalidateUnreadProactiveCount(w);
}
function saveTextsLog(w, key, log) {
  saveChatLog(w.textsDir, key, log);
  invalidateUnreadProactiveCount(w);
}
function deleteTextsLog(w, key) {
  deleteChatLog(w.textsDir, key);
  invalidateUnreadProactiveCount(w);
}

// Every proactive (unprompted) char entry, across every 1-on-1 texting
// log, that hasn't been marked read yet — group logs live in the same
// dir but their entries never get `proactive` set, so they're already
// excluded without any special-casing (their id just never appears in
// byCharacterId, since only non-zero counts are recorded). Registered
// before the :characterId route below so "unread" is never captured as a
// param. Returns both the world-wide total (the phone app's badge) and a
// per-characterId breakdown (so the contacts list can show which contact
// it's actually from) from the same single scan.
function countUnreadProactiveTexts(w) {
  if (unreadProactiveCountCache.has(w.id)) return unreadProactiveCountCache.get(w.id);
  let files;
  try {
    files = fs.readdirSync(w.textsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { total: 0, byCharacterId: {} }; // not cached — a transient/first-run read failure, not a real "0" count
  }
  let total = 0;
  const byCharacterId = {};
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    const count = loadChatLog(w.textsDir, id).filter((e) => e.type === 'char' && e.proactive && !e.read).length;
    if (count) byCharacterId[id] = count;
    total += count;
  }
  const result = { total, byCharacterId };
  unreadProactiveCountCache.set(w.id, result);
  return result;
}

app.get('/api/texts/unread', (req, res) => {
  res.json(countUnreadProactiveTexts(req.world));
});

// Opening a conversation marks any proactive texts in it as read — the
// unread badge (GET /api/texts/unread) only ever counts what's actually
// still unseen.
app.get('/api/texts/:characterId', (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const log = loadChatLog(w.textsDir, characterId);
  if (log.some((e) => e.proactive && !e.read)) {
    log.forEach((e) => { if (e.proactive) e.read = true; });
    saveTextsLog(w, characterId, log);
  }
  res.json({ log });
});

// Manual "text me now" — same generation path as an automatic hit, just
// skipping the dice roll (debugging the prompt/memory injection, or a
// real player-facing nudge for a character you're missing).
app.post('/api/texts/:characterId/trigger', async (req, res) => {
  const w = req.world;
  const { characterId } = req.params;
  const character = loadCharacters(w).find((c) => c.id === characterId);
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const cfg = loadConfig();
  if (!cfg.apiKey) return res.status(400).json({ error: 'No API key configured. Add one in Settings.' });

  try {
    const entry = await generateProactiveText({ w, cfg, characterId, character });
    res.json({ log: loadChatLog(w.textsDir, characterId), entry });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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

  const { day, timeOfDay } = loadWorld(w).time;
  appendTextsEntries(w, characterId, [{ type: 'user', text: text.trim(), day, timeOfDay }]);
  logger.info('chat', `text -> ${character.name}`);
  maybeSendProactiveTexts(w, [characterId]);

  const signal = requestCancelSignal(req, res);
  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.textsDir, characterId) });

    const result = await runTextingReply({ w, cfg, characterId, character, onEvent: send, signal });
    if (!signal.aborted) {
      send({ type: 'done', log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
    }
    return res.end();
  }

  const result = await runTextingReply({ w, cfg, characterId, character, signal });
  if (!signal.aborted) {
    res.json({ log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
  }
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

  const signal = requestCancelSignal(req, res);
  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log });

    const result = await runTextingReply({ w, cfg, characterId, character, onEvent: send, signal });
    if (!signal.aborted) {
      send({ type: 'done', log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
    }
    return res.end();
  }

  const result = await runTextingReply({ w, cfg, characterId, character, signal });
  if (!signal.aborted) {
    res.json({ log: loadChatLog(w.textsDir, characterId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
  }
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
  saveTextsLog(w, characterId, log);
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
  // Surfaces a reply that was still awaiting allow/deny the last time this
  // conversation was open (see pendingCascadeSteps) — reopening the thread
  // re-shows the same prompt instead of it silently vanishing.
  const pending = pendingCascadeSteps.get(group.id);
  const pendingReply = pending ? { charId: pending.replierId, name: loadCharacters(w).find((c) => c.id === pending.replierId)?.name || null } : null;
  res.json({ group, log: loadChatLog(w.textsDir, group.id), ...(pendingReply ? { pendingReply } : {}) });
});

app.delete('/api/groups/:groupId', (req, res) => {
  const w = req.world;
  const groups = loadGroups(w);
  const group = groups.find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  pendingCascadeSteps.delete(group.id);
  saveGroups(w, groups.filter((g) => g.id !== group.id));
  deleteTextsLog(w, group.id);
  res.json({ ok: true });
});

// personas/world/places are invariant for a whole cascade (only the chat
// log itself needs re-reading between replies, since each one appends an
// entry the next should see) — loaded once by runGroupCascade and passed
// down, instead of generateGroupReply reloading all three from disk on
// every single reply. Same idea (and same fix) as loadTurnContext/
// buildTurnRequest already do for the scene-chat reaction round.
function loadGroupTurnContext(w) {
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const world = loadWorld(w);
  const placesById = {};
  loadPlaces(w).forEach((p) => { placesById[p.id] = p; });
  return { world, placesById, activePersona, activePersonaId };
}

// One cascade reply, generation-wise close to runTextingReply but scoped to
// whichever member is replying within the group — see groupHistoryFromLog
// for why the history shaping differs from 1-on-1 (a plain chat-completion
// API has no "third party" role, so everyone else's lines, including the
// user's, fold into 'user' turns; only the replying character's own past
// lines come back as 'assistant').
async function generateGroupReply({ w, cfg, group, replierId, character, charactersById, turnContext, onEvent = null, selfContinuation = false, signal }) {
  const { world, placesById, activePersona } = turnContext;
  const personaLabel = activePersona ? activePersona.name : 'Visitor';
  const log = loadChatLog(w.textsDir, group.id);

  const latestEntry = [...log].reverse().find((m) => m.type === 'user' || m.type === 'char');
  const memoryQuery = latestEntry ? latestEntry.text : `${personaLabel} texts the group.`;

  let memories = [];
  try {
    memories = await retrieveMemories({ db: w.db, embedFn: embed, characterIds: [replierId], query: memoryQuery, minScore: cfg.memoryMinScore });
  } catch (err) {
    logger.warn('memory', `group retrieval failed, continuing without memories: ${err.message}`);
  }

  const relationships = await relationshipKnowledge(w, replierId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery);
  const groupMembers = group.participantIds.filter((id) => id !== replierId).map((id) => charactersById[id]?.name).filter(Boolean);

  const messages = buildTextingMessages({
    char: character,
    persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
    memories, relationships, time: world.time, groupMembers, selfContinuation,
    textingPromptTemplate: publicConfig(cfg).textingPromptTemplate,
  }, groupHistoryFromLog(log, replierId, personaLabel));

  if (onEvent) onEvent({ type: 'speaker', charId: replierId, name: character.name });

  let text, usage, timing;
  if (onEvent && cfg.streaming) {
    ({ text, usage, timing } = await streamOpenRouter(cfg, messages, undefined, `${character.name} (group)`,
      (delta) => onEvent({ type: 'delta', ...delta }), signal));
  } else {
    ({ text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (group)`, signal));
  }

  const entry = {
    type: 'char', charId: replierId, name: character.name, text: (text || '').trim(),
    day: world.time.day, timeOfDay: world.time.timeOfDay,
  };
  const stats = buildGenerationStats(usage, timing);
  if (stats) entry.stats = stats;
  appendTextsEntries(w, group.id, [entry]);
  if (onEvent) onEvent({ type: 'turn', entries: [entry] });
  return entry;
}

// A character spontaneously texting first into a GROUP conversation,
// unprompted — the group-text counterpart to generateProactiveText's 1-on-1
// version, scoped to the group's own shared history (groupHistoryFromLog)
// via buildTextingMessages' groupMembers + proactive flags together (they're
// independent scene dimensions, already composable — see texting.js). The
// resulting entry becomes the cascade's own trigger message (see
// runGroupCascade's triggerSpeakerId — its own comment already anticipated
// this exact feature), so it doesn't record memory on its own; the /trigger
// route below records the whole round afterward, same as /send does for a
// user-triggered one.
async function generateProactiveGroupText({ w, cfg, group, replierId, character, charactersById, turnContext, signal }) {
  const { world, placesById, activePersona } = turnContext;
  const personaLabel = activePersona ? activePersona.name : 'Visitor';
  const log = loadChatLog(w.textsDir, group.id);

  const memoryQuery = `${character.name} decides to text the group out of the blue.`;
  let memories = [];
  try {
    memories = await retrieveMemories({ db: w.db, embedFn: embed, characterIds: [replierId], query: memoryQuery, minScore: cfg.memoryMinScore });
  } catch (err) {
    logger.warn('memory', `proactive group text retrieval failed, continuing without memories: ${err.message}`);
  }

  const relationships = await relationshipKnowledge(w, replierId, charactersById, placesById, world, activePersona ? activePersona.name : null, memoryQuery);
  const groupMembers = group.participantIds.filter((id) => id !== replierId).map((id) => charactersById[id]?.name).filter(Boolean);

  const messages = buildTextingMessages({
    char: character,
    persona: activePersona ? { name: activePersona.name, description: activePersona.description } : null,
    memories, relationships, time: world.time, groupMembers, proactive: true,
    textingPromptTemplate: publicConfig(cfg).textingPromptTemplate,
  }, groupHistoryFromLog(log, replierId, personaLabel));

  const { text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (proactive group text)`, signal);

  const entry = {
    type: 'char', charId: replierId, name: character.name, text: (text || '').trim(),
    day: world.time.day, timeOfDay: world.time.timeOfDay,
  };
  const stats = buildGenerationStats(usage, timing);
  if (stats) entry.stats = stats;
  appendTextsEntries(w, group.id, [entry]);
  return entry;
}

// Where a fresh cascade starts counting from — triggerSpeakerId is 'user'
// for a user-sent message, or a real character id for a character-initiated
// one (the proactive-group-text feature); either way, an id nextCascadeStep
// doesn't recognize as an actual group member (like the 'user' sentinel)
// means there's no consecutive-reply streak to protect yet.
function normalizeTriggerSpeaker(charactersById, triggerSpeakerId) {
  const lastSpeakerId = charactersById[triggerSpeakerId] ? triggerSpeakerId : null;
  return { lastSpeakerId, lastSpeakerStreak: lastSpeakerId ? 1 : 0 };
}

// Runs the reply cascade after any message lands in a group text — the
// user's own message today, or a character's proactive one (see
// generateProactiveGroupText), which is why triggerSpeakerId isn't
// hardcoded to 'user'. Each step's decision (continue? who?) comes from
// nextCascadeStep (textCascade.js) — factored out so the manual-approval
// flow (beginGroupCascade's paused path, and the /cascade/allow route) can
// ask the same question one step at a time instead of running straight
// through. Stops on the first failed roll, on running out of eligible
// repliers, or at MAX_CASCADE_REPLIES regardless of how the dice keep
// landing.
async function runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId, onEvent = null, signal }) {
  if (!cfg.apiKey) return { entries: [], error: 'No API key configured. Add one in Settings.' };

  const cascadeEntries = [];
  let { lastSpeakerId, lastSpeakerStreak } = normalizeTriggerSpeaker(charactersById, triggerSpeakerId);
  let repliesSoFar = 0;
  let error, cancelled = false;
  const turnContext = loadGroupTurnContext(w);

  for (;;) {
    const step = nextCascadeStep({
      participantIds: group.participantIds, lastSpeakerId, lastSpeakerStreak, repliesSoFar,
      cascadeBaseChance: cfg.cascadeBaseChance, cascadeDecayRate: cfg.cascadeDecayRate, cascadePerCharacterCap: cfg.cascadePerCharacterCap,
    });
    if (!step) break;
    const { replierId } = step;
    const character = charactersById[replierId];
    if (!character) break; // shouldn't happen — participantIds are validated at creation

    // The cap can let replierId go again right after their OWN last line
    // (a deliberate "double text" allowance) — when it does, the message
    // array would otherwise end on their own assistant turn with nothing
    // new to react to. buildTextingMessages' selfContinuation directive is
    // what keeps that from just restating the same thing (see its own
    // comment, and textCascade.js's, for why the cap itself isn't the fix).
    const selfContinuation = replierId === lastSpeakerId;

    let entry;
    try {
      entry = await generateGroupReply({ w, cfg, group, replierId, character, charactersById, turnContext, onEvent, selfContinuation, signal });
    } catch (err) {
      cancelled = !!err.cancelled;
      if (!cancelled) { error = err.message; logger.warn('chat', `group cascade reply failed, stopping the cascade here: ${err.message}`); }
      break;
    }
    cascadeEntries.push(entry);

    lastSpeakerStreak = replierId === lastSpeakerId ? lastSpeakerStreak + 1 : 1;
    lastSpeakerId = replierId;
    repliesSoFar += 1;
  }

  return { entries: cascadeEntries, ...(error ? { error } : {}), cancelled };
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

// A cascade reply awaiting the user's explicit allow/deny (the manual-
// response-flow feature, gated by cfg.groupCascadeManualApproval) — keyed
// by groupId, one entry per group with a paused cascade. Cleared the
// instant that decision is made (allow or deny) or the round otherwise
// concludes, so a stale entry can never resurface and silently resume a
// round the user already walked away from. Stores plain resumable facts,
// not `w`/db handles or other live objects — characters/group/config are
// all reloaded fresh at allow/deny time, same as any other route already
// does, so an edit made while a reply sits pending (e.g. the character
// being deleted) is naturally picked up rather than working from a stale
// snapshot.
const pendingCascadeSteps = new Map(); // groupId -> { replierId, lastSpeakerId, lastSpeakerStreak, repliesSoFar, triggerEntry, cascadeEntries, userLabel, activePersonaId, time }

// Starts (or restarts) a group's cascade right after a trigger message has
// landed — shared by /send, /retry, and /trigger, which differ only in how
// they each produce that trigger entry. Two modes, gated by
// cfg.groupCascadeManualApproval:
//   off (default) — today's fully-automatic cascade: runs straight through
//     to completion (streamed via SSE when cfg.streaming is also on AND
//     allowStreaming permits it — see below), records the round, and
//     responds. Unchanged from before this feature.
//   on — pauses before EVERY cascade reply, including the first, for the
//     user's explicit allow/deny ("X wants to respond, allow?"). Never
//     streamed, since each step is already separated by a real user
//     interaction; parks a resumable snapshot in pendingCascadeSteps and
//     responds with { log, pendingReply } instead of generating anything.
// allowStreaming=false forces the plain-JSON path regardless of
// cfg.streaming — /trigger passes this: it's a deliberately simple "nudge"
// action (matching 1-on-1 texting's own /api/texts/:characterId/trigger
// precedent) whose frontend caller (triggerGroupApi) is a plain JSON POST,
// not an SSE-aware fetch, so a streamed response here would just silently
// fail to parse rather than degrade gracefully.
async function beginGroupCascade({ req, res, w, cfg, group, charactersById, triggerEntry, triggerSpeakerId, userLabel, activePersonaId, time, allowStreaming = true }) {
  if (cfg.groupCascadeManualApproval) {
    // A new trigger supersedes any pending step the user never answered —
    // but whatever cascade replies THAT round already had approved (its
    // cascadeEntries) already landed in the visible log via generateGroupReply
    // and deserve their memory row same as any other round, rather than
    // silently vanishing from memory just because the prompt was abandoned.
    const abandoned = pendingCascadeSteps.get(group.id);
    if (abandoned) {
      pendingCascadeSteps.delete(group.id);
      recordGroupRound(w, {
        group, triggerEntry: abandoned.triggerEntry, cascadeEntries: abandoned.cascadeEntries,
        userLabel: abandoned.userLabel, activePersonaId: abandoned.activePersonaId, time: abandoned.time,
      });
    }
    if (!cfg.apiKey) {
      recordGroupRound(w, { group, triggerEntry, cascadeEntries: [], userLabel, activePersonaId, time });
      return res.json({ log: loadChatLog(w.textsDir, group.id), error: 'No API key configured. Add one in Settings.' });
    }

    const { lastSpeakerId, lastSpeakerStreak } = normalizeTriggerSpeaker(charactersById, triggerSpeakerId);
    const step = nextCascadeStep({
      participantIds: group.participantIds, lastSpeakerId, lastSpeakerStreak, repliesSoFar: 0,
      cascadeBaseChance: cfg.cascadeBaseChance, cascadeDecayRate: cfg.cascadeDecayRate, cascadePerCharacterCap: cfg.cascadePerCharacterCap,
    });
    if (!step) {
      recordGroupRound(w, { group, triggerEntry, cascadeEntries: [], userLabel, activePersonaId, time });
      return res.json({ log: loadChatLog(w.textsDir, group.id) });
    }

    pendingCascadeSteps.set(group.id, {
      replierId: step.replierId, lastSpeakerId, lastSpeakerStreak, repliesSoFar: 0,
      triggerEntry, cascadeEntries: [], userLabel, activePersonaId, time,
    });
    return res.json({
      log: loadChatLog(w.textsDir, group.id),
      pendingReply: { charId: step.replierId, name: charactersById[step.replierId]?.name || null },
    });
  }

  // A cancelled cascade shouldn't leave any memory trace, same as a
  // cancelled reaction round (runReactionRound) or 1-on-1 text
  // (runTextingReply) — a dice-rolled zero-reply cascade is still
  // genuinely recorded (the room "heard" the trigger message even if
  // nobody answered, same philosophy as recordSilentRound), only a real
  // user-initiated Stop skips it.
  const finish = (result) => {
    if (result.cancelled) return;
    recordGroupRound(w, { group, triggerEntry, cascadeEntries: result.entries, userLabel, activePersonaId, time });
  };
  const signal = requestCancelSignal(req, res);

  if (cfg.streaming && cfg.apiKey && allowStreaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.textsDir, group.id) });

    const result = await runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId, onEvent: send, signal });
    finish(result);
    if (!signal.aborted) {
      send({ type: 'done', log: loadChatLog(w.textsDir, group.id), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
    }
    return res.end();
  }

  const result = await runGroupCascade({ w, cfg, group, charactersById, triggerSpeakerId, signal });
  finish(result);
  if (!signal.aborted) {
    res.json({ log: loadChatLog(w.textsDir, group.id), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
  }
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

  const time = loadWorld(w).time;
  const userEntry = { type: 'user', text: text.trim(), day: time.day, timeOfDay: time.timeOfDay };
  appendTextsEntries(w, groupId, [userEntry]);
  logger.info('chat', `group text -> ${group.name}`);
  // Mirrors /say and 1-on-1 texting's /send — a group's own participants are
  // excluded since the cascade below already covers them; this only gives
  // OTHER characters (not in this group) a chance to spontaneously text in.
  maybeSendProactiveTexts(w, group.participantIds);

  const cfg = loadConfig();
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const userLabel = activePersona ? activePersona.name : 'Visitor';

  await beginGroupCascade({
    req, res, w, cfg, group, charactersById, triggerEntry: userEntry, triggerSpeakerId: 'user', userLabel, activePersonaId, time,
  });
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

  await beginGroupCascade({
    req, res, w, cfg, group, charactersById, triggerEntry, triggerSpeakerId: 'user', userLabel, activePersonaId, time,
  });
});

// Manual "make someone text first" — the group-chat counterpart to 1-on-1
// texting's /api/texts/:characterId/trigger (same deliberate simplicity: no
// streaming, no cancel signal, matching that route's own precedent for a
// "nudge" action). characterId is optional — with none given, one is picked
// randomly from the group's own participants. The resulting message becomes
// the cascade's own trigger (runGroupCascade's triggerSpeakerId), so the
// rest of the group can naturally react to it same as they would a user
// message.
app.post('/api/groups/:groupId/trigger', async (req, res) => {
  const w = req.world;
  const { groupId } = req.params;
  const { characterId } = req.body || {};

  const group = loadGroups(w).find((g) => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });

  let replierId = characterId;
  if (replierId) {
    if (!group.participantIds.includes(replierId)) {
      return res.status(400).json({ error: 'That character is not a member of this group.' });
    }
  } else {
    replierId = group.participantIds[Math.floor(Math.random() * group.participantIds.length)];
  }
  const character = charactersById[replierId];
  if (!character) return res.status(404).json({ error: 'Character not found.' });

  const cfg = loadConfig();
  if (!cfg.apiKey) return res.status(400).json({ error: 'No API key configured. Add one in Settings.' });

  const turnContext = loadGroupTurnContext(w);
  const { activePersona, activePersonaId, world } = turnContext;
  const userLabel = activePersona ? activePersona.name : 'Visitor';

  let triggerEntry;
  try {
    triggerEntry = await generateProactiveGroupText({ w, cfg, group, replierId, character, charactersById, turnContext });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  logger.info('chat', `group proactive trigger: ${character.name} -> ${group.name}`);
  // Same "give everyone else a chance too" call /send makes — a group's own
  // participants are excluded since the cascade below already covers them.
  maybeSendProactiveTexts(w, group.participantIds);

  await beginGroupCascade({
    req, res, w, cfg, group, charactersById, triggerEntry, triggerSpeakerId: replierId, userLabel, activePersonaId, time: world.time,
    allowStreaming: false,
  });
});

// The user approves whichever reply is currently paused (see
// pendingCascadeSteps/beginGroupCascade) — 400s if nothing is actually
// pending, which also naturally covers a stale/expired approval the user
// clicked after the group already moved on some other way. autoAllow=true
// answers "yes, and don't ask again for the rest of this cascade": the
// loop below just keeps generating+re-rolling by itself instead of parking
// a new pending step after each reply.
app.post('/api/groups/:groupId/cascade/allow', async (req, res) => {
  const w = req.world;
  const { groupId } = req.params;
  const { autoAllow } = req.body || {};

  const pending = pendingCascadeSteps.get(groupId);
  if (!pending) return res.status(400).json({ error: 'No reply is currently awaiting approval.' });

  const group = loadGroups(w).find((g) => g.id === groupId);
  if (!group) { pendingCascadeSteps.delete(groupId); return res.status(404).json({ error: 'Group not found.' }); }

  const cfg = loadConfig();
  if (!cfg.apiKey) return res.status(400).json({ error: 'No API key configured. Add one in Settings.' });

  const charactersById = {};
  loadCharacters(w).forEach((c) => { charactersById[c.id] = c; });
  const turnContext = loadGroupTurnContext(w);

  let { replierId, lastSpeakerId, lastSpeakerStreak, repliesSoFar, cascadeEntries } = pending;

  for (;;) {
    const character = charactersById[replierId];
    if (!character) {
      // The character was deleted while this reply sat pending — nothing
      // sane left to generate; end the round with whatever already landed.
      pendingCascadeSteps.delete(groupId);
      recordGroupRound(w, { group, triggerEntry: pending.triggerEntry, cascadeEntries, userLabel: pending.userLabel, activePersonaId: pending.activePersonaId, time: pending.time });
      return res.status(404).json({ error: 'That character no longer exists.', log: loadChatLog(w.textsDir, groupId) });
    }

    const selfContinuation = replierId === lastSpeakerId;
    let entry;
    try {
      entry = await generateGroupReply({ w, cfg, group, replierId, character, charactersById, turnContext, selfContinuation });
    } catch (err) {
      pendingCascadeSteps.delete(groupId);
      recordGroupRound(w, { group, triggerEntry: pending.triggerEntry, cascadeEntries, userLabel: pending.userLabel, activePersonaId: pending.activePersonaId, time: pending.time });
      return res.status(502).json({ error: err.message, log: loadChatLog(w.textsDir, groupId) });
    }
    cascadeEntries = [...cascadeEntries, entry];
    lastSpeakerStreak = replierId === lastSpeakerId ? lastSpeakerStreak + 1 : 1;
    lastSpeakerId = replierId;
    repliesSoFar += 1;

    const step = nextCascadeStep({
      participantIds: group.participantIds, lastSpeakerId, lastSpeakerStreak, repliesSoFar,
      cascadeBaseChance: cfg.cascadeBaseChance, cascadeDecayRate: cfg.cascadeDecayRate, cascadePerCharacterCap: cfg.cascadePerCharacterCap,
    });

    if (!step) {
      pendingCascadeSteps.delete(groupId);
      recordGroupRound(w, { group, triggerEntry: pending.triggerEntry, cascadeEntries, userLabel: pending.userLabel, activePersonaId: pending.activePersonaId, time: pending.time });
      return res.json({ log: loadChatLog(w.textsDir, groupId) });
    }

    if (!autoAllow) {
      pendingCascadeSteps.set(groupId, {
        replierId: step.replierId, lastSpeakerId, lastSpeakerStreak, repliesSoFar,
        triggerEntry: pending.triggerEntry, cascadeEntries, userLabel: pending.userLabel, activePersonaId: pending.activePersonaId, time: pending.time,
      });
      return res.json({
        log: loadChatLog(w.textsDir, groupId),
        pendingReply: { charId: step.replierId, name: charactersById[step.replierId]?.name || null },
      });
    }
    replierId = step.replierId; // autoAllow: keep going without parking a new pending step
  }
});

// The user declines the currently-paused reply — the cascade round simply
// ends here (no reroll to a different member): a definitive "no", not a
// retry. Whatever already landed earlier in this same round (before this
// particular reply was ever proposed) is still recorded normally.
app.post('/api/groups/:groupId/cascade/deny', (req, res) => {
  const w = req.world;
  const { groupId } = req.params;

  const pending = pendingCascadeSteps.get(groupId);
  if (!pending) return res.status(400).json({ error: 'No reply is currently awaiting approval.' });
  pendingCascadeSteps.delete(groupId);

  const group = loadGroups(w).find((g) => g.id === groupId);
  if (group) {
    recordGroupRound(w, {
      group, triggerEntry: pending.triggerEntry, cascadeEntries: pending.cascadeEntries,
      userLabel: pending.userLabel, activePersonaId: pending.activePersonaId, time: pending.time,
    });
  }
  res.json({ log: loadChatLog(w.textsDir, groupId) });
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
  saveTextsLog(w, groupId, log);
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

  appendPlaceChatEntries(w, placeId, [{ type: 'system', text: `📞 You call ${character.name}.`, call: true }], world.time);
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
async function runCallReply({ w, cfg, placeId, place, characterId, character, callState, onEvent = null, signal }) {
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
        (delta) => onEvent({ type: 'delta', ...delta }), signal));
    } else {
      ({ text, usage, timing } = await callOpenRouter(cfg, messages, undefined, `${character.name} (call)`, signal));
    }

    const entry = { type: 'char', charId: characterId, name: character.name, text: (text || '').trim(), call: true };
    const stats = buildGenerationStats(usage, timing);
    if (stats) entry.stats = stats;
    appendPlaceChatEntries(w, placeId, [entry], world.time);
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
        callContext: { calleeName: character.name }, signal,
      });
      if (narration) {
        const narratorEntry = { ...narration, call: true };
        appendPlaceChatEntries(w, placeId, [narratorEntry], world.time);
        if (onEvent) onEvent({ type: 'turn', entries: [narratorEntry] });
      }
    }

    return { entries: [entry] };
  } catch (err) {
    return { error: err.message, cancelled: !!err.cancelled };
  }
}

// Persists this place's (already in-place-mutated) callState without
// clobbering another place's call that may have saved its own changes to
// calls.json during the awaited LLM call above — reloads fresh and only
// writes this place's entry back if the call is still active there (a
// concurrent /end could have removed it, which this must not resurrect).
function saveCallStateIfStillActive(w, placeId, callState) {
  const freshCalls = loadCalls(w);
  if (freshCalls[placeId]) freshCalls[placeId] = callState;
  saveCalls(w, freshCalls);
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
  appendPlaceChatEntries(w, placeId, [userEntry]);
  callState.transcript.push({ type: 'user', text: userEntry.text, entryId: userEntry.id });
  saveCalls(w, calls);
  logger.info('chat', `call say -> ${character.name}`);

  const signal = requestCancelSignal(req, res);
  const cfg = loadConfig();
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.chatDir, placeId) });

    const result = await runCallReply({ w, cfg, placeId, place, characterId, character, callState, onEvent: send, signal });
    saveCallStateIfStillActive(w, placeId, callState);
    if (!signal.aborted) {
      send({ type: 'done', log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
    }
    return res.end();
  }

  const result = await runCallReply({ w, cfg, placeId, place, characterId, character, callState, signal });
  saveCallStateIfStillActive(w, placeId, callState);
  if (!signal.aborted) {
    res.json({ log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
  }
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
  appendPlaceChatEntries(w, placeId, [{ type: 'system', text: `📞 Call with ${calleeName} ended.`, call: true }], world.time);
  logger.info('chat', `call ended: ${calleeName} @ ${place ? place.name : placeId}`);

  res.json({ log: loadChatLog(w.chatDir, placeId), placements: world.placements });
});

// --- World / placement routes ------------------------------------------

// Cached per-world rather than rescanning every place's entire chat log on
// every GET /api/world (which the frontend calls on most view navigations) —
// invalidated (not incrementally updated) by every place-chat write below,
// simpler and safer than tracking exactly which writes could add/remove a
// "met" character, at the cost of one extra full rescan on the next read
// after any write.
const metCharacterIdsCache = new Map(); // worldId -> string[]
function invalidateMetCharacterIds(w) {
  metCharacterIdsCache.delete(w.id);
}
// Every place-chat mutation goes through one of these three instead of
// calling chatStore.js's append/save/delete directly against w.chatDir, so
// the cache above can never go stale. Stamping day/timeOfDay here — the one
// chokepoint every new place-chat entry already passes through, across a
// dozen call sites (user lines, character/narrator turns, call system
// markers) — means every one of them gets it for free, the same way
// texting entries do (see appendTextsEntries), without touching each site
// individually. `day == null` guards against re-stamping an entry that
// already carries one (there are none today, but a future caller might).
// `time` is optional — most call sites have nothing else in scope and are
// fine paying for one small loadWorld() read, but a hot per-turn call site
// (runReactionRound's loop) already has the round's world loaded via
// loadTurnContext and can pass its `.time` straight through instead of
// re-reading world.json redundantly on every reacting character's turn.
function appendPlaceChatEntries(w, placeId, entries, time = null) {
  const { day, timeOfDay } = time || loadWorld(w).time;
  entries.forEach((e) => { if (e.day == null) { e.day = day; e.timeOfDay = timeOfDay; } });
  appendChatEntries(w.chatDir, placeId, entries);
  invalidateMetCharacterIds(w);
}
function savePlaceChatLog(w, placeId, log) {
  saveChatLog(w.chatDir, placeId, log);
  invalidateMetCharacterIds(w);
}
function deletePlaceChatLog(w, placeId) {
  deleteChatLog(w.chatDir, placeId);
  invalidateMetCharacterIds(w);
}

// Every character id that has ever spoken (a type:'char' entry) in any
// place's chat log — used by the Phone contacts list to only surface
// characters the user has actually met in a scene, rather than every
// character that exists in the world (see PhoneContacts.vue).
function metCharacterIds(w) {
  if (metCharacterIdsCache.has(w.id)) return metCharacterIdsCache.get(w.id);
  const ids = new Set();
  for (const place of loadPlaces(w)) {
    for (const entry of loadChatLog(w.chatDir, place.id)) {
      if (entry.type === 'char' && entry.charId) ids.add(entry.charId);
    }
  }
  const result = [...ids];
  metCharacterIdsCache.set(w.id, result);
  return result;
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

// Both callOpenRouter and streamOpenRouter abort if the endpoint goes fully
// unresponsive — generous enough that a slow-but-working model never trips
// it (streamOpenRouter's timer resets on every chunk received, so a long but
// actively-producing generation is never killed), this only guards against
// a genuinely hung connection: no response at all, or a stream that stops
// producing chunks mid-generation and never closes.
const LLM_TIMEOUT_MS = 120_000;

// A resettable AbortController-backed deadline — reset() pushes the abort
// out by another full LLM_TIMEOUT_MS, used by streamOpenRouter's read loop
// to implement "no more than N seconds between chunks" rather than one
// fixed deadline for the whole (potentially long) stream. Also forwards an
// optional externalSignal (a client-initiated "Stop generating" — see
// requestCancelSignal below) into the same controller, so callers only ever
// need to look at timeout.signal/cancel() and don't have to combine two
// signals themselves.
function timeoutController(ms, externalSignal) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  return {
    signal: controller.signal,
    reset() { clearTimeout(timer); timer = setTimeout(() => controller.abort(), ms); },
    cancel() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
}

// Wires an AbortController to abort as soon as the client gives up on this
// request — aborts its own fetch, navigates away mid-stream, etc. — so a
// "Stop" button genuinely cancels the outbound OpenRouter call too, not
// just the client-side wait. Listening on req's own 'close' is a trap: that
// fires as soon as the *request* finishes being read (often immediately,
// well before the handler even starts), not when the connection actually
// goes away — every request would look "cancelled" from the first tick.
// res's 'close' is the reliable one: it fires on a genuine client
// disconnect same as req's does, but also fires after an ordinary response
// finishes, so it's gated on res.writableEnded to tell the two apart.
function requestCancelSignal(req, res) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  return controller.signal;
}

// A distinguishable error for callOpenRouter/streamOpenRouter's AbortError
// catch blocks to throw when the abort came from an externalSignal (a real
// user-initiated cancel) rather than the internal LLM_TIMEOUT_MS deadline —
// callers can check `err.cancelled` to skip surfacing this as a failure.
function cancelledError() {
  return Object.assign(new Error('Generation cancelled.'), { cancelled: true });
}

// Non-streaming completion. `meta` is logging context only (who/where).
// Returns { text, reasoning, usage, timing } — reasoning is present when the
// endpoint returned a reasoning/thinking trace (OpenRouter normalizes it);
// usage is token counts (null fields if the endpoint didn't report them);
// timing is wall-clock duration for tokens/sec display.
async function callOpenRouter(cfg, messages, maxTokens, meta = '', externalSignal) {
  const payload = completionPayload(cfg, messages, maxTokens);
  logger.info('llm', `→ ${cfg.apiBase || DEFAULT_API_BASE} model=${cfg.model}${cfg.providers?.length ? ` providers=${cfg.providers.join(',')}` : ''}${meta ? ` — ${meta}` : ''}`);
  logger.debug('llm', 'request payload', payload);

  const startedAt = Date.now();
  const timeout = timeoutController(LLM_TIMEOUT_MS, externalSignal);
  let r;
  try {
    r = await fetch(`${cfg.apiBase || DEFAULT_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: completionHeaders(cfg),
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) {
        logger.info('llm', `request cancelled by user${meta ? ` — ${meta}` : ''}`);
        throw cancelledError();
      }
      logger.error('llm', `request timed out after ${LLM_TIMEOUT_MS}ms with no response`);
      throw new Error(`Endpoint timed out after ${LLM_TIMEOUT_MS / 1000}s with no response.`);
    }
    logger.error('llm', `endpoint unreachable: ${err.message}`);
    throw new Error(`Endpoint unreachable: ${err.message}`);
  } finally {
    timeout.cancel();
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
async function streamOpenRouter(cfg, messages, maxTokens, meta, onDelta, externalSignal) {
  const payload = completionPayload(cfg, messages, maxTokens, true);
  logger.info('llm', `→ ${cfg.apiBase || DEFAULT_API_BASE} model=${cfg.model} (streaming)${meta ? ` — ${meta}` : ''}`);
  logger.debug('llm', 'request payload', payload);

  const startedAt = Date.now();
  const timeout = timeoutController(LLM_TIMEOUT_MS, externalSignal);
  let r;
  try {
    r = await fetch(`${cfg.apiBase || DEFAULT_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: completionHeaders(cfg),
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });
  } catch (err) {
    timeout.cancel();
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) {
        logger.info('llm', `stream request cancelled by user${meta ? ` — ${meta}` : ''}`);
        throw cancelledError();
      }
      logger.error('llm', `stream request timed out after ${LLM_TIMEOUT_MS}ms with no response`);
      throw new Error(`Endpoint timed out after ${LLM_TIMEOUT_MS / 1000}s with no response.`);
    }
    logger.error('llm', `endpoint unreachable: ${err.message}`);
    throw new Error(`Endpoint unreachable: ${err.message}`);
  }
  // Fresh full window for the read loop below, distinct from the
  // just-used initial-connect window — reset() on every chunk received from
  // here on implements "no more than LLM_TIMEOUT_MS between chunks", not one
  // fixed deadline for the whole (potentially long) generation.
  timeout.reset();

  if (!r.ok) {
    timeout.cancel();
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
  try {
    for (;;) {
      let done, value;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        if (err.name === 'AbortError') {
          if (externalSignal?.aborted) {
            logger.info('llm', `stream cancelled by user mid-stream${meta ? ` — ${meta}` : ''}`);
            throw cancelledError();
          }
          throw new Error(`Endpoint stopped responding mid-stream (no data for ${LLM_TIMEOUT_MS / 1000}s).`);
        }
        throw err;
      }
      if (done) break;
      timeout.reset(); // got data — the connection is alive, push the deadline out again
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
  } finally {
    timeout.cancel();
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
// Everything about a world that's invariant across every character's turn
// within one round (or a single /regenerate call) — config, active
// persona/preset, world state, and a places-by-id lookup. Callers load this
// ONCE per round (not once per reacting character — see runReactionRound)
// and pass it into buildTurnRequest.
function loadTurnContext(w) {
  const cfg = loadConfig();
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  const { presets, activePresetId } = loadPresets();
  const activePreset = presets.find((p) => p.id === activePresetId) || null;
  const world = loadWorld(w);
  const placesById = {};
  loadPlaces(w).forEach((p) => { placesById[p.id] = p; });
  return { cfg, world, placesById, activePersona, activePersonaId, activePreset };
}

async function buildTurnRequest({ w, place, speakerId, presentIds, charactersById, log, turnContext }) {
  const { cfg, world, placesById, activePersona, activePersonaId, activePreset } = turnContext;

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
      ownerNames: place.ownerIds.map((oid) => charactersById[oid]?.name).filter(Boolean),
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
async function generateCharacterTurn({ w, cfg, place, speakerId, presentIds, charactersById, log, onEvent = null, backgroundIds = [], signal }) {
  const request = await buildTurnRequest({ w, place, speakerId, presentIds, charactersById, log, turnContext: loadTurnContext(w) });
  if (onEvent) onEvent({ type: 'speaker', charId: speakerId, name: request.speaker.name });
  try {
    let text, reasoning, usage, timing;
    if (onEvent && cfg.streaming) {
      ({ text, reasoning, usage, timing } = await streamOpenRouter(cfg, request.messages, request.maxReplyTokens,
        `${request.speaker.name} @ ${place.name}`, (delta) => onEvent({ type: 'delta', ...delta }), signal));
    } else {
      ({ text, reasoning, usage, timing } = await callOpenRouter(cfg, request.messages, request.maxReplyTokens,
        `${request.speaker.name} @ ${place.name}`, signal));
    }
    return { entries: await turnEntriesFrom(w, text, reasoning, request, usage, timing, place, charactersById, cfg.suggestedActionsMode, backgroundIds) };
  } catch (err) {
    return { error: err.message, cancelled: !!err.cancelled };
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
async function attemptNarratorTurn({ w, cfg, place, presentIds, backgroundIds, charactersById, log, callContext = null, signal }) {
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
        ownerNames: place.ownerIds.map((oid) => charactersById[oid]?.name).filter(Boolean),
        weather: place.area ? loadWeather(w)[place.area]?.condition || null : null,
      },
      worldSetting: world.setting,
      time: world.time,
      backgroundChars,
      transcript: buildHistoryTranscript(log, { userLabel, tokenBudget: 1200 }),
      callContext,
    });

    // Same reply-token budget a real character turn gets (the active
    // preset's maxReplyTokens, or the app default) — there's no way to
    // predict how long a good narration should be, so this shouldn't have
    // its own separate, arbitrary cap.
    const { presets, activePresetId } = loadPresets();
    const activePreset = presets.find((p) => p.id === activePresetId) || null;
    const { maxReplyTokens } = contextSettingsFor(activePreset);

    const { text } = await callOpenRouter(cfg, messages, maxReplyTokens, `Narrator @ ${place.name}`, signal);
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
async function narrateEmptyPlaceOrEcho({ w, placeId, place, signal }) {
  const cfg = loadConfig();
  let note = null;
  if (cfg.narratorEnabled !== false) {
    const log = loadChatLog(w.chatDir, placeId);
    if (shouldNarrate({ placeType: place.type, presentCount: 0, backgroundCount: 0, log })) {
      note = await attemptNarratorTurn({ w, cfg, place, presentIds: [], backgroundIds: [], charactersById: {}, log, signal });
    }
  }
  // A cancel means Stop everywhere else in the app — persisting a fallback
  // note despite it (attemptNarratorTurn treats a genuine cancel the same
  // as "declined to speak," so this can't be told apart from that case any
  // other way) would be the one place that didn't honor it.
  if (signal?.aborted) return;
  if (!note) note = { type: 'system', text: 'Your words echo. No one is here to answer.' };
  appendPlaceChatEntries(w, placeId, [note]);
}

// Present characters can all be inactive at once (everyone's in the room
// but nobody's an active participant right now) — no turns get generated,
// but the room still "hears" what was said. Tries a narrator line first
// (describing the scene/background cast is exactly this situation's use
// case); falls back to a flat note if the narrator is off, unavailable, or
// has nothing to add. Either way the round is recorded into every present
// character's memory, same as a normal round would, minus any replies.
async function recordSilentRound({ w, placeId, place, presentIds, charactersById, turnEntries, signal }) {
  const cfg = loadConfig();
  let note = null;
  if (cfg.narratorEnabled !== false) {
    const log = loadChatLog(w.chatDir, placeId);
    if (shouldNarrate({ placeType: place.type, presentCount: presentIds.length, backgroundCount: presentIds.length, log })) {
      note = await attemptNarratorTurn({ w, cfg, place, presentIds, backgroundIds: presentIds, charactersById, log, signal });
    }
  }
  // Same cancel guard as narrateEmptyPlaceOrEcho — see its comment. Skips
  // both the fallback note AND the memory recording below.
  if (signal?.aborted) return;
  if (!note) note = { type: 'system', text: 'No one reacts.' };

  const time = loadWorld(w).time; // loaded once, reused below — recordRound wants it too
  appendPlaceChatEntries(w, placeId, [note], time);
  const { personas, activePersonaId } = loadPersonas(w);
  const activePersona = personas.find((p) => p.id === activePersonaId) || null;
  recordRound(w, {
    placeId, presentIds,
    turnEntries: [...turnEntries, note],
    userLabel: activePersona ? activePersona.name : 'Visitor',
    activePersonaId,
    time,
  });
}

// A full reaction round: every reacting character takes their own turn, in
// order, each seeing the previous speakers' turns from this round (the log
// is re-read per turn). Afterward the whole round (trigger entries +
// everyone's turns) is recorded once into each present character's memory.
// `onEvent`, when provided, streams progress (speaker/delta/turn events)
// — the SSE path of /say. Returns { error } from the first failed turn;
// earlier turns stay persisted.
async function runReactionRound({ w, placeId, place, reactIds, presentIds, charactersById, turnEntriesSoFar, onEvent = null, signal }) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { error: 'No API key configured. Add one in Settings.' };
  }

  const roundEntries = [];
  let error = null;
  let cancelled = false;
  let userLabel = 'Visitor';
  let activePersonaId = null;
  let time = null;
  const backgroundIds = presentIds.filter((id) => !reactIds.includes(id));

  // Loaded once for the whole round, not once per reacting character — world/
  // personas/presets are invariant for the round's duration; only the chat
  // log itself needs re-reading each iteration, since each character's turn
  // appends entries the next character should see.
  const turnContext = loadTurnContext(w);

  for (const speakerId of reactIds) {
    const log = loadChatLog(w.chatDir, placeId);
    const request = await buildTurnRequest({ w, place, speakerId, presentIds, charactersById, log, turnContext });
    userLabel = request.userLabel;
    activePersonaId = request.activePersonaId;
    time = request.time;

    if (onEvent) onEvent({ type: 'speaker', charId: speakerId, name: request.speaker.name });

    let text, reasoning, usage, timing;
    try {
      if (onEvent && cfg.streaming) {
        ({ text, reasoning, usage, timing } = await streamOpenRouter(cfg, request.messages, request.maxReplyTokens,
          `${request.speaker.name} @ ${place.name}`, (delta) => onEvent({ type: 'delta', ...delta }), signal));
      } else {
        ({ text, reasoning, usage, timing } = await callOpenRouter(cfg, request.messages, request.maxReplyTokens,
          `${request.speaker.name} @ ${place.name}`, signal));
      }
    } catch (err) {
      error = err.message;
      cancelled = !!err.cancelled;
      break;
    }

    const entries = await turnEntriesFrom(w, text, reasoning, request, usage, timing, place, charactersById, cfg.suggestedActionsMode, backgroundIds);
    appendPlaceChatEntries(w, placeId, entries, turnContext.world.time);
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
      const narration = await attemptNarratorTurn({ w, cfg, place, presentIds, backgroundIds, charactersById, log, signal });
      if (narration) {
        appendPlaceChatEntries(w, placeId, [narration], turnContext.world.time);
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

  return error ? { error, cancelled } : {};
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

  recordLastPlaceForActivePersona(w, placeId);

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

  appendPlaceChatEntries(w, placeId, turnEntries, world.time);
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
// /say and /retry both can hit a "nobody to react" branch (an empty place,
// or everyone present is inactive) that has nothing to stream turn-by-turn
// — just one atomic narrator-or-fallback note. These branches used to
// always answer with a plain JSON body regardless of cfg.streaming — but
// the frontend decides whether to fetch via the streaming or non-streaming
// path *before* it knows the room's character state (see chat.js's
// sendMessage/retryMessage), so a streaming client parsing a plain JSON
// body through its SSE reader/parser gets zero events back. That left
// `this.logs[placeId]` stuck on the id-less optimistic placeholder chat.js
// pushed for the user's own line — un-deletable/un-editable (both require
// a real id) until the user left and re-entered the place. Mirrors the
// main round's own ack/done SSE shape either way, so both response modes
// behave identically here too.
async function respondAfterSilentBranch({ res, w, placeId, signal, cfg, runBranch }) {
  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log: loadChatLog(w.chatDir, placeId) });
    await runBranch();
    if (!signal.aborted) send({ type: 'done', log: loadChatLog(w.chatDir, placeId) });
    res.end();
    return;
  }
  await runBranch();
  if (!signal.aborted) res.json({ log: loadChatLog(w.chatDir, placeId) });
}

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
  appendPlaceChatEntries(w, placeId, turnEntries);
  logger.info('chat', `say @ ${place.name}: ${charIds.length} character(s) present, ${activeIds.length} active`);
  maybeSendProactiveTexts(w, charIds);

  const signal = requestCancelSignal(req, res);
  const cfg = loadConfig();

  if (!charIds.length) {
    await respondAfterSilentBranch({
      res, w, placeId, signal, cfg, runBranch: () => narrateEmptyPlaceOrEcho({ w, placeId, place, signal }),
    });
    return;
  }

  if (!activeIds.length) {
    await respondAfterSilentBranch({
      res, w, placeId, signal, cfg,
      runBranch: () => recordSilentRound({ w, placeId, place, presentIds: charIds, charactersById, turnEntries, signal }),
    });
    return;
  }

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
      turnEntriesSoFar: turnEntries, onEvent: send, signal,
    });
    // A cancelled round isn't a failure worth alarming the user over — the
    // frontend checks `cancelled` to skip its usual error banner for this case.
    if (!signal.aborted) {
      send({ type: 'done', log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
    }
    return res.end();
  }

  const result = await runReactionRound({
    w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById, turnEntriesSoFar: turnEntries, signal,
  });
  if (!signal.aborted) {
    res.json({ log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
  }
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

  const signal = requestCancelSignal(req, res);
  const cfg = loadConfig();
  const turnEntriesSoFar = [log[lastUserIdx]];

  if (!charIds.length) {
    await respondAfterSilentBranch({
      res, w, placeId, signal, cfg, runBranch: () => narrateEmptyPlaceOrEcho({ w, placeId, place, signal }),
    });
    return;
  }

  if (!activeIds.length) {
    await respondAfterSilentBranch({
      res, w, placeId, signal, cfg,
      runBranch: () => recordSilentRound({ w, placeId, place, presentIds: charIds, charactersById, turnEntries: turnEntriesSoFar, signal }),
    });
    return;
  }

  if (cfg.streaming && cfg.apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'ack', log });

    const result = await runReactionRound({
      w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById, turnEntriesSoFar, onEvent: send, signal,
    });
    if (!signal.aborted) {
      send({ type: 'done', log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
    }
    return res.end();
  }

  const result = await runReactionRound({
    w, placeId, place, reactIds: activeIds, presentIds: charIds, charactersById, turnEntriesSoFar, signal,
  });
  if (!signal.aborted) {
    res.json({ log: loadChatLog(w.chatDir, placeId), ...(result.error ? { error: result.error, cancelled: result.cancelled } : {}) });
  }
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

  const signal = requestCancelSignal(req, res);

  const result = await generateCharacterTurn({
    w, cfg, place, speakerId: target.charId, presentIds, charactersById,
    log: log.slice(0, idx), onEvent: send, backgroundIds, signal,
  });
  if (result.error) {
    if (signal.aborted) return res.end();
    if (send) { send({ type: 'done', log, error: result.error, cancelled: result.cancelled }); return res.end(); }
    return res.status(502).json({ error: result.error });
  }

  result.entries.forEach((e) => { if (!e.id) e.id = crypto.randomUUID(); });

  // Re-load and re-locate the target entry rather than reusing the `log`/`idx`
  // captured before the awaited generation above — a concurrent request (a new
  // message, another edit/delete) could have appended to or changed this same
  // place's log during that window, and splicing into the stale array would
  // silently discard whatever it added.
  const freshLog = loadChatLog(w.chatDir, placeId);
  const freshIdx = freshLog.findIndex((e) => e.id === entryId);
  if (freshIdx === -1) {
    const err = 'This message no longer exists — it may have been deleted while the reply was generating.';
    if (send) { send({ type: 'done', log: freshLog, error: err }); return res.end(); }
    return res.status(409).json({ error: err });
  }
  freshLog.splice(freshIdx, 1, ...result.entries);
  savePlaceChatLog(w, placeId, freshLog);
  logger.info('chat', `regenerated message ${entryId} @ ${place.name}`);

  await attachEntriesToMemories({
    db: w.db, embedFn: embed, memoryIds,
    newEntryIds: result.entries.map((e) => e.id),
    log: freshLog, userLabel, formatEntry: formatLogEntry,
  }).catch((err) => logger.error('memory', `regen memory sync failed: ${err.message}`));

  if (send) {
    send({ type: 'turn', entries: result.entries });
    send({ type: 'done', log: freshLog });
    return res.end();
  }
  res.json({ log: freshLog });
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
  savePlaceChatLog(w, placeId, log);
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
  savePlaceChatLog(w, placeId, log);
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
  const HOST = process.env.HOST || "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`Freeroam backend running at http://localhost:${PORT}`);
  });
}

export { app, registry };
