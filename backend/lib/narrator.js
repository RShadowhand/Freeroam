import { weekdayFor } from './context.js';
import { joinNames } from './textUtils.js';

// How many rounds (user messages) must pass since the last narrator turn
// before an ambiance-only narration is worth another API call — applies
// whenever there's no "background cast" to justify narrating every round
// (a solo active conversation, or a fully-active group with nobody sitting
// out). Without this, an engaged 1:1 or group chat would get an aside after
// every single reply, which reads as noise rather than texture.
const AMBIANCE_CADENCE_ROUNDS = 3;

function roundsSinceLastNarration(log) {
  let rounds = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === 'narrator') break;
    if (log[i].type === 'user') rounds += 1;
  }
  return rounds;
}

// Whether the narrator is even eligible to speak this round:
// - Nobody present: the narrator is the only thing that CAN respond.
// - Anyone present-but-not-active ("background"): always worth narrating,
//   since describing them is the narrator's core job and (when this is
//   checked from the "nobody active replied" fallback) it's also the only
//   thing standing between the user and total silence — checked BEFORE the
//   private-room rule below, since a private room's sole occupant can
//   themselves be the one demoted to background, and that silence still
//   needs breaking.
// - A private place with exactly one person there, who IS active: that
//   person IS the scene — a narrator voice would be a third wheel.
// - Otherwise (a solo active chat, or a fully-active group with no one
//   sitting out): ambiance only, throttled to AMBIANCE_CADENCE_ROUNDS.
export function shouldNarrate({ placeType, presentCount, backgroundCount = 0, log = [] }) {
  if (presentCount === 0) return true;
  if (backgroundCount > 0) return true;
  if (placeType === 'private' && presentCount === 1) return false;
  return roundsSinceLastNarration(log) >= AMBIANCE_CADENCE_ROUNDS;
}

export const NARRATOR_SILENCE = '[nothing]';

export function isNarratorSilent(text) {
  return !text || !text.trim() || text.trim().toLowerCase() === NARRATOR_SILENCE;
}

// scene = {
//   place: { name, area, desc, type, ownerNames },
//   worldSetting, time: { day, timeOfDay } | null,
//   backgroundChars: [{ name, snippet }],  // present but not active
//   transcript: string,                    // recent log, already budget-trimmed
//   callContext: { calleeName } | null,     // set while the user is mid-call (Phase 3) — backgroundChars
//     are then bystanders overhearing one side of it, not an ordinary background cast
// }
export function buildNarratorMessages(scene) {
  const { place, worldSetting = '', time = null, backgroundChars = [], transcript = '', callContext = null } = scene;

  const weekday = time ? weekdayFor(time.day) : null;
  const when = time ? `It is Day ${time.day}${weekday ? ` (${weekday})` : ''}, ${time.timeOfDay}.\n` : '';
  const weather = place.weather ? `Weather: ${place.weather}.\n` : '';
  const locationLine = place.type === 'private'
    ? `This is ${place.ownerNames?.length ? `${joinNames(place.ownerNames)}'s` : "a resident's"} private place.`
    : 'This is a communal space, open to anyone.';
  const castLabel = callContext ? 'Present, silently overhearing one side of a phone call' : 'Present but not currently part of the conversation';
  const castBlock = backgroundChars.length
    ? `\n\n${castLabel}:\n${backgroundChars.map((c) => `- ${c.name}${c.snippet ? `: ${c.snippet}` : ''}`).join('\n')}`
    : '';
  const settingBlock = worldSetting.trim() ? `\n\n${worldSetting.trim()}` : '';
  const callBlock = callContext
    ? `\n\nA phone call is in progress with ${callContext.calleeName}, who isn't physically here. `
      + `The transcript below shows only this side of the call — anyone present can hear these words but not what `
      + `${callContext.calleeName} is saying back. Narrate them as overhearing half a conversation, not as part of it.`
    : '';

  const system = [
    'You are the narrator — the ambient voice of the world in a roleplay app, not a character in it. '
      + 'Describe incidental scene detail: ambiance, background events, and what present-but-uninvolved people are doing. '
      + 'Never speak, think, or act for anyone currently in the conversation, and never invent new named characters. '
      + 'Keep it to 1-3 sentences, grounded and understated — this is scene texture, not a plot twist.',
    `If genuinely nothing worth mentioning is happening right now, reply with exactly "${NARRATOR_SILENCE}" and nothing else.`,
    `${when}${weather}Current place: ${place.name}${place.area ? ` (${place.area})` : ''}\n${place.desc || ''}\n${locationLine}${castBlock}${settingBlock}${callBlock}`,
  ].join('\n\n');

  const user = transcript.trim()
    ? `Recent scene:\n${transcript.trim()}\n\nWrite the narrator's next line, or "${NARRATOR_SILENCE}".`
    : `Nothing has happened here yet. Set the scene, or reply "${NARRATOR_SILENCE}".`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
