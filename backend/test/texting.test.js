import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTextingMessages, historyFromLog, groupHistoryFromLog } from '../lib/texting.js';

describe('buildTextingMessages', () => {
  const baseScene = {
    char: { name: 'Ezra Vane', description: 'Precise, dry-witted archivist.', personality: 'Reserved, exacting.' },
    persona: null,
    textingPromptTemplate: 'Reply in short, casual text messages.',
  };

  test('returns [system, ...history]', () => {
    const history = [{ role: 'user', content: 'hey' }, { role: 'assistant', content: 'hi' }];
    const messages = buildTextingMessages(baseScene, history);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'system');
    assert.deepEqual(messages.slice(1), history);
  });

  test('defaults to an empty history when none is given', () => {
    assert.deepEqual(buildTextingMessages(baseScene), [{ role: 'system', content: buildTextingMessages(baseScene)[0].content }]);
  });

  test('includes the texting prompt template text', () => {
    const [system] = buildTextingMessages(baseScene);
    assert.ok(system.content.includes('Reply in short, casual text messages.'));
  });

  test('includes character name, description, and personality', () => {
    const [system] = buildTextingMessages(baseScene);
    assert.ok(system.content.includes('Ezra Vane'));
    assert.ok(system.content.includes('Precise, dry-witted archivist.'));
    assert.ok(system.content.includes('Personality: Reserved, exacting.'));
  });

  test('uses "the visitor" when no persona is active', () => {
    const [system] = buildTextingMessages(baseScene);
    assert.ok(system.content.includes('texting with the visitor'));
    assert.ok(!system.content.includes('(texting you):')); // no persona block without a persona
  });

  test('uses the persona name, with a persona block when a description is given', () => {
    const scene = { ...baseScene, persona: { name: 'Kael', description: 'A quiet wanderer.' } };
    const [system] = buildTextingMessages(scene);
    assert.ok(system.content.includes('texting with Kael'));
    assert.ok(system.content.includes('Kael (texting you):\nA quiet wanderer.'));
  });

  test('includes the in-world day/weekday/time-of-day when given', () => {
    const scene = { ...baseScene, time: { day: 3, timeOfDay: 'evening' } };
    const [system] = buildTextingMessages(scene);
    assert.match(system.content, /Day 3 \(Wednesday\), evening/);
  });

  test('omits the day/time line entirely when no time is given', () => {
    const [system] = buildTextingMessages(baseScene);
    assert.ok(!system.content.includes('Day '));
  });

  test('appends a memory block when memories are present, omits it otherwise', () => {
    const withMemories = buildTextingMessages({ ...baseScene, memories: ['Once mentioned a locked archive.'] })[0];
    assert.ok(withMemories.content.includes('What you remember:'));
    assert.ok(withMemories.content.includes('Once mentioned a locked archive.'));

    const without = buildTextingMessages(baseScene)[0];
    assert.ok(!without.content.includes('What you remember:'));
  });

  test('appends a relationships block when given, omits it otherwise', () => {
    const withRelationships = buildTextingMessages({ ...baseScene, relationships: ['Kael is your old friend.'] })[0];
    assert.ok(withRelationships.content.includes('What you know about people:'));
    assert.ok(withRelationships.content.includes('Kael is your old friend.'));

    const without = buildTextingMessages(baseScene)[0];
    assert.ok(!without.content.includes('What you know about people:'));
  });

  test('group texts phrase the roster line and warn against repeating what was already said', () => {
    const scene = { ...baseScene, persona: { name: 'Shad', description: null }, groupMembers: ['Mireille', 'Soot'] };
    const [system] = buildTextingMessages(scene);
    assert.ok(system.content.includes('in a group text with Shad, Mireille, and Soot'));
    assert.match(system.content, /don't repeat a greeting or message/i);
  });

  test('1-on-1 texts omit the group roster and repeat-warning language', () => {
    const [system] = buildTextingMessages(baseScene);
    assert.ok(!system.content.includes('group text'));
    assert.ok(!system.content.includes("don't repeat"));
  });

  test('proactive appends a final directive turn to originate a message unprompted', () => {
    const scene = { ...baseScene, persona: { name: 'Shad', description: null }, proactive: true };
    const messages = buildTextingMessages(scene, [{ role: 'assistant', content: 'an earlier text' }]);
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content, /out of the blue/i);
  });

  test('selfContinuation appends a follow-up directive instead, distinct from proactive', () => {
    const scene = { ...baseScene, persona: { name: 'Shad', description: null }, selfContinuation: true };
    const messages = buildTextingMessages(scene, [{ role: 'assistant', content: 'hi daddy!!' }]);
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content, /follow-up/i);
    assert.ok(!last.content.includes('out of the blue'));
  });

  test('proactive and selfContinuation are mutually exclusive — proactive wins if both are set', () => {
    const scene = { ...baseScene, proactive: true, selfContinuation: true };
    const messages = buildTextingMessages(scene);
    const last = messages[messages.length - 1];
    assert.match(last.content, /out of the blue/i);
  });

  test('neither directive is appended when both flags are false/absent', () => {
    const messages = buildTextingMessages(baseScene, [{ role: 'user', content: 'hi' }]);
    assert.equal(messages.length, 2); // just [system, history] — no extra turn
  });
});

describe('historyFromLog', () => {
  test('maps user entries to "user" and char entries to "assistant"', () => {
    const log = [
      { type: 'user', text: 'hey' },
      { type: 'char', text: 'hi there', charId: 'ezra', name: 'Ezra' },
    ];
    assert.deepEqual(historyFromLog(log), [
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  test('drops entries of any other type', () => {
    const log = [
      { type: 'user', text: 'hey' },
      { type: 'system', text: 'You return to the conversation.' },
      { type: 'char', text: 'hi', charId: 'ezra', name: 'Ezra' },
    ];
    assert.deepEqual(historyFromLog(log), [
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  test('drops entries with empty/missing text', () => {
    const log = [{ type: 'user', text: '' }, { type: 'char', text: 'hi', charId: 'ezra', name: 'Ezra' }];
    assert.deepEqual(historyFromLog(log), [{ role: 'assistant', content: 'hi' }]);
  });

  test('returns an empty array for an empty log', () => {
    assert.deepEqual(historyFromLog([]), []);
  });
});

describe('groupHistoryFromLog', () => {
  test('the current speaker\'s own lines become "assistant", unprefixed', () => {
    const log = [{ type: 'char', charId: 'ezra', name: 'Ezra', text: 'hey all' }];
    assert.deepEqual(groupHistoryFromLog(log, 'ezra'), [{ role: 'assistant', content: 'hey all' }]);
  });

  test('other characters\' lines become "user", prefixed with their name', () => {
    const log = [{ type: 'char', charId: 'mireille', name: 'Mireille', text: 'hi!' }];
    assert.deepEqual(groupHistoryFromLog(log, 'ezra'), [{ role: 'user', content: 'Mireille: hi!' }]);
  });

  test('the human\'s lines become "user", prefixed with the given userLabel', () => {
    const log = [{ type: 'user', text: 'hello everyone' }];
    assert.deepEqual(groupHistoryFromLog(log, 'ezra', 'Shad'), [{ role: 'user', content: 'Shad: hello everyone' }]);
  });

  test('drops entries of any other type', () => {
    const log = [
      { type: 'user', text: 'hi' },
      { type: 'error', text: 'something broke' },
      { type: 'char', charId: 'ezra', name: 'Ezra', text: 'hey' },
    ];
    assert.deepEqual(groupHistoryFromLog(log, 'ezra', 'Shad'), [
      { role: 'user', content: 'Shad: hi' },
      { role: 'assistant', content: 'hey' },
    ]);
  });

  test('returns an empty array for an empty log', () => {
    assert.deepEqual(groupHistoryFromLog([], 'ezra'), []);
  });

  // The actual bug report this guards against: two different characters
  // (or the human, then a character) both replying before the current
  // speaker's turn both map to role:'user' as SEPARATE entries unless
  // merged — three or more consecutive same-role turns with no
  // 'assistant' turn between them is an unusual shape for a chat-
  // completion API and can make it lose track of who already said what.
  test('merges consecutive turns that end up with the same role, newline-joined', () => {
    const log = [
      { type: 'user', text: 'Welcome to the group!' },
      { type: 'char', charId: 'mireille', name: 'Mireille', text: 'hi mom!!' },
      { type: 'char', charId: 'mireille', name: 'Mireille', text: 'omg hi grandma!!' },
    ];
    // From soot's perspective: all three are 'user' (Shad's line, then two
    // of Mireille's) — none of them are soot's own lines.
    assert.deepEqual(groupHistoryFromLog(log, 'soot', 'Shad'), [
      { role: 'user', content: 'Shad: Welcome to the group!\nMireille: hi mom!!\nMireille: omg hi grandma!!' },
    ]);
  });

  test('does not merge across an intervening turn of a different role', () => {
    const log = [
      { type: 'char', charId: 'mireille', name: 'Mireille', text: 'hi!' },
      { type: 'char', charId: 'ezra', name: 'Ezra', text: 'hello.' }, // ezra's own line, from ezra's perspective
      { type: 'char', charId: 'mireille', name: 'Mireille', text: 'how are you?' },
    ];
    assert.deepEqual(groupHistoryFromLog(log, 'ezra'), [
      { role: 'user', content: 'Mireille: hi!' },
      { role: 'assistant', content: 'hello.' },
      { role: 'user', content: 'Mireille: how are you?' },
    ]);
  });

  test('merges more than two consecutive same-role turns', () => {
    const log = [
      { type: 'char', charId: 'mireille', name: 'Mireille', text: 'a' },
      { type: 'char', charId: 'soot', name: 'Soot', text: 'b' },
      { type: 'char', charId: 'custodian', name: 'Custodian', text: 'c' },
    ];
    assert.deepEqual(groupHistoryFromLog(log, 'ezra'), [
      { role: 'user', content: 'Mireille: a\nSoot: b\nCustodian: c' },
    ]);
  });
});
