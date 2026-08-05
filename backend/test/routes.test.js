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
import JSZip from 'jszip';
import { encodeEmbedding, upsertMemoryVectors } from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app, registry, server, baseUrl, tmpRoot;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-test-'));
  process.env.FREEROAM_TEST_ROOT = tmpRoot;
  ({ app, registry } = await import('../server.js'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  registry.closeAll(); // release every world's SQLite lock so the temp dir can be removed on Windows
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Every test in this file runs against the registry's default world
// (no X-World-Id header sent) — this helper resolves that world's on-disk
// data dir for the handful of tests that poke a file directly.
function defaultWorldDataDir() {
  return registry.getDefault().dataDir;
}

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

  test('surfaces a clear timeout message when the endpoint hangs (AbortError from a hung fetch)', async (t) => {
    // callOpenRouter's AbortController.abort() manifests to callers as a
    // fetch rejection named 'AbortError' — simulate that directly rather
    // than actually waiting out LLM_TIMEOUT_MS in a test.
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }));

    const res = await postJson('/api/characters/draft', {
      name: 'A Mysterious Stranger',
      log: [{ type: 'user', text: 'Who are you?' }],
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /timed out/i);
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

describe('Settings: textingPromptTemplate + textingTypingIndicator', () => {
  test('textingPromptTemplate defaults to the built-in text, reported as not customized', async () => {
    const cfg = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.match(cfg.textingPromptTemplate, /texting, not narrating/i);
    assert.equal(cfg.textingPromptTemplateIsCustom, false);
  });

  test('round-trips a custom texting prompt, then resets to default on an empty string', async () => {
    const custom = 'Reply only with emoji.';
    const saved = await (await postJson('/api/settings', { textingPromptTemplate: custom })).json();
    assert.equal(saved.textingPromptTemplate, custom);
    assert.equal(saved.textingPromptTemplateIsCustom, true);

    const reset = await (await postJson('/api/settings', { textingPromptTemplate: '' })).json();
    assert.match(reset.textingPromptTemplate, /texting, not narrating/i);
    assert.equal(reset.textingPromptTemplateIsCustom, false);
  });

  test('textingTypingIndicator defaults to false and round-trips', async () => {
    const cfg = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(cfg.textingTypingIndicator, false);

    const saved = await (await postJson('/api/settings', { textingTypingIndicator: true })).json();
    assert.equal(saved.textingTypingIndicator, true);

    await postJson('/api/settings', { textingTypingIndicator: false }); // leave settings clean for later tests
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

describe('Places: multi-owner (ownerIds)', () => {
  async function makeCharacter(name) {
    const res = await postJson('/api/characters', { name, description: 'A test character.' });
    return (await res.json()).character;
  }

  test('POST /api/places accepts multiple ownerIds, deduped, only when private', async () => {
    const a = await makeCharacter('Owner A ' + Math.random());
    const b = await makeCharacter('Owner B ' + Math.random());
    const res = await postJson('/api/places', {
      name: 'Shared House ' + Math.random(), type: 'private', ownerIds: [a.id, b.id, a.id],
    });
    assert.equal(res.status, 201);
    const { place } = await res.json();
    assert.deepEqual(place.ownerIds, [a.id, b.id]);
  });

  test('POST /api/places rejects an unknown owner id', async () => {
    const res = await postJson('/api/places', {
      name: 'Bad Owner House ' + Math.random(), type: 'private', ownerIds: ['not-a-real-character'],
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/places drops ownerIds for a communal place', async () => {
    const a = await makeCharacter('Owner C ' + Math.random());
    const res = await postJson('/api/places', {
      name: 'Communal Hall ' + Math.random(), type: 'communal', ownerIds: [a.id],
    });
    const { place } = await res.json();
    assert.deepEqual(place.ownerIds, []);
  });

  test('PUT /api/places/:id replaces the whole ownerIds array', async () => {
    const a = await makeCharacter('Owner D ' + Math.random());
    const b = await makeCharacter('Owner E ' + Math.random());
    const created = await (await postJson('/api/places', {
      name: 'Edit House ' + Math.random(), type: 'private', ownerIds: [a.id],
    })).json();

    const put = await fetch(`${baseUrl}/api/places/${created.place.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerIds: [b.id] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await put.json()).place.ownerIds, [b.id]);
  });

  test('deleting a character removes just that owner from a multi-owner place, keeping the rest', async () => {
    const a = await makeCharacter('Owner F ' + Math.random());
    const b = await makeCharacter('Owner G ' + Math.random());
    const created = await (await postJson('/api/places', {
      name: 'Twin Owned House ' + Math.random(), type: 'private', ownerIds: [a.id, b.id],
    })).json();

    await fetch(`${baseUrl}/api/characters/${a.id}`, { method: 'DELETE' });

    const { places } = await (await fetch(`${baseUrl}/api/places`)).json();
    const place = places.find((p) => p.id === created.place.id);
    assert.deepEqual(place.ownerIds, [b.id]);
  });
});

describe('GET /api/changelog', () => {
  test('returns real git history entries with the expected shape', async () => {
    const res = await fetch(`${baseUrl}/api/changelog`);
    assert.equal(res.status, 200);
    const { entries } = await res.json();
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length > 0);
    assert.match(entries[0].hash, /^[0-9a-f]{40}$/);
    assert.match(entries[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entries[0].subject.length > 0);
  });
});

describe('Export/import: characters, personas, places', () => {
  test('GET /api/characters/:id/export and /export return the plural wire shape', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Export Me ' + Math.random(), description: 'Test.' })).json();
    // Compare against the normalized shape (GET /api/characters), not POST's
    // raw response — loadCharacters applies normalizeCharacter (adds e.g.
    // schedule: {}), same as /export does, so this is the fair comparison.
    const { characters: allChars } = await (await fetch(`${baseUrl}/api/characters`)).json();
    const normalized = allChars.find((c) => c.id === character.id);

    const single = await (await fetch(`${baseUrl}/api/characters/${character.id}/export`)).json();
    assert.deepEqual(single.characters, [normalized]);

    const all = await (await fetch(`${baseUrl}/api/characters/export`)).json();
    assert.ok(all.characters.some((c) => c.id === character.id));
  });

  test('GET /api/characters/:id/export 404s for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/characters/not-a-real-id/export`);
    assert.equal(res.status, 404);
  });

  test('POST /api/characters/import mints fresh ids and clears avatarUrl', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Original ' + Math.random(), description: 'Has some description.' })).json();
    const { characters: exported } = await (await fetch(`${baseUrl}/api/characters/${character.id}/export`)).json();

    const res = await postJson('/api/characters/import', { characters: exported });
    assert.equal(res.status, 201);
    const { characters: imported } = await res.json();
    assert.equal(imported.length, 1);
    assert.notEqual(imported[0].id, character.id);
    assert.equal(imported[0].name, character.name);
    assert.equal(imported[0].description, character.description);
    assert.equal(imported[0].avatarUrl, null);
  });

  test('POST /api/characters/import rejects an empty/missing array', async () => {
    assert.equal((await postJson('/api/characters/import', {})).status, 400);
    assert.equal((await postJson('/api/characters/import', { characters: [] })).status, 400);
  });

  // Card-bytes resolution itself is unit-tested in cardImport.test.js — this
  // just checks the route wires a resolved card into a real, persisted
  // character (fresh id, avatarUrl set to a written file, same shape the
  // multipart upload route produces).
  describe('POST /api/characters/import-url', () => {
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    function pngChunk(type, data) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length, 0);
      return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
    }
    function buildCardPng(name) {
      const ihdr = pngChunk('IHDR', Buffer.alloc(13));
      const base64 = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name, description: 'Imported from a URL.' } })).toString('base64');
      const charaData = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(base64, 'latin1')]);
      return Buffer.concat([PNG_SIGNATURE, ihdr, pngChunk('tEXt', charaData), pngChunk('IEND', Buffer.alloc(0))]);
    }

    test('imports a character from a direct card PNG URL', async (t) => {
      // Mocking globalThis.fetch also intercepts postJson's own request to
      // this test's local server (both go through the same global fetch),
      // so — same pattern as mockOpenRouterFetch — anything bound for
      // baseUrl falls through to the real fetch; only the outbound
      // card-download call gets faked.
      const realFetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url, opts) => {
        if (typeof url === 'string' && url.startsWith(baseUrl)) return realFetch(url, opts);
        return new Response(buildCardPng('URL Import Test'), { status: 200, headers: { 'content-type': 'image/png' } });
      });

      const res = await postJson('/api/characters/import-url', { url: 'https://example.com/card.png' });
      assert.equal(res.status, 201);
      const { character } = await res.json();
      assert.equal(character.name, 'URL Import Test');
      assert.ok(character.id);
      assert.ok(character.avatarUrl?.includes(character.id));

      const { characters } = await (await fetch(`${baseUrl}/api/characters`)).json();
      assert.ok(characters.some((c) => c.id === character.id));
    });

    test('rejects a missing url', async () => {
      const res = await postJson('/api/characters/import-url', {});
      assert.equal(res.status, 400);
    });

    test('surfaces a card-resolution failure as a 400, not a 500', async (t) => {
      const realFetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url, opts) => {
        if (typeof url === 'string' && url.startsWith(baseUrl)) return realFetch(url, opts);
        return new Response('not a card', { status: 404 });
      });
      const res = await postJson('/api/characters/import-url', { url: 'https://example.com/missing.png' });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Fetch failed \(404\)/);
    });
  });

  test('GET /api/personas/:id/export and /export round-trip; import clears avatarUrl', async () => {
    const { persona } = await (await postJson('/api/personas', { name: 'Export Persona ' + Math.random(), description: 'A test persona.' })).json();

    const single = await (await fetch(`${baseUrl}/api/personas/${persona.id}/export`)).json();
    assert.deepEqual(single.personas, [persona]);

    const res = await postJson('/api/personas/import', { personas: single.personas });
    assert.equal(res.status, 201);
    const { personas: imported } = await res.json();
    assert.notEqual(imported[0].id, persona.id);
    assert.equal(imported[0].name, persona.name);
    assert.equal(imported[0].avatarUrl, null);
  });

  test('GET /api/places/export supports single/area/all granularities', async () => {
    const area = 'Export Test Area ' + Math.random();
    const p1 = await (await postJson('/api/places', { name: 'Place One ' + Math.random(), type: 'communal', area })).json();
    const p2 = await (await postJson('/api/places', { name: 'Place Two ' + Math.random(), type: 'communal', area })).json();
    await postJson('/api/places', { name: 'Elsewhere ' + Math.random(), type: 'communal', area: 'Somewhere Else ' + Math.random() });

    const single = await (await fetch(`${baseUrl}/api/places/${p1.place.id}/export`)).json();
    assert.deepEqual(single.places, [p1.place]);

    const byArea = await (await fetch(`${baseUrl}/api/places/export?area=${encodeURIComponent(area)}`)).json();
    const byAreaIds = byArea.places.map((p) => p.id).sort();
    assert.deepEqual(byAreaIds, [p1.place.id, p2.place.id].sort());

    const all = await (await fetch(`${baseUrl}/api/places/export`)).json();
    assert.ok(all.places.some((p) => p.id === p1.place.id) && all.places.some((p) => p.id === p2.place.id));
  });

  test('POST /api/places/import drops ownerIds unknown to the target world, with a warning', async () => {
    // Owner exists in the SOURCE world; import targets a different, fresh
    // world where that character was never created — the real scenario this
    // warning is for (a place exported from one world, imported into another).
    const { character } = await (await postJson('/api/characters', { name: 'Source Owner ' + Math.random(), description: 'Test.' })).json();
    const { place } = await (await postJson('/api/places', {
      name: 'Owned Elsewhere ' + Math.random(), type: 'private', ownerIds: [character.id],
    })).json();
    const { world: otherWorld } = await (await postJson('/api/worlds', { name: 'Import Target ' + Math.random(), mode: 'empty' })).json();

    const res = await fetch(`${baseUrl}/api/places/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-World-Id': otherWorld.id },
      body: JSON.stringify({ places: [place] }),
    });
    assert.equal(res.status, 201);
    const { places: imported, warnings } = await res.json();
    assert.equal(imported.length, 1);
    assert.deepEqual(imported[0].ownerIds, []);
    assert.equal(warnings.length, 1);
  });

  test('POST /api/places/import disambiguates an id that collides with an existing place in the target world', async () => {
    const sameName = 'Collision House ' + Math.random();
    const { place: existing } = await (await postJson('/api/places', { name: sameName, type: 'communal' })).json();

    const { places: imported } = await (await postJson('/api/places/import', {
      places: [{ name: sameName, type: 'communal' }],
    })).json();
    assert.notEqual(imported[0].id, existing.id);
    assert.ok(imported[0].id.startsWith(existing.id));
  });

  test('POST /api/places/import keeps ownerIds that DO resolve in the target world', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Real Owner ' + Math.random(), description: 'Test.' })).json();
    const { places: imported, warnings } = await (await postJson('/api/places/import', {
      places: [{ name: 'Reimportable House ' + Math.random(), type: 'private', ownerIds: [character.id] }],
    })).json();
    assert.deepEqual(imported[0].ownerIds, [character.id]);
    assert.deepEqual(warnings, []);
  });
});

describe('World export/import (whole-world zip bundle)', () => {
  function worldHeaders(id, extra = {}) {
    return { ...extra, headers: { ...(extra.headers || {}), 'X-World-Id': id } };
  }

  test('round-trips characters/places/chat/memories through export -> import as a new world', async () => {
    const { world: src } = await (await postJson('/api/worlds', { name: 'Export Source ' + Math.random(), mode: 'empty' })).json();

    const { character } = await (await fetch(`${baseUrl}/api/characters`, worldHeaders(src.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Export Char', description: 'Test.' }),
    }))).json();
    const { place } = await (await fetch(`${baseUrl}/api/places`, worldHeaders(src.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Export Place', type: 'communal' }),
    }))).json();
    await fetch(`${baseUrl}/api/places/${place.id}/enter`, worldHeaders(src.id, { method: 'POST' }));

    // A memory row inserted directly (bypasses the OpenRouter-dependent
    // reply pipeline this test suite otherwise avoids) — isolates the
    // export/import zip mechanism from real generation.
    const srcWorld = registry.get(src.id);
    const memoryId = 'export-test-mem-1';
    const embedding = encodeEmbedding([0.1, 0.2, 0.3, 0.4]);
    srcWorld.db.prepare(`
      INSERT INTO memories (id, persona_key, text, embedding, place_id, day, time_of_day, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memoryId, 'none', 'Something memorable happened.', embedding, place.id, 1, 'noon', new Date().toISOString());
    srcWorld.db.prepare('INSERT INTO memory_participants (memory_id, character_id) VALUES (?, ?)').run(memoryId, character.id);
    upsertMemoryVectors(srcWorld.db, memoryId, [character.id], [embedding]);

    const exportRes = await fetch(`${baseUrl}/api/worlds/${src.id}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeHistory: true }),
    });
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get('content-type'), 'application/zip');
    const zipBuffer = Buffer.from(await exportRes.arrayBuffer());
    assert.ok(zipBuffer.length > 0);

    const form = new FormData();
    form.append('bundle', new Blob([zipBuffer], { type: 'application/zip' }), 'world.zip');
    form.append('name', 'Imported World ' + Math.random());
    const importRes = await fetch(`${baseUrl}/api/worlds/import`, { method: 'POST', body: form });
    assert.equal(importRes.status, 201);
    const { world: imported, warnings } = await importRes.json();
    assert.deepEqual(warnings, []);

    const { characters: destChars } = await (await fetch(`${baseUrl}/api/characters`, worldHeaders(imported.id))).json();
    assert.ok(destChars.some((c) => c.name === 'Export Char'));

    const { places: destPlaces } = await (await fetch(`${baseUrl}/api/places`, worldHeaders(imported.id))).json();
    // A whole-world import preserves original ids (raw file copy, not a
    // re-slugified merge like /api/places/import) — chat logs are keyed by
    // placeId filename, so ids must survive unchanged for chat history to
    // still resolve to the right place after import.
    assert.ok(destPlaces.some((p) => p.id === place.id && p.name === 'Export Place'));

    const destWorld = registry.get(imported.id);
    assert.equal(destWorld.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
    assert.equal(destWorld.db.prepare('SELECT text FROM memories WHERE id = ?').get(memoryId)?.text, 'Something memorable happened.');
    assert.equal(destWorld.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n, 1);

    const { log } = await (await fetch(`${baseUrl}/api/places/${place.id}/chat`, worldHeaders(imported.id))).json();
    assert.ok(log.length > 0);
  });

  test('includeHistory:false excludes chat logs from the export', async () => {
    const { world: src } = await (await postJson('/api/worlds', { name: 'No History Source ' + Math.random(), mode: 'empty' })).json();
    const { place } = await (await fetch(`${baseUrl}/api/places`, worldHeaders(src.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'History Place', type: 'communal' }),
    }))).json();
    await fetch(`${baseUrl}/api/places/${place.id}/enter`, worldHeaders(src.id, { method: 'POST' }));

    const exportRes = await fetch(`${baseUrl}/api/worlds/${src.id}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeHistory: false }),
    });
    const zipBuffer = Buffer.from(await exportRes.arrayBuffer());

    const form = new FormData();
    form.append('bundle', new Blob([zipBuffer], { type: 'application/zip' }), 'world.zip');
    const { world: imported } = await (await fetch(`${baseUrl}/api/worlds/import`, { method: 'POST', body: form })).json();

    const { log } = await (await fetch(`${baseUrl}/api/places/${place.id}/chat`, worldHeaders(imported.id))).json();
    assert.equal(log.length, 0);
  });

  test('POST /api/worlds/import 400s without a file', async () => {
    const form = new FormData();
    const res = await fetch(`${baseUrl}/api/worlds/import`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
  });

  test('cleans up the newly-created world if the import fails partway through (corrupt db.json)', async () => {
    // manifest.json is valid (so peekManifest and registry.create both
    // succeed, same as a real import) — the corruption is in db.json, which
    // importWorldBundle only gets to (and JSON.parses) after the world
    // already exists, exercising the post-creation failure/cleanup path.
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ formatVersion: 1, worldName: 'Corrupt DB Test', includeHistory: true }));
    zip.file('db.json', 'this is not valid json{{{');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const { worlds: before } = await (await fetch(`${baseUrl}/api/worlds`)).json();

    const form = new FormData();
    form.append('bundle', new Blob([buffer], { type: 'application/zip' }), 'world.zip');
    const res = await fetch(`${baseUrl}/api/worlds/import`, { method: 'POST', body: form });
    assert.equal(res.status, 500);

    const { worlds: after } = await (await fetch(`${baseUrl}/api/worlds`)).json();
    assert.equal(after.length, before.length, 'no orphaned world should remain after a failed import');
    assert.ok(!after.some((w) => w.name === 'Corrupt DB Test'), 'the failed import\'s world should not exist');
  });

  test('POST /api/worlds/import skips zip-slip entries that try to escape the world directory', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ formatVersion: 1, worldName: 'Zip Slip Test', includeHistory: true }));
    // A crafted entry name that path.join would otherwise resolve to
    // tmpRoot/zip-slip-escaped.json — four levels up out of the destination
    // world's chats/ dir (.../data/worlds/<id>/chats). The import must skip
    // it rather than write outside the world directory (see restoreDirFromZip).
    zip.file('chats/../../../../zip-slip-escaped.json', JSON.stringify([{ type: 'system', text: 'pwned' }]));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const form = new FormData();
    form.append('bundle', new Blob([buffer], { type: 'application/zip' }), 'world.zip');
    const res = await fetch(`${baseUrl}/api/worlds/import`, { method: 'POST', body: form });
    assert.equal(res.status, 201);

    assert.ok(!fs.existsSync(path.join(tmpRoot, 'zip-slip-escaped.json')), 'zip-slip entry must not escape the world dir');
  });
});

describe('PNG card export/import (characters, personas, places)', () => {
  test('GET /api/characters/:id/card.png downloads a re-importable PNG card', async () => {
    const { character } = await (await postJson('/api/characters', {
      name: 'Card Char ' + Math.random(), description: 'A test character for card export.', personality: 'Curious.',
    })).json();

    const res = await fetch(`${baseUrl}/api/characters/${character.id}/card.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.ok(buffer.length > 0);
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); // PNG signature

    const form = new FormData();
    form.append('card', new Blob([buffer], { type: 'image/png' }), 'card.png');
    const importRes = await fetch(`${baseUrl}/api/characters`, { method: 'POST', body: form });
    assert.equal(importRes.status, 201);
    const { character: reimported } = await importRes.json();
    assert.equal(reimported.name, character.name);
    assert.equal(reimported.description, character.description);
    assert.equal(reimported.personality, character.personality);
  });

  test('GET /api/characters/:id/card.png 404s for an unknown id', async () => {
    assert.equal((await fetch(`${baseUrl}/api/characters/not-a-real-id/card.png`)).status, 404);
  });

  test('GET /api/personas/:id/card.png downloads a re-importable PNG card', async () => {
    const { persona } = await (await postJson('/api/personas', { name: 'Card Persona ' + Math.random(), description: 'Test persona.' })).json();

    const res = await fetch(`${baseUrl}/api/personas/${persona.id}/card.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buffer = Buffer.from(await res.arrayBuffer());

    const form = new FormData();
    form.append('card', new Blob([buffer], { type: 'image/png' }), 'card.png');
    const importRes = await fetch(`${baseUrl}/api/personas/import`, { method: 'POST', body: form });
    assert.equal(importRes.status, 201);
    const { personas: reimported } = await importRes.json();
    assert.equal(reimported.length, 1);
    assert.equal(reimported[0].name, persona.name);
    assert.equal(reimported[0].description, persona.description);
    assert.notEqual(reimported[0].id, persona.id);
  });

  test('GET /api/places/:id/card.png downloads a re-importable PNG card, dropping ownerIds (only names travel)', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Card Owner ' + Math.random(), description: 'Test.' })).json();
    const { place } = await (await postJson('/api/places', {
      name: 'Card Place ' + Math.random(), type: 'private', ownerIds: [character.id], area: 'Card Test Area',
    })).json();

    const res = await fetch(`${baseUrl}/api/places/${place.id}/card.png`);
    assert.equal(res.status, 200);
    const buffer = Buffer.from(await res.arrayBuffer());

    const form = new FormData();
    form.append('card', new Blob([buffer], { type: 'image/png' }), 'card.png');
    const importRes = await fetch(`${baseUrl}/api/places/import`, { method: 'POST', body: form });
    assert.equal(importRes.status, 201);
    const { places: reimported, warnings } = await importRes.json();
    assert.equal(reimported.length, 1);
    assert.equal(reimported[0].name, place.name);
    assert.equal(reimported[0].type, 'private');
    assert.equal(reimported[0].area, place.area);
    assert.deepEqual(reimported[0].ownerIds, []); // card carries display names only, not resolvable ids
    assert.deepEqual(warnings, []);
  });

  test('POST /api/personas/import and /api/places/import reject a non-PNG file upload', async () => {
    const badForm = () => {
      const form = new FormData();
      form.append('card', new Blob([Buffer.from('not a png')], { type: 'image/png' }), 'card.png');
      return form;
    };
    const personaRes = await fetch(`${baseUrl}/api/personas/import`, { method: 'POST', body: badForm() });
    assert.equal(personaRes.status, 400);
    const placeRes = await fetch(`${baseUrl}/api/places/import`, { method: 'POST', body: badForm() });
    assert.equal(placeRes.status, 400);
  });
});

describe('Avatar upload via PUT /api/characters/:id and PUT /api/personas/:id', () => {
  const tinyPng = () => new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });

  test('PUT /api/characters/:id with an avatar file sets avatarUrl and writes the file to disk', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Avatar Char', description: 'x' })).json();
    const form = new FormData();
    form.append('avatar', tinyPng(), 'avatar.png');
    const res = await fetch(`${baseUrl}/api/characters/${character.id}`, { method: 'PUT', body: form });
    assert.equal(res.status, 200);
    const { character: updated } = await res.json();
    assert.equal(updated.avatarUrl, `${registry.getDefault().avatarUrlBase}/${character.id}.png`);
    assert.ok(fs.existsSync(path.join(registry.getDefault().avatarDir, `${character.id}.png`)));
  });

  test('PUT /api/characters/:id replaces an existing avatar (same id+ext, new file written)', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Replace Char', description: 'x' })).json();
    const form1 = new FormData();
    form1.append('avatar', tinyPng(), 'avatar.png');
    const { character: withAvatar } = await (await fetch(`${baseUrl}/api/characters/${character.id}`, { method: 'PUT', body: form1 })).json();
    assert.ok(fs.existsSync(path.join(registry.getDefault().avatarDir, path.basename(withAvatar.avatarUrl))));

    const form2 = new FormData();
    form2.append('avatar', tinyPng(), 'avatar2.png');
    const { character: replaced } = await (await fetch(`${baseUrl}/api/characters/${character.id}`, { method: 'PUT', body: form2 })).json();
    assert.equal(replaced.avatarUrl, withAvatar.avatarUrl);
    assert.ok(fs.existsSync(path.join(registry.getDefault().avatarDir, path.basename(replaced.avatarUrl))));
  });

  test('PUT /api/characters/:id still accepts a plain JSON body (no avatar) for text-only edits', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Text Only Char', description: 'x' })).json();
    const res = await fetch(`${baseUrl}/api/characters/${character.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed Char' }),
    });
    assert.equal(res.status, 200);
    const { character: updated } = await res.json();
    assert.equal(updated.name, 'Renamed Char');
    assert.equal(updated.avatarUrl, null);
  });

  test('PUT /api/personas/:id with an avatar file sets avatarUrl and writes the file to disk', async () => {
    const { persona } = await (await postJson('/api/personas', { name: 'Avatar Persona', description: 'x' })).json();
    const form = new FormData();
    form.append('avatar', tinyPng(), 'avatar.png');
    const res = await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: 'PUT', body: form });
    assert.equal(res.status, 200);
    const { persona: updated } = await res.json();
    assert.equal(updated.avatarUrl, `${registry.getDefault().avatarUrlBase}/personas/${persona.id}.png`);
    assert.ok(fs.existsSync(path.join(registry.getDefault().personaAvatarDir, `${persona.id}.png`)));
  });

  test('PUT /api/personas/:id replaces an existing avatar (same id+ext, new file written)', async () => {
    const { persona } = await (await postJson('/api/personas', { name: 'Replace Persona', description: 'x' })).json();
    const form1 = new FormData();
    form1.append('avatar', tinyPng(), 'avatar.png');
    const { persona: withAvatar } = await (await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: 'PUT', body: form1 })).json();

    const form2 = new FormData();
    form2.append('avatar', tinyPng(), 'avatar2.png');
    const { persona: replaced } = await (await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: 'PUT', body: form2 })).json();
    assert.equal(replaced.avatarUrl, withAvatar.avatarUrl);
    assert.ok(fs.existsSync(path.join(registry.getDefault().personaAvatarDir, path.basename(replaced.avatarUrl))));
  });

  test('PUT /api/characters/:id and PUT /api/personas/:id reject a non-image avatar mimetype', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Bad Avatar Char', description: 'x' })).json();
    const { persona } = await (await postJson('/api/personas', { name: 'Bad Avatar Persona', description: 'x' })).json();
    const badForm = () => {
      const form = new FormData();
      form.append('avatar', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'avatar.txt');
      return form;
    };
    assert.equal((await fetch(`${baseUrl}/api/characters/${character.id}`, { method: 'PUT', body: badForm() })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/personas/${persona.id}`, { method: 'PUT', body: badForm() })).status, 400);
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

  test('every new place-chat entry carries the current in-world day/timeOfDay', async () => {
    await postJson('/api/world/time', { day: 9, timeOfDay: 'sunrise' });
    const place = await makePlace('Timestamped Hall');
    const { log } = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    assert.equal(log[0].day, 9);
    assert.equal(log[0].timeOfDay, 'sunrise');
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
    const charsPath = path.join(defaultWorldDataDir(), 'characters.json');
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

  // metCharacterIds (GET /api/world) is cached per-world and invalidated on
  // every place-chat write — this specifically checks the cache doesn't go
  // stale: a GET before the character has spoken must not "lock in" a
  // pre-greeting snapshot that a later GET, after they've spoken, still returns.
  test('GET /api/world\'s metCharacterIds picks up a character speaking for the first time, even after an earlier GET cached the world', async () => {
    const place = await makePlace('Cache Check Hall');
    const { character } = await (await postJson('/api/characters', { name: 'Cache Check Greeter', description: 'Friendly.' })).json();
    const charsPath = path.join(defaultWorldDataDir(), 'characters.json');
    const chars = JSON.parse(fs.readFileSync(charsPath, 'utf-8'));
    chars.find((c) => c.id === character.id).greetings = ['Hello from the cache test!'];
    fs.writeFileSync(charsPath, JSON.stringify(chars));
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeId: place.id, greetingIndex: 0 }),
    });

    const before = await (await fetch(`${baseUrl}/api/world`)).json();
    assert.ok(!before.metCharacterIds.includes(character.id), 'not met yet — no greeting fired');

    await postJson(`/api/places/${place.id}/enter`, {}); // fires the scripted greeting (a type:'char' entry)

    const after = await (await fetch(`${baseUrl}/api/world`)).json();
    assert.ok(after.metCharacterIds.includes(character.id), 'the earlier GET must not have cached a stale, pre-greeting result');
  });

  test('a greeting-only arrival (no generation) still records the greeting into memory', async () => {
    const place = await makePlace('Memorable Greeting Hall');
    const { character } = await (await postJson('/api/characters', { name: 'Sole Greeter', description: 'Warm.' })).json();
    const charsPath = path.join(defaultWorldDataDir(), 'characters.json');
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
    const chatPath = path.join(defaultWorldDataDir(), 'chats', `${place.id}.json`);
    assert.equal(fs.existsSync(chatPath), true);

    await fetch(`${baseUrl}/api/places/${place.id}`, { method: 'DELETE' });
    assert.equal(fs.existsSync(chatPath), false);
  });

  test('persisted entries carry stable ids', async () => {
    const place = await makePlace('Identified Hall');
    const { log } = await (await postJson(`/api/places/${place.id}/enter`, {})).json();
    assert.ok(log[0].id);
  });

  // "Nobody to react" branches (empty place / all-inactive) used to always
  // answer with plain JSON regardless of cfg.streaming — but the frontend
  // picks its fetch path *before* knowing the room's character state, so a
  // streaming client parsing a plain-JSON body through its SSE reader got
  // zero events, leaving the user's own line stuck on the id-less
  // optimistic placeholder (un-deletable/un-editable until leaving and
  // re-entering the place). See respondAfterSilentBranch in server.js.
  function parseSseFrames(body) {
    return body.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')));
  }

  test('an empty-place say with streaming enabled responds as valid SSE carrying a real-id user line', async () => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real', streaming: true, narratorEnabled: false });
    const place = await makePlace('Streaming Empty Hall');

    const res = await fetch(`${baseUrl}/api/places/${place.id}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello?' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const frames = parseSseFrames(await res.text());
    const doneFrame = frames.find((f) => f.type === 'done');
    assert.ok(doneFrame, 'expected a done event in the SSE stream');
    const userEntry = doneFrame.log.find((e) => e.type === 'user');
    assert.ok(userEntry?.id, 'the user line must carry a real id, not the id-less optimistic placeholder shape');

    await postJson('/api/settings', { streaming: false, narratorEnabled: true });
    await postJson('/api/settings/clear-key', {});
  });

  test('an all-inactive-present say with streaming enabled also responds as valid SSE carrying a real-id user line', async () => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real', streaming: true, narratorEnabled: false });
    const place = await makePlace('Streaming Inactive Hall');
    const character = await placeCharacter('Streaming Inactive Occupant', place.id);
    await fetch(`${baseUrl}/api/characters/${character.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }),
    });

    const res = await fetch(`${baseUrl}/api/places/${place.id}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Anyone?' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const frames = parseSseFrames(await res.text());
    const doneFrame = frames.find((f) => f.type === 'done');
    assert.ok(doneFrame, 'expected a done event in the SSE stream');
    const userEntry = doneFrame.log.find((e) => e.type === 'user');
    assert.ok(userEntry?.id, 'the user line must carry a real id, not the id-less optimistic placeholder shape');

    await postJson('/api/settings', { streaming: false, narratorEnabled: true });
    await postJson('/api/settings/clear-key', {});
  });
});

describe('Persona-scoped "last place" (recordLastPlaceForActivePersona)', () => {
  async function makePlace(name) {
    const res = await postJson('/api/places', { name, type: 'communal' });
    return (await res.json()).place;
  }
  async function makePersona(name) {
    const { persona } = await (await postJson('/api/personas', { name, description: 'A test persona.' })).json();
    return persona;
  }

  test('entering a place records it on the active persona, and updates on the next entry', async () => {
    const persona = await makePersona('Wanderer');
    await postJson('/api/personas/active', { id: persona.id });
    const hallA = await makePlace('Last Place Hall A');
    const hallB = await makePlace('Last Place Hall B');

    await postJson(`/api/places/${hallA.id}/enter`, {});
    let { personas } = await (await fetch(`${baseUrl}/api/personas`)).json();
    assert.equal(personas.find((p) => p.id === persona.id).lastPlaceId, hallA.id);

    await postJson(`/api/places/${hallB.id}/enter`, {});
    ({ personas } = await (await fetch(`${baseUrl}/api/personas`)).json());
    assert.equal(personas.find((p) => p.id === persona.id).lastPlaceId, hallB.id);

    await postJson('/api/personas/active', { id: null });
  });

  test('with no active persona, entering a place is a no-op for lastPlaceId', async () => {
    await postJson('/api/personas/active', { id: null });
    const persona = await makePersona('Bystander');
    const place = await makePlace('No Active Persona Hall');
    await postJson(`/api/places/${place.id}/enter`, {});
    const { personas } = await (await fetch(`${baseUrl}/api/personas`)).json();
    assert.equal(personas.find((p) => p.id === persona.id).lastPlaceId, undefined);
  });

  test('lastPlaceId is stripped from persona export — meaningless across an import boundary', async () => {
    const persona = await makePersona('Exported Wanderer');
    await postJson('/api/personas/active', { id: persona.id });
    const place = await makePlace('Export Boundary Hall');
    await postJson(`/api/places/${place.id}/enter`, {});

    const single = await (await fetch(`${baseUrl}/api/personas/${persona.id}/export`)).json();
    assert.equal(single.personas[0].lastPlaceId, undefined);

    const all = await (await fetch(`${baseUrl}/api/personas/export`)).json();
    assert.equal(all.personas.find((p) => p.id === persona.id).lastPlaceId, undefined);

    await postJson('/api/personas/active', { id: null });
  });
});

describe('Texting: GET/POST /api/texts/:characterId (validation paths — no real OpenRouter call)', () => {
  async function makeCharacter(name) {
    const { character } = await (await postJson('/api/characters', { name, description: 'Texts sometimes.' })).json();
    return character;
  }

  test('GET 404s for an unknown character', async () => {
    assert.equal((await fetch(`${baseUrl}/api/texts/nope`)).status, 404);
  });

  test('a fresh conversation starts empty', async () => {
    const character = await makeCharacter('Fresh Contact');
    const { log } = await (await fetch(`${baseUrl}/api/texts/${character.id}`)).json();
    assert.deepEqual(log, []);
  });

  test('send 404s for an unknown character', async () => {
    assert.equal((await postJson('/api/texts/nope/send', { text: 'Hi?' })).status, 404);
  });

  test('send rejects empty text', async () => {
    const character = await makeCharacter('Silent Contact');
    assert.equal((await postJson(`/api/texts/${character.id}/send`, { text: '   ' })).status, 400);
  });

  test('sending with no API key persists the user line, reports the error, generates no reply', async () => {
    const character = await makeCharacter('No Key Contact');
    const { log, error } = await (await postJson(`/api/texts/${character.id}/send`, { text: 'You around?' })).json();
    assert.match(error, /API key/i);
    assert.equal(log.length, 1);
    assert.equal(log[0].type, 'user');
    assert.equal(log[0].text, 'You around?');
  });

  test('the user line persists across a GET after a failed send', async () => {
    const character = await makeCharacter('Persisted Contact');
    await postJson(`/api/texts/${character.id}/send`, { text: 'Ping.' });
    const { log } = await (await fetch(`${baseUrl}/api/texts/${character.id}`)).json();
    assert.equal(log.length, 1);
    assert.equal(log[0].text, 'Ping.');
    assert.ok(log[0].id);
  });

  test('two characters get independent conversation logs', async () => {
    const a = await makeCharacter('Contact A');
    const b = await makeCharacter('Contact B');
    await postJson(`/api/texts/${a.id}/send`, { text: 'Message for A.' });

    const logA = (await (await fetch(`${baseUrl}/api/texts/${a.id}`)).json()).log;
    const logB = (await (await fetch(`${baseUrl}/api/texts/${b.id}`)).json()).log;
    assert.equal(logA.length, 1);
    assert.equal(logB.length, 0);
  });

  test('a new text entry carries the current in-world day/timeOfDay', async () => {
    await postJson('/api/world/time', { day: 7, timeOfDay: 'evening' });
    const character = await makeCharacter('Timestamped Contact');
    const { log } = await (await postJson(`/api/texts/${character.id}/send`, { text: 'What time is it there?' })).json();
    assert.equal(log[0].day, 7);
    assert.equal(log[0].timeOfDay, 'evening');
  });
});

describe('Texting: delete message (DELETE /api/texts/:characterId/messages/:entryId)', () => {
  async function makeCharacter(name) {
    const { character } = await (await postJson('/api/characters', { name, description: 'Texts sometimes.' })).json();
    return character;
  }

  test('404s for an unknown character', async () => {
    const res = await fetch(`${baseUrl}/api/texts/nope/messages/whatever`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('404s for an unknown message id', async () => {
    const character = await makeCharacter('Delete Test A');
    const res = await fetch(`${baseUrl}/api/texts/${character.id}/messages/not-a-real-entry`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('removes the message from the log', async () => {
    const character = await makeCharacter('Delete Test B');
    const sendRes = await (await postJson(`/api/texts/${character.id}/send`, { text: 'delete me' })).json();
    const entry = sendRes.log.find((e) => e.text === 'delete me');
    assert.ok(entry, 'expected the user line to be in the log');

    const res = await fetch(`${baseUrl}/api/texts/${character.id}/messages/${entry.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(!data.log.some((e) => e.id === entry.id));
  });
});

describe('Texting: retry (POST /api/texts/:characterId/retry)', () => {
  const realFetch = globalThis.fetch;
  function mockOpenRouterFetch(handler) {
    return async (url, opts) => {
      if (typeof url === 'string' && url.includes('/chat/completions')) return handler(url, opts);
      return realFetch(url, opts);
    };
  }
  async function makeCharacter(name) {
    const { character } = await (await postJson('/api/characters', { name, description: 'Texts sometimes.' })).json();
    return character;
  }

  test('rejects retry with nothing sent yet', async () => {
    const character = await makeCharacter('Retry Test A');
    const res = await postJson(`/api/texts/${character.id}/retry`, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /say something first/i);
  });

  test('rejects retry when the last message already has a reply', async (t) => {
    const character = await makeCharacter('Retry Test B');
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'a reply' } }] }), { status: 200 })));

    await postJson(`/api/texts/${character.id}/send`, { text: 'hi' });
    const res = await postJson(`/api/texts/${character.id}/retry`, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /already has a reply/i);
    await postJson('/api/settings/clear-key', {});
  });

  test('re-runs generation for a trailing message with no reply', async (t) => {
    const character = await makeCharacter('Retry Test C');
    await postJson(`/api/texts/${character.id}/send`, { text: 'anyone?' }); // no key -> guaranteed zero replies

    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'finally replying' } }] }), { status: 200 })));

    const res = await postJson(`/api/texts/${character.id}/retry`, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.log.some((e) => e.type === 'char' && e.text === 'finally replying'));
    await postJson('/api/settings/clear-key', {});
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
    const chatPath = path.join(defaultWorldDataDir(), 'chats', `${placeId}.json`);
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

describe('Active participants (promote/demote)', () => {
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

  async function setActive(charId, active) {
    return fetch(`${baseUrl}/api/characters/${charId}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
    });
  }

  async function isActive(charId) {
    const { placements } = await (await fetch(`${baseUrl}/api/world`)).json();
    return placements[charId]?.active !== false;
  }

  test('a freshly-placed character is active by default', async () => {
    const place = await makePlace('Default Active Hall');
    const char = await placeCharacter('Newcomer', place.id);
    assert.equal(await isActive(char.id), true);
  });

  test('demoting sets active: false; promoting sets it back', async () => {
    const place = await makePlace('Toggle Hall');
    const char = await placeCharacter('Togglable', place.id);

    let res = await setActive(char.id, false);
    assert.equal(res.status, 200);
    assert.equal(await isActive(char.id), false);

    res = await setActive(char.id, true);
    assert.equal(res.status, 200);
    assert.equal(await isActive(char.id), true);
  });

  test('setting active alone (no placeId in the body) requires an existing placement', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Unplaced', description: 'Nowhere.' })).json();
    const res = await setActive(character.id, false);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /placeId is required/i);
  });

  test('re-placing (moving) a demoted character resets them to active', async () => {
    const placeA = await makePlace('Origin Hall');
    const placeB = await makePlace('Destination Hall');
    const char = await placeCharacter('Wanderer', placeA.id);
    await setActive(char.id, false);
    assert.equal(await isActive(char.id), false);

    await fetch(`${baseUrl}/api/characters/${char.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId: placeB.id }),
    });
    assert.equal(await isActive(char.id), true);
  });

  test('changing only greetingIndex does not disturb the active flag', async () => {
    const place = await makePlace('Greeting Index Hall');
    const char = await placeCharacter('Greetable', place.id);
    await setActive(char.id, false);

    await fetch(`${baseUrl}/api/characters/${char.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ greetingIndex: null }),
    });
    assert.equal(await isActive(char.id), false);
  });

  test('say with everyone present but nobody active: no API-key error, a "no one reacts" note, and the round is still recorded into bystanders\' memory', async () => {
    const place = await makePlace('Quiet Crowd Hall');
    const bystander = await placeCharacter('Bystander', place.id);
    await setActive(bystander.id, false);
    await postJson(`/api/places/${place.id}/enter`, {});

    const { log, error } = await (await postJson(`/api/places/${place.id}/say`, { text: 'Anyone want to chat?' })).json();
    assert.equal(error, undefined); // the silent-round path never calls runReactionRound, so no API-key error
    assert.equal(log[log.length - 2].type, 'user');
    assert.match(log[log.length - 1].text, /no one reacts/i);
    assert.equal(log[log.length - 1].type, 'system');

    // Memory recording is fire-and-forget — poll briefly for it to land.
    let memories = [];
    for (let i = 0; i < 40; i++) {
      memories = (await (await fetch(`${baseUrl}/api/memory/${bystander.id}`)).json()).memories;
      if (memories.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(memories.length, 1);
    assert.ok(memories[0].text.includes('Anyone want to chat?'));
  });

  test('say with a mix of active and inactive characters still attempts generation (surfaces the usual "no API key" error)', async () => {
    const place = await makePlace('Mixed Crowd Hall');
    await placeCharacter('Speaker', place.id);
    const quiet = await placeCharacter('Quiet One', place.id);
    await setActive(quiet.id, false);
    await postJson(`/api/places/${place.id}/enter`, {});

    const { error } = await (await postJson(`/api/places/${place.id}/say`, { text: 'Hello?' })).json();
    assert.match(error, /API key/i); // at least one active participant -> normal generation path, not the silent one
  });

  test('retry with everyone present but nobody active behaves the same as say — silent round, no error', async () => {
    const place = await makePlace('Quiet Crowd Retry Hall');
    const bystander = await placeCharacter('Retry Bystander', place.id);
    await setActive(bystander.id, false);
    await postJson(`/api/places/${place.id}/enter`, {});
    await postJson(`/api/places/${place.id}/say`, { text: 'Hmm.' });
    // The above already resolves via the silent path (no dangling user
    // message), so drive retry from a manually-seeded dangling user line.
    const chatPath = path.join(defaultWorldDataDir(), 'chats', `${place.id}.json`);
    const log = JSON.parse(fs.readFileSync(chatPath, 'utf-8'));
    log.push({ id: 'usr-retry-1', type: 'user', text: 'Still there?' });
    fs.writeFileSync(chatPath, JSON.stringify(log));

    const { error, log: afterRetry } = await (await postJson(`/api/places/${place.id}/retry`, {})).json();
    assert.equal(error, undefined);
    assert.match(afterRetry[afterRetry.length - 1].text, /no one reacts/i);
  });
});

describe("Narrator uses the active preset's maxReplyTokens, not a fixed cap", () => {
  const realFetch = globalThis.fetch;
  function mockOpenRouterFetch(handler) {
    return async (url, opts) => {
      if (typeof url === 'string' && url.includes('/chat/completions')) return handler(url, opts);
      return realFetch(url, opts);
    };
  }
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
  async function setActive(charId, active) {
    return fetch(`${baseUrl}/api/characters/${charId}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
    });
  }

  test('a demoted sole occupant triggers a narrator turn whose max_tokens matches the active preset, not the old fixed 150', async (t) => {
    const { preset } = await (await postJson('/api/presets', {
      name: 'Narrator Budget Test', prompts: [], maxReplyTokens: 777,
    })).json();
    await postJson('/api/presets/active', { id: preset.id });
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });

    const place = await makePlace('Narrator Budget Hall');
    const char = await placeCharacter('Sole Occupant', place.id);
    await setActive(char.id, false); // background-only -> shouldNarrate() fires unconditionally (see #13's fix)
    await postJson(`/api/places/${place.id}/enter`, {});

    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A narrator line.' } }] }), { status: 200 });
    }));

    const { log } = await (await postJson(`/api/places/${place.id}/say`, { text: 'Hello?' })).json();

    assert.ok(capturedBody, 'expected the narrator to actually call the (mocked) endpoint');
    assert.equal(capturedBody.max_tokens, 777);
    assert.ok(log.some((e) => e.type === 'narrator' && e.text === 'A narrator line.'));

    await postJson('/api/settings/clear-key', {});
  });

  test('cancelling mid-narrator-call in a silent round persists no fallback note and records no memory', async (t) => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
    const place = await makePlace('Cancelled Silent Round Hall');
    const char = await placeCharacter('Cancelled Occupant', place.id);
    await setActive(char.id, false); // background-only -> hits recordSilentRound unconditionally

    // Hangs until the request's own AbortSignal fires, then rejects the
    // same way a real aborted fetch would — exercises the real
    // res.on('close') -> signal -> callOpenRouter cancellation path.
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch((url, opts) => new Promise((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      });
    })));

    const controller = new AbortController();
    const sayPromise = fetch(`${baseUrl}/api/places/${place.id}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Anyone?' }), signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 30)); // let the request land and start the (hung) narrator call
    controller.abort();
    await assert.rejects(sayPromise);

    // Give the server a moment to process the abort.
    await new Promise((r) => setTimeout(r, 50));
    const { log } = await (await fetch(`${baseUrl}/api/places/${place.id}/chat`)).json();
    assert.ok(!log.some((e) => e.text === 'No one reacts.'), 'a cancelled silent round should not persist the fallback note');

    const { memories } = await (await fetch(`${baseUrl}/api/memory/${char.id}`)).json();
    assert.ok(!memories.some((m) => m.text.includes('Anyone?')), 'a cancelled silent round should not record a memory either');

    await postJson('/api/settings/clear-key', {});
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
    const chatPath = path.join(defaultWorldDataDir(), 'chats', `${place.id}.json`);
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

  test('GET is paginated: default limit/offset, total count, walking through pages with no gaps', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Paginated Pat', description: '.' })).json();
    for (let i = 0; i < 7; i++) {
      await postJson(`/api/memory/${character.id}`, { text: `Memory ${i}.` });
    }

    const defaultRes = await (await fetch(`${baseUrl}/api/memory/${character.id}`)).json();
    assert.equal(defaultRes.memories.length, 7); // fewer than the default limit — all come back
    assert.equal(defaultRes.total, 7);
    assert.equal(defaultRes.limit, 50);
    assert.equal(defaultRes.offset, 0);

    const page1 = await (await fetch(`${baseUrl}/api/memory/${character.id}?limit=3&offset=0`)).json();
    const page2 = await (await fetch(`${baseUrl}/api/memory/${character.id}?limit=3&offset=3`)).json();
    const page3 = await (await fetch(`${baseUrl}/api/memory/${character.id}?limit=3&offset=6`)).json();
    assert.equal(page1.memories.length, 3);
    assert.equal(page2.memories.length, 3);
    assert.equal(page3.memories.length, 1);
    assert.equal(page1.total, 7); // total reflects the whole set, not the page
    const allIds = [...page1.memories, ...page2.memories, ...page3.memories].map((m) => m.id);
    assert.equal(new Set(allIds).size, 7);
  });

  test('GET clamps an out-of-range limit and ignores a garbage offset', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Clamp Tester', description: '.' })).json();
    await postJson(`/api/memory/${character.id}`, { text: 'One memory.' });

    const overLimit = await (await fetch(`${baseUrl}/api/memory/${character.id}?limit=99999`)).json();
    assert.equal(overLimit.limit, 200); // capped, not 99999

    const garbage = await (await fetch(`${baseUrl}/api/memory/${character.id}?limit=nonsense&offset=-5`)).json();
    assert.equal(garbage.limit, 50); // falls back to the default
    assert.equal(garbage.offset, 0);
  });

  test('POST /api/memory/:characterId/query ranks every memory and marks which the real algorithm would recall', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Debug Target', description: '.' })).json();
    await postJson(`/api/memory/${character.id}`, { text: 'The visitor once asked about ancient maps.' });
    await postJson(`/api/memory/${character.id}`, { text: 'Nothing to do with the topic at all.' });

    const res = await postJson(`/api/memory/${character.id}/query`, { query: 'Tell me about the old maps.' });
    assert.equal(res.status, 200);
    const { results, minScoreUsed } = await res.json();
    assert.equal(results.length, 2); // every memory is ranked, not just the recalled ones
    assert.equal(typeof minScoreUsed, 'number'); // defaulted from Settings > Memory when not given explicitly
    const mapsResult = results.find((r) => r.text.includes('maps'));
    assert.ok(mapsResult);
    assert.equal(typeof mapsResult.score, 'number');
    assert.ok('selected' in mapsResult);
  });

  test('POST .../query accepts a minScore override, distinct from the configured default', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Threshold Tester', description: '.' })).json();
    await postJson(`/api/memory/${character.id}`, { text: 'About the old maps.' });

    const res = await postJson(`/api/memory/${character.id}/query`, { query: 'maps', minScore: 0.99 });
    const { minScoreUsed } = await res.json();
    assert.equal(minScoreUsed, 0.99);
  });

  test('POST .../query rejects a missing/empty query', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'No Query Given', description: '.' })).json();
    assert.equal((await postJson(`/api/memory/${character.id}/query`, {})).status, 400);
    assert.equal((await postJson(`/api/memory/${character.id}/query`, { query: '   ' })).status, 400);
  });

  test('POST .../query returns [] for a character with no memories, not an error', async () => {
    const { character } = await (await postJson('/api/characters', { name: 'Blank Slate Bo', description: '.' })).json();
    const res = await postJson(`/api/memory/${character.id}/query`, { query: 'anything' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results, []);
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

describe('Weather', () => {
  async function makeAreaPlace(name, area) {
    const res = await postJson('/api/places', { name, type: 'communal', area });
    return (await res.json()).place;
  }

  test('GET /api/weather lists known areas and conditions, with no entry for an area that has never rolled', async () => {
    const area = 'Weather Test Area ' + Math.random();
    await makeAreaPlace('Weather Cafe', area);
    const { areas, conditions, weather } = await (await fetch(`${baseUrl}/api/weather`)).json();
    assert.ok(areas.includes(area));
    assert.ok(Array.isArray(conditions) && conditions.length > 0);
    assert.equal(weather[area], undefined);
  });

  test('setting an area to manual pins a condition; day changes never overwrite it', async () => {
    const area = 'Manual Area ' + Math.random();
    await makeAreaPlace('Manual Place', area);

    const res = await postJson(`/api/weather/${encodeURIComponent(area)}`, { mode: 'manual', condition: 'stormy' });
    assert.equal(res.status, 200);
    const { weather: first } = await res.json();
    assert.equal(first[area].mode, 'manual');
    assert.equal(first[area].condition, 'stormy');

    const { time: before } = await (await fetch(`${baseUrl}/api/world`)).json();
    await postJson('/api/world/time', { day: before.day + 10 });

    const { weather: after } = await (await fetch(`${baseUrl}/api/weather`)).json();
    assert.equal(after[area].mode, 'manual');
    assert.equal(after[area].condition, 'stormy');
  });

  test('an auto area rolls to match the day after an explicit day change, and does not re-roll for a repeat of the same day', async () => {
    const area = 'Auto Area ' + Math.random();
    await makeAreaPlace('Auto Place', area);

    const { time: before } = await (await fetch(`${baseUrl}/api/world`)).json();
    const targetDay = before.day + 5;

    await postJson('/api/world/time', { day: targetDay });
    let { weather } = await (await fetch(`${baseUrl}/api/weather`)).json();
    assert.equal(weather[area].mode, 'auto');
    assert.equal(weather[area].updatedDay, targetDay);
    const firstCondition = weather[area].condition;

    await postJson('/api/world/time', { day: targetDay }); // same day again — no-op for weather
    ({ weather } = await (await fetch(`${baseUrl}/api/weather`)).json());
    assert.equal(weather[area].condition, firstCondition);
    assert.equal(weather[area].updatedDay, targetDay);
  });

  test('switching an area back to auto keeps its current condition immediately (no surprise change on the switch itself)', async () => {
    const area = 'Switch Area ' + Math.random();
    await makeAreaPlace('Switch Place', area);
    await postJson(`/api/weather/${encodeURIComponent(area)}`, { mode: 'manual', condition: 'snowy' });

    const res = await postJson(`/api/weather/${encodeURIComponent(area)}`, { mode: 'auto' });
    const { weather } = await res.json();
    assert.equal(weather[area].mode, 'auto');
    assert.equal(weather[area].condition, 'snowy');
  });

  test('rejects an unknown area, an invalid condition, and an unrecognized mode', async () => {
    const area = 'Validation Area ' + Math.random();
    await makeAreaPlace('Validation Place', area);

    assert.equal((await postJson('/api/weather/definitely-not-a-real-area', { mode: 'auto' })).status, 404);
    assert.equal((await postJson(`/api/weather/${encodeURIComponent(area)}`, { mode: 'manual', condition: 'apocalyptic' })).status, 400);
    assert.equal((await postJson(`/api/weather/${encodeURIComponent(area)}`, { mode: 'whatever' })).status, 400);
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

  test('POST /api/relationships/:characterId/query ranks every relationship, scored, no LLM call', async () => {
    const [a, b] = await twoCharacters();
    await putRel(a.id, b.id, ['guild contact']);
    await putRel(a.id, 'user', ['mentor']); // core, always selected

    const res = await postJson(`/api/relationships/${a.id}/query`, { query: 'tell me about the guild' });
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.equal(results.length, 2); // both rows ranked, not just the winner
    const guildResult = results.find((r) => r.otherId === b.id);
    assert.ok(guildResult);
    assert.equal(typeof guildResult.score, 'number');
    assert.equal(guildResult.otherName, b.name);
    const userResult = results.find((r) => r.otherId === 'user');
    assert.equal(userResult.selected, true);
    assert.equal(userResult.selectionReason, 'core');
  });

  test('POST .../query rejects a missing/empty query', async () => {
    const [a] = await twoCharacters();
    assert.equal((await postJson(`/api/relationships/${a.id}/query`, {})).status, 400);
    assert.equal((await postJson(`/api/relationships/${a.id}/query`, { query: '   ' })).status, 400);
  });

  test('POST .../query returns [] for a character with no relationships, not an error', async () => {
    const [a] = await twoCharacters();
    const res = await postJson(`/api/relationships/${a.id}/query`, { query: 'anything' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results, []);
  });

  test('POST .../query finds a person by description, via identity embeddings — "friend with blue eyes"', async () => {
    const wren = (await (await postJson('/api/characters', { name: 'Wren', description: 'Blue eyes, sharp grin.' })).json()).character;
    const dara = (await (await postJson('/api/characters', { name: 'Dara', description: 'Brown eyes, soft-spoken.' })).json()).character;
    const [a] = await twoCharacters();
    await putRel(a.id, wren.id, ['friend']);
    await putRel(a.id, dara.id, ['friend']);

    const res = await postJson(`/api/relationships/${a.id}/query`, { query: 'that friend of yours with the blue eyes' });
    const { results } = await res.json();
    const wrenResult = results.find((r) => r.otherId === wren.id);
    const daraResult = results.find((r) => r.otherId === dara.id);
    assert.ok(wrenResult.score > daraResult.score);
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

  test('narratorEnabled defaults to true and round-trips', async () => {
    const initial = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(initial.narratorEnabled, true);

    const off = await (await postJson('/api/settings', { narratorEnabled: false })).json();
    assert.equal(off.narratorEnabled, false);

    const on = await (await postJson('/api/settings', { narratorEnabled: true })).json();
    assert.equal(on.narratorEnabled, true);
  });

  test('a non-boolean narratorEnabled is ignored, leaving the previous value in place', async () => {
    await postJson('/api/settings', { narratorEnabled: false });
    const cfg = await (await postJson('/api/settings', { narratorEnabled: 'yes' })).json();
    assert.equal(cfg.narratorEnabled, false);
    await postJson('/api/settings', { narratorEnabled: true });
  });
});

describe('Message edit & delete', () => {
  async function placeWithChat() {
    const { place } = await (await postJson('/api/places', { name: 'Edit Hall ' + Math.random(), type: 'communal' })).json();
    const { character } = await (await postJson('/api/characters', { name: 'Edit Subject', description: '.' })).json();
    const chatPath = path.join(defaultWorldDataDir(), 'chats', `${place.id}.json`);
    fs.mkdirSync(path.dirname(chatPath), { recursive: true });
    fs.writeFileSync(chatPath, JSON.stringify([
      { id: 'sys-1', type: 'system', text: `You arrive at ${place.name}.` },
      { id: 'usr-1', type: 'user', text: 'Original user line.' },
      { id: 'msg-1', type: 'char', charId: character.id, name: character.name, text: 'Original reply.' },
      { id: 'narr-1', type: 'narrator', text: 'A bell tolls somewhere distant.' },
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
    assert.equal(log.length, 3);
    assert.equal((await del()).status, 404);
  });

  test('narrator messages can be edited like character/user messages', async () => {
    const { place } = await placeWithChat();
    const res = await fetch(`${baseUrl}/api/places/${place.id}/messages/narr-1`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'A cart rattles past instead.' }),
    });
    assert.equal(res.status, 200);
    const { log } = await res.json();
    assert.equal(log.find((e) => e.id === 'narr-1').text, 'A cart rattles past instead.');
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

describe('World (save-slot) management: /api/worlds', () => {
  function withWorld(worldId, opts = {}) {
    return { ...opts, headers: { ...(opts.headers || {}), 'X-World-Id': worldId } };
  }

  test('GET /api/worlds lists at least the default world', async () => {
    const { worlds, defaultWorldId } = await (await fetch(`${baseUrl}/api/worlds`)).json();
    assert.ok(worlds.length >= 1);
    assert.ok(worlds.some((w) => w.id === defaultWorldId));
  });

  test('POST /api/worlds creates a seeded world by default; rejects a blank name', async () => {
    const res = await postJson('/api/worlds', { name: 'Fantasy Campaign' });
    assert.equal(res.status, 201);
    const { world } = await res.json();
    assert.equal(world.name, 'Fantasy Campaign');
    assert.ok(world.id);

    const bad = await postJson('/api/worlds', { name: '   ' });
    assert.equal(bad.status, 400);
  });

  test('mode "empty" starts with no characters/places; mode "seeded" (default) gets the builtin cast on first read', async () => {
    const emptyRes = await postJson('/api/worlds', { name: 'Blank Slate', mode: 'empty' });
    const { world: emptyWorld } = await emptyRes.json();
    const emptyChars = await (await fetch(`${baseUrl}/api/characters`, withWorld(emptyWorld.id))).json();
    assert.deepEqual(emptyChars.characters, []);

    const seededRes = await postJson('/api/worlds', { name: 'Seeded World' });
    const { world: seededWorld } = await seededRes.json();
    const seededChars = await (await fetch(`${baseUrl}/api/characters`, withWorld(seededWorld.id))).json();
    assert.ok(seededChars.characters.length > 0); // BUILTIN_CHARACTERS seeded lazily on first read
  });

  test('PUT /api/worlds/:id renames; unknown id 404s', async () => {
    const { world } = await (await postJson('/api/worlds', { name: 'Original Name', mode: 'empty' })).json();
    const res = await fetch(`${baseUrl}/api/worlds/${world.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).world.name, 'Renamed');

    const missing = await fetch(`${baseUrl}/api/worlds/does-not-exist`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }),
    });
    assert.equal(missing.status, 404);
  });

  test('DELETE /api/worlds/:id removes it from the list; repeat delete 404s', async () => {
    const { world } = await (await postJson('/api/worlds', { name: 'Disposable', mode: 'empty' })).json();
    const del = await fetch(`${baseUrl}/api/worlds/${world.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const { worlds } = await (await fetch(`${baseUrl}/api/worlds`)).json();
    assert.equal(worlds.some((w) => w.id === world.id), false);

    const repeat = await fetch(`${baseUrl}/api/worlds/${world.id}`, { method: 'DELETE' });
    assert.equal(repeat.status, 404);
  });

  test('POST /api/worlds/:id/duplicate copies characters; includeHistory:false still copies but wipes memory', async () => {
    const { world: src } = await (await postJson('/api/worlds', { name: 'Dup Source', mode: 'empty' })).json();
    await fetch(`${baseUrl}/api/characters`, {
      method: 'POST', headers: { ...withWorld(src.id).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate Me', description: 'A test character.' }),
    });

    const dup = await (await fetch(`${baseUrl}/api/worlds/${src.id}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dup Target', includeHistory: false }),
    })).json();
    assert.equal(dup.world.name, 'Dup Target');

    const dupChars = await (await fetch(`${baseUrl}/api/characters`, withWorld(dup.world.id))).json();
    assert.ok(dupChars.characters.some((c) => c.name === 'Duplicate Me'));
  });

  test('unknown X-World-Id header 400s with code UNKNOWN_WORLD; missing header uses the default world', async () => {
    const bad = await fetch(`${baseUrl}/api/characters`, withWorld('not-a-real-world-id'));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'UNKNOWN_WORLD');

    const noHeader = await fetch(`${baseUrl}/api/characters`);
    assert.equal(noHeader.status, 200);
  });

  test('two worlds are fully isolated: a character/place/chat created in one is invisible from the other', async () => {
    const { world: a } = await (await postJson('/api/worlds', { name: 'World A', mode: 'empty' })).json();
    const { world: b } = await (await postJson('/api/worlds', { name: 'World B', mode: 'empty' })).json();

    const placeRes = await fetch(`${baseUrl}/api/places`, {
      method: 'POST', headers: { ...withWorld(a.id).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A-Only Place', type: 'communal' }),
    });
    const { place } = await placeRes.json();

    const aPlaces = await (await fetch(`${baseUrl}/api/places`, withWorld(a.id))).json();
    const bPlaces = await (await fetch(`${baseUrl}/api/places`, withWorld(b.id))).json();
    assert.ok(aPlaces.places.some((p) => p.id === place.id));
    assert.equal(bPlaces.places.some((p) => p.id === place.id), false);

    // Chat log for the same place id literally doesn't exist under B's dir.
    await fetch(`${baseUrl}/api/places/${place.id}/enter`, withWorld(a.id, { method: 'POST' }));
    const aChat = await (await fetch(`${baseUrl}/api/places/${place.id}/chat`, withWorld(a.id))).json();
    assert.ok(aChat.log.length > 0);
    const bChatRes = await fetch(`${baseUrl}/api/places/${place.id}/chat`, withWorld(b.id));
    assert.equal(bChatRes.status, 404); // the place doesn't exist in B at all
  });

  test('a streaming-capable route (SSE path skipped without a key, but routing honors the header) respects X-World-Id', async () => {
    const { world: a } = await (await postJson('/api/worlds', { name: 'SSE World', mode: 'empty' })).json();
    const res = await fetch(`${baseUrl}/api/places/nope/say`, withWorld(a.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hi.' }),
    }));
    assert.equal(res.status, 404); // place not found IN WORLD A specifically — proves the header was honored, not silently defaulted
  });
});
