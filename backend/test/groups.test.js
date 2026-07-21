// Route-level tests for Phase 4 (Group texting) — own temp FREEROAM_TEST_ROOT,
// same pattern as routes.test.js/calls.test.js. Cascade math itself has its
// own statistical coverage in textCascade.test.js; this exercises the route
// wiring end to end with Math.random mocked for a fully deterministic
// cascade path (rollContinues/pickReplier both read from it).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app, registry, server, baseUrl, tmpRoot;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-groups-test-'));
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
function putJson(urlPath, body) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function del(urlPath) {
  return fetch(`${baseUrl}${urlPath}`, { method: 'DELETE' });
}
async function getJson(urlPath) {
  return (await fetch(`${baseUrl}${urlPath}`)).json();
}

const realFetch = globalThis.fetch;
function mockOpenRouterFetch(handler) {
  return async (url, opts) => {
    if (typeof url === 'string' && url.includes('/chat/completions')) return handler(url, opts);
    return realFetch(url, opts);
  };
}

// Feeds Math.random a fixed sequence — both rollContinues and pickReplier
// read from it, so this fully determines a cascade's path (who replies,
// how many times). Falls back to 0.99 (guaranteed "stop" for any decayed
// chance) once the sequence is exhausted, so a test only needs to specify
// as many rolls as it cares about.
function mockRandomSequence(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.99);
}

describe('Groups: creation and validation', () => {
  test('rejects a missing name', async () => {
    const res = await postJson('/api/groups', { participantIds: ['ezra', 'mireille'] });
    assert.equal(res.status, 400);
  });

  test('rejects fewer than 2 participants', async () => {
    const res = await postJson('/api/groups', { name: 'Solo', participantIds: ['ezra'] });
    assert.equal(res.status, 400);
  });

  test('rejects an unknown character id', async () => {
    const res = await postJson('/api/groups', { name: 'Bad group', participantIds: ['ezra', 'nobody'] });
    assert.equal(res.status, 400);
  });

  test('creates a group with valid participants', async () => {
    const res = await postJson('/api/groups', { name: 'The Neighborhood', participantIds: ['ezra', 'mireille', 'soot'] });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.group.name, 'The Neighborhood');
    assert.deepEqual(data.group.participantIds.sort(), ['ezra', 'mireille', 'soot']);
    assert.ok(data.group.id);
  });

  test('GET /api/groups lists created groups', async () => {
    const { groups } = await getJson('/api/groups');
    assert.ok(groups.some((g) => g.name === 'The Neighborhood'));
  });

  test('GET /api/groups/:groupId 404s for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/groups/not-a-real-id`);
    assert.equal(res.status, 404);
  });

  test('DELETE /api/groups/:groupId removes it', async () => {
    const { group } = await (await postJson('/api/groups', { name: 'Temp', participantIds: ['ezra', 'soot'] })).json();
    const res = await fetch(`${baseUrl}/api/groups/${group.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const check = await fetch(`${baseUrl}/api/groups/${group.id}`);
    assert.equal(check.status, 404);
  });
});

describe('Groups: sending without an API key', () => {
  test('surfaces the no-API-key error rather than silently sending nothing', async () => {
    const { group } = await (await postJson('/api/groups', { name: 'No Key Group', participantIds: ['ezra', 'mireille'] })).json();
    const res = await postJson(`/api/groups/${group.id}/send`, { text: 'hello?' });
    assert.equal(res.status, 200); // the route itself succeeds — the user's line still persists
    const data = await res.json();
    assert.match(data.error, /API key/i);
    assert.equal(data.log[0].type, 'user');
    assert.equal(data.log.length, 1); // no cascade replies landed
  });
});

describe('Groups: the cascade (OpenRouter + Math.random mocked)', () => {
  let group;

  before(async () => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
    ({ group } = await (await postJson('/api/groups', { name: 'Cascade Test', participantIds: ['ezra', 'mireille'] })).json());
  });
  after(async () => {
    await postJson('/api/settings/clear-key', {});
  });

  test('rejects an empty message', async () => {
    const res = await postJson(`/api/groups/${group.id}/send`, { text: '   ' });
    assert.equal(res.status, 400);
  });

  test('the system prompt phrases this as a group text, naming the other participant', async (t) => {
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Noted.' } }] }), { status: 200 });
    }));
    // Force exactly one reply then stop: roll continues (0), pick index 0 (ezra), roll stops (0.99)
    t.mock.method(Math, 'random', mockRandomSequence([0, 0, 0.99]));

    const res = await postJson(`/api/groups/${group.id}/send`, { text: 'Morning, all.' });
    assert.equal(res.status, 200);

    const systemMessage = capturedBody.messages.find((m) => m.role === 'system').content;
    assert.match(systemMessage, /group text with/i);
    assert.match(systemMessage, /Mireille/); // the other participant, not the replier themselves
  });

  test('a forced two-reply cascade appends both entries with the right speakers, then stops', async (t) => {
    let call = 0;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      call += 1;
      const text = call === 1 ? 'Ezra here.' : 'Mireille here.';
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
    }));
    // iter1: roll continue (0), pick ezra (0 -> index 0)
    // iter2: roll continue (0), pick mireille (0.6 -> index 1 of 2)
    // iter3: roll stop (0.99)
    t.mock.method(Math, 'random', mockRandomSequence([0, 0, 0, 0.6, 0.99]));

    const res = await postJson(`/api/groups/${group.id}/send`, { text: 'Anyone around?' });
    assert.equal(res.status, 200);
    const data = await res.json();

    const charEntries = data.log.filter((e) => e.type === 'char');
    const lastTwo = charEntries.slice(-2);
    assert.equal(lastTwo[0].charId, 'ezra');
    assert.equal(lastTwo[0].text, 'Ezra here.');
    assert.equal(lastTwo[1].charId, 'mireille');
    assert.equal(lastTwo[1].text, 'Mireille here.');
  });

  test('a same-character back-to-back reply gets a follow-up directive, not silence or a repeat prompt', async (t) => {
    // The actual fix for the reported "character says hi twice" bug: when
    // the cap lets ezra go again right after his own last line, the prompt
    // needs an explicit "add something new" nudge — otherwise the message
    // array ends on his own assistant turn with nothing to react to and a
    // real model just restates itself. See lib/texting.js's selfContinuation.
    let call = 0;
    const payloads = [];
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      call += 1;
      payloads.push(JSON.parse(opts.body));
      const text = call === 1 ? 'hiii everyone!!' : 'omg one more thing!!';
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
    }));
    // iter1: roll continue (0), pick ezra (idx0 of 2)
    // iter2: roll continue (0), pick ezra again (streak=1 < cap 2, still eligible, idx0 again)
    // iter3: roll stop (0.99)
    t.mock.method(Math, 'random', mockRandomSequence([0, 0, 0, 0, 0.99]));

    const res = await postJson(`/api/groups/${group.id}/send`, { text: 'Hey all!' });
    assert.equal(res.status, 200);
    const data = await res.json();

    const charEntries = data.log.filter((e) => e.type === 'char').slice(-2);
    assert.equal(charEntries[0].charId, 'ezra');
    assert.equal(charEntries[1].charId, 'ezra');

    assert.equal(payloads.length, 2);
    const secondCallLast = payloads[1].messages[payloads[1].messages.length - 1];
    assert.equal(secondCallLast.role, 'user');
    assert.match(secondCallLast.content, /follow-up/i, 'expected the selfContinuation directive on the second call');

    const secondToLast = payloads[1].messages[payloads[1].messages.length - 2];
    assert.equal(secondToLast.role, 'assistant', "ezra's own first line should still be a clean assistant turn");
    assert.equal(secondToLast.content, 'hiii everyone!!');
  });

  test("every participant's memory records the round, including whoever didn't reply this time", async (t) => {
    // Fresh group where only one member is ever picked, so the other member's
    // memory can only have come from the shared-round recording, not from
    // ever generating a reply themselves.
    const { group: quietGroup } = await (await postJson('/api/groups', { name: 'Quiet Group', participantIds: ['ezra', 'soot'] })).json();

    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Just me.' } }] }), { status: 200 })));
    // roll continue (0), pick ezra (0), roll stop (0.99) — soot never replies
    t.mock.method(Math, 'random', mockRandomSequence([0, 0, 0.99]));

    await postJson(`/api/groups/${quietGroup.id}/send`, { text: 'Ping.' });

    const { memories: ezraMemories } = await getJson('/api/memory/ezra');
    const { memories: sootMemories } = await getJson('/api/memory/soot');
    assert.ok(ezraMemories.some((m) => m.text.includes('Just me.')));
    assert.ok(sootMemories.some((m) => m.text.includes('Just me.')), "soot's memory should include the round even though soot never replied");
  });

  test('the cascade never lets one character reply more than the configured cap in a row', async (t) => {
    // Base/decay near 1 so the cascade would run long if not for the cap —
    // stress the cap specifically, not the decay math (already covered in
    // textCascade.test.js).
    await postJson('/api/settings', { cascadeBaseChance: 0.99, cascadeDecayRate: 0.99, cascadePerCharacterCap: 2 });
    const { group: capGroup } = await (await postJson('/api/groups', { name: 'Cap Test', participantIds: ['ezra', 'mireille'] })).json();

    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200 })));
    // Always "continue" (0), always try to pick the same slot (0) — with only
    // 2 participants and a cap of 2, index 0 can mean different characters
    // once the cap forces an exclusion, so this alone proves the cap is
    // enforced (server never 500s, and no single charId appears 3x running).
    let n = 0;
    t.mock.method(Math, 'random', () => {
      n += 1;
      return n % 20 === 0 ? 0.999 : 0; // stop eventually so the test terminates
    });

    const res = await postJson(`/api/groups/${capGroup.id}/send`, { text: 'Go.' });
    assert.equal(res.status, 200);
    const data = await res.json();

    const speakers = data.log.filter((e) => e.type === 'char').map((e) => e.charId);
    let run = 1;
    for (let i = 1; i < speakers.length; i++) {
      run = speakers[i] === speakers[i - 1] ? run + 1 : 1;
      assert.ok(run <= 2, `charId ${speakers[i]} replied ${run} times in a row: ${speakers.join(',')}`);
    }

    await postJson('/api/settings', { cascadeBaseChance: 0.85, cascadeDecayRate: 0.98, cascadePerCharacterCap: 2 });
  });

  test('the default cap (2) allows a back-to-back double-text but never a third in a row', async (t) => {
    // Cap 2 is a deliberate default, not a bug — a character replying to
    // their own line once in a row reads as a natural double-text. What it
    // must never do is run a third time with nothing new from anyone else
    // to react to; groupHistoryFromLog's turn-merging (lib/texting.js) is
    // what keeps that from reading as a repeated-greeting glitch, not the
    // cap itself — see textCascade.js's comment for the full history.
    const settingsRes = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(settingsRes.cascadePerCharacterCap, 2, 'expected the default cap to be 2');

    const { group: defaultCapGroup } = await (await postJson('/api/groups', { name: 'Default Cap', participantIds: ['ezra', 'mireille'] })).json();
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200 })));
    let n = 0;
    t.mock.method(Math, 'random', () => {
      n += 1;
      return n % 20 === 0 ? 0.999 : 0;
    });

    const res = await postJson(`/api/groups/${defaultCapGroup.id}/send`, { text: 'Go.' });
    const data = await res.json();
    const speakers = data.log.filter((e) => e.type === 'char').map((e) => e.charId);
    let run = 1;
    for (let i = 1; i < speakers.length; i++) {
      run = speakers[i] === speakers[i - 1] ? run + 1 : 1;
      assert.ok(run <= 2, `charId ${speakers[i]} replied ${run} times in a row: ${speakers.join(',')}`);
    }
  });
});

describe('Groups: delete message', () => {
  let group;
  before(async () => {
    ({ group } = await (await postJson('/api/groups', { name: 'Delete Test', participantIds: ['ezra', 'mireille'] })).json());
  });

  test('404s for an unknown group', async () => {
    const res = await del('/api/groups/not-a-real-id/messages/whatever');
    assert.equal(res.status, 404);
  });

  test('404s for an unknown message id', async () => {
    const res = await del(`/api/groups/${group.id}/messages/not-a-real-entry`);
    assert.equal(res.status, 404);
  });

  test('removes the message from the log', async () => {
    await postJson('/api/settings', { apiKey: '' }); // no key — just want the user line persisted, no generation
    const sendRes = await (await postJson(`/api/groups/${group.id}/send`, { text: 'delete me' })).json();
    const entry = sendRes.log.find((e) => e.text === 'delete me');
    assert.ok(entry, 'expected the user line to be in the log');

    const res = await del(`/api/groups/${group.id}/messages/${entry.id}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(!data.log.some((e) => e.id === entry.id));
  });
});

describe('Groups: retry', () => {
  let group;
  before(async () => {
    await postJson('/api/settings', { apiKey: '' });
    ({ group } = await (await postJson('/api/groups', { name: 'Retry Test', participantIds: ['ezra', 'mireille'] })).json());
  });

  test('rejects retry with nothing sent yet', async () => {
    const res = await postJson(`/api/groups/${group.id}/retry`, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /say something first/i);
  });

  test('rejects retry when the last message already has a reply', async (t) => {
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200 })));
    t.mock.method(Math, 'random', mockRandomSequence([0, 0, 0.99])); // one reply lands

    await postJson(`/api/groups/${group.id}/send`, { text: 'hi' });
    const res = await postJson(`/api/groups/${group.id}/retry`, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /already has a reply/i);
  });

  test('re-runs the cascade for a trailing message with no reply', async (t) => {
    await postJson('/api/settings', { apiKey: '' }); // no key -> guaranteed zero replies land
    const { group: retryGroup } = await (await postJson('/api/groups', { name: 'Retry2', participantIds: ['ezra', 'mireille'] })).json();
    await postJson(`/api/groups/${retryGroup.id}/send`, { text: 'anyone?' });

    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'finally replying' } }] }), { status: 200 })));
    t.mock.method(Math, 'random', mockRandomSequence([0, 0, 0.99]));

    const res = await postJson(`/api/groups/${retryGroup.id}/retry`, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.log.some((e) => e.type === 'char' && e.text === 'finally replying'));
  });
});

describe('Groups: edit (rename + participants)', () => {
  let group;
  before(async () => {
    ({ group } = await (await postJson('/api/groups', { name: 'Edit Test', participantIds: ['ezra', 'mireille'] })).json());
  });

  test('404s for an unknown group', async () => {
    const res = await putJson('/api/groups/not-a-real-id', { name: 'New name' });
    assert.equal(res.status, 404);
  });

  test('renames the group', async () => {
    const res = await putJson(`/api/groups/${group.id}`, { name: 'Renamed' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.group.name, 'Renamed');

    const { groups } = await getJson('/api/groups');
    assert.ok(groups.some((g) => g.id === group.id && g.name === 'Renamed'));
  });

  test('rejects an empty rename', async () => {
    const res = await putJson(`/api/groups/${group.id}`, { name: '  ' });
    assert.equal(res.status, 400);
  });

  test('adds a participant', async () => {
    const res = await putJson(`/api/groups/${group.id}`, { participantIds: ['ezra', 'mireille', 'soot'] });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.group.participantIds.sort(), ['ezra', 'mireille', 'soot']);
  });

  test('rejects an unknown character id when editing participants', async () => {
    const res = await putJson(`/api/groups/${group.id}`, { participantIds: ['ezra', 'nobody'] });
    assert.equal(res.status, 400);
  });

  test('rejects dropping below 2 participants', async () => {
    const res = await putJson(`/api/groups/${group.id}`, { participantIds: ['ezra'] });
    assert.equal(res.status, 400);
  });

  test('removes a participant down to exactly 2', async () => {
    const res = await putJson(`/api/groups/${group.id}`, { participantIds: ['ezra', 'mireille'] });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.group.participantIds.sort(), ['ezra', 'mireille']);
  });
});
