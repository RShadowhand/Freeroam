// Reads a generated message for a small set of high-value cues — a
// destination the speaker is inviting the user toward, or a new character
// being named — and turns them into suggestion chips the frontend can
// render as one-click shortcuts. Three modes (see detectSuggestedActions):
//   'regex'  — fixed trigger-phrase/capitalization patterns, instant, but
//              only fires on phrasing that matches the list verbatim.
//   'ml'     — local NER (entity extraction) + zero-shot intent
//              classification via lib/nlp.js; robust to phrasing the regex
//              was never written for, at the cost of real inference time.
//   'hybrid' — runs both and merges, regex hits taking priority on overlap.
// All three degrade to "no suggestions" rather than throwing — a reply the
// heuristics can't parse is not an error, it's just a reply with nothing
// to suggest.
import { extractEntities as defaultExtractEntities, classifyIntent as defaultClassifyIntent } from './nlp.js';
import { characterMentionedIn } from './textUtils.js';
import { logger } from './log.js';

// Trigger words use explicit [Xx] case classes rather than a blanket /i
// flag, so the destination capture below can stay case-sensitive on
// [A-Z] — that's what tells a proper-noun-like phrase apart from the
// rest of the sentence.
const INVITE_DEST_RE = /\b(?:[Ll]et'?s\s+(?:go|head|walk)(?:\s+on)?|[Cc]ome\s+(?:with\s+me|along)|[Ff]ollow\s+me|[Ww]alk\s+with\s+me|[Hh]eads?\s+(?:over\s+|off\s+)?(?:to|toward)|[Tt]akes?\s+you\s+to|[Ll]eads?\s+you\s+to|[Ii]nvit(?:es?|ing)\s+you\s+to)\b\s*(?:to\s+)?(?:the\s+)?([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,3})/;

const NEW_CHAR_RE = /\b(?:named|called)\s+([A-Z][A-Za-z'\-]+)\b/g;

// Beckon/step-back are intent signals, not new entities, so unlike
// destination/new-character detection they never introduce anyone new —
// they only fire when the text plausibly concerns someone already known to
// be present-but-background (beckon) or the speaker themselves (step-back).
// Case-insensitive throughout, unlike INVITE_DEST_RE/NEW_CHAR_RE above,
// since there's no proper-noun capture riding on the capitalization here.
const BECKON_RE = /\b(?:come (?:here|over|on over|join us|closer)|join (?:us|me)|come (?:sit|hang) with us|why don'?t you join|pull up a (?:chair|seat))\b/i;
const STEP_BACK_RE = /\b(?:excuses? (?:myself|themselves|herself|himself)|steps? away|walks? off|have to (?:go|take this|run|step out)|needs? (?:a moment|a minute)|be right back|catch (?:up|you) later|duty calls|gotta (?:go|run))\b/i;

const INTENT_INVITE = 'invites the user to go to another place';
const INTENT_INTRODUCE = 'introduces a new character by name';
const INTENT_BECKON = 'invites or calls someone over to join the conversation';
const INTENT_STEP_BACK = 'the speaker excuses themselves or steps back from the conversation';
const INTENT_NONE = 'none of the above';
const INTENT_THRESHOLD = 0.55; // zero-shot scores are calibrated loosely — this was picked by feel, not a benchmark

// Generic family address terms — "Mom"/"Daddy" read as a proper noun (both
// to the regex's capitalization check and to NER, which tags them PER when
// used as a direct address) but naming one isn't naming a *new character*
// worth a suggestion chip. Includes both the formal relationship word
// (mother/father/...) and its informal address forms (mommy/mom/mama/...)
// since either can appear capitalized as "Mother, look!" or "Mom, look!".
const FAMILY_ADDRESS_TERMS = new Set([
  'mom', 'mommy', 'mama', 'ma', 'mother',
  'dad', 'daddy', 'papa', 'pa', 'father',
  'grandma', 'grandmother', 'granny', 'nana',
  'grandpa', 'grandfather', 'gramps', 'pop',
  'sis', 'sister', 'bro', 'brother',
  'auntie', 'aunt', 'uncle',
]);

// A candidate name isn't worth a "+ Add character" suggestion when it's
// already in the cast, it's the active persona's own name (that's the
// user, not someone to add), or it's a generic family address term.
function isExcludedCharacterName(name, { knownNames, personaName }) {
  const lower = name.trim().toLowerCase();
  if (!lower) return true;
  if (knownNames.has(lower)) return true;
  if (personaName && lower === personaName.trim().toLowerCase()) return true;
  if (FAMILY_ADDRESS_TERMS.has(lower)) return true;
  return false;
}

function regexPromoteSuggestion(text, { backgroundCharacters }) {
  if (!backgroundCharacters.length || !BECKON_RE.test(text)) return null;
  const match = backgroundCharacters.find((c) => characterMentionedIn(text, c));
  return match ? { type: 'promote', charId: match.id, name: match.name } : null;
}

function regexDemoteSuggestion(text, { speakerId, speakerName }) {
  if (!speakerId || !STEP_BACK_RE.test(text)) return null;
  return { type: 'demote', charId: speakerId, name: speakerName };
}

async function mlPromoteSuggestion(text, { backgroundCharacters, classifyIntentFn }) {
  if (!backgroundCharacters.length) return null;
  let intent = [];
  try {
    intent = await classifyIntentFn(text, [INTENT_BECKON, INTENT_NONE]);
  } catch {
    return null; // model unavailable/failed — no ML suggestion, not an error
  }
  if (!(intent[0] && intent[0].label === INTENT_BECKON && intent[0].score >= INTENT_THRESHOLD)) return null;
  const match = backgroundCharacters.find((c) => characterMentionedIn(text, c));
  return match ? { type: 'promote', charId: match.id, name: match.name } : null;
}

async function mlDemoteSuggestion(text, { speakerId, speakerName, classifyIntentFn }) {
  if (!speakerId) return null;
  let intent = [];
  try {
    intent = await classifyIntentFn(text, [INTENT_STEP_BACK, INTENT_NONE]);
  } catch {
    return null;
  }
  if (!(intent[0] && intent[0].label === INTENT_STEP_BACK && intent[0].score >= INTENT_THRESHOLD)) return null;
  return { type: 'demote', charId: speakerId, name: speakerName };
}

// Promote/demote are checked independently of destination/new-character
// detection and its 3-suggestion cap — there's at most one of each
// (there's only one speaker to demote, and a beckon phrase names at most
// one background character), so there's no dedup/overflow logic to share
// with mergeSuggestions. 'hybrid' tries the regex heuristic first (cheap,
// instant) and only falls back to the ML classifier when regex finds
// nothing, mirroring "regex hits take priority" without needing an actual
// merge step.
async function participationSuggestions(text, ctx, mode) {
  const out = [];

  const promote = mode === 'ml'
    ? await mlPromoteSuggestion(text, ctx)
    : regexPromoteSuggestion(text, ctx) || (mode === 'hybrid' ? await mlPromoteSuggestion(text, ctx) : null);
  if (promote) out.push(promote);

  const demote = mode === 'ml'
    ? await mlDemoteSuggestion(text, ctx)
    : regexDemoteSuggestion(text, ctx) || (mode === 'hybrid' ? await mlDemoteSuggestion(text, ctx) : null);
  if (demote) out.push(demote);

  return out;
}

function matchPlace(phrase, places) {
  const norm = phrase.trim().toLowerCase();
  if (!norm) return null;
  return places.find((p) => {
    const pn = p.name.trim().toLowerCase();
    return pn === norm || norm.includes(pn) || pn.includes(norm);
  }) || null;
}

function destinationSuggestion(phrase, places, currentPlaceId) {
  const place = matchPlace(phrase, places);
  if (place && place.id !== currentPlaceId) {
    return { key: `dest:${place.id}`, suggestion: { type: 'destination', known: true, placeId: place.id, placeName: place.name } };
  }
  if (!place) {
    return { key: `dest:${phrase.toLowerCase()}`, suggestion: { type: 'destination', known: false, placeName: phrase } };
  }
  return null; // matched, but it's where they already are
}

function regexSuggestions(text, { places, characters, currentPlaceId, personaName }) {
  const suggestions = [];
  const seen = new Set();

  const inviteMatch = INVITE_DEST_RE.exec(text);
  if (inviteMatch) {
    const hit = destinationSuggestion(inviteMatch[1].trim(), places, currentPlaceId);
    if (hit) { seen.add(hit.key); suggestions.push(hit.suggestion); }
  }

  const knownNames = new Set(characters.map((c) => c.name.trim().toLowerCase()));
  NEW_CHAR_RE.lastIndex = 0;
  let m;
  while (suggestions.length < 3 && (m = NEW_CHAR_RE.exec(text))) {
    const name = m[1].trim();
    const key = `char:${name.toLowerCase()}`;
    if (!isExcludedCharacterName(name, { knownNames, personaName }) && !seen.has(key)) {
      seen.add(key);
      suggestions.push({ type: 'new-character', name });
    }
  }

  return suggestions.slice(0, 3);
}

async function mlSuggestions(text, { places, characters, currentPlaceId, personaName }, extractEntitiesFn, classifyIntentFn) {
  const suggestions = [];
  const seen = new Set();

  let entities;
  try {
    entities = await extractEntitiesFn(text);
  } catch {
    return suggestions; // model unavailable/failed — no ML suggestions, not an error
  }

  const locEntities = entities.filter((e) => e.type === 'LOC').sort((a, b) => b.score - a.score);
  if (locEntities.length) {
    const place = matchPlace(locEntities[0].text, places);
    if (!place) {
      // A genuinely new place is worth surfacing on its own — mirrors
      // new-character detection below, which isn't intent-gated either.
      // Only the actionable "send/go there" suggestions for a *known*
      // place need the stronger invite-intent signal (below); merely
      // recognizing a name as place-shaped doesn't.
      seen.add(`dest:${locEntities[0].text.toLowerCase()}`);
      suggestions.push({ type: 'destination', known: false, placeName: locEntities[0].text });
    } else if (place.id !== currentPlaceId) {
      let intent = [];
      try {
        intent = await classifyIntentFn(text, [INTENT_INVITE, INTENT_INTRODUCE, INTENT_NONE]);
      } catch { /* leave intent empty — no invite suggestion without it */ }
      if (intent[0] && intent[0].label === INTENT_INVITE && intent[0].score >= INTENT_THRESHOLD) {
        seen.add(`dest:${place.id}`);
        suggestions.push({ type: 'destination', known: true, placeId: place.id, placeName: place.name });
      }
    }
  }

  const knownNames = new Set(characters.map((c) => c.name.trim().toLowerCase()));
  for (const e of entities) {
    if (suggestions.length >= 3) break;
    if (e.type !== 'PER') continue;
    const key = `char:${e.text.toLowerCase()}`;
    if (!isExcludedCharacterName(e.text, { knownNames, personaName }) && !seen.has(key)) {
      seen.add(key);
      suggestions.push({ type: 'new-character', name: e.text });
    }
  }

  return suggestions.slice(0, 3);
}

function mergeSuggestions(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const s of [...primary, ...secondary]) {
    const key = s.type === 'destination'
      ? (s.known ? `dest:${s.placeId}` : `dest:${s.placeName.toLowerCase()}`)
      : `char:${s.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

// Returns up to 5 suggestion objects:
//   { type: 'destination', known: true,  placeId, placeName } — matched an existing place
//   { type: 'destination', known: false, placeName }          — no existing place matched
//   { type: 'new-character', name }                           — a name not already in the cast
//   { type: 'promote', charId, name }                         — a background character is being beckoned over
//   { type: 'demote', charId, name }                          — the speaker is stepping back from the conversation
// extractEntitiesFn/classifyIntentFn default to the real local-model calls
// in lib/nlp.js but can be swapped out — mainly so tests can exercise 'ml'/
// 'hybrid' mode without pulling down real models. personaName is the active
// persona's display name — excluded from new-character detection since
// that's the user, not someone to add. backgroundCharacters is the present-
// but-inactive cast at this place (see backend/lib/presence.js), needed to
// resolve who a beckon phrase could plausibly be about; speakerId/speakerName
// identify whose turn this is, since a step-back suggestion is reflexive.
export async function detectSuggestedActions(text, {
  places = [], characters = [], currentPlaceId = null, mode = 'regex', personaName = null,
  backgroundCharacters = [], speakerId = null, speakerName = null,
  extractEntitiesFn = defaultExtractEntities, classifyIntentFn = defaultClassifyIntent,
} = {}) {
  if (!text) return [];
  const ctx = { places, characters, currentPlaceId, personaName, backgroundCharacters, speakerId, speakerName, classifyIntentFn };

  let suggestions;
  if (mode === 'ml') {
    suggestions = await mlSuggestions(text, ctx, extractEntitiesFn, classifyIntentFn);
  } else if (mode === 'hybrid') {
    const [regexHits, mlHits] = await Promise.all([
      regexSuggestions(text, ctx),
      mlSuggestions(text, ctx, extractEntitiesFn, classifyIntentFn),
    ]);
    suggestions = mergeSuggestions(regexHits, mlHits);
  } else {
    suggestions = regexSuggestions(text, ctx);
  }

  suggestions = [...suggestions, ...(await participationSuggestions(text, ctx, mode))];

  logger.info('suggest', `${mode}: ${suggestions.length} suggestion(s)`);
  logger.debug('suggest', 'detection detail', { mode, text: text.slice(0, 120), suggestions });
  return suggestions;
}
