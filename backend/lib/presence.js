// Pure selection logic over world.placements, split out of server.js so it
// can be unit-tested directly instead of only through full HTTP round-trips
// (most of which would otherwise need a real OpenRouter call to observe).

// Everyone physically at `placeId` — used for scene awareness (the LLM
// should know inactive characters are still in the room) and for memory
// recording (bystanders remember what happened even if they didn't react).
export function presentCharIds(placements, charactersById, placeId) {
  return Object.entries(placements || {})
    .filter(([, p]) => p && p.placeId === placeId)
    .map(([cid]) => cid)
    .filter((cid) => charactersById[cid]);
}

// The subset of presentCharIds who actually take a turn each round. Active
// is the default — a placement with no `active` field (every placement made
// before this feature existed, or a freshly-placed/moved character) counts
// as active — so a crowd's replies become trimmable by demotion rather than
// everyone always talking.
export function activeCharIds(placements, charactersById, placeId) {
  return Object.entries(placements || {})
    .filter(([, p]) => p && p.placeId === placeId && p.active !== false)
    .map(([cid]) => cid)
    .filter((cid) => charactersById[cid]);
}
