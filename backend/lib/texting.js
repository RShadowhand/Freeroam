import { weekdayFor } from './context.js';

// Texting gets its own small, self-contained prompt builder rather than
// being squeezed through the physical-scene pipeline (scenarioBlock/
// markerContent/assemblePresetMessages) — that pipeline assumes a real
// place (locationLine, "also present", preset-configurable blocks aimed
// at scene structure) that doesn't apply to a remote text exchange. Same
// reasoning narrator.js already followed for its own dedicated
// buildNarratorMessages rather than reusing defaultSystemPrompt.
//
// "A" / "A and B" / "A, B, and C" — used for the group-text roster line.
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

// scene = {
//   char: { name, description, personality },   // the character replying
//   persona: { name, description } | null,      // active user persona, or null
//   memories: string[],                         // relevant memory snippets, already retrieved by the caller
//   relationships: string[],                     // speaker's relations + whereabouts knowledge, resolved by caller
//   time: { day, timeOfDay } | null,             // in-world clock
//   textingPromptTemplate: string,               // already resolved to the built-in default if unset
//   mode: 'text' | 'call',                       // 'call' phrases this as a live phone call, not a text thread — see Phase 3
//   groupMembers: string[],                      // Phase 4 — other characters' names in a group text, excluding char and the user
// }
export function buildTextingMessages(scene, history = []) {
  const { char, persona = null, memories = [], relationships = [], time = null, textingPromptTemplate, mode = 'text', groupMembers = [] } = scene;

  const weekday = time ? weekdayFor(time.day) : null;
  const when = time ? `It is Day ${time.day}${weekday ? ` (${weekday})` : ''}, ${time.timeOfDay}.` : '';
  const personaName = persona ? persona.name : 'the visitor';
  const isGroup = groupMembers.length > 0;
  const verb = mode === 'call' ? 'on a phone call with' : isGroup ? 'in a group text with' : 'texting with';
  const who = isGroup ? joinNames([personaName, ...groupMembers]) : personaName;

  const identity = [char.description || '', char.personality ? `Personality: ${char.personality}` : ''].filter(Boolean).join('\n');
  const personaBlock = persona && persona.description ? `\n\n${persona.name} (${mode === 'call' ? 'calling you' : 'texting you'}):\n${persona.description}` : '';
  const memoryBlock = memories.length ? `\n\nWhat you remember:\n${memories.map((m) => `- ${m}`).join('\n')}` : '';
  const relationshipBlock = relationships.length ? `\n\nWhat you know about people:\n${relationships.map((r) => `- ${r}`).join('\n')}` : '';
  const groupBlock = isGroup ? `\n\nOther messages in this thread that aren't from ${personaName} or you are from the other people in the group — reply as part of the conversation, not just to ${personaName}.` : '';

  const system = [
    textingPromptTemplate.trim(),
    [when, `You are ${char.name}, ${verb} ${who}.`].filter(Boolean).join('\n'),
    `${char.name}:\n${identity}`,
  ].filter(Boolean).join('\n\n') + personaBlock + memoryBlock + relationshipBlock + groupBlock;

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

// Group texting's version of historyFromLog — a plain chat-completion API
// only has system/user/assistant roles, no "third party," so only the
// character CURRENTLY replying gets their own past lines back as
// 'assistant' (preserving their own voice); the user's lines AND every
// other character's lines both fold into 'user', with other characters'
// lines prefixed by name so the speaker can tell who said what.
export function groupHistoryFromLog(log, speakerId, userLabel = 'the visitor') {
  return log
    .filter((e) => e.type === 'user' || e.type === 'char')
    .map((e) => {
      if (e.type === 'char' && e.charId === speakerId) return { role: 'assistant', content: e.text };
      if (e.type === 'char') return { role: 'user', content: `${e.name}: ${e.text}` };
      return { role: 'user', content: `${userLabel}: ${e.text}` };
    })
    .filter((m) => m.content);
}
