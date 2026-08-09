// Reads a generated message for a small set of high-value cues — a
// destination the speaker is inviting the user toward, a new character
// being named, someone being beckoned over or stepping back, or a text
// message being promised — and turns them into suggestion chips the
// frontend can render as one-click shortcuts. Three modes (see
// detectSuggestedActions):
//   'regex'  — fixed trigger-phrase/capitalization patterns, instant, but
//              only fires on phrasing that matches the list verbatim.
//   'ml'     — local NER (entity extraction) + multi-label zero-shot intent
//              scoring via lib/nlp.js; robust to phrasing the regex was
//              never written for, at the cost of real inference time.
//   'hybrid' — runs both and merges, regex hits taking priority on overlap.
// All three degrade to "no suggestions" rather than throwing — a reply the
// heuristics can't parse is not an error, it's just a reply with nothing
// to suggest.
import { extractEntities as defaultExtractEntities, classifyIntents as defaultClassifyIntents } from './nlp.js';
import { characterAliases, characterMentionedIn, firstMentionedCharacter } from './textUtils.js';
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

// Tuned zero-shot config — measured, not guessed. Every wording and
// threshold below comes from the multi-label spot-check on DeBERTa-v3
// documented on the intent-detection research task (.kanbn, 2026-08-09
// comments): 18 cases including two real production regressions, per-label
// separation analysis — calibrated against the SAME q8 dtype nlp.js loads
// (an earlier pass calibrated on fp32 and the quantization score shift
// broke two gates in real use; thresholds and dtype are a matched set).
// The single biggest finding was that label WORDING is a hyperparameter —
// near-synonymous phrasings of the same intent measured opposite outcomes
// — so treat these strings as tuned values: don't reword without rerunning
// the spot-check. `labels` is an array so alternate wordings can be
// ensembled later (multi-label scoring makes extra hypotheses one forward
// pass each); a family's score is the max across its wordings.
//
// invite/beckon measured overlapping in *intent* space (an invite is
// semantically a beckon too), but both are slot-gated below — invite only
// produces a suggestion when a known place resolves, beckon only when a
// background character's alias matches — which neutralized every observed
// cross-fire. Their thresholds are set from their positives (all ≥ 0.97 at
// q8) rather than from clean separation.
const INTENT_FAMILIES = {
  invite: { labels: ['invites the user to go to another place'], threshold: 0.9 },
  beckon: { labels: ['invites or calls someone over to join the conversation'], threshold: 0.9 },
  leaving: { labels: ['the speaker announces that they are leaving'] }, // gated differently — see mlDemoteSuggestion
  texting: { labels: ['the speaker promises to text someone'], threshold: 0.85 },
};

// Demote can't be a simple whole-text threshold at q8: a long reply
// containing a dismissal aimed at the listener ("Go.") scores 0.98 on the
// leaving label while a genuine "I think I should get going" scores 0.86 —
// no separating threshold exists. The per-sentence data shows the split
// that does work: every false-firing sentence is second-person/imperative
// ("Go.", "Door sticks on the way out." — both 1.00) while a real
// step-back is first-person by nature. So: cheap whole-text pre-gate, then
// score only first-person sentences, decide per sentence.
const LEAVING_PRE_GATE = 0.5;
const LEAVING_SENTENCE_THRESHOLD = 0.8;

// Mirrors backend/lib/context.js's own TIMES_OF_DAY exactly (duplicated
// rather than imported — same reasoning as lib/llmSuggestedActions.js:
// context.js pulls in a much larger prompt-building surface this module
// has no other reason to depend on).
const TIMES_OF_DAY = ['sunrise', 'morning', 'noon', 'afternoon', 'evening', 'sunset', 'night'];

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
// knownNames is built from characterAliases (full name, first name,
// nicknames) rather than full names alone — real-model testing caught
// "Ezra Vane" being re-suggested as new character "Ezra" because NER
// returns whatever form the prose used, not the cast's canonical spelling.
// The persona gets the same first-name treatment for the same reason.
function isExcludedCharacterName(name, { knownNames, personaName }) {
  const lower = name.trim().toLowerCase();
  if (!lower) return true;
  if (knownNames.has(lower)) return true;
  if (personaName) {
    const personaLower = personaName.trim().toLowerCase();
    if (lower === personaLower || lower === personaLower.split(/\s+/)[0]) return true;
  }
  if (FAMILY_ADDRESS_TERMS.has(lower)) return true;
  return false;
}

function knownNameSet(characters) {
  return new Set(characters.flatMap((c) => characterAliases(c).map((a) => a.toLowerCase())));
}

// --- Intent-family scoring (ml/hybrid) ------------------------------------

// One multi-label call covering every family's wordings; per-family score
// is the max across that family's label variants. Returns null (rather than
// throwing) when the classifier is unavailable — callers treat null as
// "no ml intent signal", the same degradation contract as everything else
// here.
async function intentFamilyScores(text, classifyIntentsFn) {
  const allLabels = Object.values(INTENT_FAMILIES).flatMap((f) => f.labels);
  let scored;
  try {
    scored = await classifyIntentsFn(text, allLabels);
  } catch {
    return null;
  }
  const byLabel = new Map(scored.map((s) => [s.label, s.score]));
  const scores = {};
  for (const [family, cfg] of Object.entries(INTENT_FAMILIES)) {
    scores[family] = Math.max(...cfg.labels.map((l) => byLabel.get(l) ?? 0));
  }
  return scores;
}

function familyFires(scores, family) {
  return !!scores && scores[family] >= INTENT_FAMILIES[family].threshold;
}

// --- Texting detection (ml/hybrid only) -----------------------------------
// The regex layer has no texting patterns; a promised text is pure ml
// territory. Pipeline per the research task's validated design: whole-text
// multi-label score gates the family; the trigger SENTENCE is then located
// by re-scoring per sentence (whole-text NLI detects reliably but a long
// reply needs localization — and the trigger sentence doubles as the
// extractive summary/reason, plus the input for the time rules below);
// target resolution and the now/later split are deterministic rules, not
// model output.

function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[.!?"])\s+(?=[A-Z"“])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

// Resolves a texting promise's relative time ("tonight", "in an hour",
// "tomorrow morning") against the current in-world time. Deterministic on
// purpose — the LLM-mode attempt at having a model do this took three
// prompt iterations and still only approximated it; a keyword table over a
// 7-value enum is exact and testable. Must be run on the localized trigger
// sentence, not the whole reply: production testing caught narration
// ("He doesn't answer immediately...") hijacking the now/later split when
// rules ran over full text. Exported for tests.
export function resolveWhen(text, day = 1, timeOfDay = 'morning') {
  const t = text.toLowerCase();
  const idx = Math.max(0, TIMES_OF_DAY.indexOf(timeOfDay));
  const step = (n) => ({ day: day + Math.floor((idx + n) / TIMES_OF_DAY.length), timeOfDay: TIMES_OF_DAY[(idx + n) % TIMES_OF_DAY.length] });
  if (/right now|immediately|this (?:very )?(?:second|minute|moment)/.test(t)) return { when: 'now' };
  if (/tomorrow/.test(t)) return { when: 'later', day: day + 1, timeOfDay: /tomorrow (morning|afternoon|evening|night)/.exec(t)?.[1] ?? 'morning' };
  if (/tonight|this evening/.test(t)) return { when: 'later', day, timeOfDay: idx < TIMES_OF_DAY.indexOf('evening') ? 'evening' : 'night' };
  if (/this afternoon/.test(t)) return { when: 'later', day, timeOfDay: 'afternoon' };
  if (/in an hour|an hour|a (?:few|couple(?: of)?) hours|later today/.test(t)) return { when: 'later', ...step(2) };
  if (/\blater\b|when i (?:have|find|get|know)|once i|as soon as i/.test(t)) return { when: 'later', ...step(2) };
  return { when: 'unspecified' };
}

// Locates the sentence that carries the texting promise: re-scores each
// sentence against just the texting family's labels and takes the best
// one, falling back to the whole text when nothing clears the floor (short
// replies usually ARE the trigger). Capped so a pathological wall of text
// can't turn into an unbounded pile of classifier calls.
const TRIGGER_SENTENCE_FLOOR = 0.7;
const MAX_TRIGGER_SENTENCES = 30;
async function locateTextingTrigger(text, classifyIntentsFn) {
  const sentences = splitSentences(text).slice(0, MAX_TRIGGER_SENTENCES);
  if (sentences.length <= 1) return text;
  let best = null;
  let bestScore = 0;
  for (const s of sentences) {
    let scored;
    try {
      scored = await classifyIntentsFn(s, INTENT_FAMILIES.texting.labels);
    } catch {
      return text; // classifier died mid-scan — whole text is still a usable trigger
    }
    const score = Math.max(...scored.map((r) => r.score), 0);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= TRIGGER_SENTENCE_FLOOR ? best : text;
}

// Who the promised text is aimed at, resolved from the trigger sentence —
// deterministic, never trusts a model with the binding (the exact failure
// FunctionGemma showed in this task's research, and the reason LLM mode
// hides the persona's name from its prompt):
//   1. a known character's alias in the sentence (excluding the speaker),
//   2. the persona when addressed as "you" or by name,
//   3. a NER PER span found in the sentence — kept as a free-text name,
//   4. nobody named at all — the implicit addressee is the persona ("I'll
//      text what I find" mid-conversation is aimed at whoever's there).
function resolveTextingTarget(trigger, { characters, personaName, speakerId, entities }) {
  const others = characters.filter((c) => c.id !== speakerId);
  const mentioned = firstMentionedCharacter(trigger, others);
  if (mentioned) return { targetKind: 'character', charId: mentioned.id, targetName: mentioned.name };

  const personaFirst = personaName ? personaName.trim().split(/\s+/)[0].toLowerCase() : null;
  const asPersona = { targetKind: 'persona', charId: null, targetName: personaName || 'the persona' };
  if (/\byou\b/i.test(trigger)) return asPersona;

  const per = (entities || []).find((e) => e.type === 'PER' && trigger.toLowerCase().includes(e.text.toLowerCase()));
  if (per) {
    const lower = per.text.trim().toLowerCase();
    if (personaName && (lower === personaName.trim().toLowerCase() || lower === personaFirst)) return asPersona;
    return { targetKind: 'character', charId: null, targetName: per.text };
  }

  return asPersona;
}

async function textingSuggestion(text, ctx, scores, classifyIntentsFn) {
  if (!familyFires(scores, 'texting')) return null;
  const trigger = await locateTextingTrigger(text, classifyIntentsFn);
  const target = resolveTextingTarget(trigger, ctx);
  const when = resolveWhen(trigger, ctx.worldDay ?? 1, ctx.worldTimeOfDay ?? 'morning');
  // Sentence splitting keeps whatever quote mark the prose opened/closed
  // dialogue with, which reads as noise once the sentence stands alone as
  // a summary ('"I'll text what I find.' in a real production log).
  const gist = trigger.replace(/^["'“”‘’\s]+/, '').replace(/["'“”‘’\s]+$/, '').slice(0, 300);
  if (when.when === 'later') {
    return { type: 'scheduled-text', ...target, day: when.day, timeOfDay: when.timeOfDay, reason: gist };
  }
  // 'now' and 'unspecified' both land on an immediate text — scheduling
  // requires a concrete future day/timeOfDay, and inventing one for a
  // vague promise is exactly the guesswork this pipeline exists to avoid.
  return { type: 'text-someone', ...target, summary: gist };
}

// --- Participation (promote/demote) ---------------------------------------

function regexPromoteSuggestion(text, { backgroundCharacters }) {
  if (!backgroundCharacters.length || !BECKON_RE.test(text)) return null;
  const match = backgroundCharacters.find((c) => characterMentionedIn(text, c));
  return match ? { type: 'promote', charId: match.id, name: match.name } : null;
}

function regexDemoteSuggestion(text, { speakerId, speakerName }) {
  if (!speakerId || !STEP_BACK_RE.test(text)) return null;
  return { type: 'demote', charId: speakerId, name: speakerName };
}

// ml promote consumes the shared multi-label scores computed once in
// detectSuggestedActions — no classifier calls of its own. The alias/
// speaker gating is unchanged from the regex versions: the classifier only
// earns its keep on the intent side, never on deciding *who*.
function mlPromoteSuggestion(text, { backgroundCharacters }, scores) {
  if (!backgroundCharacters.length || !familyFires(scores, 'beckon')) return null;
  const match = backgroundCharacters.find((c) => characterMentionedIn(text, c));
  return match ? { type: 'promote', charId: match.id, name: match.name } : null;
}

// See the LEAVING_* comment above for why demote is sentence-level: the
// whole-text score only pre-gates (cheap skip for the common no-signal
// case); the decision comes from first-person sentences alone, so a
// dismissal aimed at the listener ("Go.") structurally can't fire it —
// and a reply with no first-person sentence at all has nobody excusing
// themselves, so it never demotes.
async function mlDemoteSuggestion(text, { speakerId, speakerName }, scores, classifyIntentsFn) {
  if (!speakerId || !scores || scores.leaving < LEAVING_PRE_GATE) return null;
  const firstPerson = splitSentences(text).filter((s) => /\bI\b/.test(s)).slice(0, MAX_TRIGGER_SENTENCES);
  for (const s of firstPerson) {
    let scored;
    try {
      scored = await classifyIntentsFn(s, INTENT_FAMILIES.leaving.labels);
    } catch {
      return null;
    }
    if (Math.max(...scored.map((r) => r.score), 0) >= LEAVING_SENTENCE_THRESHOLD) {
      return { type: 'demote', charId: speakerId, name: speakerName };
    }
  }
  return null;
}

// Promote/demote are checked independently of destination/new-character
// detection and its 3-suggestion cap — there's at most one of each
// (there's only one speaker to demote, and a beckon phrase names at most
// one background character), so there's no dedup/overflow logic to share
// with mergeSuggestions. 'hybrid' tries the regex heuristic first (cheap,
// instant) and only falls back to the ml scores when regex finds nothing,
// mirroring "regex hits take priority" without needing an actual merge step.
async function participationSuggestions(text, ctx, mode, scores, classifyIntentsFn) {
  const out = [];

  const promote = mode === 'ml'
    ? mlPromoteSuggestion(text, ctx, scores)
    : regexPromoteSuggestion(text, ctx) || (mode === 'hybrid' ? mlPromoteSuggestion(text, ctx, scores) : null);
  if (promote) out.push(promote);

  const demote = mode === 'ml'
    ? await mlDemoteSuggestion(text, ctx, scores, classifyIntentsFn)
    : regexDemoteSuggestion(text, ctx) || (mode === 'hybrid' ? await mlDemoteSuggestion(text, ctx, scores, classifyIntentsFn) : null);
  if (demote) out.push(demote);

  return out;
}

// --- Destination / new-character ------------------------------------------

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

  const knownNames = knownNameSet(characters);
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

async function mlSuggestions(text, { places, characters, currentPlaceId, personaName }, entities, scores) {
  const suggestions = [];
  const seen = new Set();

  const locEntities = entities.filter((e) => e.type === 'LOC').sort((a, b) => b.score - a.score);
  if (locEntities.length) {
    const place = matchPlace(locEntities[0].text, places);
    if (!place) {
      // A genuinely new place is worth surfacing on its own — mirrors
      // new-character detection below, which isn't intent-gated either.
      // Only the actionable "send/go there" suggestions for a *known*
      // place need the stronger invite-intent signal; merely recognizing
      // a name as place-shaped doesn't.
      seen.add(`dest:${locEntities[0].text.toLowerCase()}`);
      suggestions.push({ type: 'destination', known: false, placeName: locEntities[0].text });
    } else if (place.id !== currentPlaceId && familyFires(scores, 'invite')) {
      seen.add(`dest:${place.id}`);
      suggestions.push({ type: 'destination', known: true, placeId: place.id, placeName: place.name });
    }
  }

  const knownNames = knownNameSet(characters);
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

// Returns up to 6 suggestion objects:
//   { type: 'destination', known: true,  placeId, placeName } — matched an existing place
//   { type: 'destination', known: false, placeName }          — no existing place matched
//   { type: 'new-character', name }                           — a name not already in the cast
//   { type: 'promote', charId, name }                         — a background character is being beckoned over
//   { type: 'demote', charId, name }                          — the speaker is stepping back from the conversation
//   { type: 'text-someone', targetKind, charId, targetName, summary }                      — ml/hybrid only
//   { type: 'scheduled-text', targetKind, charId, targetName, day, timeOfDay, reason }     — ml/hybrid only
// The texting shapes match lib/llmSuggestedActions.js's parseIntents output
// exactly, so the frontend renders both modes' chips identically.
// extractEntitiesFn/classifyIntentsFn default to the real local-model calls
// in lib/nlp.js but can be swapped out — mainly so tests can exercise 'ml'/
// 'hybrid' mode without pulling down real models. classifyIntentsFn is the
// multi-label contract: (text, labels) => [{ label, score }] covering every
// requested label, scores independent (no softmax competition). personaName
// is the active persona's display name — excluded from new-character
// detection since that's the user, not someone to add. backgroundCharacters
// is the present-but-inactive cast at this place (see backend/lib/
// presence.js), needed to resolve who a beckon phrase could plausibly be
// about; speakerId/speakerName identify whose turn this is, since a
// step-back suggestion is reflexive. worldDay/worldTimeOfDay feed the
// scheduled-text time rules (defaulting to day 1 morning when absent).
export async function detectSuggestedActions(text, {
  places = [], characters = [], currentPlaceId = null, mode = 'regex', personaName = null,
  backgroundCharacters = [], speakerId = null, speakerName = null,
  worldDay = null, worldTimeOfDay = null,
  extractEntitiesFn = defaultExtractEntities, classifyIntentsFn = defaultClassifyIntents,
} = {}) {
  if (!text) return [];
  const ctx = { places, characters, currentPlaceId, personaName, backgroundCharacters, speakerId, speakerName, worldDay, worldTimeOfDay };

  // One classifier call and one NER call shared by everything downstream —
  // either failing degrades that half of the pipeline to "no signal", never
  // to an error.
  let scores = null;
  let entities = null;
  if (mode === 'ml' || mode === 'hybrid') {
    scores = await intentFamilyScores(text, classifyIntentsFn);
    try {
      entities = await extractEntitiesFn(text);
    } catch {
      entities = null;
    }
  }
  ctx.entities = entities || [];

  let suggestions;
  if (mode === 'ml') {
    suggestions = entities ? await mlSuggestions(text, ctx, entities, scores) : [];
  } else if (mode === 'hybrid') {
    suggestions = mergeSuggestions(
      regexSuggestions(text, ctx),
      entities ? await mlSuggestions(text, ctx, entities, scores) : [],
    );
  } else {
    suggestions = regexSuggestions(text, ctx);
  }

  suggestions = [...suggestions, ...(await participationSuggestions(text, ctx, mode, scores, classifyIntentsFn))];

  if ((mode === 'ml' || mode === 'hybrid') && scores) {
    const texting = await textingSuggestion(text, ctx, scores, classifyIntentsFn);
    if (texting) suggestions.push(texting);
  }

  logger.info('suggest', `${mode}: ${suggestions.length} suggestion(s)`);
  logger.debug('suggest', 'detection detail', { mode, text: text.slice(0, 120), suggestions, scores });
  return suggestions;
}
