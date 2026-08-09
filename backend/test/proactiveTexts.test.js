import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rollsProactiveText } from '../lib/proactiveTexts.js';
import { splitDueScheduledTexts } from '../lib/scheduledTexts.js';

describe('rollsProactiveText', () => {
  test('hits when the roll is below chance', () => {
    assert.equal(rollsProactiveText(0.002, () => 0.001), true);
  });

  test('misses when the roll is at or above chance', () => {
    assert.equal(rollsProactiveText(0.002, () => 0.002), false);
    assert.equal(rollsProactiveText(0.002, () => 0.5), false);
  });

  test('a chance of 0 never hits, regardless of the roll', () => {
    assert.equal(rollsProactiveText(0, () => 0), false);
  });

  test('a chance of 1 always hits (rng never reaches exactly 1)', () => {
    assert.equal(rollsProactiveText(1, () => 0.9999999), true);
  });

  test('defaults to Math.random when no rng is given', () => {
    assert.equal(typeof rollsProactiveText(0.5), 'boolean');
  });
});

describe('splitDueScheduledTexts', () => {
  const at = (day, timeOfDay) => ({ day, timeOfDay });

  test('due at exactly the scheduled slot, and anything earlier that day', () => {
    const list = [{ id: 'a', day: 2, timeOfDay: 'afternoon' }];
    assert.equal(splitDueScheduledTexts(list, at(2, 'afternoon')).due.length, 1);
    assert.equal(splitDueScheduledTexts(list, at(2, 'night')).due.length, 1);
  });

  test('not due earlier the same day or on an earlier day', () => {
    const list = [{ id: 'a', day: 2, timeOfDay: 'afternoon' }];
    assert.equal(splitDueScheduledTexts(list, at(2, 'morning')).due.length, 0);
    assert.equal(splitDueScheduledTexts(list, at(1, 'night')).due.length, 0);
  });

  test('a time jump straight past the slot still counts as due', () => {
    const list = [{ id: 'a', day: 2, timeOfDay: 'afternoon' }];
    assert.equal(splitDueScheduledTexts(list, at(4, 'sunrise')).due.length, 1);
  });

  test('an unknown stored timeOfDay fires rather than stranding forever', () => {
    const list = [{ id: 'a', day: 2, timeOfDay: 'the witching hour' }];
    assert.equal(splitDueScheduledTexts(list, at(2, 'sunrise')).due.length, 1);
  });

  test('splits a mixed list without losing entries', () => {
    const list = [
      { id: 'due', day: 1, timeOfDay: 'morning' },
      { id: 'later', day: 3, timeOfDay: 'evening' },
    ];
    const { due, remaining } = splitDueScheduledTexts(list, at(2, 'noon'));
    assert.deepEqual(due.map((e) => e.id), ['due']);
    assert.deepEqual(remaining.map((e) => e.id), ['later']);
  });
});

// Route-level tests get their own temp world/server (own temp
// FREEROAM_TEST_ROOT, same pattern as calls.test.js/groups.test.js) rather
// than sharing routes.test.js's instance — a chance:1 roll needs to fire
// for every non-excluded character in the world, and routes.test.js
// accumulates dozens of characters across its full run, which would make
// that slow and flaky here.
describe('Proactive texts: routes', () => {
  let app, registry, server, baseUrl, tmpRoot;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-proactive-test-'));
    process.env.FREEROAM_TEST_ROOT = tmpRoot;
    ({ app, registry } = await import('../server.js'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    // Set once up front (except the "requires an API key" test, which
    // clears it back out for its own duration) rather than relying on test
    // execution order to have left a key behind.
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-test-not-real' }),
    });
    // A fresh world lazily seeds 4 builtin characters (ezra/mireille/soot/
    // custodian) on first read — left in place, they'd permanently occupy
    // slots in every maybeSendProactiveTexts roll pool this file exercises,
    // which MAX_PROACTIVE_TEXTS_PER_ROUND caps at 3. Clear them so each
    // test's own characters are the only ones competing for those slots.
    const { characters: builtins } = await (await fetch(`${baseUrl}/api/characters`)).json();
    await Promise.all(builtins.map((c) => fetch(`${baseUrl}/api/characters/${c.id}`, { method: 'DELETE' })));
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    registry.closeAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  async function getJson(urlPath) {
    return (await fetch(`${baseUrl}${urlPath}`)).json();
  }
  // Registers cleanup via t.after() so this character doesn't linger in the
  // shared world once its own test ends — these tests rely on chance=1
  // hitting every non-excluded character, and MAX_PROACTIVE_TEXTS_PER_ROUND
  // caps that at 3, so letting characters accumulate across tests would make
  // later tests' rolls exceed the cap and flake.
  async function makeCharacter(name, t) {
    const { character } = await (await postJson('/api/characters', { name, description: 'Might text you.' })).json();
    if (t) t.after(async () => { await fetch(`${baseUrl}/api/characters/${character.id}`, { method: 'DELETE' }); });
    return character;
  }
  const realFetch = globalThis.fetch;
  function mockOpenRouterFetch(handler) {
    return async (url, opts) => {
      if (typeof url === 'string' && url.includes('/chat/completions')) return handler(url, opts);
      return realFetch(url, opts);
    };
  }
  // Fire-and-forget proactive generation isn't awaited by the triggering
  // request — give it a moment to land before asserting on it.
  function settle(ms = 250) {
    return new Promise((r) => setTimeout(r, ms));
  }

  test('manual trigger 404s for an unknown character', async () => {
    const res = await postJson('/api/texts/nope/trigger', {});
    assert.equal(res.status, 404);
  });

  test('manual trigger requires an API key', async (t) => {
    const character = await makeCharacter('No Key Trigger', t);
    await postJson('/api/settings/clear-key', {});
    const res = await postJson(`/api/texts/${character.id}/trigger`, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /API key/i);
    await postJson('/api/settings', { apiKey: 'sk-test-not-real' });
  });

  test('manual trigger writes a proactive text entry and a memory', async (t) => {
    const character = await makeCharacter('Trigger Test', t);
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Hey, you free later?' } }] }), { status: 200 })));

    const res = await postJson(`/api/texts/${character.id}/trigger`, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    const entry = data.log.find((e) => e.text === 'Hey, you free later?');
    assert.ok(entry);
    assert.equal(entry.proactive, true);

    const { memories } = await getJson(`/api/memory/${character.id}`);
    assert.ok(memories.some((m) => m.text.includes('Hey, you free later?')));
  });

  test('the final prompt turn tells the character to text unprompted', async (t) => {
    const character = await makeCharacter('Prompt Check', t);
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Reply.' } }] }), { status: 200 });
    }));
    await postJson(`/api/texts/${character.id}/trigger`, {});
    const lastMessage = capturedBody.messages[capturedBody.messages.length - 1];
    assert.equal(lastMessage.role, 'user');
    assert.match(lastMessage.content, /out of the blue/i);
  });

  test('a hint in the trigger body anchors the final prompt turn to the promised subject', async (t) => {
    const character = await makeCharacter('Hinted Prompt Check', t);
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'About that spreadsheet…' } }] }), { status: 200 });
    }));
    const res = await postJson(`/api/texts/${character.id}/trigger`, { hint: "I'll text you about that spreadsheet of our earnings" });
    assert.equal(res.status, 200);
    const lastMessage = capturedBody.messages[capturedBody.messages.length - 1];
    assert.equal(lastMessage.role, 'user');
    assert.match(lastMessage.content, /spreadsheet of our earnings/);
    assert.ok(!/out of the blue/i.test(lastMessage.content));
  });

  test('a non-string or blank hint is ignored, falling back to the out-of-the-blue directive', async (t) => {
    const character = await makeCharacter('Bad Hint Check', t);
    let capturedBody = null;
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Reply.' } }] }), { status: 200 });
    }));
    await postJson(`/api/texts/${character.id}/trigger`, { hint: '   ' });
    const lastMessage = capturedBody.messages[capturedBody.messages.length - 1];
    assert.match(lastMessage.content, /out of the blue/i);
  });

  test('unread count reflects proactive texts and clears once the conversation is opened', async (t) => {
    const character = await makeCharacter('Unread Test', t);
    const before = await getJson('/api/texts/unread');

    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Ping!' } }] }), { status: 200 })));
    await postJson(`/api/texts/${character.id}/trigger`, {});

    const afterTrigger = await getJson('/api/texts/unread');
    assert.equal(afterTrigger.total, before.total + 1);
    assert.equal(afterTrigger.byCharacterId[character.id], 1, 'the per-contact breakdown should attribute the unread text to this character');

    await getJson(`/api/texts/${character.id}`); // opening the conversation marks it read
    const afterOpen = await getJson('/api/texts/unread');
    assert.equal(afterOpen.total, before.total);
    assert.equal(afterOpen.byCharacterId[character.id], undefined, 'a fully-read contact should not appear in the breakdown at all');
  });

  test('/say excludes present characters from the roll, includes absent ones', async (t) => {
    const placeRes = await postJson('/api/places', { name: 'Proactive Test Place', type: 'communal' });
    const place = (await placeRes.json()).place;
    const present = await makeCharacter('Present Roller', t);
    const absent = await makeCharacter('Absent Roller', t);
    await fetch(`${baseUrl}/api/characters/${present.id}/place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeId: place.id }),
    });

    await postJson('/api/settings', { textingChancePerChar: 1 });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Some reply.' } }] }), { status: 200 })));

    await postJson(`/api/places/${place.id}/say`, { text: 'Hello?' });
    await settle();

    const presentLog = (await getJson(`/api/texts/${present.id}`)).log;
    const absentLog = (await getJson(`/api/texts/${absent.id}`)).log;
    assert.ok(!presentLog.some((e) => e.proactive), 'a present character should never get a proactive text');
    assert.ok(absentLog.some((e) => e.proactive), 'an absent character with chance=1 should get a proactive text');

    await postJson('/api/settings', { textingChancePerChar: 0.002 });
  });

  test('/texts/:characterId/send excludes the texted character from the roll', async (t) => {
    const texted = await makeCharacter('Texted Roller', t);
    const other = await makeCharacter('Other Roller', t);

    await postJson('/api/settings', { textingChancePerChar: 1 });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Some reply.' } }] }), { status: 200 })));

    await postJson(`/api/texts/${texted.id}/send`, { text: 'hey' });
    await settle();

    const textedLog = (await getJson(`/api/texts/${texted.id}`)).log;
    const otherLog = (await getJson(`/api/texts/${other.id}`)).log;
    assert.ok(!textedLog.some((e) => e.proactive), 'the character just texted should never also get a proactive text this round');
    assert.ok(otherLog.some((e) => e.proactive), 'another character with chance=1 should get a proactive text');

    await postJson('/api/settings', { textingChancePerChar: 0.002 });
  });

  test('/api/groups/:groupId/send excludes every participant from the roll, includes an outsider', async (t) => {
    const memberA = await makeCharacter('Group Member A', t);
    const memberB = await makeCharacter('Group Member B', t);
    const outsider = await makeCharacter('Group Outsider', t);
    const { group } = await (await postJson('/api/groups', { name: 'Proactive Group', participantIds: [memberA.id, memberB.id] })).json();

    await postJson('/api/settings', { textingChancePerChar: 1 });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Some reply.' } }] }), { status: 200 })));

    await postJson(`/api/groups/${group.id}/send`, { text: 'hey everyone' });
    await settle();

    const memberALog = (await getJson(`/api/texts/${memberA.id}`)).log;
    const memberBLog = (await getJson(`/api/texts/${memberB.id}`)).log;
    const outsiderLog = (await getJson(`/api/texts/${outsider.id}`)).log;
    assert.ok(!memberALog.some((e) => e.proactive), 'a group participant should never get a proactive text from their own group round');
    assert.ok(!memberBLog.some((e) => e.proactive), 'a group participant should never get a proactive text from their own group round');
    assert.ok(outsiderLog.some((e) => e.proactive), 'a character outside the group with chance=1 should get a proactive text');

    await postJson('/api/settings', { textingChancePerChar: 0.002 });
  });

  test('caps how many characters fire per round, even when every one of them rolls a hit', async (t) => {
    const sender = await makeCharacter('Burst Sender', t);
    const bystanders = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeCharacter(`Burst Bystander ${i}`, t)),
    );

    await postJson('/api/settings', { textingChancePerChar: 1 }); // every non-excluded character rolls a hit
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Some reply.' } }] }), { status: 200 })));

    await postJson(`/api/texts/${sender.id}/send`, { text: 'hi everyone' });
    await settle();

    const logs = await Promise.all(bystanders.map((c) => getJson(`/api/texts/${c.id}`).then((r) => r.log)));
    const firedCount = logs.filter((log) => log.some((e) => e.proactive)).length;
    assert.ok(firedCount <= 3, `expected at most 3 proactive texts to fire, got ${firedCount}`);

    await postJson('/api/settings', { textingChancePerChar: 0.002 });
  });

  test('a chance of 0 never fires a proactive text', async (t) => {
    const bystander = await makeCharacter('Never Rolls', t);
    await postJson('/api/settings', { textingChancePerChar: 0 });
    t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Should not appear.' } }] }), { status: 200 })));

    const other = await makeCharacter('Zero Chance Sender', t);
    await postJson(`/api/texts/${other.id}/send`, { text: 'hi' });
    await settle();

    const bystanderLog = (await getJson(`/api/texts/${bystander.id}`)).log;
    assert.equal(bystanderLog.length, 0);
    await postJson('/api/settings', { textingChancePerChar: 0.002 });
  });

  // Scheduled texts share this file's harness on purpose: firing IS a
  // proactive text (generateProactiveText with a hint), just triggered by
  // world time reaching a stored slot instead of a dice roll.
  describe('Scheduled texts', () => {
    function deleteJson(urlPath) {
      return fetch(`${baseUrl}${urlPath}`, { method: 'DELETE' });
    }
    // Every test pins world time explicitly first — time is shared state in
    // this world, and firing happens as a side effect of setting it.
    function setTime(day, timeOfDay) {
      return postJson('/api/world/time', { day, timeOfDay });
    }
    // Registers cleanup so a test's pending schedule never leaks into a
    // later test's time changes (same hygiene as makeCharacter).
    async function scheduleText(t, body) {
      const res = await postJson('/api/scheduled-texts', body);
      const data = await res.json().catch(() => ({}));
      if (t && data.entry) t.after(async () => { await deleteJson(`/api/scheduled-texts/${data.entry.id}`); });
      return { res, data };
    }

    test('POST validates character, day, and timeOfDay', async (t) => {
      const character = await makeCharacter('Validation Target', t);
      assert.equal((await postJson('/api/scheduled-texts', { characterId: 'nope', day: 2, timeOfDay: 'evening' })).status, 404);
      assert.equal((await postJson('/api/scheduled-texts', { characterId: character.id, day: 2, timeOfDay: 'high noon' })).status, 400);
      assert.equal((await postJson('/api/scheduled-texts', { characterId: character.id, day: 0, timeOfDay: 'evening' })).status, 400);
    });

    test('a future schedule stays pending and fires nothing', async (t) => {
      await setTime(1, 'morning');
      const character = await makeCharacter('Patient Promiser', t);
      let llmCalls = 0;
      t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () => {
        llmCalls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Too early.' } }] }), { status: 200 });
      }));

      const { res } = await scheduleText(t, { characterId: character.id, day: 5, timeOfDay: 'evening', reason: 'the ledger findings' });
      assert.equal(res.status, 200);
      await settle();

      const { pending } = await getJson('/api/scheduled-texts');
      assert.equal(pending.filter((e) => e.characterId === character.id).length, 1);
      assert.equal((await getJson(`/api/texts/${character.id}`)).log.length, 0);
      assert.equal(llmCalls, 0);
    });

    test('advancing world time to the slot fires the text, with the reason steering the prompt', async (t) => {
      await setTime(1, 'morning');
      const character = await makeCharacter('Punctual Promiser', t);
      let capturedBody = null;
      t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'About those findings…' } }] }), { status: 200 });
      }));

      await scheduleText(t, { characterId: character.id, day: 1, timeOfDay: 'afternoon', reason: "findings on Shad Torson's daughters" });
      await settle();
      assert.equal(capturedBody, null, 'must not fire before its slot');

      await setTime(1, 'afternoon');
      await settle();

      const lastMessage = capturedBody.messages[capturedBody.messages.length - 1];
      assert.match(lastMessage.content, /findings on Shad Torson's daughters/);
      assert.match(lastMessage.content, /follow through/i);

      const log = (await getJson(`/api/texts/${character.id}`)).log;
      const entry = log.find((e) => e.text === 'About those findings…');
      assert.ok(entry);
      assert.equal(entry.proactive, true);

      const { pending } = await getJson('/api/scheduled-texts');
      assert.equal(pending.filter((e) => e.characterId === character.id).length, 0);
    });

    test('a schedule whose slot is already past fires immediately on creation', async (t) => {
      await setTime(3, 'evening');
      const character = await makeCharacter('Late Promiser', t);
      t.mock.method(globalThis, 'fetch', mockOpenRouterFetch(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'Sorry this took a while.' } }] }), { status: 200 })));

      await scheduleText(t, { characterId: character.id, day: 3, timeOfDay: 'morning', reason: 'an overdue update' });
      await settle();

      const log = (await getJson(`/api/texts/${character.id}`)).log;
      assert.ok(log.some((e) => e.text === 'Sorry this took a while.' && e.proactive));
      const { pending } = await getJson('/api/scheduled-texts');
      assert.equal(pending.filter((e) => e.characterId === character.id).length, 0);
      await setTime(1, 'morning');
    });

    test('DELETE cancels a pending schedule; a second DELETE 404s', async (t) => {
      await setTime(1, 'morning');
      const character = await makeCharacter('Cancelled Promiser', t);
      const { data } = await scheduleText(null, { characterId: character.id, day: 9, timeOfDay: 'night' });
      assert.equal((await deleteJson(`/api/scheduled-texts/${data.entry.id}`)).status, 200);
      assert.equal((await deleteJson(`/api/scheduled-texts/${data.entry.id}`)).status, 404);
      const { pending } = await getJson('/api/scheduled-texts');
      assert.equal(pending.filter((e) => e.characterId === character.id).length, 0);
    });
  });
});
