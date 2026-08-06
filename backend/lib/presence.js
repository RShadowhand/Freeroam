// Pure selection logic over world.placements, split out of server.js so it
// can be unit-tested directly instead of only through full HTTP round-trips
// (most of which would otherwise need a real OpenRouter call to observe).

// A placement's manually-set response order (see PUT /api/places/:placeId/
// order) — missing/unset sorts last, stably preserving whatever order
// Object.entries happened to return for everyone else with no order set,
// rather than clumping them all at index 0.
function orderOf(placement) {
  return typeof placement.order === 'number' ? placement.order : Infinity;
}

// Everyone physically at `placeId` — used for scene awareness (the LLM
// should know inactive characters are still in the room) and for memory
// recording (bystanders remember what happened even if they didn't react).
// Sorted by each placement's manual `order` (stable for ties/unset, so
// insertion order still applies among characters nobody has ordered yet).
export function presentCharIds(placements, charactersById, placeId) {
  return Object.entries(placements || {})
    .filter(([, p]) => p && p.placeId === placeId)
    .filter(([cid]) => charactersById[cid])
    .sort((a, b) => orderOf(a[1]) - orderOf(b[1]))
    .map(([cid]) => cid);
}

// The subset of presentCharIds who actually take a turn each round. Active
// is the default — a placement with no `active` field (every placement made
// before this feature existed, or a freshly-placed/moved character) counts
// as active — so a crowd's replies become trimmable by demotion rather than
// everyone always talking. Same manual-order sort as presentCharIds.
export function activeCharIds(placements, charactersById, placeId) {
  return Object.entries(placements || {})
    .filter(([, p]) => p && p.placeId === placeId && p.active !== false)
    .filter(([cid]) => charactersById[cid])
    .sort((a, b) => orderOf(a[1]) - orderOf(b[1]))
    .map(([cid]) => cid);
}
