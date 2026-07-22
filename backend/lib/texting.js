import { weekdayFor } from './context.js';
import { joinNames } from './textUtils.js';

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
//   groupMembers: string[],                      // Phase 4 — other characters' names in a group text, excluding char and the user
//   proactive: boolean,                          // Phase 5 — char is texting first, unprompted; appends a final directive turn since there's no real incoming message to reply to
//   selfContinuation: boolean,                    // group cascade picked char to reply again right after their OWN last line — appends a directive turn for the same reason proactive does
// }
export function buildTextingMessages(scene, history = []) {
  const {
    char, persona = null, memories = [], relationships = [], time = null, textingPromptTemplate,
    mode = 'text', groupMembers = [], proactive = false, selfContinuation = false,
  } = scene;

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
  const groupBlock = isGroup
    ? `\n\nOther messages in this thread that aren't from ${personaName} or you are from the other people in the group — `
      + `reply as part of the conversation, not just to ${personaName}. Read back over what's already been said before `
      + `you reply — don't repeat a greeting or message you (or someone else) already sent.`
    : '';

  const system = [
    textingPromptTemplate.trim(),
    [when, `You are ${char.name}, ${verb} ${who}.`].filter(Boolean).join('\n'),
    `${char.name}:\n${identity}`,
  ].filter(Boolean).join('\n\n') + personaBlock + memoryBlock + relationshipBlock + groupBlock;

  const messages = [{ role: 'system', content: system }, ...history];
  // Every other case ends with a real incoming line to react to; a
  // proactive text doesn't, so the model needs an explicit nudge to
  // actually originate one instead of just continuing silently.
  if (proactive) {
    messages.push({
      role: 'user',
      content: `[${char.name} hasn't reached out to ${personaName} in a while and decides to text them out of the blue — either asking for something, or sharing something that happened. Write only ${char.name}'s text, dialogue only, nothing from ${personaName}.]`,
    });
  } else if (selfContinuation) {
    // The group cascade picked char to go again right after their own
    // last line (a deliberate "double text" allowance — see
    // textCascade.js's per-character cap), which otherwise ends the
    // message array on char's own 'assistant' turn with nothing new to
    // react to. Left alone, a model asked to "continue" from its own last
    // output tends to just restate it — this is the actual fix for that,
    // not the cap (an earlier, mistaken fix lowered the cap instead; see
    // textCascade.js's comment for the full history).
    messages.push({
      role: 'user',
      content: `[Nobody's replied yet, but ${char.name} has something to add — a real follow-up thought, not a repeat of what they just said. Like sending a second text right after the first. Write only that follow-up.]`,
    });
  }
  return messages;
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
//
// That folding routinely produces several consecutive turns with the same
// resulting role — e.g. two different characters both replying before the
// current speaker gets a turn are BOTH 'user' from the current speaker's
// perspective, as separate array entries. Left unmerged, a real
// conversation with three people can turn into a run of three or more
// bare 'user' turns with no 'assistant' turn between them at all — most
// providers tolerate this, but it's an unusual shape for a chat-completion
// API (some, like Anthropic's native API, require strict alternation and
// will merge or reject it), and a model can lose track of "who already
// said what" when the only thing distinguishing turns is a text prefix
// rather than the message structure itself. So: merge adjacent turns that
// end up with the same role into one, newline-joined — the model still
// sees every line and who said it, just as fewer, more clearly-formed
// turns that strictly alternate wherever the underlying speakers do.
export function groupHistoryFromLog(log, speakerId, userLabel = 'the visitor') {
  const turns = log
    .filter((e) => e.type === 'user' || e.type === 'char')
    .map((e) => {
      if (e.type === 'char' && e.charId === speakerId) return { role: 'assistant', content: e.text };
      if (e.type === 'char') return { role: 'user', content: `${e.name}: ${e.text}` };
      return { role: 'user', content: `${userLabel}: ${e.text}` };
    })
    .filter((m) => m.content);

  const merged = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content += `\n${turn.content}`;
    else merged.push({ ...turn });
  }
  return merged;
}
