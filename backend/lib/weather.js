import fs from 'fs';

// Weather is a small map keyed by area name — areas already exist
// implicitly as free-text strings on places (see relationshipKnowledge's
// area-match check in server.js), so weather hangs off that same key
// instead of a new entity.
//
// Each area is either 'auto' (re-rolled once per in-world day change,
// weighted toward continuity with the previous day) or 'manual' (a user's
// explicit pick, which the auto-roller never touches — not "unlikely to
// change," structurally skipped — until switched back to 'auto').

export const CONDITIONS = ['clear', 'sunny', 'overcast', 'rainy', 'stormy', 'foggy', 'snowy', 'windy'];

// From a given condition, how likely each condition (including staying
// put) is for the next day — keeps auto-rolled weather from swinging wildly
// (sunny -> stormy overnight) while still letting it drift and occasionally
// jump. Unlisted conditions just aren't reachable in one step from that row.
const TRANSITIONS = {
  clear: { clear: 4, sunny: 3, overcast: 2, windy: 1 },
  sunny: { sunny: 4, clear: 3, overcast: 1, windy: 1 },
  overcast: { overcast: 3, clear: 2, rainy: 2, foggy: 1, windy: 1, snowy: 1 },
  rainy: { rainy: 3, overcast: 3, stormy: 1, foggy: 1 },
  stormy: { stormy: 2, rainy: 3, overcast: 2, windy: 1, snowy: 1 },
  foggy: { foggy: 2, overcast: 3, clear: 1, rainy: 1, snowy: 1 },
  snowy: { snowy: 3, overcast: 2, clear: 1, windy: 1 },
  windy: { windy: 3, clear: 2, overcast: 2, sunny: 1 },
};

function randomCondition() {
  return CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)];
}

function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [condition, w] of entries) {
    roll -= w;
    if (roll <= 0) return condition;
  }
  return entries[entries.length - 1][0];
}

// The next day's condition given today's — falls back to a uniform random
// pick for an unrecognized/missing current condition rather than throwing,
// since this runs unattended off the world-time-advance route.
export function nextCondition(current) {
  const table = TRANSITIONS[current];
  return table ? weightedPick(table) : randomCondition();
}

export function loadWeather(w) {
  try {
    return JSON.parse(fs.readFileSync(w.paths.weather, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveWeather(w, weatherByArea) {
  fs.writeFileSync(w.paths.weather, JSON.stringify(weatherByArea, null, 2));
}

// Re-rolls every area currently in 'auto' mode for `day` — areas in
// 'manual' mode are left completely untouched, and an area already rolled
// for this exact day is left alone too (so retreating and re-advancing
// across the same day doesn't make weather flicker). Areas with no entry
// yet are seeded with a uniform random pick (no prior day to transition
// from).
export function rollAutoWeather(weatherByArea, areas, day) {
  const next = { ...weatherByArea };
  for (const area of areas) {
    const entry = next[area];
    if (entry && entry.mode === 'manual') continue;
    if (entry && entry.updatedDay === day) continue;
    const condition = entry ? nextCondition(entry.condition) : randomCondition();
    next[area] = { mode: 'auto', condition, updatedDay: day };
  }
  return next;
}

export function setManualWeather(weatherByArea, area, condition, day) {
  if (!CONDITIONS.includes(condition)) throw new Error(`Unknown weather condition: ${condition}`);
  return { ...weatherByArea, [area]: { mode: 'manual', condition, updatedDay: day } };
}

// Hands an area back to the auto-roller — keeps its current condition
// (rather than immediately re-rolling) so switching to Auto doesn't itself
// look like a weather change; the next real day change will roll it.
export function setAutoWeather(weatherByArea, area, day) {
  const entry = weatherByArea[area];
  const condition = entry ? entry.condition : randomCondition();
  return { ...weatherByArea, [area]: { mode: 'auto', condition, updatedDay: day } };
}
