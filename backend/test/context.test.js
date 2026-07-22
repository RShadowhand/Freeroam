import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  estimateTokens,
  contextSettingsFor,
  historyBudget,
  sliceSinceLastArrival,
  formatLogEntry,
  buildHistoryTranscript,
  buildHistoryMessages,
  substituteMacros,
  assemblePresetSections,
  assemblePresetMessages,
  defaultSystemPrompt,
  buildSystemPrompt,
  parseCharacterTurn,
  importSillyTavernPreset,
  exportSillyTavernPreset,
  weekdayFor,
  WEEKDAYS,
  nextTimeSlot,
  scheduledPlaceFor,
  normalizeUsage,
  buildGenerationStats,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_REPLY_TOKENS,
} from '../lib/context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stFixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'silly-tavern-default-preset.json'), 'utf-8')
);

describe('estimateTokens', () => {
  test('empty/falsy input costs nothing', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(null), 0);
  });

  test('roughly 4 characters per token, rounded up', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('a'.repeat(400)), 100);
  });
});

describe('contextSettingsFor', () => {
  test('falls back to defaults with no preset', () => {
    assert.deepEqual(contextSettingsFor(null), {
      contextLength: DEFAULT_CONTEXT_LENGTH,
      maxReplyTokens: DEFAULT_MAX_REPLY_TOKENS,
    });
  });

  test('falls back to defaults when preset fields are 0/missing', () => {
    assert.deepEqual(contextSettingsFor({}), {
      contextLength: DEFAULT_CONTEXT_LENGTH,
      maxReplyTokens: DEFAULT_MAX_REPLY_TOKENS,
    });
  });

  test('uses preset values when present', () => {
    assert.deepEqual(contextSettingsFor({ contextLength: 4096, maxReplyTokens: 250 }), {
      contextLength: 4096,
      maxReplyTokens: 250,
    });
  });
});

describe('historyBudget', () => {
  test('subtracts system prompt, instruction, and reply tokens from the context length', () => {
    const budget = historyBudget({
      contextLength: 1000,
      maxReplyTokens: 100,
      systemPromptTokens: 200,
      instructionTokens: 50,
    });
    // 1000 - (200 + 50 + 100) = 650, minus 10% safety margin = 585
    assert.equal(budget, 585);
  });

  test('never goes negative when the system prompt alone exceeds the context length', () => {
    const budget = historyBudget({
      contextLength: 100,
      maxReplyTokens: 100,
      systemPromptTokens: 500,
    });
    assert.equal(budget, 0);
  });

  test('instructionTokens defaults to 0', () => {
    const withDefault = historyBudget({ contextLength: 1000, maxReplyTokens: 100, systemPromptTokens: 200 });
    const explicit = historyBudget({ contextLength: 1000, maxReplyTokens: 100, systemPromptTokens: 200, instructionTokens: 0 });
    assert.equal(withDefault, explicit);
  });
});

describe('normalizeUsage', () => {
  test('extracts prompt/completion/reasoning token counts', () => {
    const usage = normalizeUsage({ prompt_tokens: 120, completion_tokens: 45, completion_tokens_details: { reasoning_tokens: 30 } });
    assert.deepEqual(usage, { promptTokens: 120, completionTokens: 45, reasoningTokens: 30 });
  });

  test('reasoningTokens is null when the endpoint doesn\'t report it, not 0', () => {
    const usage = normalizeUsage({ prompt_tokens: 120, completion_tokens: 45 });
    assert.equal(usage.reasoningTokens, null);
  });

  test('returns null for a missing usage object', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage(undefined), null);
  });

  test('non-finite token fields become null rather than NaN', () => {
    const usage = normalizeUsage({ prompt_tokens: 'oops', completion_tokens: 45 });
    assert.equal(usage.promptTokens, null);
    assert.equal(usage.completionTokens, 45);
  });
});

describe('buildGenerationStats', () => {
  test('computes tokens/sec from completion tokens and total duration', () => {
    const stats = buildGenerationStats(
      { promptTokens: 200, completionTokens: 100, reasoningTokens: null },
      { totalMs: 5000, ttftMs: 400 },
    );
    assert.equal(stats.promptTokens, 200);
    assert.equal(stats.completionTokens, 100);
    assert.equal(stats.totalMs, 5000);
    assert.equal(stats.ttftMs, 400);
    assert.equal(stats.tokensPerSec, 20); // 100 tokens / 5s
  });

  test('tokensPerSec is null when completion tokens are unknown', () => {
    const stats = buildGenerationStats({ promptTokens: 200, completionTokens: null, reasoningTokens: null }, { totalMs: 5000, ttftMs: null });
    assert.equal(stats.tokensPerSec, null);
  });

  test('tokensPerSec is null when timing is unknown', () => {
    const stats = buildGenerationStats({ promptTokens: 200, completionTokens: 100, reasoningTokens: null }, null);
    assert.equal(stats.tokensPerSec, null);
    assert.equal(stats.totalMs, null);
  });

  test('returns null when both usage and timing are absent', () => {
    assert.equal(buildGenerationStats(null, null), null);
  });

  test('handles usage without timing, and timing without usage', () => {
    const usageOnly = buildGenerationStats({ promptTokens: 10, completionTokens: 5, reasoningTokens: null }, null);
    assert.equal(usageOnly.completionTokens, 5);
    assert.equal(usageOnly.totalMs, null);

    const timingOnly = buildGenerationStats(null, { totalMs: 1000, ttftMs: 100 });
    assert.equal(timingOnly.completionTokens, null);
    assert.equal(timingOnly.totalMs, 1000);
  });
});

describe('weekdayFor', () => {
  test('Day 1 is a Monday', () => {
    assert.equal(weekdayFor(1), 'Monday');
  });

  test('cycles through all seven weekdays in order', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(weekdayFor), WEEKDAYS);
  });

  test('wraps correctly into a second (and later) week', () => {
    assert.equal(weekdayFor(8), 'Monday');
    assert.equal(weekdayFor(14), 'Sunday');
    assert.equal(weekdayFor(15), 'Monday');
  });

  test('stays consistent for non-positive days too (time travel before Day 1)', () => {
    assert.equal(weekdayFor(0), 'Sunday');
    assert.equal(weekdayFor(-1), 'Saturday');
    assert.equal(weekdayFor(-6), 'Monday');
  });

  test('returns null for non-integer input', () => {
    assert.equal(weekdayFor(null), null);
    assert.equal(weekdayFor(undefined), null);
    assert.equal(weekdayFor(1.5), null);
  });
});

describe('nextTimeSlot', () => {
  test('steps to the next time of day within the same day', () => {
    assert.deepEqual(nextTimeSlot({ day: 3, timeOfDay: 'morning' }), { day: 3, timeOfDay: 'noon' });
  });

  test('wraps from night into sunrise of the next day', () => {
    assert.deepEqual(nextTimeSlot({ day: 3, timeOfDay: 'night' }), { day: 4, timeOfDay: 'sunrise' });
  });
});

describe('scheduledPlaceFor', () => {
  const placesById = {
    tavern: { id: 'tavern', name: 'The Tavern' },
    market: { id: 'market', name: 'The Market' },
  };

  test('resolves the place scheduled for a character on a given day/time-of-day', () => {
    const character = { schedule: { Wednesday: { evening: { placeId: 'tavern', reason: 'Work' } } } };
    // Day 3 is a Wednesday (Day 1 = Monday).
    assert.equal(scheduledPlaceFor(character, 3, 'evening', placesById), placesById.tavern);
  });

  test('returns null when nothing is scheduled for that slot', () => {
    const character = { schedule: { Wednesday: { evening: { placeId: 'tavern' } } } };
    assert.equal(scheduledPlaceFor(character, 3, 'morning', placesById), null);
  });

  test('returns null when the character has no schedule at all', () => {
    assert.equal(scheduledPlaceFor({}, 3, 'evening', placesById), null);
  });

  test('returns null if the scheduled placeId no longer resolves to a real place', () => {
    const character = { schedule: { Wednesday: { evening: { placeId: 'ghost-town' } } } };
    assert.equal(scheduledPlaceFor(character, 3, 'evening', placesById), null);
  });
});

describe('sliceSinceLastArrival', () => {
  test('returns everything since (and including) the most recent system entry', () => {
    const log = [
      { type: 'system', text: 'You arrive at Town Square.' },
      { type: 'char', name: 'Ezra', text: 'Hello.' },
      { type: 'user', text: 'Hi.' },
      { type: 'system', text: 'You return to Town Square.' },
      { type: 'char', name: 'Ezra', text: 'Back again?' },
    ];
    const slice = sliceSinceLastArrival(log);
    assert.equal(slice.length, 2);
    assert.equal(slice[0].text, 'You return to Town Square.');
    assert.equal(slice[1].text, 'Back again?');
  });

  test('returns the whole log when there is no system marker', () => {
    const log = [{ type: 'user', text: 'Hi.' }, { type: 'char', name: 'Ezra', text: 'Hello.' }];
    assert.equal(sliceSinceLastArrival(log).length, 2);
  });

  test('returns an empty array for an empty log', () => {
    assert.deepEqual(sliceSinceLastArrival([]), []);
  });
});

describe('formatLogEntry', () => {
  test('formats system entries in parentheses', () => {
    assert.equal(formatLogEntry({ type: 'system', text: 'You arrive.' }, 'Kael'), '(You arrive.)');
  });

  test('formats user entries with the given label', () => {
    assert.equal(formatLogEntry({ type: 'user', text: 'Hello?' }, 'Kael'), 'Kael: Hello?');
  });

  test('formats character entries with their own name, ignoring userLabel', () => {
    assert.equal(formatLogEntry({ type: 'char', name: 'Ezra Vane', text: 'Ah.' }, 'Kael'), 'Ezra Vane: Ah.');
  });

  test('formats narrator entries unprefixed — scene prose, not a person speaking', () => {
    assert.equal(formatLogEntry({ type: 'narrator', text: 'A bell tolls somewhere distant.' }, 'Kael'), 'A bell tolls somewhere distant.');
  });
});

describe('buildHistoryTranscript', () => {
  const log = [
    { type: 'system', text: 'You arrive at Town Square.' },
    { type: 'user', text: 'Hello?' },
    { type: 'char', name: 'Ezra', text: 'Ah, a visitor.' },
    { type: 'user', text: 'Who are you?' },
    { type: 'char', name: 'Ezra', text: 'The archivist, obviously.' },
  ];

  test('with no budget, includes every line since the last arrival, formatted by type', () => {
    const transcript = buildHistoryTranscript(log, { userLabel: 'Kael' });
    assert.equal(
      transcript,
      '(You arrive at Town Square.)\nKael: Hello?\nEzra: Ah, a visitor.\nKael: Who are you?\nEzra: The archivist, obviously.'
    );
  });

  test('excludes anything before the most recent arrival marker', () => {
    const withOldVisit = [
      { type: 'system', text: 'You arrive at Town Square.' },
      { type: 'char', name: 'Ezra', text: 'Old conversation from a previous visit.' },
      { type: 'system', text: 'You return to Town Square.' },
      { type: 'user', text: 'Fresh start.' },
    ];
    const transcript = buildHistoryTranscript(withOldVisit, { userLabel: 'Visitor' });
    assert.ok(!transcript.includes('Old conversation'));
    assert.ok(transcript.includes('Fresh start.'));
  });

  test('with a tight budget, keeps only the most recent lines that fit, in chronological order', () => {
    // Budget for exactly the last message plus a little slack, not enough for two.
    const lastLineTokens = estimateTokens('Ezra: The archivist, obviously.');
    const transcript = buildHistoryTranscript(log, { userLabel: 'Kael', tokenBudget: lastLineTokens + 1 });
    assert.equal(transcript, 'Ezra: The archivist, obviously.');
  });

  test('always keeps at least the single most recent message, even over budget', () => {
    const transcript = buildHistoryTranscript(log, { userLabel: 'Kael', tokenBudget: 0 });
    assert.equal(transcript, 'Ezra: The archivist, obviously.');
  });

  test('a larger budget pulls in more of the recent tail, oldest-first', () => {
    const twoLines = 'Kael: Who are you?\nEzra: The archivist, obviously.';
    const budget = estimateTokens(twoLines) + 2;
    const transcript = buildHistoryTranscript(log, { userLabel: 'Kael', tokenBudget: budget });
    assert.equal(transcript, twoLines);
  });

  test('includes narrator entries, unprefixed, alongside the rest', () => {
    const withNarrator = [...log, { type: 'narrator', text: 'A bell tolls somewhere distant.' }];
    const transcript = buildHistoryTranscript(withNarrator, { userLabel: 'Kael' });
    assert.ok(transcript.endsWith('The archivist, obviously.\nA bell tolls somewhere distant.'));
  });
});

describe('buildHistoryMessages', () => {
  const log = [
    { type: 'system', text: 'You arrive at Town Square.' },
    { type: 'user', text: 'Hello?' },
    { type: 'char', charId: 'ezra', name: 'Ezra', text: 'Ah, a visitor.' },
    { type: 'char', charId: 'mira', name: 'Mireille', text: 'Oh, hello.' },
    { type: 'user', text: 'Who are you both?' },
    { type: 'char', charId: 'ezra', name: 'Ezra', text: 'The archivist, obviously.' },
  ];

  test('tags the speaker\'s own lines "assistant" and everything else "user", merging adjacent same-role turns', () => {
    const messages = buildHistoryMessages(log, { userLabel: 'Kael', speakerId: 'ezra' });
    assert.deepEqual(messages, [
      { role: 'user', content: '(You arrive at Town Square.)\nKael: Hello?' },
      { role: 'assistant', content: 'Ah, a visitor.' },
      { role: 'user', content: 'Mireille: Oh, hello.\nKael: Who are you both?' },
      { role: 'assistant', content: 'The archivist, obviously.' },
    ]);
  });

  test('a different speaker sees the first Ezra line as "user" content instead', () => {
    const messages = buildHistoryMessages(log, { userLabel: 'Kael', speakerId: 'mira' });
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.ok(messages[0].content.includes('Ezra: Ah, a visitor.'));
    assert.equal(messages[1].content, 'Oh, hello.');
  });

  test('excludes anything before the most recent arrival marker', () => {
    const withOldVisit = [
      { type: 'system', text: 'You arrive at Town Square.' },
      { type: 'char', charId: 'ezra', name: 'Ezra', text: 'Old conversation from a previous visit.' },
      { type: 'system', text: 'You return to Town Square.' },
      { type: 'user', text: 'Fresh start.' },
    ];
    const messages = buildHistoryMessages(withOldVisit, { userLabel: 'Visitor', speakerId: 'ezra' });
    assert.ok(!messages.some(m => m.content.includes('Old conversation')));
    assert.ok(messages.some(m => m.content.includes('Fresh start.')));
  });

  test('always keeps at least the single most recent message, even over budget', () => {
    const messages = buildHistoryMessages(log, { userLabel: 'Kael', speakerId: 'ezra', tokenBudget: 0 });
    assert.deepEqual(messages, [{ role: 'assistant', content: 'The archivist, obviously.' }]);
  });

  test('a larger budget pulls in more of the recent tail, oldest-first, still role-tagged', () => {
    const budget = estimateTokens('Kael: Who are you both?\nThe archivist, obviously.') + 2;
    const messages = buildHistoryMessages(log, { userLabel: 'Kael', speakerId: 'ezra', tokenBudget: budget });
    assert.deepEqual(messages, [
      { role: 'user', content: 'Kael: Who are you both?' },
      { role: 'assistant', content: 'The archivist, obviously.' },
    ]);
  });

  test('narrator entries fold into "user" content, unprefixed, for every speaker', () => {
    const withNarrator = [...log, { type: 'narrator', text: 'A bell tolls somewhere distant.' }];
    const messages = buildHistoryMessages(withNarrator, { userLabel: 'Kael', speakerId: 'ezra' });
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.includes('A bell tolls somewhere distant.'));
  });
});

describe('substituteMacros', () => {
  test('replaces {{user}} and {{char}}', () => {
    const out = substituteMacros('{{user}} greets {{char}}.', { userName: 'Kael', charNames: ['Ezra Vane'] });
    assert.equal(out, 'Kael greets Ezra Vane.');
  });

  test('merges multiple present characters into one comma list for {{char}}', () => {
    const out = substituteMacros('{{char}}', { userName: 'Kael', charNames: ['Ezra Vane', 'Mireille'] });
    assert.equal(out, 'Ezra Vane, Mireille');
  });

  test('is case-insensitive and replaces repeats', () => {
    const out = substituteMacros('{{USER}} and {{user}}', { userName: 'Kael', charNames: [] });
    assert.equal(out, 'Kael and Kael');
  });

  test('{{char}} resolves to an empty string with nobody present — never a placeholder like "no one"', () => {
    const out = substituteMacros('[{{char}}]', { userName: 'Kael', charNames: [] });
    assert.equal(out, '[]');
  });

  test('{{user}} resolves to an empty string with no active persona — never a placeholder like "the visitor"', () => {
    const out = substituteMacros('[{{user}}]');
    assert.equal(out, '[]');
  });

  test('resolves persona/description/personality/scenario/world/time/day, each empty when unset', () => {
    const template = '{{persona}}|{{description}}|{{personality}}|{{scenario}}|{{world}}|{{time}}|{{day}}';
    assert.equal(substituteMacros(template, {}), '||||||'); // 7 empty segments, 6 separators
    const filled = substituteMacros(template, {
      personaDescription: 'A quiet wanderer.',
      charDescription: 'Precise archivist.',
      charPersonality: 'Dry-witted.',
      sceneDescription: 'A half-wild greenhouse.',
      worldSetting: 'Gaslit alleys.',
      timeOfDay: 'evening',
      day: 3,
    });
    assert.equal(filled, 'A quiet wanderer.|Precise archivist.|Dry-witted.|A half-wild greenhouse.|Gaslit alleys.|evening|3');
  });

  test('{{random:a,b,c}} picks one of the given options', () => {
    const out = substituteMacros('{{random:apple,banana,cherry}}', {});
    assert.ok(['apple', 'banana', 'cherry'].includes(out));
  });

  test('{{roll:2d6}} sums two six-sided dice (2-12)', () => {
    for (let i = 0; i < 20; i++) {
      const out = Number(substituteMacros('{{roll:2d6}}', {}));
      assert.ok(out >= 2 && out <= 12, `roll out of range: ${out}`);
    }
  });

  test('{{roll:d20}} defaults the count to 1', () => {
    for (let i = 0; i < 20; i++) {
      const out = Number(substituteMacros('{{roll:d20}}', {}));
      assert.ok(out >= 1 && out <= 20, `roll out of range: ${out}`);
    }
  });

  test('a malformed {{roll:...}} or {{random:}} is left as literal text', () => {
    assert.equal(substituteMacros('{{roll:xdY}}', {}), '{{roll:xdY}}');
    assert.equal(substituteMacros('{{random:}}', {}), '{{random:}}');
  });

  test('an unrecognized macro is left as literal text, matching SillyTavern', () => {
    assert.equal(substituteMacros('{{notarealmacro}}', { userName: 'Kael' }), '{{notarealmacro}}');
  });

  test('falsy/empty text is returned as-is', () => {
    assert.equal(substituteMacros(''), '');
    assert.equal(substituteMacros(null), null);
  });
});

describe('assemblePresetSections', () => {
  const scene = {
    chars: [
      { name: 'Ezra Vane', description: 'Precise, dry-witted archivist.' },
      { name: 'Mireille', description: 'Gentle, dreamy gardener.' },
    ],
    place: { name: 'The Greenhouse', area: 'Garden District', desc: 'A public greenhouse gone half-wild.', type: 'communal' },
    persona: { name: 'Kael', description: 'A quiet wanderer who names stray cats.' },
  };

  test('fills charDescription by merging all present characters into one block', () => {
    const preset = { prompts: [{ identifier: 'charDescription', marker: true, enabled: true }] };
    const [section] = assemblePresetSections(preset, scene);
    assert.ok(section.includes('Ezra Vane:\nPrecise, dry-witted archivist.'));
    assert.ok(section.includes('Mireille:\nGentle, dreamy gardener.'));
  });

  test('fills scenario from the place', () => {
    const preset = { prompts: [{ identifier: 'scenario', marker: true, enabled: true }] };
    const [section] = assemblePresetSections(preset, scene);
    assert.ok(section.includes('The Greenhouse'));
    assert.ok(section.includes('Garden District'));
    assert.ok(section.includes('A public greenhouse gone half-wild.'));
  });

  test('fills personaDescription from the active persona', () => {
    const preset = { prompts: [{ identifier: 'personaDescription', marker: true, enabled: true }] };
    const [section] = assemblePresetSections(preset, scene);
    assert.ok(section.includes('Kael'));
    assert.ok(section.includes('A quiet wanderer who names stray cats.'));
  });

  test('personaDescription contributes nothing when no persona is active', () => {
    const preset = { prompts: [{ identifier: 'personaDescription', marker: true, enabled: true }] };
    const sections = assemblePresetSections(preset, { ...scene, persona: null });
    assert.deepEqual(sections, []);
  });

  test('unsupported markers contribute nothing but do not throw', () => {
    const preset = {
      prompts: [
        { identifier: 'worldInfoAfter', marker: true, enabled: true },
        { identifier: 'chatHistory', marker: true, enabled: true },
        { identifier: 'jailbreak', marker: true, enabled: true },
      ],
    };
    assert.deepEqual(assemblePresetSections(preset, scene), []);
  });

  test('fills charPersonality only when set, opt-in — omits characters with no personality text', () => {
    const preset = { prompts: [{ identifier: 'charPersonality', marker: true, enabled: true }] };
    const withPersonality = { ...scene, chars: [{ ...scene.chars[0], personality: 'Dry-witted, precise.' }, scene.chars[1]] };
    const [section] = assemblePresetSections(preset, withPersonality);
    assert.ok(section.includes("Ezra Vane's personality: Dry-witted, precise."));
    assert.ok(!section.includes('Mireille'));
  });

  test('charPersonality contributes nothing when no character has one set', () => {
    const preset = { prompts: [{ identifier: 'charPersonality', marker: true, enabled: true }] };
    assert.deepEqual(assemblePresetSections(preset, scene), []);
  });

  test('fills charScenario only for characters with their own scenario text, opt-in', () => {
    const preset = { prompts: [{ identifier: 'charScenario', marker: true, enabled: true }] };
    const withScenario = { ...scene, chars: [{ ...scene.chars[0], scenario: 'Mid-inventory, interrupted.' }, scene.chars[1]] };
    const [section] = assemblePresetSections(preset, withScenario);
    assert.equal(section, 'Character Scenario:\nEzra Vane: Mid-inventory, interrupted.');
  });

  test('fills dialogueExamples only for characters with example dialogue, opt-in', () => {
    const preset = { prompts: [{ identifier: 'dialogueExamples', marker: true, enabled: true }] };
    const withExamples = { ...scene, chars: [{ ...scene.chars[0], exampleDialogue: '"Precisely as recorded," Ezra said.' }, scene.chars[1]] };
    const [section] = assemblePresetSections(preset, withExamples);
    assert.ok(section.includes("Ezra Vane's example dialogue:"));
    assert.ok(section.includes('"Precisely as recorded," Ezra said.'));
  });

  test('scenario/exampleDialogue never leak into the request when the preset has no such marker (opt-in only, unlike memories/world setting)', () => {
    const preset = { prompts: [{ identifier: 'charDescription', marker: true, enabled: true }] };
    const loaded = {
      ...scene,
      chars: [{ ...scene.chars[0], scenario: 'A card scenario nobody asked for.', exampleDialogue: 'Unwanted example line.' }, scene.chars[1]],
    };
    const sections = assemblePresetSections(preset, loaded);
    assert.ok(!sections.some((s) => s.includes('card scenario nobody asked for')));
    assert.ok(!sections.some((s) => s.includes('Unwanted example line')));
  });

  test('disabled blocks are skipped', () => {
    const preset = { prompts: [{ identifier: 'main', role: 'system', content: 'Should not appear.', enabled: false }] };
    assert.deepEqual(assemblePresetSections(preset, scene), []);
  });

  test('empty content blocks are skipped', () => {
    const preset = { prompts: [{ identifier: 'nsfw', role: 'system', content: '   ', enabled: true }] };
    assert.deepEqual(assemblePresetSections(preset, scene), []);
  });

  test('applies macro substitution to real text blocks', () => {
    const preset = { prompts: [{ identifier: 'main', role: 'system', content: "Write {{char}}'s reply to {{user}}.", enabled: true }] };
    const [section] = assemblePresetSections(preset, scene);
    assert.equal(section, "Write Ezra Vane, Mireille's reply to Kael.");
  });

  test('fills characterMemory with retrieved memory snippets', () => {
    const preset = { prompts: [{ identifier: 'characterMemory', marker: true, enabled: true }] };
    const sceneWithMemories = { ...scene, memories: ['Ezra once mentioned a locked archive.', 'Mireille remembers the visitor liked ferns.'] };
    const [section] = assemblePresetSections(preset, sceneWithMemories);
    assert.ok(section.includes('Ezra once mentioned a locked archive.'));
    assert.ok(section.includes('Mireille remembers the visitor liked ferns.'));
  });

  test('characterMemory contributes nothing when there are no memories yet', () => {
    const preset = { prompts: [{ identifier: 'characterMemory', marker: true, enabled: true }] };
    assert.deepEqual(assemblePresetSections(preset, scene), []); // scene has no `memories` field at all
    assert.deepEqual(assemblePresetSections(preset, { ...scene, memories: [] }), []);
  });

  test('injects retrieved memories even when the preset never declares a characterMemory marker (e.g. an imported SillyTavern preset)', () => {
    const preset = { prompts: [{ identifier: 'charDescription', marker: true, enabled: true }] };
    const sceneWithMemories = { ...scene, memories: ['Ezra once mentioned a locked archive.'] };
    const sections = assemblePresetSections(preset, sceneWithMemories);
    assert.ok(sections.some((s) => s.includes('Ezra once mentioned a locked archive.')));
  });

  test('does not force memories back in when the preset explicitly disables its characterMemory marker', () => {
    const preset = { prompts: [{ identifier: 'characterMemory', marker: true, enabled: false }] };
    const sceneWithMemories = { ...scene, memories: ['Ezra once mentioned a locked archive.'] };
    assert.deepEqual(assemblePresetSections(preset, sceneWithMemories), []);
  });

  test('injects the world setting even when the preset never declares a worldInfoBefore marker, ahead of other sections', () => {
    const preset = { prompts: [{ identifier: 'charDescription', marker: true, enabled: true }] };
    const sceneWithSetting = { ...scene, worldSetting: 'A world where the rivers run backwards.' };
    const sections = assemblePresetSections(preset, sceneWithSetting);
    assert.equal(sections[0], 'World Setting:\nA world where the rivers run backwards.');
  });

  test('does not force world setting back in when the preset explicitly disables its worldInfoBefore marker', () => {
    const preset = { prompts: [{ identifier: 'worldInfoBefore', marker: true, enabled: false }] };
    const sceneWithSetting = { ...scene, worldSetting: 'A world where the rivers run backwards.' };
    assert.deepEqual(assemblePresetSections(preset, sceneWithSetting), []);
  });
});

describe('defaultSystemPrompt', () => {
  const baseScene = {
    chars: [{ name: 'Ezra Vane', description: 'Precise, dry-witted archivist.' }],
    place: { name: 'Town Square', area: 'Downtown', desc: 'The open square.', type: 'communal', ownerNames: [] },
    persona: null,
  };

  test('uses "the visitor" when no persona is active', () => {
    const prompt = defaultSystemPrompt(baseScene);
    assert.ok(prompt.includes('"the visitor"'));
    assert.ok(!prompt.includes('(the visitor):')); // no persona block without a persona
  });

  test('uses the persona name in place of "the visitor", with a non-redundant persona block', () => {
    const scene = { ...baseScene, persona: { name: 'Kael', description: 'A quiet wanderer.' } };
    const prompt = defaultSystemPrompt(scene);
    assert.ok(prompt.includes('"Kael"'));
    assert.ok(prompt.includes('Kael (the visitor):\nA quiet wanderer.'));
    assert.ok(!prompt.includes('Kael (Kael)')); // regression check for the redundant-label bug
  });

  test('private place mentions the owner by name', () => {
    const scene = { ...baseScene, place: { ...baseScene.place, type: 'private', ownerNames: ['Ezra Vane'] } };
    const prompt = defaultSystemPrompt(scene);
    assert.ok(prompt.includes("This is Ezra Vane's private place"));
  });

  test('private place with multiple owners joins their names', () => {
    const scene = { ...baseScene, place: { ...baseScene.place, type: 'private', ownerNames: ['Ezra Vane', 'Mireille', 'Soot'] } };
    const prompt = defaultSystemPrompt(scene);
    assert.ok(prompt.includes("This is Ezra Vane, Mireille, and Soot's private place"));
  });

  test('communal place uses generic wording', () => {
    const prompt = defaultSystemPrompt(baseScene);
    assert.ok(prompt.includes('This is a communal space, open to anyone.'));
  });

  test('appends a memory block when memories are present', () => {
    const scene = { ...baseScene, memories: ['Ezra once mentioned a locked archive.'] };
    const prompt = defaultSystemPrompt(scene);
    assert.ok(prompt.includes("What's remembered so far:"));
    assert.ok(prompt.includes('Ezra once mentioned a locked archive.'));
  });

  test('omits the memory block entirely when there are no memories', () => {
    const prompt = defaultSystemPrompt(baseScene);
    assert.ok(!prompt.includes("What's remembered so far:"));
  });

  test('includes a weather line when the place carries one', () => {
    const scene = { ...baseScene, place: { ...baseScene.place, weather: 'rainy' } };
    const prompt = defaultSystemPrompt(scene);
    assert.ok(prompt.includes('Weather: rainy.'));
  });

  test('omits the weather line entirely when the place has none', () => {
    const prompt = defaultSystemPrompt(baseScene);
    assert.ok(!prompt.includes('Weather:'));
  });
});

describe('buildSystemPrompt', () => {
  const scene = {
    chars: [{ name: 'Ezra Vane', description: 'Precise, dry-witted archivist.' }],
    place: { name: 'Town Square', area: 'Downtown', desc: 'The open square.', type: 'communal', ownerNames: [] },
    persona: null,
  };

  test('falls back to the default prompt when there is no preset', () => {
    assert.equal(buildSystemPrompt(null, scene), defaultSystemPrompt(scene));
  });

  test('falls back to the default prompt when the preset has no prompts', () => {
    assert.equal(buildSystemPrompt({ prompts: [] }, scene), defaultSystemPrompt(scene));
  });

  test('a preset fully controls the prompt — nothing is appended to it', () => {
    const preset = { prompts: [{ identifier: 'main', role: 'system', content: 'Custom instructions.', enabled: true }] };
    assert.equal(buildSystemPrompt(preset, scene), 'Custom instructions.');
  });

  test('the scenario marker names the other characters present', () => {
    const preset = { prompts: [{ identifier: 'scenario', marker: true, enabled: true }] };
    const prompt = buildSystemPrompt(preset, { ...scene, othersPresent: ['Mireille', 'Soot'] });
    assert.ok(prompt.includes('Also present: Mireille, Soot.'));
  });

  test('the scenario marker carries the in-world date, weekday, and time of day', () => {
    const preset = { prompts: [{ identifier: 'scenario', marker: true, enabled: true }] };
    const prompt = buildSystemPrompt(preset, { ...scene, time: { day: 3, timeOfDay: 'sunset' } });
    assert.ok(prompt.includes('It is Day 3 (Wednesday), sunset.'));
  });

  test('the worldInfoBefore marker is filled with the global world setting', () => {
    const preset = { prompts: [{ identifier: 'worldInfoBefore', marker: true, enabled: true }] };
    const prompt = buildSystemPrompt(preset, { ...scene, worldSetting: 'A rain-soaked port city.' });
    assert.equal(prompt, 'World Setting:\nA rain-soaked port city.');
  });

  test('charDescription carries relationship/whereabouts knowledge', () => {
    const preset = { prompts: [{ identifier: 'charDescription', marker: true, enabled: true }] };
    const prompt = buildSystemPrompt(preset, {
      ...scene,
      relationships: ['Mireille is your sister. You happen to know they are currently at The Greenhouse.'],
    });
    assert.ok(prompt.includes('What Ezra Vane knows about people:'));
    assert.ok(prompt.includes('Mireille is your sister.'));
  });

  test('default prompt includes world setting, time, and relationships too', () => {
    const prompt = defaultSystemPrompt({
      ...scene,
      time: { day: 2, timeOfDay: 'night' },
      worldSetting: 'Gaslit alleys everywhere.',
      relationships: ['Soot is your rival.'],
    });
    assert.ok(prompt.includes('Gaslit alleys everywhere.'));
    assert.ok(prompt.includes('It is Day 2 (Tuesday), night.'));
    assert.ok(prompt.includes('Soot is your rival.'));
  });
});

describe('assemblePresetMessages', () => {
  const scene = {
    chars: [{ name: 'Ezra Vane', description: 'Precise, dry-witted archivist.' }],
    place: { name: 'The Greenhouse', area: 'Garden District', desc: 'A public greenhouse gone half-wild.', type: 'communal' },
    persona: { name: 'Kael', description: 'A quiet wanderer.' },
  };

  test('marker blocks are prefixed with the block\'s own configured name', () => {
    const preset = { prompts: [{ identifier: 'scenario', name: 'Scenario', marker: true, enabled: true }] };
    const [msg] = assemblePresetMessages(preset, scene);
    assert.ok(msg.content.startsWith('Scenario:\n'));
  });

  test('a renamed marker block uses the user\'s chosen name, not the standard label', () => {
    const preset = { prompts: [{ identifier: 'personaDescription', name: 'User Persona', marker: true, enabled: true }] };
    const [msg] = assemblePresetMessages(preset, scene);
    assert.ok(msg.content.startsWith('User Persona:\n'));
  });

  test('a plain block with role "user" is sent as its own user-role message, not folded into system', () => {
    const preset = {
      prompts: [
        { identifier: 'main', name: 'Main', role: 'system', content: 'System instructions.', enabled: true },
        { identifier: 'nudge', name: 'Nudge', role: 'user', content: 'Remember to stay in character.', enabled: true },
      ],
    };
    const messages = assemblePresetMessages(preset, scene);
    assert.deepEqual(messages.map(m => m.role), ['system', 'user']);
    assert.equal(messages[1].content, 'Remember to stay in character.');
  });

  test('a plain block with role "assistant" comes through as an assistant message', () => {
    const preset = { prompts: [{ identifier: 'prefill', name: 'Prefill', role: 'assistant', content: 'Understood.', enabled: true }] };
    const [msg] = assemblePresetMessages(preset, scene);
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content, 'Understood.');
  });

  test('adjacent same-role blocks are merged into one message', () => {
    const preset = {
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'First.', enabled: true },
        { identifier: 'b', name: 'B', role: 'system', content: 'Second.', enabled: true },
      ],
    };
    const messages = assemblePresetMessages(preset, scene);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'First.\n\nSecond.');
  });

  test('non-adjacent same-role blocks (separated by a different role) are not merged', () => {
    const preset = {
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'First.', enabled: true },
        { identifier: 'b', name: 'B', role: 'user', content: 'Middle.', enabled: true },
        { identifier: 'c', name: 'C', role: 'system', content: 'Last.', enabled: true },
      ],
    };
    const messages = assemblePresetMessages(preset, scene);
    assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'system']);
  });

  test('memoryAsSeparateMessage keeps characterMemory from merging with neighboring system blocks', () => {
    const preset = {
      memoryAsSeparateMessage: true,
      prompts: [
        { identifier: 'main', name: 'Main', role: 'system', content: 'Before.', enabled: true },
        { identifier: 'characterMemory', name: 'Character Memory', marker: true, enabled: true },
        { identifier: 'tail', name: 'Tail', role: 'system', content: 'After.', enabled: true },
      ],
    };
    const messages = assemblePresetMessages(preset, { ...scene, memories: ['Once mentioned a locked archive.'] });
    assert.equal(messages.length, 3);
    assert.equal(messages[0].content, 'Before.');
    assert.ok(messages[1].content.startsWith('Character Memory:\n'));
    assert.ok(messages[1].content.includes('locked archive'));
    assert.equal(messages[2].content, 'After.');
  });

  test('without memoryAsSeparateMessage, characterMemory merges with adjacent system blocks as before', () => {
    const preset = {
      prompts: [
        { identifier: 'main', name: 'Main', role: 'system', content: 'Before.', enabled: true },
        { identifier: 'characterMemory', name: 'Character Memory', marker: true, enabled: true },
      ],
    };
    const messages = assemblePresetMessages(preset, { ...scene, memories: ['Once mentioned a locked archive.'] });
    assert.equal(messages.length, 1);
    assert.ok(messages[0].content.includes('Before.'));
    assert.ok(messages[0].content.includes('Character Memory:'));
  });
});

describe('parseCharacterTurn', () => {
  const speaker = { id: 'ezra', name: 'Ezra Vane' };
  const present = [speaker, { id: 'mireille', name: 'Mireille' }];

  test('a narrative reply stays one entry attributed to the speaker', () => {
    const text = 'Ezra adjusts his spectacles.\n\nHe considers the ledger for a long moment before answering.';
    const entries = parseCharacterTurn(text, speaker, present);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].charId, 'ezra');
    assert.ok(entries[0].text.includes('spectacles'));
    assert.ok(entries[0].text.includes('ledger'));
  });

  test("strips the speaker's own leading name prefix", () => {
    const [entry] = parseCharacterTurn('Ezra Vane: Records, always.', speaker, present);
    assert.equal(entry.text, 'Records, always.');
    assert.equal(entry.charId, 'ezra');
  });

  test('first-name-only self prefix is also stripped', () => {
    const [entry] = parseCharacterTurn('Ezra: Hm.', speaker, present);
    assert.equal(entry.text, 'Hm.');
  });

  test('a fully "Name: line"-formatted reply is multiplex-parsed with correct attribution', () => {
    const text = 'Ezra Vane: The records say otherwise.\nMireille: Do they, though?';
    const entries = parseCharacterTurn(text, speaker, present);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].charId, 'ezra');
    assert.equal(entries[1].charId, 'mireille');
  });

  test('unknown speakers in a formatted reply still get NPC-tagged', () => {
    const text = 'Ezra Vane: Who goes there?\nThe Lamplighter: Only me.';
    const entries = parseCharacterTurn(text, speaker, present);
    assert.equal(entries[1].isNPC, true);
    assert.equal(entries[1].name, 'The Lamplighter');
  });

  test('empty reply produces an error entry', () => {
    const entries = parseCharacterTurn('  ', speaker, present);
    assert.equal(entries[0].type, 'error');
  });
});

describe('importSillyTavernPreset (real SillyTavern export)', () => {
  const imported = importSillyTavernPreset(stFixture, 'Default');

  test('falls back to the given filename since ST presets carry no "name" field', () => {
    assert.equal(imported.name, 'Default');
  });

  test('imports the context-length settings from openai_max_context / openai_max_tokens', () => {
    assert.equal(imported.contextLength, 4095);
    assert.equal(imported.maxReplyTokens, 300);
  });

  test('picks the richer (persona-aware) prompt_order block', () => {
    // The 100001 block includes personaDescription; the 100000 one doesn't.
    assert.ok(imported.prompts.some(p => p.identifier === 'personaDescription'));
    assert.equal(imported.prompts[2].identifier, 'personaDescription');
  });

  test('imports all 12 prompt blocks in order', () => {
    assert.equal(imported.prompts.length, 12);
    assert.equal(imported.prompts[0].identifier, 'main');
  });

  test('reflects prompt_order enabled flags (enhanceDefinitions is off by default)', () => {
    const enhance = imported.prompts.find(p => p.identifier === 'enhanceDefinitions');
    assert.equal(enhance.enabled, false);
    const main = imported.prompts.find(p => p.identifier === 'main');
    assert.equal(main.enabled, true);
  });

  test('marks marker blocks correctly', () => {
    const scenario = imported.prompts.find(p => p.identifier === 'scenario');
    assert.equal(scenario.marker, true);
    const main = imported.prompts.find(p => p.identifier === 'main');
    assert.equal(main.marker, false);
  });
});

describe('importSillyTavernPreset (edge cases)', () => {
  test('falls back to defaults with no context-length fields in the source', () => {
    const imported = importSillyTavernPreset({ prompts: [] }, 'Blank');
    assert.equal(imported.contextLength, DEFAULT_CONTEXT_LENGTH);
    assert.equal(imported.maxReplyTokens, DEFAULT_MAX_REPLY_TOKENS);
  });

  test('handles a preset with prompts but no prompt_order', () => {
    const raw = { prompts: [{ identifier: 'main', role: 'system', content: 'Hi.' }] };
    const imported = importSillyTavernPreset(raw, 'NoOrder');
    assert.equal(imported.prompts.length, 1);
    assert.equal(imported.prompts[0].enabled, true);
  });

  test('appends prompts missing from prompt_order rather than dropping them', () => {
    const raw = {
      prompts: [
        { identifier: 'main', role: 'system', content: 'Hi.' },
        { identifier: 'extra', role: 'system', content: 'Custom.' },
      ],
      prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: true }] }],
    };
    const imported = importSillyTavernPreset(raw, 'Partial');
    assert.equal(imported.prompts.length, 2);
    assert.ok(imported.prompts.some(p => p.identifier === 'extra'));
  });
});

describe('exportSillyTavernPreset', () => {
  const preset = {
    name: 'Test',
    contextLength: 4096,
    maxReplyTokens: 500,
    prompts: [
      { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Hi {{user}}.', marker: false, enabled: true },
      { identifier: 'scenario', name: 'Scenario', role: 'system', content: '', marker: true, enabled: false },
    ],
  };
  const exported = exportSillyTavernPreset(preset);

  test('includes context-length fields', () => {
    assert.equal(exported.openai_max_context, 4096);
    assert.equal(exported.openai_max_tokens, 500);
  });

  test('marker blocks omit role/content but keep the marker flag', () => {
    const scenario = exported.prompts.find(p => p.identifier === 'scenario');
    assert.equal(scenario.marker, true);
    assert.equal('role' in scenario, false);
    assert.equal('content' in scenario, false);
  });

  test('text blocks include role/content and omit the marker flag', () => {
    const main = exported.prompts.find(p => p.identifier === 'main');
    assert.equal(main.role, 'system');
    assert.equal(main.content, 'Hi {{user}}.');
    assert.equal('marker' in main, false);
  });

  test('prompt_order reflects the enabled flags in the same order as prompts', () => {
    assert.deepEqual(exported.prompt_order[0].order, [
      { identifier: 'main', enabled: true },
      { identifier: 'scenario', enabled: false },
    ]);
  });

  test('round-trips back through importSillyTavernPreset', () => {
    const reimported = importSillyTavernPreset(exported, 'roundtrip');
    assert.equal(reimported.contextLength, 4096);
    assert.equal(reimported.maxReplyTokens, 500);
    assert.equal(reimported.prompts.length, 2);
    assert.equal(reimported.prompts.find(p => p.identifier === 'scenario').enabled, false);
  });
});
