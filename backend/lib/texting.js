import { weekdayFor } from './context.js';

// Texting gets its own small, self-contained prompt builder rather than
// being squeezed through the physical-scene pipeline (scenarioBlock/
// markerContent/assemblePresetMessages) — that pipeline assumes a real
// place (locationLine, "also present", preset-configurable blocks aimed
// at scene structure) that doesn't apply to a remote text exchange. Same
// reasoning narrator.js already followed for its own dedicated
// buildNarratorMessages rather than reusing defaultSystemPrompt.
//
// scene = {
//   char: { name, description, personality },   // the character replying
//   persona: { name, description } | null,      // active user persona, or null
//   memories: string[],                         // relevant memory snippets, already retrieved by the caller
//   relationships: string[],                     // speaker's relations + whereabouts knowledge, resolved by caller
//   time: { day, timeOfDay } | null,             // in-world clock
//   textingPromptTemplate: string,               // already resolved to the built-in default if unset
//   mode: 'text' | 'call',                       // 'call' phrases this as a live phone call, not a text thread — see Phase 3
// }
export function buildTextingMessages(scene, history = []) {
  const { char, persona = null, memories = [], relationships = [], time = null, textingPromptTemplate, mode = 'text' } = scene;

  const weekday = time ? weekdayFor(time.day) : null;
  const when = time ? `It is Day ${time.day}${weekday ? ` (${weekday})` : ''}, ${time.timeOfDay}.` : '';
  const personaName = persona ? persona.name : 'the visitor';
  const verb = mode === 'call' ? 'on a phone call with' : 'texting with';

  const identity = [char.description || '', char.personality ? `Personality: ${char.personality}` : ''].filter(Boolean).join('\n');
  const personaBlock = persona && persona.description ? `\n\n${persona.name} (${mode === 'call' ? 'calling you' : 'texting you'}):\n${persona.description}` : '';
  const memoryBlock = memories.length ? `\n\nWhat you remember:\n${memories.map((m) => `- ${m}`).join('\n')}` : '';
  const relationshipBlock = relationships.length ? `\n\nWhat you know about people:\n${relationships.map((r) => `- ${r}`).join('\n')}` : '';

  const system = [
    textingPromptTemplate.trim(),
    [when, `You are ${char.name}, ${verb} ${personaName}.`].filter(Boolean).join('\n'),
    `${char.name}:\n${identity}`,
  ].filter(Boolean).join('\n\n') + personaBlock + memoryBlock + relationshipBlock;

  return [{ role: 'system', content: system }, ...history];
}

// A conversation's stored log, mapped to plain chat-completion turns —
// the character's own lines become 'assistant', everything else (just
// 'user' for now; texting has no system/narrator entries) becomes 'user'.
export function historyFromLog(log) {
  return log
    .filter((e) => e.type === 'user' || e.type === 'char')
    .map((e) => ({ role: e.type === 'char' ? 'assistant' : 'user', content: e.text }))
    .filter((m) => m.content);
}
