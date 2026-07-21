// The reply cascade: after any message lands in a group text (from the
// user or, recursively, from a cascade reply itself), each further reply is
// an independent coin flip whose odds shrink with every reply that's
// already landed — self-terminating regardless of group size, and cheap
// to reason about without any group-size-specific rule.
//
// Defaults are tuned (via expected-value math + a Monte Carlo check, not
// just a guess) against the plan's two anchors:
//   - 2 others in the group -> ~3-5 total cascade replies
//   - 5 others in the group -> ~0.7-0.8 average replies per character
// Both come out of the same base/decay pair because total cascade length
// is driven almost entirely by the decay curve, not by how many people are
// eligible to reply — group size only changes how that same total gets
// split across more or fewer people.
export const DEFAULT_CASCADE_BASE_CHANCE = 0.85;
export const DEFAULT_CASCADE_DECAY_RATE = 0.98;
// A character replying to their own last line back-to-back reads as a
// natural "double text" at 2 — real people do this. An earlier version of
// this comment blamed a cap >1 for characters repeating themselves with
// nothing new to react to, but that turned out to be a red herring: the
// actual cause was groupHistoryFromLog (lib/texting.js) sending the model
// several consecutive same-role turns with no structural signal separating
// them, which is now fixed by merging those turns. Cascade length (E[N])
// is governed by the decay curve, not by this cap — it only decides who's
// picked, so this value doesn't change the tuned anchors (confirmed by
// simulation: ~3-5 total for 2 others, ~0.7-0.8/character for 5 others,
// same at cap 1 or 2).
export const DEFAULT_CASCADE_PER_CHARACTER_CAP = 2;

// Hard ceiling on additional replies per cascade, regardless of how the
// dice keep landing — decay alone only ever asymptotes toward zero chance,
// it never actually reaches it, so a real (if astronomically unlikely) run
// of luck could otherwise run unbounded. Not a tunable setting: this is a
// safety net, not part of the tuned feel.
export const MAX_CASCADE_REPLIES = 12;

// The chance that reply number `repliesSoFar + 1` happens, given how many
// replies have already landed in this cascade.
export function nextCascadeChance(baseChance, decayRate, repliesSoFar) {
  return baseChance * Math.pow(decayRate, repliesSoFar);
}

export function rollContinues(chance, rng = Math.random) {
  return rng() < chance;
}

// Everyone eligible to reply next: the full candidate pool, minus the
// current speaker once they've hit the consecutive-reply cap — a lower
// cap keeps one character from monologuing while everyone else in the
// group stays silent; it does NOT limit how many times a character can
// reply across the whole cascade, only back-to-back. Falls back to the
// full pool if excluding the streak-holder would leave nobody at all
// (e.g. a 1-participant "group", which shouldn't exist but shouldn't
// crash either).
export function eligibleReplierIds(candidateIds, lastSpeakerId, lastSpeakerStreak, perCharacterCap) {
  if (lastSpeakerId !== null && lastSpeakerStreak >= perCharacterCap) {
    const filtered = candidateIds.filter((id) => id !== lastSpeakerId);
    if (filtered.length) return filtered;
  }
  return candidateIds;
}

export function pickReplier(candidateIds, rng = Math.random) {
  return candidateIds[Math.floor(rng() * candidateIds.length)];
}
