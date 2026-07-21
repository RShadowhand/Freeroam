import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTextingMessages, historyFromLog } from '../lib/texting.js';

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
