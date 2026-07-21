// Route-level tests for Phase 3 (Calls) — own temp FREEROAM_TEST_ROOT, same
// pattern as routes.test.js. The interesting logic (snapshot/demote/restore,
// redacted bystander memory, call-aware narrator) lives directly in
// server.js's route handlers, not in a separate lib module, so this exercises
// it through real HTTP requests rather than unit-testing pure functions.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app, registry, server, baseUrl, tmpRoot;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-calls-test-'));
  process.env.FREEROAM_TEST_ROOT = tmpRoot;
  ({ app, registry } = await import('../server.js'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  registry.closeAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function postJson(urlPath, body) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function getJson(urlPath) {
  return (await fetch(`${baseUrl}${urlPath}`)).json();
}

function worldJsonPath() {
  return path.join(registry.getDefault().dataDir, 'world.json');
}
function readWorldJson() {
  return JSON.parse(fs.readFileSync(worldJsonPath(), 'utf-8'));
}
function writeWorldJson(data) {
  fs.writeFileSync(worldJsonPath(), JSON.stringify(data, null, 2));
}

const realFetch = globalThis.fetch;
// Same pattern as routes.test.js's mockOpenRouterFetch — only intercepts
// outbound OpenRouter completion calls, everything else (postJson/getJson
// hitting the real local test server) passes through untouched.
function mockOpenRouterFetch(handler) {
  return async (url, opts) => {
    if (typeof url === 'string' && url.includes('/chat/completions')) return handler(url, opts);
    return realFetch(url, opts);
  };
}

describe('Calls: demote on start / restore on end', () => {
  before(async () => {
    await postJson('/api/characters/mireille/place', { placeId: 'town-square' });
    await postJson('/api/characters/soot/place', { placeId: 'town-square', active: false });
    // Simulate mireille's placement predating the active-flag feature (no
    // explicit field at all) — the placement API always writes an explicit
    // true/false, so the only way to reach that state is a direct rewrite,
    // same as an old save file would look like.
    const world = readWorldJson();
    delete world.placements.mireille.active;
    writeWorldJson(world);
  });

  test('rejects starting a call with an unknown character', async () => {
    const res = await postJson('/api/calls/nobody/start', { placeId: 'town-square' });
    assert.equal(res.status, 404);
  });

  test('rejects starting a call at an unknown place', async () => {
    const res = await postJson('/api/calls/custodian/start', { placeId: 'nowhere' });
    assert.equal(res.status, 404);
  });

  test('rejects calling someone who is already present at that place', async () => {
    const res = await postJson('/api/calls/mireille/start', { placeId: 'town-square' });
    assert.equal(res.status, 400);
  });

  test('start demotes every present bystander, regardless of their prior active state', async () => {
    const res = await postJson('/api/calls/custodian/start', { placeId: 'town-square' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.callee.name, 'Custodian');
    assert.equal(data.placements.mireille.active, false); // had no explicit field before
    assert.equal(data.placements.soot.active, false); // was already false before
  });

  test('a second call at the same place is rejected while one is in progress', async () => {
    const res = await postJson('/api/calls/soot/start', { placeId: 'town-square' });
    assert.equal(res.status, 409);
  });

  test('appends a call-start system entry tagged call:true', async () => {
    const { log } = await getJson('/api/places/town-square/chat');
    const entry = log[log.length - 1];
    assert.equal(entry.type, 'system');
    assert.equal(entry.call, true);
    assert.match(entry.text, /Custodian/);
  });

  test('GET /api/places/:placeId/chat reports the active call', async () => {
    const { activeCall } = await getJson('/api/places/town-square/chat');
    assert.deepEqual(activeCall, { charId: 'custodian', name: 'Custodian' });
  });

  test('a normal /say at that place is rejected while the call is in progress', async () => {
    const res = await postJson('/api/places/town-square/say', { text: 'Hello?' });
    assert.equal(res.status, 409);
  });

  test('ending a call for a character with no active call is rejected', async () => {
    const res = await postJson('/api/calls/soot/end', { placeId: 'town-square' });
    assert.equal(res.status, 400);
  });

  test('end restores each bystander to their exact pre-call state, not blindly to active', async () => {
    const res = await postJson('/api/calls/custodian/end', { placeId: 'town-square' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal('active' in data.placements.mireille, false); // back to "no explicit field"
    assert.equal(data.placements.soot.active, false); // was demoted before the call too, stays demoted
  });

  test('appends a call-end system entry tagged call:true', async () => {
    const { log } = await getJson('/api/places/town-square/chat');
    const entry = log[log.length - 1];
    assert.equal(entry.type, 'system');
    assert.equal(entry.call, true);
    assert.match(entry.text, /ended/i);
  });

  test('activeCall clears once the call ends', async () => {
    const { activeCall } = await getJson('/api/places/town-square/chat');
    assert.equal(activeCall, null);
  });

  test('a normal /say at that place succeeds again once the call has ended', async () => {
    const res = await postJson('/api/places/town-square/say', { text: 'Anyone home?' });
    assert.equal(res.status, 200);
  });
});

describe('Calls: generation and redacted bystander memory (OpenRouter mocked)', () => {
  before(async () => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real', narratorEnabled: false });
    await postJson('/api/characters/mireille/place', { placeId: 'archive-house' });
    await postJson('/api/calls/custodian/start', { placeId: 'archive-house' });
  });
  after(async () => {
    await postJson('/api/calls/custodian/end', { placeId: 'archive-house' }).catch(() => {});
    await postJson('/api/settings/clear-key', {});
  });

  test('rejects an empty message', async () => {
    const res = await postJson('/api/calls/custodian/say', { placeId: 'archive-house', text: '  ' });
    assert.equal(res.status, 400);
  });

  test('rejects a call/character combination with no active call', async () => {
    const res = await postJson('/api/calls/soot/say', { placeId: 'archive-house', text: 'hey' });
    assert.equal(res.status, 400);
  });

  test('the system prompt phrases this as a phone call, not a text thread', async (t) => {
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Workshop. What is it now?' } }] }), { status: 200 });
    }));

    const res = await postJson('/api/calls/custodian/say', { placeId: 'archive-house', text: 'Got a minute?' });
    assert.equal(res.status, 200);

    const systemMessage = capturedBody.messages.find((m) => m.role === 'system').content;
    assert.match(systemMessage, /on a phone call with/i);
  });

  test('appends both lines to the place log, tagged call:true', async () => {
    const { log } = await getJson('/api/places/archive-house/chat');
    const userLine = log.find((e) => e.type === 'user' && e.text === 'Got a minute?');
    const charLine = log.find((e) => e.type === 'char' && e.charId === 'custodian');
    assert.ok(userLine && userLine.call);
    assert.ok(charLine && charLine.call);
    assert.equal(charLine.text, 'Workshop. What is it now?');
  });

  test("the callee's memory contains both sides of the exchange", async () => {
    const { memories } = await getJson('/api/memory/custodian');
    const callMemory = memories.find((m) => m.text.includes('Workshop. What is it now?'));
    assert.ok(callMemory, 'expected a memory containing the callee\'s reply');
    assert.match(callMemory.text, /Got a minute\?/);
  });

  test("a bystander's memory contains only the user's side, never the callee's reply", async () => {
    const { memories } = await getJson('/api/memory/mireille');
    const callMemory = memories.find((m) => m.text.includes('Got a minute?'));
    assert.ok(callMemory, 'expected a memory of the user\'s line');
    assert.doesNotMatch(callMemory.text, /Workshop\. What is it now\?/);
  });
});

describe('Calls: ambient bystander narration', () => {
  before(async () => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real', narratorEnabled: true });
    await postJson('/api/characters/soot/place', { placeId: 'old-ballroom' });
    await postJson('/api/calls/custodian/start', { placeId: 'old-ballroom' });
  });
  after(async () => {
    await postJson('/api/calls/custodian/end', { placeId: 'old-ballroom' }).catch(() => {});
    await postJson('/api/settings/clear-key', {});
  });

  test('fires the narrator for bystanders, told they are overhearing a call', async (t) => {
    let narratorSystemMessage = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const systemMessage = body.messages.find((m) => m.role === 'system')?.content || '';
      if (/you are the narrator/i.test(systemMessage)) {
        narratorSystemMessage = systemMessage;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Soot watches the doorway, unbothered.' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Go on.' } }] }), { status: 200 });
    }));

    const res = await postJson('/api/calls/custodian/say', { placeId: 'old-ballroom', text: 'Can you check the west wing?' });
    assert.equal(res.status, 200);

    assert.ok(narratorSystemMessage, 'expected the narrator to be invoked for the bystander');
    assert.match(narratorSystemMessage, /phone call/i);
    assert.match(narratorSystemMessage, /Custodian/);

    const { log } = await getJson('/api/places/old-ballroom/chat');
    const narratorEntry = [...log].reverse().find((e) => e.type === 'narrator');
    assert.ok(narratorEntry && narratorEntry.call, 'expected a call-tagged narrator entry in the log');
    assert.equal(narratorEntry.text, 'Soot watches the doorway, unbothered.');
  });
});
