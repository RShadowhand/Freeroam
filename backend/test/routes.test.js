// Real HTTP-level tests for the routes added in this session (NPC/manual
// character creation, persona-drafting, and memory record/retrieve). The
// app is pointed at a disposable temp directory (FREEROAM_TEST_ROOT) so
// this suite never touches the real backend/data or config.json — no real
// OpenRouter key or spend involved. Memory record/retrieve exercise the
// real local embedding model (free, no network per call after the model's
// cached — see embeddings.test.js); the OpenRouter-backed draft route is
// only tested up through its validation paths, since exercising a real
// completion would need a real API key and cost real money.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app, db, server, baseUrl, tmpRoot;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-test-'));
  process.env.FREEROAM_TEST_ROOT = tmpRoot;
  ({ app, db } = await import('../server.js'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close(); // release the SQLite lock so the temp dir can be removed on Windows
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function postJson(urlPath, body) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/characters (manual/NPC creation)', () => {
  test('creates a character from name+persona JSON, no card', async () => {
    const res = await postJson('/api/characters', { name: 'A Mysterious Stranger', description: 'Wears a long coat and says little.' });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.character.name, 'A Mysterious Stranger');
    assert.equal(data.character.description, 'Wears a long coat and says little.');
    assert.equal(data.character.source, 'npc');
    assert.equal(data.character.avatarUrl, null);
    assert.deepEqual(data.character.greetings, []);
  });

  test('rejects a missing name', async () => {
    const res = await postJson('/api/characters', { description: 'No name given.' });
    assert.equal(res.status, 400);
  });

  test('trims whitespace from name and persona', async () => {
    const res = await postJson('/api/characters', { name: '  Padded Name  ', description: '  padded persona  ' });
    const data = await res.json();
    assert.equal(data.character.name, 'Padded Name');
    assert.equal(data.character.description, 'padded persona');
  });

  test('deleting an NPC character also cleans up its memories (now SQLite-backed)', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Temp NPC', description: 'For deletion test.' })).json();

    await postJson('/api/memory/record', {
      text: 'Visitor: Hi.\nTemp NPC: Hello.',
      placeId: 'town-square',
      personaId: null,
      characterIds: [character.id],
    });
    assert.equal((await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json()).memories.length, 1);

    await fetch(`${baseUrl}/api/characters/${character.id}`, { method: 'DELETE' });
    assert.deepEqual((await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json()).memories, []);
  });

  test('PUT /api/characters/:id edits name and persona', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Editable', description: 'Old persona.' })).json();
    const res = await fetch(`${baseUrl}/api/characters/${character.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', description: 'New persona.' }),
    });
    assert.equal(res.status, 200);
    const { character: updated } = await res.json();
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.description, 'New persona.');

    const missing = await fetch(`${baseUrl}/api/characters/does-not-exist`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }),
    });
    assert.equal(missing.status, 404);
  });

  test('stores personality/scenario/exampleDialogue as separate fields, trimmed', async () => {
    const res = await postJson('/api/characters', {
      name: 'Structured Sam',
      description: '  A gardener.  ',
      personality: '  Gentle, dreamy.  ',
      scenario: '  Mid-harvest.  ',
      exampleDialogue: '  "The roses are listening," she said.  ',
    });
    const { character } = await res.json();
    assert.equal(character.description, 'A gardener.');
    assert.equal(character.personality, 'Gentle, dreamy.');
    assert.equal(character.scenario, 'Mid-harvest.');
    assert.equal(character.exampleDialogue, '"The roses are listening," she said.');
  });

  test('PUT edits personality/scenario/exampleDialogue independently, leaving other fields untouched', async () => {
    const { character } = await (await postJson('/api/characters', {
      name: 'Edit Fields', description: 'Original description.', personality: 'Original personality.',
    })).json();

    const res = await fetch(`${baseUrl}/api/characters/${character.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'New scenario.', exampleDialogue: 'New example.' }),
    });
    const { character: updated } = await res.json();
    assert.equal(updated.description, 'Original description.'); // untouched
    assert.equal(updated.personality, 'Original personality.'); // untouched
    assert.equal(updated.scenario, 'New scenario.');
    assert.equal(updated.exampleDialogue, 'New example.');
  });

  test('built-in characters are migrated to the structured shape on read — no leftover "persona" field', async () => {
    const res = await fetch(`${baseUrl}/api/characters`);
    const { characters } = await res.json();
    const ezra = characters.find((c) => c.id === 'ezra');
    assert.ok(ezra);
    assert.ok(ezra.description.includes('archivist'));
    assert.equal('persona' in ezra, false);
  });
});

describe('GET /api/prompts/standard-blocks', () => {
  test('returns the standard block catalog with the expected marker identifiers', async () => {
    const res = await fetch(`${baseUrl}/api/prompts/standard-blocks`);
    assert.equal(res.status, 200);
    const { blocks } = await res.json();
    const identifiers = blocks.map((b) => b.identifier);
    for (const id of ['charDescription', 'charPersonality', 'charScenario', 'dialogueExamples', 'scenario', 'worldInfoBefore', 'personaDescription', 'characterMemory']) {
      assert.ok(identifiers.includes(id), `missing ${id}`);
    }
    const main = blocks.find((b) => b.identifier === 'main');
    assert.equal(main.marker, false);
    assert.ok(main.defaultContent.length > 0);
    const markerEntry = blocks.find((b) => b.identifier === 'charDescription');
    assert.equal(markerEntry.marker, true);
  });
});

describe('POST /api/memory/record + /api/memory/retrieve', () => {
  test('records and retrieves a relevant memory over an unrelated one', async () => {
    const { character: ezra } = await (await postJson('/api/characters', { name: 'Ezra Vane', description: 'Archivist.' })).json();

    await postJson('/api/memory/record', {
      text: 'Visitor: Do you keep records of everyone who visits?\nEzra Vane: Meticulously. Every arrival, logged.',
      placeId: 'archive-house',
      personaId: 'persona-1',
      characterIds: [ezra.id],
    });
    await postJson('/api/memory/record', {
      text: 'Visitor: Nice weather today.\nEzra Vane: I suppose so.',
      placeId: 'archive-house',
      personaId: 'persona-1',
      characterIds: [ezra.id],
    });

    const res = await postJson('/api/memory/retrieve', {
      query: 'Do you remember what records you keep of visitors?',
      personaId: 'persona-1',
      characterIds: [ezra.id],
      topKPerCharacter: 2,
    });
    assert.equal(res.status, 200);
    const { memories } = await res.json();
    assert.ok(memories.length >= 1);
    assert.ok(memories[0].includes('records'), `expected the records memory to rank first, got: ${memories[0]}`);
  });

  test('memory is global — a memory formed under one persona is still recalled under a different one', async () => {
    const { character: mireille } = await (await postJson('/api/characters', { name: 'Mireille', description: 'Gardener.' })).json();

    await postJson('/api/memory/record', {
      text: 'Visitor: I love the ferns here.\nMireille: They remember you now, traveler.',
      placeId: 'greenhouse-park',
      personaId: 'persona-A',
      characterIds: [mireille.id],
    });

    const res = await postJson('/api/memory/retrieve', {
      query: 'ferns',
      personaId: 'persona-B',
      characterIds: [mireille.id],
    });
    const { memories } = await res.json();
    assert.equal(memories.length, 1);
    assert.ok(memories[0].includes('ferns'));
  });

  test('retrieve returns an empty list for an empty query or no characters', async () => {
    const res1 = await postJson('/api/memory/retrieve', { query: '', characterIds: ['whoever'] });
    assert.deepEqual((await res1.json()).memories, []);

    const res2 = await postJson('/api/memory/retrieve', { query: 'hello', characterIds: [] });
    assert.deepEqual((await res2.json()).memories, []);
  });

  test('record rejects missing text or missing characterIds', async () => {
    const res1 = await postJson('/api/memory/record', { characterIds: ['a'] });
    assert.equal(res1.status, 400);

    const res2 = await postJson('/api/memory/record', { text: 'hi' });
    assert.equal(res2.status, 400);
  });
});

describe('POST /api/characters/draft (validation only — no real OpenRouter call)', () => {
  test('rejects a missing name (checked before the API key, so this is the specific error)', async () => {
    const res = await postJson('/api/characters/draft', { log: [{ type: 'user', text: 'Hi.' }] });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /name/i);
  });

  test('rejects when no API key is configured (fresh test root has none)', async () => {
    const res = await postJson('/api/characters/draft', {
      name: 'A Mysterious Stranger',
      log: [{ type: 'user', text: 'Who are you?' }, { type: 'char', name: 'Stranger', text: 'No one of consequence.' }],
      userLabel: 'Kael',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /API key/i);
  });

  test('a non-array log is handled gracefully (still 400s on the missing API key, not a crash)', async () => {
    const res = await postJson('/api/characters/draft', { name: 'A Mysterious Stranger', log: 'not an array' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /API key/i);
  });
});

describe('POST /api/characters/draft (empty-response handling, real OpenRouter call mocked)', () => {
  // These need an API key configured to get past the earlier 400, and stub
  // out the actual outbound OpenRouter call — restore both afterward so the
  // "no API key configured" tests elsewhere in this file (which rely on a
  // fresh, keyless test root) keep passing.
  const realFetch = globalThis.fetch;

  // postJson (this file's own HTTP client, used to reach the real local
  // test server) also goes through globalThis.fetch, so a mock that faked
  // every call would swallow that traffic too and the request would never
  // reach the Express app at all. Only fake calls that target the
  // OpenRouter completions endpoint; everything else passes through.
  function mockOpenRouterFetch(handler) {
    return async (url, opts) => {
      if (typeof url === 'string' && url.includes('/chat/completions')) return handler(url, opts);
      return realFetch(url, opts);
    };
  }

  before(async () => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
  });
  after(async () => {
    await postJson('/api/settings/clear-key', {});
  });

  test('surfaces an error instead of silently succeeding when the model returns empty content', async (t) => {
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '', reasoning: 'thinking it over at length...' } }],
    }), { status: 200 })));

    const res = await postJson('/api/characters/draft', {
      name: 'A Mysterious Stranger',
      log: [{ type: 'user', text: 'Who are you?' }],
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /empty/i);
  });

  test('returns the description when the model responds normally', async (t) => {
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '  A quiet keeper of the archive, precise in speech.  ' } }],
    }), { status: 200 })));

    const res = await postJson('/api/characters/draft', {
      name: 'A Mysterious Stranger',
      log: [{ type: 'user', text: 'Who are you?' }],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.description, 'A quiet keeper of the archive, precise in speech.');
  });

  test('includes the world setting in the prompt sent to the model', async (t) => {
    await postJson('/api/world/setting', { setting: 'A rain-soaked port city where magic is fading from the world.' });

    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A brief persona.' } }] }), { status: 200 });
    }));

    await postJson('/api/characters/draft', { name: 'A Mysterious Stranger', log: [{ type: 'user', text: 'Who goes there?' }] });
    await postJson('/api/world/setting', { setting: '' }); // restore before later tests

    const userMessage = capturedBody.messages.find((m) => m.role === 'user').content;
    assert.match(userMessage, /rain-soaked port city where magic is fading/);
    assert.match(userMessage, /World Setting/i);
  });

  test('does not add an empty world-setting block when none is configured', async (t) => {
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A brief persona.' } }] }), { status: 200 });
    }));

    await postJson('/api/characters/draft', { name: 'A Mysterious Stranger', log: [{ type: 'user', text: 'Who goes there?' }] });

    const userMessage = capturedBody.messages.find((m) => m.role === 'user').content;
    assert.doesNotMatch(userMessage, /World Setting/i);
  });

  test('gives a reasoning-enabled draft a larger token budget than the plain 300', async (t) => {
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A brief persona.' } }] }), { status: 200 });
    }));

    await postJson('/api/settings', { reasoning: 'medium' });
    await postJson('/api/characters/draft', { name: 'A Mysterious Stranger', log: [] });
    await postJson('/api/settings', { reasoning: 'off' }); // restore before the next test

    assert.ok(capturedBody.max_tokens > 300, `expected a larger budget with reasoning on, got ${capturedBody.max_tokens}`);
  });

  test('a custom draft-persona prompt is sent as the system message, with {{char}}/{{world}} substituted', async (t) => {
    await postJson('/api/settings', {
      draftPersonaPrompt: 'Write a one-line bio for {{char}}. Setting: {{world}}. Keep it under 15 words.',
    });
    await postJson('/api/world/setting', { setting: 'a neon-lit megacity' });

    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A brief persona.' } }] }), { status: 200 });
    }));

    await postJson('/api/characters/draft', { name: 'Reeve Alcatraz', log: [] });

    await postJson('/api/settings', { draftPersonaPrompt: '' }); // restore before later tests
    await postJson('/api/world/setting', { setting: '' });

    const systemMessage = capturedBody.messages.find((m) => m.role === 'system').content;
    assert.equal(systemMessage, 'Write a one-line bio for Reeve Alcatraz. Setting: a neon-lit megacity. Keep it under 15 words.');
  });

  test('falls back to the built-in default prompt when none is configured', async (t) => {
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A brief persona.' } }] }), { status: 200 });
    }));

    await postJson('/api/characters/draft', { name: 'A Mysterious Stranger', log: [] });

    const systemMessage = capturedBody.messages.find((m) => m.role === 'system').content;
    assert.match(systemMessage, /character-sheet writing assistant/i);
    assert.match(systemMessage, /"A Mysterious Stranger"/);
  });
});

describe('Settings: draftPersonaPrompt', () => {
  test('defaults to the built-in prompt text, reported as not customized', async () => {
    const cfg = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.match(cfg.draftPersonaPrompt, /character-sheet writing assistant/i);
    assert.equal(cfg.draftPersonaPromptIsCustom, false);
  });

  test('round-trips a custom prompt, then resets to default on an empty string', async () => {
    const custom = 'Describe {{char}} in exactly one sentence.';
    const saved = await (await postJson('/api/settings', { draftPersonaPrompt: custom })).json();
    assert.equal(saved.draftPersonaPrompt, custom);
    assert.equal(saved.draftPersonaPromptIsCustom, true);

    const reset = await (await postJson('/api/settings', { draftPersonaPrompt: '' })).json();
    assert.match(reset.draftPersonaPrompt, /character-sheet writing assistant/i);
    assert.equal(reset.draftPersonaPromptIsCustom, false);
  });
});

describe('POST/PUT /api/presets — memoryAsSeparateMessage', () => {
  test('defaults to false on create, and round-trips through PUT', async () => {
    const created = await (await postJson('/api/presets', { name: 'Stats Test Preset', prompts: [] })).json();
    assert.equal(created.preset.memoryAsSeparateMessage, false);

    const res = await fetch(`${baseUrl}/api/presets/${created.preset.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryAsSeparateMessage: true }),
    });
    const { preset: updated } = await res.json();
    assert.equal(updated.memoryAsSeparateMessage, true);
  });
});

describe('POST /api/presets/import + /api/presets/export', () => {
  const stFixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'silly-tavern-default-preset.json'), 'utf-8')
  );

  test('imports the real SillyTavern default preset end-to-end', async () => {
    const res = await postJson('/api/presets/import', { raw: stFixture, fallbackName: 'Default' });
    assert.equal(res.status, 201);
    const { preset } = await res.json();
    assert.equal(preset.name, 'Default');
    assert.equal(preset.contextLength, 4095);
    assert.equal(preset.maxReplyTokens, 300);
    assert.equal(preset.prompts.length, 12);
    assert.ok(preset.id);

    // It's actually saved, not just transformed — GET should show it.
    const listRes = await fetch(`${baseUrl}/api/presets`);
    const { presets } = await listRes.json();
    assert.ok(presets.some((p) => p.id === preset.id));
  });

  test('rejects import with no raw object', async () => {
    const res = await postJson('/api/presets/import', { fallbackName: 'Nothing' });
    assert.equal(res.status, 400);
  });

  test('export reconstructs a SillyTavern-shaped preset from a draft (no save required)', async () => {
    const draft = {
      name: 'My Draft',
      contextLength: 4096,
      maxReplyTokens: 500,
      prompts: [
        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Hi {{user}}.', marker: false, enabled: true },
        { identifier: 'scenario', name: 'Scenario', marker: true, enabled: false },
      ],
    };
    const res = await postJson('/api/presets/export', draft);
    assert.equal(res.status, 200);
    const exported = await res.json();
    assert.equal(exported.openai_max_context, 4096);
    assert.equal(exported.openai_max_tokens, 500);
    assert.equal(exported.prompts.length, 2);
    assert.deepEqual(exported.prompt_order[0].order, [
      { identifier: 'main', enabled: true },
      { identifier: 'scenario', enabled: false },
    ]);

    // Never persisted — exporting a draft shouldn't create a saved preset.
    const listRes = await fetch(`${baseUrl}/api/presets`);
    const { presets } = await listRes.json();
    assert.ok(!presets.some((p) => p.name === 'My Draft'));
  });

  test('export rejects a missing prompts array', async () => {
    const res = await postJson('/api/presets/export', { name: 'Incomplete' });
    assert.equal(res.status, 400);
  });

  test('import then export round-trips the context-length settings', async () => {
    const { preset } = await (await postJson('/api/presets/import', { raw: stFixture, fallbackName: 'Default' })).json();
    const res = await postJson('/api/presets/export', preset);
    const exported = await res.json();
    assert.equal(exported.openai_max_context, 4095);
    assert.equal(exported.openai_max_tokens, 300);
  });
});

describe('Persisted chat: /api/places/:placeId/enter, /say, GET /chat', () => {
  async function makePlace(name) {
    const res = await postJson('/api/places', { name, type: 'communal' });
    return (await res.json()).place;
  }

  async function placeCharacter(name, placeId) {
    const { character } = await (await postJson('/api/characters', { name, description: 'Present.' })).json();
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId }),
    });
    return character;
  }

  test('enter/say/chat all 404 for an unknown place', async () => {
    assert.equal((await postJson('/api/places/nope/enter', {})).status, 404);
    assert.equal((await postJson('/api/places/nope/say', { text: 'Hi.' })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/places/nope/chat`)).status, 404);
  });

  test('first enter persists an arrival marker; the log survives re-reading (persistence)', async () => {
    const place = await makePlace('Quiet Hall');
    const { log } = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    assert.equal(log.length, 1);
    assert.match(log[0].text, /You arrive at Quiet Hall/);

    const { log: reread } = await (await fetch(`${baseUrl}/api/places/${place.id}/chat`)).json();
    assert.deepEqual(reread, log);
  });

  test('a repeat enter appends NOTHING — a misclick leaves no trace; the return marker is deferred to /say', async () => {
    const place = await makePlace('Revisited Hall');
    await postJson(`/api/places/${place.id}/enter`, {});
    const second = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    assert.equal(second.log.length, 1); // still just the original arrival
    assert.equal(second.returnMarkerPending, true);

    // Saying something with announceArrival inserts the marker just before the user line.
    const { log } = await (await postJson(`/api/places/${place.id}/say`, { text: 'Back again.', announceArrival: true })).json();
    const markerIdx = log.findIndex((e) => /You return to Revisited Hall/.test(e.text || ''));
    const userIdx = log.findIndex((e) => e.type === 'user');
    assert.ok(markerIdx !== -1, 'return marker present after say');
    assert.equal(userIdx, markerIdx + 1);
  });

  test('entering never generates a reaction — arrivals are free even with characters present', async () => {
    const place = await makePlace('Occupied Hall');
    await placeCharacter('Occupant One', place.id);

    const res = await postJson(`/api/places/${place.id}/enter`, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.error, undefined); // no generation attempted, so no API-key error either
    assert.equal(data.log.length, 1); // just the arrival marker — no generated reply
    assert.equal(data.log[0].type, 'system');
  });

  test('a scripted greeting fires on the first-ever arrival only, and persists', async () => {
    const place = await makePlace('Greeting Hall');
    // The JSON character-creation path doesn't accept greetings, so edit the
    // data file directly — the app re-reads it per request.
    const { character } = await (await postJson('/api/characters', { name: 'Greeter', description: 'Friendly.' })).json();
    const charsPath = path.join(tmpRoot, 'data', 'characters.json');
    const chars = JSON.parse(fs.readFileSync(charsPath, 'utf-8'));
    chars.find((c) => c.id === character.id).greetings = ['Well met, traveler!'];
    fs.writeFileSync(charsPath, JSON.stringify(chars));
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeId: place.id, greetingIndex: 0 }),
    });

    const { log } = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    const greeting = log.find((e) => e.type === 'char' && e.charId === character.id);
    assert.equal(greeting.text, 'Well met, traveler!');

    const { log: secondVisit } = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    const greetingCount = secondVisit.filter((e) => e.type === 'char' && e.text === 'Well met, traveler!').length;
    assert.equal(greetingCount, 1); // not repeated on the return visit
  });

  test('a greeting-only arrival (no generation) still records the greeting into memory', async () => {
    const place = await makePlace('Memorable Greeting Hall');
    const { character } = await (await postJson('/api/characters', { name: 'Sole Greeter', description: 'Warm.' })).json();
    const charsPath = path.join(tmpRoot, 'data', 'characters.json');
    const chars = JSON.parse(fs.readFileSync(charsPath, 'utf-8'));
    chars.find((c) => c.id === character.id).greetings = ['I have been expecting you.'];
    fs.writeFileSync(charsPath, JSON.stringify(chars));
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeId: place.id, greetingIndex: 0 }),
    });

    await postJson(`/api/places/${place.id}/enter`, {});

    // Memory recording is fire-and-forget — poll briefly for it to land.
    let memories = [];
    for (let i = 0; i < 40; i++) {
      memories = (await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json()).memories;
      if (memories.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(memories.length, 1);
    assert.ok(memories[0].text.includes('I have been expecting you.'));
    assert.ok(memories[0].text.includes('You arrive at Memorable Greeting Hall.'));
  });

  test('say with no one present persists the user line plus an echo marker', async () => {
    const place = await makePlace('Echoing Hall');
    await postJson(`/api/places/${place.id}/enter`, {});
    const { log, error } = await (await postJson(`/api/places/${place.id}/say`, { text: 'Anyone here?' })).json();
    assert.equal(error, undefined); // nothing to generate, so nothing failed
    assert.equal(log[1].type, 'user');
    assert.equal(log[1].text, 'Anyone here?');
    assert.match(log[2].text, /echo/i);
  });

  test('say with someone present but no key persists the user line, reports the error, generates nothing', async () => {
    const place = await makePlace('Missing Key Hall');
    await placeCharacter('Occupant Two', place.id);
    await postJson(`/api/places/${place.id}/enter`, {});

    const before = (await (await fetch(`${baseUrl}/api/places/${place.id}/chat`)).json()).log.length;
    const { log, error } = await (await postJson(`/api/places/${place.id}/say`, { text: 'Hello?' })).json();
    assert.match(error, /API key/i);
    assert.equal(log.length, before + 1); // exactly the user line was added
    assert.equal(log[log.length - 1].type, 'user');
  });

  test('say rejects empty text', async () => {
    const place = await makePlace('Silent Hall');
    assert.equal((await postJson(`/api/places/${place.id}/say`, { text: '   ' })).status, 400);
  });

  test('deleting a place deletes its chat log file', async () => {
    const place = await makePlace('Doomed Hall');
    await postJson(`/api/places/${place.id}/enter`, {});
    const chatPath = path.join(tmpRoot, 'data', 'chats', `${place.id}.json`);
    assert.equal(fs.existsSync(chatPath), true);

    await fetch(`${baseUrl}/api/places/${place.id}`, { method: 'DELETE' });
    assert.equal(fs.existsSync(chatPath), false);
  });

  test('persisted entries carry stable ids', async () => {
    const place = await makePlace('Identified Hall');
    const { log } = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    assert.ok(log[0].id);
  });
});

describe('POST /api/places/:placeId/retry (validation paths — no real OpenRouter call)', () => {
  async function makePlace(name) {
    const res = await postJson('/api/places', { name, type: 'communal' });
    return (await res.json()).place;
  }

  async function placeCharacter(name, placeId) {
    const { character } = await (await postJson('/api/characters', { name, description: 'Present.' })).json();
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId }),
    });
    return character;
  }

  function writeLog(placeId, log) {
    const chatPath = path.join(tmpRoot, 'data', 'chats', `${placeId}.json`);
    fs.mkdirSync(path.dirname(chatPath), { recursive: true });
    fs.writeFileSync(chatPath, JSON.stringify(log));
  }

  test('404s for an unknown place', async () => {
    assert.equal((await postJson('/api/places/nope/retry', {})).status, 404);
  });

  test('400s when there is no user message to retry yet', async () => {
    const place = await makePlace('Empty Retry Hall');
    await postJson(`/api/places/${place.id}/enter`, {});
    const res = await postJson(`/api/places/${place.id}/retry`, {});
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /nothing to retry/i);
  });

  test('400s when the last user message already has a character reply after it', async () => {
    const place = await makePlace('Answered Hall');
    const character = await placeCharacter('Answerer', place.id);
    writeLog(place.id, [
      { id: 'usr-1', type: 'user', text: 'Hello?' },
      { id: 'msg-1', type: 'char', charId: character.id, name: character.name, text: 'Hello yourself.' },
    ]);

    const res = await postJson(`/api/places/${place.id}/retry`, {});
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /already has a reply/i);
  });

  test('allowed when every reply under the user message was deleted, leaving only the dangling user line', async () => {
    const place = await makePlace('Cleared Replies Hall');
    writeLog(place.id, [{ id: 'usr-1', type: 'user', text: 'Hello?' }]);

    // Nobody present -> resolves immediately with an echo marker rather
    // than an API-key error, but the key point is it's accepted (not a 400).
    const res = await postJson(`/api/places/${place.id}/retry`, {});
    assert.equal(res.status, 200);
  });

  test('retrying does not append a duplicate user message, and surfaces the same "no API key" error as /say', async () => {
    const place = await makePlace('Missing Key Retry Hall');
    await placeCharacter('Retry Occupant', place.id);
    await postJson(`/api/places/${place.id}/enter`, {});

    const sayRes = await (await postJson(`/api/places/${place.id}/say`, { text: 'Hello?' })).json();
    assert.match(sayRes.error, /API key/i);
    const afterSay = (await (await fetch(`${baseUrl}/api/places/${place.id}/chat`)).json()).log;
    assert.equal(afterSay[afterSay.length - 1].type, 'user');

    const retryRes = await (await postJson(`/api/places/${place.id}/retry`, {})).json();
    assert.match(retryRes.error, /API key/i);
    const afterRetry = (await (await fetch(`${baseUrl}/api/places/${place.id}/chat`)).json()).log;
    assert.equal(afterRetry.length, afterSay.length); // no new user entry appended
    assert.equal(afterRetry[afterRetry.length - 1].type, 'user');
    assert.equal(afterRetry[afterRetry.length - 1].text, 'Hello?');
  });

  test('with nobody present, retry appends the echo marker (like /say) without a key', async () => {
    const place = await makePlace('Echo Retry Hall');
    await postJson(`/api/places/${place.id}/enter`, {});
    await postJson(`/api/places/${place.id}/say`, { text: 'Anyone here?' });

    const { log } = await (await postJson(`/api/places/${place.id}/retry`, {})).json();
    assert.match(log[log.length - 1].text, /echo/i);
  });
});

describe('POST /api/places/:placeId/regenerate (validation paths — no real OpenRouter call)', () => {
  async function makeOccupiedPlaceWithChat() {
    const { place } = await (await postJson('/api/places', { name: 'Regen Hall ' + Math.random(), type: 'communal' })).json();
    const { character } = await (await postJson('/api/characters', { name: 'Regen Subject', description: 'Present.' })).json();
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId: place.id }),
    });
    // Persist a fake generated message directly (generation needs a real key).
    const chatPath = path.join(tmpRoot, 'data', 'chats', `${place.id}.json`);
    fs.mkdirSync(path.dirname(chatPath), { recursive: true });
    const log = [
      { id: 'sys-1', type: 'system', text: `You arrive at ${place.name}.` },
      { id: 'msg-1', type: 'char', charId: character.id, name: character.name, text: 'Original line.' },
    ];
    fs.writeFileSync(chatPath, JSON.stringify(log));
    return { place, character };
  }

  test('404s for an unknown place and for an unknown entry id', async () => {
    assert.equal((await postJson('/api/places/nope/regenerate', { entryId: 'x' })).status, 404);
    const { place } = await makeOccupiedPlaceWithChat();
    assert.equal((await postJson(`/api/places/${place.id}/regenerate`, { entryId: 'does-not-exist' })).status, 404);
  });

  test('rejects a missing entryId', async () => {
    const { place } = await makeOccupiedPlaceWithChat();
    assert.equal((await postJson(`/api/places/${place.id}/regenerate`, {})).status, 400);
  });

  test('rejects regenerating a system entry (only generated character messages)', async () => {
    const { place } = await makeOccupiedPlaceWithChat();
    const res = await postJson(`/api/places/${place.id}/regenerate`, { entryId: 'sys-1' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /character messages/i);
  });

  test('a valid target fails only at the API-key step (validation passed), leaving the log untouched', async () => {
    const { place } = await makeOccupiedPlaceWithChat();
    const res = await postJson(`/api/places/${place.id}/regenerate`, { entryId: 'msg-1' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /API key/i);

    const { log } = await (await fetch(`${baseUrl}/api/places/${place.id}/chat`)).json();
    assert.equal(log.find((e) => e.id === 'msg-1').text, 'Original line.');
  });
});

describe('Memory management: GET/POST /api/memory/:characterId, PUT/DELETE /api/memory/:characterId/:entryId', () => {
  test('a fresh character has no memories', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Fresh Face', description: 'New.' })).json();
    const res = await fetch(`${baseUrl}/api/memory/${character.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).memories, []);
  });

  test('adds a memory manually and lists it back, without an embedding field', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Wren', description: 'Curious.' })).json();

    const addRes = await postJson(`/api/memory/${character.id}`, { text: 'Loves riddles.', personaId: 'kael-1', placeId: 'town-square' });
    assert.equal(addRes.status, 201);
    const { memory } = await addRes.json();
    assert.equal(memory.text, 'Loves riddles.');
    assert.equal(memory.personaId, 'kael-1');
    assert.equal('embedding' in memory, false);

    const listRes = await fetch(`${baseUrl}/api/memory/${character.id}`);
    const { memories } = await listRes.json();
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, memory.id);
    assert.equal('embedding' in memories[0], false);
  });

  test('rejects adding a memory with no text', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Empty Adder', description: '.' })).json();
    const res = await postJson(`/api/memory/${character.id}`, { personaId: 'kael-1' });
    assert.equal(res.status, 400);
  });

  test('memories added under different personas are both listed, tagged correctly', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Multi Persona Friend', description: '.' })).json();
    await postJson(`/api/memory/${character.id}`, { text: 'For persona A.', personaId: 'persona-A' });
    await postJson(`/api/memory/${character.id}`, { text: 'For persona B.', personaId: 'persona-B' });
    await postJson(`/api/memory/${character.id}`, { text: 'For no persona.' });

    const { memories } = await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json();
    assert.equal(memories.length, 3);
    assert.deepEqual(new Set(memories.map((m) => m.personaId)), new Set(['persona-A', 'persona-B', null]));
  });

  test('edits a memory\'s text via PUT, and the edit is reflected in listing and retrieval', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Editable Ed', description: '.' })).json();
    const { memory } = await (await postJson(`/api/memory/${character.id}`, { text: 'Original text about records.', personaId: 'kael-1' })).json();

    const putRes = await fetch(`${baseUrl}/api/memory/${character.id}/${memory.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Edited text about weather.' }),
    });
    assert.equal(putRes.status, 200);
    const { memory: updated } = await putRes.json();
    assert.equal(updated.text, 'Edited text about weather.');

    const { memories } = await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json();
    assert.equal(memories[0].text, 'Edited text about weather.');
  });

  test('PUT rejects empty text and 404s for an unknown entry id', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Put Tester', description: '.' })).json();
    const { memory } = await (await postJson(`/api/memory/${character.id}`, { text: 'Something.', personaId: 'kael-1' })).json();

    const emptyRes = await fetch(`${baseUrl}/api/memory/${character.id}/${memory.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(emptyRes.status, 400);

    const missingRes = await fetch(`${baseUrl}/api/memory/${character.id}/does-not-exist`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(missingRes.status, 404);
  });

  test('deletes a memory via DELETE, and a repeat delete 404s', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Delete Tester', description: '.' })).json();
    const { memory } = await (await postJson(`/api/memory/${character.id}`, { text: 'Temporary.', personaId: 'kael-1' })).json();

    const delRes = await fetch(`${baseUrl}/api/memory/${character.id}/${memory.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    const { memories } = await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json();
    assert.deepEqual(memories, []);

    const repeatRes = await fetch(`${baseUrl}/api/memory/${character.id}/${memory.id}`, { method: 'DELETE' });
    assert.equal(repeatRes.status, 404);
  });

  test('manually added memories are retrievable through the same ranking as recorded turns', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Retrievable Rae', description: '.' })).json();
    await postJson(`/api/memory/${character.id}`, { text: 'The visitor once asked about ancient maps.', personaId: 'kael-1' });
    await postJson(`/api/memory/${character.id}`, { text: 'Nothing to do with the topic at all.', personaId: 'kael-1' });

    const res = await postJson('/api/memory/retrieve', {
      query: 'Tell me about the old maps you mentioned.',
      personaId: 'kael-1',
      characterIds: [character.id],
    });
    const { memories } = await res.json();
    assert.ok(memories[0].includes('maps'));
  });

  test('the /api/memory/:characterId GET route does not shadow /api/memory/record or /api/memory/retrieve', async () => {
    // Regression check for route-registration order: these literal-path
    // POST routes must still work even though /api/memory/:characterId
    // (also POST) is registered afterward.
    const { character } = await (await postJson('/api/characters', { name: 'Route Order Check', description: '.' })).json();
    const recordRes = await postJson('/api/memory/record', { text: 'Hi.', characterIds: [character.id] });
    assert.equal(recordRes.status, 200);
    const retrieveRes = await postJson('/api/memory/retrieve', { query: 'Hi.', characterIds: [character.id] });
    assert.equal(retrieveRes.status, 200);
  });
});

describe('World time & setting', () => {
  test('world state carries default time and empty setting', async () => {
    const { time, setting } = await (await fetch(`${baseUrl}/api/world`)).json();
    assert.ok(time.day >= 1);
    assert.ok(typeof time.timeOfDay === 'string');
    assert.equal(typeof setting, 'string');
  });

  test('time can be set explicitly and advanced (wrapping night into the next day)', async () => {
    let res = await postJson('/api/world/time', { day: 1, timeOfDay: 'night' });
    assert.equal((await res.json()).time.timeOfDay, 'night');

    res = await postJson('/api/world/time', { advance: true });
    const { time } = await res.json();
    assert.equal(time.timeOfDay, 'sunrise'); // wrapped past night
    assert.equal(time.day, 2);
  });

  test('rejects invalid timeOfDay and day', async () => {
    assert.equal((await postJson('/api/world/time', { timeOfDay: 'brunch' })).status, 400);
    assert.equal((await postJson('/api/world/time', { day: 0 })).status, 400);
  });

  test('time can retreat (wrapping to the previous day at sunrise), and time-travel to any earlier day directly', async () => {
    await postJson('/api/world/time', { day: 5, timeOfDay: 'sunrise' });

    let res = await postJson('/api/world/time', { retreat: true });
    let { time } = await res.json();
    assert.equal(time.timeOfDay, 'night'); // wrapped back past sunrise
    assert.equal(time.day, 4);

    res = await postJson('/api/world/time', { day: 1, timeOfDay: 'morning' });
    time = (await res.json()).time;
    assert.equal(time.day, 1);
    assert.equal(time.timeOfDay, 'morning');
  });

  test('retreat never takes day below 1', async () => {
    await postJson('/api/world/time', { day: 1, timeOfDay: 'sunrise' });
    const res = await postJson('/api/world/time', { retreat: true });
    const { time } = await res.json();
    assert.equal(time.day, 1);
    assert.equal(time.timeOfDay, 'night');
  });

  test('world setting persists', async () => {
    await postJson('/api/world/setting', { setting: 'A rain-soaked port city, gaslit.' });
    const { setting } = await (await fetch(`${baseUrl}/api/world`)).json();
    assert.equal(setting, 'A rain-soaked port city, gaslit.');
  });
});

describe('Character schedules', () => {
  async function makePlace(name) {
    const res = await postJson('/api/places', { name, type: 'communal' });
    return (await res.json()).place;
  }

  function putSchedule(characterId, day, timeOfDay, body) {
    return fetch(`${baseUrl}/api/characters/${characterId}/schedule/${day}/${timeOfDay}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  test('sets a schedule slot and returns it on the character', async () => {
    const place = await makePlace('Schedule Tavern ' + Math.random());
    const { character } = await (await postJson('/api/characters', { name: 'Scheduled Sam', description: '.' })).json();

    const res = await putSchedule(character.id, 'Wednesday', 'evening', { placeId: place.id, reason: 'Work' });
    assert.equal(res.status, 200);
    const { character: updated } = await res.json();
    assert.deepEqual(updated.schedule.Wednesday.evening, { placeId: place.id, reason: 'Work' });
  });

  test('clearing a slot (no placeId) removes it', async () => {
    const place = await makePlace('Schedule Market ' + Math.random());
    const { character } = await (await postJson('/api/characters', { name: 'Clearable Cara', description: '.' })).json();
    await putSchedule(character.id, 'Monday', 'noon', { placeId: place.id });

    const res = await putSchedule(character.id, 'Monday', 'noon', { placeId: null });
    assert.equal(res.status, 200);
    const { character: updated } = await res.json();
    assert.equal(updated.schedule.Monday?.noon, undefined);
  });

  test('rejects an unknown day, timeOfDay, character, or place', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Validation Val', description: '.' })).json();
    const place = await makePlace('Valid Place ' + Math.random());

    assert.equal((await putSchedule(character.id, 'Someday', 'evening', { placeId: place.id })).status, 400);
    assert.equal((await putSchedule(character.id, 'Monday', 'teatime', { placeId: place.id })).status, 400);
    assert.equal((await putSchedule('does-not-exist', 'Monday', 'evening', { placeId: place.id })).status, 404);
    assert.equal((await putSchedule(character.id, 'Monday', 'evening', { placeId: 'nonexistent-place' })).status, 404);
  });

  test('advancing/setting world time automatically moves a scheduled character to their slot\'s place', async () => {
    const placeA = await makePlace('Auto Move Home ' + Math.random());
    const placeB = await makePlace('Auto Move Work ' + Math.random());
    const { character } = await (await postJson('/api/characters', { name: 'Autonomous Andy', description: '.' })).json();

    // Day 1 is a Monday: schedule morning -> placeB.
    await putSchedule(character.id, 'Monday', 'morning', { placeId: placeB.id, reason: 'Work' });
    // Manually place them at placeA first, at a different (unscheduled) slot.
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId: placeA.id }),
    });
    await postJson('/api/world/time', { day: 1, timeOfDay: 'sunrise' });

    const res = await postJson('/api/world/time', { advance: true }); // -> Day 1, morning
    const { placements } = await res.json();
    assert.equal(placements[character.id].placeId, placeB.id);
  });

  test('a character with nothing scheduled for the new slot keeps their existing placement', async () => {
    const placeA = await makePlace('Untouched Place ' + Math.random());
    const { character } = await (await postJson('/api/characters', { name: 'Unscheduled Uma', description: '.' })).json();
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId: placeA.id }),
    });

    const res = await postJson('/api/world/time', { advance: true });
    const { placements } = await res.json();
    assert.equal(placements[character.id].placeId, placeA.id);
  });
});

describe('Relationships', () => {
  async function twoCharacters() {
    const a = (await (await postJson('/api/characters', { name: 'Rel A ' + Math.random(), description: '.' })).json()).character;
    const b = (await (await postJson('/api/characters', { name: 'Rel B ' + Math.random(), description: '.' })).json()).character;
    return [a, b];
  }

  function putRel(charId, targetId, labels) {
    return fetch(`${baseUrl}/api/relationships/${charId}/${targetId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels }),
    });
  }

  test('sets multi-label relations to a character and to the user, and lists them', async () => {
    const [a, b] = await twoCharacters();
    assert.equal((await putRel(a.id, b.id, ['ex-wife', 'friend'])).status, 200);
    assert.equal((await putRel(a.id, 'user', ['mentor'])).status, 200);

    const { relationships } = await (await fetch(`${baseUrl}/api/relationships`)).json();
    const ab = relationships.find((r) => r.characterId === a.id && r.targetId === b.id);
    assert.deepEqual(ab.labels, ['ex-wife', 'friend']);
    const au = relationships.find((r) => r.characterId === a.id && r.targetId === 'user');
    assert.deepEqual(au.labels, ['mentor']);
  });

  test('empty labels removes the relation; duplicates and blanks are cleaned', async () => {
    const [a, b] = await twoCharacters();
    await putRel(a.id, b.id, ['friend', 'friend', '  ', 'rival']);
    let { relationships } = await (await fetch(`${baseUrl}/api/relationships`)).json();
    assert.deepEqual(relationships.find((r) => r.characterId === a.id && r.targetId === b.id).labels, ['friend', 'rival']);

    await putRel(a.id, b.id, []);
    ({ relationships } = await (await fetch(`${baseUrl}/api/relationships`)).json());
    assert.equal(relationships.find((r) => r.characterId === a.id && r.targetId === b.id), undefined);
  });

  test('validation: unknown ids, self-relation, bad labels', async () => {
    const [a] = await twoCharacters();
    assert.equal((await putRel('nope', a.id, ['friend'])).status, 404);
    assert.equal((await putRel(a.id, 'nope', ['friend'])).status, 404);
    assert.equal((await putRel(a.id, a.id, ['friend'])).status, 400);
    assert.equal((await putRel(a.id, 'user', 'not-an-array')).status, 400);
  });

  test('deleting a character removes their relations both ways', async () => {
    const [a, b] = await twoCharacters();
    await putRel(a.id, b.id, ['sister']);
    await putRel(b.id, a.id, ['brother']);
    await fetch(`${baseUrl}/api/characters/${a.id}`, { method: 'DELETE' });

    const { relationships } = await (await fetch(`${baseUrl}/api/relationships`)).json();
    assert.equal(relationships.some((r) => r.characterId === a.id || r.targetId === a.id), false);
  });
});

describe('Settings: endpoint config fields', () => {
  test('round-trips apiBase, streaming, reasoning, providers', async () => {
    const res = await postJson('/api/settings', {
      apiBase: 'https://example.com/v1/', streaming: true, reasoning: 'high', providers: ['SomeProvider', 'AnotherProvider'],
    });
    const cfg = await res.json();
    assert.equal(cfg.apiBase, 'https://example.com/v1'); // trailing slash trimmed
    assert.equal(cfg.streaming, true);
    assert.equal(cfg.reasoning, 'high');
    assert.deepEqual(cfg.providers, ['SomeProvider', 'AnotherProvider']);

    // Providers endpoint is OpenRouter-only — a custom base gets [] without a network call.
    const { providers } = await (await fetch(`${baseUrl}/api/models/providers?model=any/model`)).json();
    assert.deepEqual(providers, []);

    // Restore defaults so later tests are unaffected.
    await postJson('/api/settings', { apiBase: 'https://openrouter.ai/api/v1', streaming: false, reasoning: 'off', providers: [] });
  });

  test('providers: non-string entries are dropped, duplicates and blanks are cleaned up', async () => {
    const res = await postJson('/api/settings', { providers: ['Foo', '  ', 'Foo', 42, 'Bar'] });
    const cfg = await res.json();
    assert.deepEqual(cfg.providers, ['Foo', 'Bar']);
    await postJson('/api/settings', { providers: [] });
  });

  test('invalid reasoning values are ignored', async () => {
    const cfg = await (await postJson('/api/settings', { reasoning: 'ultra' })).json();
    assert.equal(cfg.reasoning, 'off');
  });

  test('memoryMinScore defaults to 0.35, round-trips, and is clamped to [0,1]', async () => {
    const initial = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(initial.memoryMinScore, 0.35);

    const updated = await (await postJson('/api/settings', { memoryMinScore: 0.6 })).json();
    assert.equal(updated.memoryMinScore, 0.6);

    const clampedHigh = await (await postJson('/api/settings', { memoryMinScore: 5 })).json();
    assert.equal(clampedHigh.memoryMinScore, 1);
    const clampedLow = await (await postJson('/api/settings', { memoryMinScore: -2 })).json();
    assert.equal(clampedLow.memoryMinScore, 0);

    // Restore default so later tests are unaffected.
    await postJson('/api/settings', { memoryMinScore: 0.35 });
  });

  test('a non-numeric memoryMinScore is ignored, leaving the previous value in place', async () => {
    await postJson('/api/settings', { memoryMinScore: 0.5 });
    const cfg = await (await postJson('/api/settings', { memoryMinScore: 'high' })).json();
    assert.equal(cfg.memoryMinScore, 0.5);
    await postJson('/api/settings', { memoryMinScore: 0.35 });
  });
});

describe('Message edit & delete', () => {
  async function placeWithChat() {
    const { place } = await (await postJson('/api/places', { name: 'Edit Hall ' + Math.random(), type: 'communal' })).json();
    const { character } = await (await postJson('/api/characters', { name: 'Edit Subject', description: '.' })).json();
    const chatPath = path.join(tmpRoot, 'data', 'chats', `${place.id}.json`);
    fs.mkdirSync(path.dirname(chatPath), { recursive: true });
    fs.writeFileSync(chatPath, JSON.stringify([
      { id: 'sys-1', type: 'system', text: `You arrive at ${place.name}.` },
      { id: 'usr-1', type: 'user', text: 'Original user line.' },
      { id: 'msg-1', type: 'char', charId: character.id, name: character.name, text: 'Original reply.' },
    ]));
    return { place, character };
  }

  test('edits a user message and a character message in place', async () => {
    const { place } = await placeWithChat();
    let res = await fetch(`${baseUrl}/api/places/${place.id}/messages/usr-1`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Edited user line.' }),
    });
    assert.equal(res.status, 200);
    let { log } = await res.json();
    assert.equal(log.find((e) => e.id === 'usr-1').text, 'Edited user line.');

    res = await fetch(`${baseUrl}/api/places/${place.id}/messages/msg-1`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Edited reply.' }),
    });
    ({ log } = await res.json());
    assert.equal(log.find((e) => e.id === 'msg-1').text, 'Edited reply.');
  });

  test('system markers cannot be edited; unknown entries 404; empty text 400', async () => {
    const { place } = await placeWithChat();
    const put = (id, body) => fetch(`${baseUrl}/api/places/${place.id}/messages/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await put('sys-1', { text: 'Hacked.' })).status, 400);
    assert.equal((await put('ghost', { text: 'Hi.' })).status, 404);
    assert.equal((await put('usr-1', { text: '  ' })).status, 400);
  });

  test('deletes a message; repeat delete 404s', async () => {
    const { place } = await placeWithChat();
    const del = () => fetch(`${baseUrl}/api/places/${place.id}/messages/msg-1`, { method: 'DELETE' });
    const res = await del();
    assert.equal(res.status, 200);
    const { log } = await res.json();
    assert.equal(log.some((e) => e.id === 'msg-1'), false);
    assert.equal(log.length, 2);
    assert.equal((await del()).status, 404);
  });

  test('editing a message rebuilds the linked memories of every witness', async () => {
    const { place, character } = await placeWithChat();
    const other = (await (await postJson('/api/characters', { name: 'Edit Witness', description: '.' })).json()).character;

    // Record a turn linked to the chat entries, witnessed by both characters.
    await postJson('/api/memory/record', {
      text: 'Kael: Original user line.\nEdit Subject: Original reply.',
      placeId: place.id,
      characterIds: [character.id, other.id],
      entryIds: ['usr-1', 'msg-1'],
    });

    await fetch(`${baseUrl}/api/places/${place.id}/messages/msg-1`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Completely different reply.' }),
    });

    for (const cid of [character.id, other.id]) {
      const { memories } = await (await fetch(`${baseUrl}/api/memory/${cid}`)).json();
      assert.equal(memories.length, 1);
      assert.ok(memories[0].text.includes('Completely different reply.'), `witness ${cid} memory rebuilt`);
      assert.ok(!memories[0].text.includes('Original reply.'));
    }
  });
});
