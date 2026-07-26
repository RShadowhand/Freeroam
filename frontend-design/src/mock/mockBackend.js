// A complete in-browser mock of backend/server.js's API surface, so this
// copy of the frontend runs standalone in `vite dev` with zero network
// dependency — every route the real app calls (see the grep across
// frontend/src/api/*.js this was built from) is answered here, in memory,
// reset on every page reload. This is for VISUAL/STRUCTURAL design work,
// not functional testing — writes persist only for the current tab session,
// "AI" replies are canned text, not real generations, and several edge-case
// routes (PNG/zip export, embedding rebuilds, memory/relationship debug
// queries) are simple no-op-ish stubs rather than full simulations.
//
// Import this file FIRST in main.js, before any store/router code runs —
// it patches window.fetch as a side effect at import time.

let nextId = 1;
const uid = (prefix = 'id') => `${prefix}-${nextId++}`;

// ---- Seed data (same demo cast/places used throughout this app's own
// design mockups, so this feels like the familiar starting point) ----------
const CHAR_EZRA = 'ezra', CHAR_MIREILLE = 'mireille', CHAR_SOOT = 'soot', CHAR_CUSTODIAN = 'custodian';

const state = {
  settings: {
    hasKey: false, model: 'anthropic/claude-3.5-sonnet', apiBase: 'https://openrouter.ai/api/v1',
    streaming: true, reasoning: 'off', providers: [],
    memoryMinScore: 0.35, suggestedActionsMode: 'regex',
    embeddingModel: 'Xenova/bge-small-en-v1.5', embeddingsStale: false,
    narratorEnabled: true,
    textingPromptTemplate: "You are texting, not narrating a scene. Reply the way a real person texts: short, casual lines of dialogue only.",
    textingPromptTemplateIsCustom: false, textingTypingIndicator: true,
    cascadeBaseChance: 0.85, cascadeDecayRate: 0.98, cascadePerCharacterCap: 2, textingChancePerChar: 0.002,
    draftPersonaPrompt: 'You are a character-sheet writing assistant...', draftPersonaPromptIsCustom: false,
  },

  characters: [
    { id: CHAR_EZRA, name: 'Ezra Vane', description: "Ezra Vane, the neighborhood's unofficial archivist. Precise, dry-witted, quietly lonely.", personality: 'Formal, quietly curious.', scenario: '', exampleDialogue: '', greetings: ['Ah. A visitor.'], schedule: {}, source: 'builtin', avatarUrl: null, color: 'hsl(35, 65%, 62%)' },
    { id: CHAR_MIREILLE, name: 'Mireille', description: "A gentle, slightly otherworldly gardener who tends the greenhouse like it's the only season that matters.", personality: 'Wistful and kind.', scenario: '', exampleDialogue: '', greetings: ['The ferns told me you were coming, traveler.'], schedule: {}, source: 'builtin', avatarUrl: null, color: 'hsl(150, 22%, 62%)' },
    { id: CHAR_SOOT, name: 'Soot', description: 'A cat who has claimed a whole alley as his personal territory and tolerates visitors on his own terms.', personality: 'Aloof, occasionally affectionate.', scenario: '', exampleDialogue: '', greetings: [], schedule: {}, source: 'builtin', avatarUrl: null, color: 'hsl(265, 22%, 62%)' },
    { id: CHAR_CUSTODIAN, name: 'Custodian', description: "The neighborhood's clockwork repairer, rarely seen without a tool in hand.", personality: 'Quiet, meticulous.', scenario: '', exampleDialogue: '', greetings: [], schedule: {}, source: 'builtin', avatarUrl: null, color: 'hsl(345, 40%, 58%)' },
  ],

  personas: {
    personas: [{ id: 'kael', name: 'Kael', description: 'A quiet wanderer who names stray cats.', avatarUrl: null, color: 'hsl(210, 30%, 58%)' }],
    activePersonaId: 'kael',
  },

  places: [
    { id: 'town-square', name: 'Town Square', desc: 'The open square where every path in the neighborhood eventually crosses.', type: 'communal', ownerIds: [], area: 'Downtown' },
    { id: 'archive-house', name: 'The Archive House', desc: 'A public reading room, shelves stacked floor to ceiling with old records.', type: 'communal', ownerIds: [], area: 'Downtown' },
    { id: 'ezras-apartment', name: "Ezra's Apartment", desc: 'A cramped, meticulously organized apartment above the Archive House.', type: 'private', ownerIds: [CHAR_EZRA], area: 'Downtown' },
    { id: 'greenhouse-park', name: 'The Greenhouse', desc: 'A public greenhouse gone half-wild.', type: 'communal', ownerIds: [], area: 'Garden District' },
    { id: 'mireilles-cottage', name: "Mireille's Cottage", desc: 'A small cottage tucked just behind the greenhouse ferns.', type: 'private', ownerIds: [CHAR_MIREILLE], area: 'Garden District' },
    { id: 'soots-alley', name: "Soot's Alley", desc: 'A narrow alley one particular cat has claimed as entirely his own.', type: 'private', ownerIds: [CHAR_SOOT], area: 'Garden District' },
    { id: 'old-ballroom', name: 'The Old Ballroom', desc: 'A dusty, disused hall that still hosts the occasional gathering.', type: 'communal', ownerIds: [], area: 'Uptown' },
    { id: 'clocktower-roof', name: 'The Clocktower Roof', desc: "A rooftop lookout beside the neighborhood's old, stopped clocktower.", type: 'communal', ownerIds: [], area: 'Uptown' },
    { id: 'custodians-workshop', name: "The Custodian's Workshop", desc: "A locked workshop where the neighborhood's clockwork gets quietly repaired.", type: 'private', ownerIds: [CHAR_CUSTODIAN], area: 'Uptown' },
  ],

  world: {
    placements: {
      [CHAR_EZRA]: { placeId: 'town-square', greetingIndex: 0 },
      [CHAR_MIREILLE]: { placeId: 'town-square', greetingIndex: 0 },
      [CHAR_SOOT]: { placeId: 'soots-alley', greetingIndex: null },
      [CHAR_CUSTODIAN]: { placeId: 'custodians-workshop', greetingIndex: null },
    },
    time: { day: 1, timeOfDay: 'noon' },
    setting: 'A quiet neighborhood where the seasons argue with each other.',
  },

  weather: {
    Downtown: { mode: 'auto', condition: 'clear' },
    'Garden District': { mode: 'auto', condition: 'overcast' },
    Uptown: { mode: 'auto', condition: 'clear' },
  },

  chats: {
    'town-square': [
      { id: uid('e'), type: 'system', text: 'You arrive at Town Square.' },
      { id: uid('e'), type: 'char', charId: CHAR_EZRA, name: 'Ezra Vane', text: "Ah. You're late by the clocktower's reckoning, though I confess the clocktower has opinions of its own about time." },
      { id: uid('e'), type: 'char', charId: CHAR_MIREILLE, name: 'Mireille', text: '"The ferns told me you were coming, traveler." "They\'re usually right about these things."' },
    ],
  },
  texts: {
    [CHAR_MIREILLE]: [{ id: uid('e'), type: 'char', name: 'Mireille', text: 'the greenhouse misses you' }],
    [CHAR_SOOT]: [
      { id: uid('e'), type: 'char', name: 'Soot', text: 'meow' },
      { id: uid('e'), type: 'char', name: 'Soot', text: '(this was a picture of a dead bird)' },
    ],
  },

  groups: [{ id: 'family-group', name: 'Family Group Chat', participantIds: [CHAR_EZRA, CHAR_MIREILLE], createdAt: new Date().toISOString() }],
  groupLogs: {
    'family-group': [
      { id: uid('e'), type: 'user', text: 'Hey everyone!' },
      { id: uid('e'), type: 'char', charId: CHAR_MIREILLE, name: 'Mireille', text: 'omg finally!! 🎉' },
    ],
  },

  calls: {},

  presets: {
    presets: [{
      id: 'default', name: 'Default', contextLength: 8192, maxReplyTokens: 1000,
      prompts: [
        { identifier: 'worldInfo', name: 'World Info', role: 'system', content: '', marker: true, enabled: true },
        { identifier: 'charDescription', name: 'Character Description', role: 'system', content: '', marker: true, enabled: true },
        { identifier: 'personality', name: 'Personality', role: 'system', content: '', marker: true, enabled: true },
      ],
    }],
    activePresetId: 'default',
  },
  standardBlocks: [
    { identifier: 'worldInfo', name: 'World Info', marker: true },
    { identifier: 'charDescription', name: 'Character Description', marker: true },
    { identifier: 'personality', name: 'Personality', marker: true },
    { identifier: 'scenario', name: 'Scenario', marker: true },
    { identifier: 'dialogueExamples', name: 'Example Dialogue', marker: true },
  ],

  worldsRegistry: {
    worlds: [{ id: 'mock-world-1', name: 'My World', createdAt: new Date().toISOString(), lastPlayedAt: new Date().toISOString() }],
    defaultWorldId: 'mock-world-1',
  },

  memories: {}, // characterId -> [{id, text, day, timeOfDay, placeId}]
  relationships: [], // [{characterId, targetId, labels: []}]
};

// Every character id that has ever spoken (a type:'char' entry) in any
// place's chat log — mirrors backend/server.js's metCharacterIds(), computed
// live off state.chats rather than cached, so a character who speaks for
// the first time during this session immediately becomes a Phone contact.
function computeMetCharacterIds() {
  const ids = new Set();
  for (const log of Object.values(state.chats)) {
    for (const entry of log) { if (entry.type === 'char' && entry.charId) ids.add(entry.charId); }
  }
  return [...ids];
}

const CANNED_LINES = [
  'That\'s an interesting thought.',
  '*tilts head slightly* Go on.',
  'I hadn\'t considered it that way before.',
  'Mm. Tell me more.',
  '*pauses* I\'m not sure how to answer that.',
  'Fair enough.',
];
function cannedReply() { return CANNED_LINES[Math.floor(Math.random() * CANNED_LINES.length)]; }
function charName(id) { return state.characters.find((c) => c.id === id)?.name || id; }

// ---- tiny response helpers -------------------------------------------
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function noContent(status = 200) { return json({ ok: true }, status); }
function notFound(message = 'Not found.') { return json({ error: message }, 404); }
function badRequest(message = 'Bad request.') { return json({ error: message }, 400); }
function blobResponse(blob, filename, contentType) {
  return new Response(blob, { status: 200, headers: { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"` } });
}

// SSE stream matching the real backend's `data: {...}\n\n` event format
// (ack/speaker/delta/turn/done) — see backend/server.js's send() helpers.
function sseResponse(buildEvents) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      await buildEvents(send, (ms) => new Promise((r) => setTimeout(r, ms)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function appendEntry(log, entry) {
  const withId = { id: uid('e'), ...entry };
  log.push(withId);
  return withId;
}

// ---- route table --------------------------------------------------------
// { method, pattern, handler(params, req) } — pattern uses :name segments,
// matched against the URL pathname only (query string parsed separately).
const routes = [];
function on(method, pattern, handler) { routes.push({ method, pattern, handler }); }

function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  return { re, keys };
}
const compiled = new Map();
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (!compiled.has(r)) compiled.set(r, compile(r.pattern));
    const { re, keys } = compiled.get(r);
    const m = pathname.match(re);
    if (m) {
      const params = {};
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
  }
  return null;
}

// ---- Settings ----
on('GET', '/api/settings', () => json(state.settings));
on('POST', '/api/settings', (_p, req) => { Object.assign(state.settings, req.body); return json(state.settings); });
on('POST', '/api/settings/clear-key', () => { state.settings.hasKey = false; return json(state.settings); });
on('POST', '/api/settings/rebuild-embeddings', () => { state.settings.embeddingsStale = false; return json({ memories: 0, relationships: 0, characters: state.characters.length, model: state.settings.embeddingModel }); });
on('GET', '/api/models', () => json({ models: [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
  { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
  { id: 'google/gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash', context_length: 1000000, pricing: { prompt: '0', completion: '0' } },
] }));
on('GET', '/api/models/providers', () => json({ providers: [{ name: 'Anthropic', pricing: { completion: '0.000015' } }] }));
on('POST', '/api/chat', () => json({ choices: [{ message: { content: 'Test received — mock backend is working.' } }] }));

// ---- Weather ----
on('GET', '/api/weather', () => json({ weather: state.weather, areas: Object.keys(state.weather), conditions: ['clear', 'overcast', 'rain', 'fog', 'storm'] }));
on('POST', '/api/weather/:area', (p, req) => {
  state.weather[p.area] = req.body.mode === 'auto' ? { mode: 'auto', condition: state.weather[p.area]?.condition || 'clear' } : { mode: 'manual', condition: req.body.condition };
  return json({ weather: state.weather });
});

// ---- World (single active-world state: placements/time/setting) ----
on('GET', '/api/world', () => json({
  places: state.places, placements: state.world.placements, time: state.world.time, setting: state.world.setting,
  metCharacterIds: computeMetCharacterIds(),
}));
on('POST', '/api/world/setting', (_p, req) => { state.world.setting = req.body.setting || ''; return json(state.world); });
on('POST', '/api/world/time', (_p, req) => { Object.assign(state.world.time, req.body); return json(state.world); });
on('POST', '/api/world/randomize', () => {
  const placeIds = state.places.map((p) => p.id);
  state.characters.forEach((c) => { state.world.placements[c.id] = { placeId: placeIds[Math.floor(Math.random() * placeIds.length)], greetingIndex: null }; });
  return json({ placements: state.world.placements });
});

// ---- Worlds (save slots) ----
on('GET', '/api/worlds', () => json(state.worldsRegistry));
on('POST', '/api/worlds', (_p, req) => {
  const w = { id: uid('world'), name: (req.body.name || 'New World').trim(), createdAt: new Date().toISOString(), lastPlayedAt: new Date().toISOString() };
  state.worldsRegistry.worlds.push(w);
  return json({ world: w }, 201);
});
on('PUT', '/api/worlds/:id', (p, req) => {
  const w = state.worldsRegistry.worlds.find((x) => x.id === p.id);
  if (!w) return notFound('Unknown world id.');
  if (req.body.name) w.name = req.body.name.trim();
  return json({ world: w });
});
on('DELETE', '/api/worlds/:id', (p) => {
  if (state.worldsRegistry.worlds.length <= 1) return badRequest('Cannot delete the only world.');
  state.worldsRegistry.worlds = state.worldsRegistry.worlds.filter((w) => w.id !== p.id);
  if (state.worldsRegistry.defaultWorldId === p.id) state.worldsRegistry.defaultWorldId = state.worldsRegistry.worlds[0].id;
  return json({ ok: true, defaultWorldId: state.worldsRegistry.defaultWorldId });
});
on('POST', '/api/worlds/:id/duplicate', (p, req) => {
  const src = state.worldsRegistry.worlds.find((x) => x.id === p.id);
  const w = { id: uid('world'), name: req.body.name || `${src?.name || 'World'} (copy)`, createdAt: new Date().toISOString(), lastPlayedAt: new Date().toISOString() };
  state.worldsRegistry.worlds.push(w);
  return json({ world: w }, 201);
});
on('POST', '/api/worlds/:id/export', () => blobResponse(new Blob(['mock world bundle']), 'world.zip', 'application/zip'));
on('POST', '/api/worlds/import', (_p, req) => {
  const w = { id: uid('world'), name: req.formFields?.get('name') || 'Imported World', createdAt: new Date().toISOString(), lastPlayedAt: new Date().toISOString() };
  state.worldsRegistry.worlds.push(w);
  return json({ world: w, warnings: [] }, 201);
});

// ---- Characters ----
on('GET', '/api/characters', () => json({ characters: state.characters }));
on('POST', '/api/characters', (_p, req) => {
  const c = { id: uid('char'), name: (req.body.name || 'New Character').trim(), description: req.body.description || '', personality: req.body.personality || '', scenario: req.body.scenario || '', exampleDialogue: req.body.exampleDialogue || '', greetings: [], schedule: {}, source: req.isForm ? 'upload' : 'npc', avatarUrl: null, color: `hsl(${Math.floor(Math.random() * 360)}, 55%, 62%)` };
  state.characters.push(c);
  return json({ character: c }, 201);
});
on('PUT', '/api/characters/:id', (p, req) => {
  const c = state.characters.find((x) => x.id === p.id);
  if (!c) return notFound('Character not found.');
  if (req.isForm) {
    const name = req.formFields.get('name');
    if (name) c.name = name;
    if (req.formFields.has('description')) c.description = req.formFields.get('description');
    if (req.formFields.has('personality')) c.personality = req.formFields.get('personality');
    if (req.formFields.has('scenario')) c.scenario = req.formFields.get('scenario');
    if (req.formFields.has('exampleDialogue')) c.exampleDialogue = req.formFields.get('exampleDialogue');
    const avatar = req.formFields.get('avatar');
    if (avatar && avatar.size) c.avatarUrl = URL.createObjectURL(avatar);
  } else {
    Object.assign(c, req.body);
  }
  return json({ character: c });
});
on('DELETE', '/api/characters/:id', (p) => {
  state.characters = state.characters.filter((c) => c.id !== p.id);
  delete state.world.placements[p.id];
  state.places.forEach((pl) => { pl.ownerIds = pl.ownerIds.filter((id) => id !== p.id); });
  return noContent();
});
on('POST', '/api/characters/:id/place', (p, req) => {
  state.world.placements[p.id] = { placeId: req.body.placeId, greetingIndex: null };
  return json({ placements: state.world.placements });
});
on('PUT', '/api/characters/:id/schedule/:day/:timeOfDay', (p, req) => {
  const c = state.characters.find((x) => x.id === p.id);
  if (!c) return notFound('Character not found.');
  c.schedule[p.day] = c.schedule[p.day] || {};
  c.schedule[p.day][p.timeOfDay] = { placeId: req.body.placeId, reason: req.body.reason || '' };
  return json({ character: c });
});
on('POST', '/api/characters/draft', () => json({ description: '(mock) A thoughtfully drafted character description would appear here.' }));
on('GET', '/api/characters/:id/export', (p) => {
  const c = state.characters.find((x) => x.id === p.id);
  if (!c) return notFound('Character not found.');
  return json({ characters: [c] });
});
on('GET', '/api/characters/export', () => json({ characters: state.characters }));
on('POST', '/api/characters/import', (_p, req) => {
  const incoming = req.body.characters || [];
  const imported = incoming.map((c) => ({ id: uid('char'), name: c.name || 'Imported', description: c.description || '', personality: c.personality || '', scenario: c.scenario || '', exampleDialogue: c.exampleDialogue || '', greetings: c.greetings || [], schedule: {}, source: 'upload', avatarUrl: null, color: `hsl(${Math.floor(Math.random() * 360)}, 55%, 62%)` }));
  state.characters.push(...imported);
  return json({ characters: imported }, 201);
});
on('GET', '/api/characters/:id/card.png', () => blobResponse(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'character.png', 'image/png'));

// ---- Personas ----
on('GET', '/api/personas', () => json(state.personas));
on('POST', '/api/personas', (_p, req) => {
  const per = { id: uid('persona'), name: req.body.name || 'New Persona', description: req.body.description || '', avatarUrl: null, color: `hsl(${Math.floor(Math.random() * 360)}, 55%, 62%)` };
  state.personas.personas.push(per);
  return json({ persona: per }, 201);
});
on('PUT', '/api/personas/:id', (p, req) => {
  const per = state.personas.personas.find((x) => x.id === p.id);
  if (!per) return notFound('Persona not found.');
  if (req.isForm) {
    const name = req.formFields.get('name');
    if (name) per.name = name;
    if (req.formFields.has('description')) per.description = req.formFields.get('description');
    const avatar = req.formFields.get('avatar');
    if (avatar && avatar.size) per.avatarUrl = URL.createObjectURL(avatar);
  } else {
    if (req.body.name) per.name = req.body.name;
    if (req.body.description !== undefined) per.description = req.body.description;
  }
  return json({ persona: per });
});
on('DELETE', '/api/personas/:id', (p) => {
  state.personas.personas = state.personas.personas.filter((x) => x.id !== p.id);
  if (state.personas.activePersonaId === p.id) state.personas.activePersonaId = null;
  return noContent();
});
on('POST', '/api/personas/active', (_p, req) => { state.personas.activePersonaId = req.body.id || null; return json({ activePersonaId: state.personas.activePersonaId }); });
on('GET', '/api/personas/:id/export', (p) => {
  const per = state.personas.personas.find((x) => x.id === p.id);
  if (!per) return notFound('Persona not found.');
  return json({ personas: [per] });
});
on('GET', '/api/personas/export', () => json({ personas: state.personas.personas }));
on('POST', '/api/personas/import', (_p, req) => {
  const incoming = req.body?.personas || [];
  const imported = incoming.map((per) => ({ id: uid('persona'), name: per.name || 'Imported', description: per.description || '', avatarUrl: null, color: `hsl(${Math.floor(Math.random() * 360)}, 55%, 62%)` }));
  state.personas.personas.push(...imported);
  return json({ personas: imported }, 201);
});
on('GET', '/api/personas/:id/card.png', () => blobResponse(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'persona.png', 'image/png'));

// ---- Places ----
on('GET', '/api/places', () => json({ places: state.places }));
on('POST', '/api/places', (_p, req) => {
  const type = req.body.type === 'private' ? 'private' : 'communal';
  const pl = { id: uid('place'), name: req.body.name, desc: req.body.desc || '', type, ownerIds: type === 'private' ? (req.body.ownerIds || []) : [], area: req.body.area || '' };
  state.places.push(pl);
  return json({ place: pl }, 201);
});
on('PUT', '/api/places/:id', (p, req) => {
  const pl = state.places.find((x) => x.id === p.id);
  if (!pl) return notFound('Place not found.');
  Object.assign(pl, req.body);
  return json({ place: pl });
});
on('DELETE', '/api/places/:id', (p) => { state.places = state.places.filter((x) => x.id !== p.id); return noContent(); });
on('GET', '/api/places/:id/export', (p) => {
  const pl = state.places.find((x) => x.id === p.id);
  if (!pl) return notFound('Place not found.');
  return json({ places: [pl] });
});
on('GET', '/api/places/export', (_p, req) => {
  const area = req.query.get('area');
  return json({ places: area ? state.places.filter((pl) => pl.area === area) : state.places });
});
on('POST', '/api/places/import', (_p, req) => {
  const incoming = req.body?.places || [];
  const imported = incoming.map((pl) => ({ id: uid('place'), name: pl.name || 'Imported place', desc: pl.desc || '', type: pl.type === 'private' ? 'private' : 'communal', ownerIds: [], area: pl.area || '' }));
  state.places.push(...imported);
  return json({ places: imported, warnings: [] }, 201);
});
on('GET', '/api/places/:id/card.png', () => blobResponse(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'place.png', 'image/png'));

// ---- Chat (place-based) ----
function presentIdsAt(placeId) {
  return Object.entries(state.world.placements).filter(([, pl]) => pl && pl.placeId === placeId).map(([cid]) => cid);
}
on('GET', '/api/places/:id/chat', (p) => json({ log: state.chats[p.id] || [], activeCall: state.calls[p.id] || null }));
on('POST', '/api/places/:id/enter', (p) => {
  const place = state.places.find((x) => x.id === p.id);
  const existingLog = state.chats[p.id] || (state.chats[p.id] = []);
  if (existingLog.length > 0) {
    return json({ log: existingLog, returnMarkerPending: true, activeCall: state.calls[p.id] || null });
  }
  appendEntry(existingLog, { type: 'system', text: `You arrive at ${place?.name || p.id}.` });
  presentIdsAt(p.id).forEach((cid) => {
    const placement = state.world.placements[cid];
    const greetings = state.characters.find((c) => c.id === cid)?.greetings || [];
    const idx = placement?.greetingIndex;
    if (idx !== null && idx !== undefined && greetings[idx] !== undefined) {
      appendEntry(existingLog, { type: 'char', charId: cid, name: charName(cid), text: greetings[idx] });
    }
  });
  return json({ log: existingLog, returnMarkerPending: false, activeCall: null });
});
function placeSayHandler({ isRetry }) {
  return (p, req) => {
    if (state.calls[p.id]) return badRequest('A call is in progress here — hang up first.');
    const log = state.chats[p.id] || (state.chats[p.id] = []);
    if (!isRetry) {
      const place = state.places.find((x) => x.id === p.id);
      if (req.body?.announceArrival && log.length > 0) appendEntry(log, { type: 'system', text: `You return to ${place?.name || p.id}.` });
      appendEntry(log, { type: 'user', text: req.body.text });
    }
    const presentIds = presentIdsAt(p.id);
    const replierId = presentIds[Math.floor(Math.random() * presentIds.length)] || CHAR_EZRA;
    const text = cannedReply();
    if (!state.settings.streaming) {
      appendEntry(log, { type: 'char', charId: replierId, name: charName(replierId), text });
      return json({ log });
    }
    return sseResponse(async (send, wait) => {
      send({ type: 'ack', log });
      await wait(300);
      send({ type: 'speaker', charId: replierId, name: charName(replierId) });
      await wait(500);
      send({ type: 'delta', text });
      const entry = appendEntry(log, { type: 'char', charId: replierId, name: charName(replierId), text });
      send({ type: 'turn', entries: [entry] });
      send({ type: 'done', log });
    });
  };
}
on('POST', '/api/places/:id/say', placeSayHandler({ isRetry: false }));
on('POST', '/api/places/:id/retry', placeSayHandler({ isRetry: true }));
on('POST', '/api/places/:id/regenerate', (p, req) => {
  const log = state.chats[p.id] || [];
  const idx = log.findIndex((e) => e.id === req.body.entryId);
  if (idx !== -1) log[idx].text = cannedReply();
  return json({ log });
});
on('PUT', '/api/places/:id/messages/:entryId', (p, req) => {
  const log = state.chats[p.id] || [];
  const entry = log.find((e) => e.id === p.entryId);
  if (!entry) return notFound('Message not found.');
  entry.text = req.body.text;
  return json({ log });
});
on('DELETE', '/api/places/:id/messages/:entryId', (p) => {
  state.chats[p.id] = (state.chats[p.id] || []).filter((e) => e.id !== p.entryId);
  return json({ log: state.chats[p.id] });
});

// ---- Groups (Party Line) ----
on('GET', '/api/groups', () => json({ groups: state.groups }));
on('POST', '/api/groups', (_p, req) => {
  const g = { id: uid('group'), name: req.body.name || 'New Group', participantIds: req.body.participantIds || [], createdAt: new Date().toISOString() };
  state.groups.push(g);
  state.groupLogs[g.id] = [];
  return json({ group: g }, 201);
});
on('GET', '/api/groups/:id', (p) => {
  const g = state.groups.find((x) => x.id === p.id);
  if (!g) return notFound('Group not found.');
  return json({ group: g, log: state.groupLogs[p.id] || [] });
});
on('PUT', '/api/groups/:id', (p, req) => {
  const g = state.groups.find((x) => x.id === p.id);
  if (!g) return notFound('Group not found.');
  Object.assign(g, req.body);
  return json({ group: g });
});
function groupSendHandler() {
  return (p, req) => {
    const log = state.groupLogs[p.id] || (state.groupLogs[p.id] = []);
    if (req.body?.text) appendEntry(log, { type: 'user', text: req.body.text });
    const g = state.groups.find((x) => x.id === p.id);
    const replierId = (g?.participantIds || [])[0] || CHAR_EZRA;
    const text = cannedReply();
    if (!state.settings.streaming) {
      appendEntry(log, { type: 'char', charId: replierId, name: charName(replierId), text });
      return json({ log });
    }
    return sseResponse(async (send, wait) => {
      send({ type: 'ack', log });
      await wait(300);
      send({ type: 'speaker', charId: replierId, name: charName(replierId) });
      await wait(500);
      const entry = appendEntry(log, { type: 'char', charId: replierId, name: charName(replierId), text });
      send({ type: 'turn', entries: [entry] });
      send({ type: 'done', log });
    });
  };
}
on('POST', '/api/groups/:id/send', groupSendHandler());
on('POST', '/api/groups/:id/retry', groupSendHandler());
on('DELETE', '/api/groups/:id', (p) => { state.groups = state.groups.filter((g) => g.id !== p.id); delete state.groupLogs[p.id]; return noContent(); });
on('DELETE', '/api/groups/:id/messages/:entryId', (p) => {
  state.groupLogs[p.id] = (state.groupLogs[p.id] || []).filter((e) => e.id !== p.entryId);
  return json({ log: state.groupLogs[p.id] });
});

// ---- Texts (TypeCast, 1-on-1) ----
// /api/texts/unread must be registered before the :characterId catch-all
// below, since matchRoute takes the first pattern match in registration
// order and "unread" would otherwise be captured as a characterId.
on('GET', '/api/texts/unread', () => json({ count: 0 }));
on('GET', '/api/texts/:characterId', (p) => json({ log: state.texts[p.characterId] || [] }));
function textSendHandler() {
  return (p, req) => {
    const log = state.texts[p.characterId] || (state.texts[p.characterId] = []);
    if (req.body?.text) appendEntry(log, { type: 'user', text: req.body.text });
    const text = cannedReply();
    if (!state.settings.streaming) {
      appendEntry(log, { type: 'char', name: charName(p.characterId), text });
      return json({ log });
    }
    return sseResponse(async (send, wait) => {
      send({ type: 'ack', log });
      await wait(300);
      send({ type: 'speaker', charId: p.characterId, name: charName(p.characterId) });
      await wait(500);
      const entry = appendEntry(log, { type: 'char', name: charName(p.characterId), text });
      send({ type: 'turn', entries: [entry] });
      send({ type: 'done', log });
    });
  };
}
on('POST', '/api/texts/:characterId/send', textSendHandler());
on('POST', '/api/texts/:characterId/retry', textSendHandler());
on('DELETE', '/api/texts/:characterId/messages/:entryId', (p) => {
  state.texts[p.characterId] = (state.texts[p.characterId] || []).filter((e) => e.id !== p.entryId);
  return json({ log: state.texts[p.characterId] });
});
on('POST', '/api/texts/:characterId/trigger', (p) => {
  const log = state.texts[p.characterId] || (state.texts[p.characterId] = []);
  appendEntry(log, { type: 'char', name: charName(p.characterId), text: cannedReply() });
  return json({ log });
});

// ---- Calls (Wavelength) ----
// A call's back-and-forth actually lives in the calling PLACE's chat log
// (tagged call:true), same as the real backend — the caller reads
// chat.logs[placeId] for both a normal scene and mid-call, so the mock has
// to append here rather than keep a separate per-call transcript.
on('POST', '/api/calls/:characterId/start', (p, req) => {
  const { placeId } = req.body;
  const log = state.chats[placeId] || (state.chats[placeId] = []);
  state.calls[placeId] = { charId: p.characterId, name: charName(p.characterId) };
  appendEntry(log, { type: 'system', text: `\u{1F4DE} You call ${charName(p.characterId)}.`, call: true });
  return json({ log, placements: state.world.placements, callee: { id: p.characterId, name: charName(p.characterId) } });
});
on('POST', '/api/calls/:characterId/say', (p, req) => {
  const { placeId, text } = req.body;
  const log = state.chats[placeId] || (state.chats[placeId] = []);
  if (text) appendEntry(log, { type: 'user', text, call: true });
  const replyText = cannedReply();
  return sseResponse(async (send, wait) => {
    send({ type: 'ack', log });
    await wait(300);
    send({ type: 'speaker', charId: p.characterId, name: charName(p.characterId) });
    await wait(500);
    const entry = appendEntry(log, { type: 'char', charId: p.characterId, name: charName(p.characterId), text: replyText, call: true });
    send({ type: 'turn', entries: [entry] });
    send({ type: 'done', log });
  });
});
on('POST', '/api/calls/:characterId/end', (p, req) => {
  const { placeId } = req.body;
  const log = state.chats[placeId] || (state.chats[placeId] = []);
  delete state.calls[placeId];
  appendEntry(log, { type: 'system', text: `\u{1F4DE} Call with ${charName(p.characterId)} ended.`, call: true });
  return json({ log, placements: state.world.placements });
});

// ---- Memory ----
on('GET', '/api/memory/:characterId', (p, req) => {
  const memories = state.memories[p.characterId] || [];
  const limit = Number(req.query.get('limit')) || 50;
  const offset = Number(req.query.get('offset')) || 0;
  return json({ memories: memories.slice(offset, offset + limit), total: memories.length, limit, offset });
});
on('POST', '/api/memory/:characterId', (p, req) => {
  const list = state.memories[p.characterId] || (state.memories[p.characterId] = []);
  const m = { id: uid('mem'), text: req.body.text || '', day: state.world.time.day, timeOfDay: state.world.time.timeOfDay };
  list.push(m);
  return json({ memory: m }, 201);
});
on('PUT', '/api/memory/:characterId/:entryId', (p, req) => {
  const m = (state.memories[p.characterId] || []).find((x) => x.id === p.entryId);
  if (!m) return notFound('Memory not found.');
  m.text = req.body.text;
  return json({ memory: m });
});
on('DELETE', '/api/memory/:characterId/:entryId', (p) => {
  state.memories[p.characterId] = (state.memories[p.characterId] || []).filter((x) => x.id !== p.entryId);
  return noContent();
});
on('POST', '/api/memory/:characterId/query', () => json({ results: [] }));

// ---- Relationships ----
on('GET', '/api/relationships', () => json({ relationships: state.relationships }));
on('PUT', '/api/relationships/:characterId/:targetId', (p, req) => {
  const labels = req.body.labels || [];
  state.relationships = state.relationships.filter((x) => !(x.characterId === p.characterId && x.targetId === p.targetId));
  if (!labels.length) return json({ ok: true, removed: true });
  state.relationships.push({ characterId: p.characterId, targetId: p.targetId, labels });
  return json({ ok: true, labels });
});
on('POST', '/api/relationships/:characterId/query', () => json({ results: [] }));

// ---- Presets ----
on('GET', '/api/presets', () => json(state.presets));
on('GET', '/api/prompts/standard-blocks', () => json({ blocks: state.standardBlocks }));
on('POST', '/api/presets', (_p, req) => {
  const preset = { id: uid('preset'), name: req.body.name || 'New Preset', contextLength: req.body.contextLength || 8192, maxReplyTokens: req.body.maxReplyTokens || 1000, prompts: req.body.prompts || [] };
  state.presets.presets.push(preset);
  return json({ preset }, 201);
});
on('PUT', '/api/presets/:id', (p, req) => {
  const preset = state.presets.presets.find((x) => x.id === p.id);
  if (!preset) return notFound('Preset not found.');
  Object.assign(preset, req.body);
  return json({ preset });
});
on('DELETE', '/api/presets/:id', (p) => { state.presets.presets = state.presets.presets.filter((x) => x.id !== p.id); return noContent(); });
on('POST', '/api/presets/active', (_p, req) => { state.presets.activePresetId = req.body.id || null; return json({ activePresetId: state.presets.activePresetId }); });
on('POST', '/api/presets/import', (_p, req) => {
  const preset = { id: uid('preset'), name: req.body.fallbackName || 'Imported Preset', contextLength: 8192, maxReplyTokens: 1000, prompts: [] };
  return json({ preset }, 201);
});
on('POST', '/api/presets/export', (_p, req) => json(req.body));

// ---- fetch monkey-patch --------------------------------------------------
const realFetch = window.fetch.bind(window);
window.fetch = async function mockFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);

  const [pathname, queryString] = url.split('?');
  const query = new URLSearchParams(queryString || '');
  const method = (init.method || 'GET').toUpperCase();
  const match = matchRoute(method, pathname);
  if (!match) {
    console.warn('[mockBackend] Unhandled route:', method, pathname);
    return json({ error: `(mock) No handler for ${method} ${pathname}` }, 501);
  }

  let body = {};
  let isForm = false;
  let formFields = null;
  if (init.body) {
    if (init.body instanceof FormData) {
      isForm = true;
      formFields = init.body;
    } else if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { /* not JSON */ }
    }
  }

  // Small artificial latency so loading states are visible, like a real request.
  await new Promise((r) => setTimeout(r, 60));
  try {
    return await match.handler(match.params, { body, query, isForm, formFields });
  } catch (err) {
    console.error('[mockBackend] handler error:', method, pathname, err);
    return json({ error: `(mock) ${err.message}` }, 500);
  }
};

console.info('[mockBackend] Active — every /api/* request is answered in-browser, no real backend involved.');
