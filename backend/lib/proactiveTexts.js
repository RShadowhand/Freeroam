// Whether a character spontaneously texts the user this time — rolled once
// per eligible character on every user input (see maybeSendProactiveTexts
// in server.js), independent of any single character's own odds. rng is
// injectable so the boundary behavior is deterministically testable
// (Math.random() returns [0, 1), so a roll of exactly `chance` never hits —
// same convention as textCascade.js's rollContinues).
export function rollsProactiveText(chance, rng = Math.random) {
  return rng() < chance;
}
