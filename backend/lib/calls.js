import fs from 'fs';

// In-progress phone calls, keyed by the placeId the user was physically in
// when the call started (that's whose chat log the call gets appended
// into, and whose present-but-not-on-the-call characters are the
// bystanders being demoted/restored). Not copied on world clone — like
// weather.json, this is transient runtime state, not curated world data.
//
// calls[placeId] = {
//   charId, name,               // the callee
//   bystanders: { [charId]: true | false | null },  // pre-call `active`
//     snapshot — null means "no explicit active field before the call"
//     (restore by clearing it, not by setting it to true) so someone
//     already demoted before the call started stays demoted after.
//   transcript: [{ type: 'user'|'char', text }],     // this call's own
//     dialogue only, in buildTextingMessages/historyFromLog's shape —
//     kept separately from the place's full chat log so a call's
//     generation history never includes anything from the physical scene
//     around it (a call is closer to a text exchange than a place scene).
//   roundCount,
// }

export function loadCalls(w) {
  try {
    return JSON.parse(fs.readFileSync(w.paths.calls, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveCalls(w, calls) {
  fs.writeFileSync(w.paths.calls, JSON.stringify(calls, null, 2));
}
