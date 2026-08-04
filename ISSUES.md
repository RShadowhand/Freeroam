# Known issues / fix plan

Verified against the codebase on 2026-08-03. Each item below was checked against
the actual source (not taken on faith) — see the "Verification" note under each
where the original report needed a correction.

## P1 — user-visible correctness

### 1. Long character names break reply-multiplex detection (`backend/lib/context.js:542,553`)
```js
const NAME_LINE = /^([A-Za-z][A-Za-z' -]{1,30}):\s*(.+)$/;
```
Character names have no length limit at creation (unlike world names, capped at
100 chars), so a name over ~31 characters is fully reachable.

**Verification note:** the original report claimed this falls back to
`presentChars[0]` ("first character in the room"). That fallback branch in
`parseReplyLines` is actually **unreachable in production** — it's only called
via `parseCharacterTurn` after a pre-check (`lines.every(l => NAME_LINE.test(l))`)
has already required every line to match, so the fallback can never fire from
that path. What actually happens: a long name makes `allNameLines` evaluate
`false`, so the entire multi-line reply collapses into **one entry attributed to
the real speaker**, with any other character's `"Name: ..."` line left as
literal unstripped text inside that one bubble — a garbled-display bug, not a
wrong-speaker-credited bug.

**Fix:** raise or remove the `{1,30}` cap (e.g. bump to a sane bound like 100 to
match the world-name convention), and collapse the two hardcoded copies of this
regex (`context.js:542` inline literal, `:553` exported `NAME_LINE` const) into
one shared constant so a future fix only has to happen in one place.

### 2. Typo in chat.js error messages ("goes wrong" → "went wrong")
7 occurrences in `frontend/src/stores/chat.js` (lines 120, 240, 244, 279, 283,
335, 339): `"Something goes wrong trying to reach the room."` / `"...on the
call."`.

**Verification note:** the original report claimed "same pattern in phone.js."
That's wrong — `phone.js`/`groups.js` use "Couldn't send that."/"Couldn't retry."
(grammatically correct, no typo). Only `chat.js` needs fixing.

**Fix:** `s/goes wrong/went wrong/` at the 7 sites in `chat.js` only.

## P2 — real races / resource risks

### 3. `openConversation` has no in-flight guard (`frontend/src/stores/phone.js:25-35`, `groups.js:60-67`)
Both check `this.loadedIds.has(id)` only — not set until *after* the `await`
resolves — so two concurrent calls before the first resolves both pass the
guard and fire duplicate GET requests for the same conversation.

**Verification note:** the original report only named `phone.js`. `groups.js`
has the identical bug at the identical lines-shape (`:60-67`) and needs the
same fix.

**Fix:** add a synchronous re-entrancy guard mirroring `chat.js`'s `entering`
flag — set a boolean (or add the id to an "in-flight" Set) synchronously before
the first `await`, checked at the top of the function, in both stores.

### 4. No timeout on OpenRouter API calls (`backend/server.js` — `callOpenRouter`, `streamOpenRouter`)
Both use `fetch` with no `signal`/`AbortController`. A hung endpoint ties up
the Express request (and, for streaming, the SSE connection) indefinitely.

**Fix:** wrap both calls with an `AbortController` + reasonable timeout budget
(e.g. 60-120s, maybe configurable), aborting and surfacing a clear timeout
error instead of hanging forever.

### 5. `maybeSendProactiveTexts` has no concurrency limit (`backend/server.js:1671-1681`)
Fire-and-forget: one OpenRouter call launched per rolling character with no
queue or cap. A world with many characters and a high `textingChancePerChar`
can burst many concurrent API calls off a single user input.

**Fix:** cap simultaneous in-flight proactive generations (small
concurrency-limited queue, or just a hard cap on how many roll per input).

## P3 — performance, no user-visible bug yet

### 6. `buildTurnRequest` reloads all world data per character turn (`backend/server.js:3079-3090`, loop at `:3363-3365`)
In `runReactionRound`, every reacting character's turn calls `buildTurnRequest`,
which reloads `loadWorld`, `loadPlaces`, `loadPersonas`, `loadPresets` from
disk — same data, N times for N active characters. Only the chat `log` itself
genuinely needs re-reading each iteration (since each turn appends new entries
the next character should see).

**Fix:** hoist those four loads out of the loop, load once, pass down.

### 7. `metCharacterIds` scans every place's entire chat log on every `GET /api/world` (`backend/server.js:2427-2435`)
O(places × log_size), called on every world-state fetch — and `loadWorldState()`
is called from 7+ views/components on mount (Freeroam, Cast, Places, Prompts,
RelationsGraph, onboarding, chat.js's own re-sync).

**Fix:** cache per-world, invalidate/update incrementally when a `type:'char'`
entry is appended (in `appendChatEntries`) instead of recomputing from a full
scan every request.

### 8. `countUnreadProactiveTexts` scans every text file every 20 seconds (`backend/server.js:1688-1701`, poll in `frontend/src/views/FreeroamView.vue:48`)
`readdirSync` + per-file parse on every poll tick, no caching. Gets slower as
text conversations accumulate.

**Fix:** same idea as #7 — maintain/derive the count incrementally rather than
re-scanning every file every 20s.

### 9. `backfillMemoryVectorIndex` loads all embeddings into JS memory at once (`backend/lib/db.js:332`)
`db.prepare('SELECT id, embedding FROM memories').all()` pulls every embedding
blob into one JS array.

**Verification note:** this is gated to run **once per database's lifetime**
(short-circuits if `memory_vectors` already exists), not on every startup as
the original phrasing implied. Lower priority than it reads — a world would
need thousands of memories before this cost is noticeable, and it only ever
happens once.

**Fix:** low priority; batch the SELECT/insert in chunks if it ever becomes a
real problem.

## P4 — maintainability, no behavior change

### 10. Triplicated SSE parser (`frontend/src/stores/chat.js:155-167`, `phone.js:61-73`, `groups.js:69-81`)
**Verification note:** the original report said "duplicated" (2 stores). It's
actually **triplicated** — `chat.js` has an identical copy too. The surrounding
`_consumeSse` loop is also near-identical between `phone.js`/`groups.js`
(`chat.js`'s differs because it drives a live-typing bubble that accumulates
text char-by-char).

**Fix:** extract one shared SSE-frame-parsing helper (and ideally the
consume-loop shape shared by phone/groups) used by all three stores.

### 11. `rebuildAllMemoryEmbeddings` has no transaction guard (`backend/lib/memoryStore.js:379-390`)
If the process crashes mid-rebuild, some memories get new embeddings while
others keep stale ones. Every other multi-row mutation in this file wraps in
`db.transaction()`.

**Note for whoever fixes this:** not a one-line wrap like the other call
sites — `db.transaction()` requires a **synchronous** callback, and this
function's per-row work is `async` (`await embedFn(...)`). The fix needs to
compute all the embeddings first (async, outside any transaction), then wrap
just the DB writes (the `UPDATE`/`upsertMemoryVectors` calls) in one
synchronous `db.transaction()`.

### 12. Inconsistent id field naming between call and text transcripts (`backend/server.js:1599` vs `2305`/`2316`/`2367`)
Confirmed **not a bug** — `callState.transcript` entries deliberately
re-key `id` → `entryId` when pushed (`server.js:2367`), a genuinely different
object shape from a raw log entry (which texting reads directly, hence `.id`).
Functionally correct today; just a maintenance trap for a future refactor.
Optional: a one-line comment at each site noting the two shapes differ on
purpose.

---

# Independent codebase sweep (2026-08-03)

Done via 4 parallel audits (backend routes, backend lib/, frontend stores+api,
frontend components/views) covering everything not already reviewed above,
followed by manual spot-checks of the highest-severity claims — 7 checked
directly against the source, 6 confirmed real, 1 false positive caught and
excluded (`groups.js:23-31`'s `createGroup` — the lib-audit flagged
`name.trim()` with "no validation," but its one call site, `server.js:1867`,
already validates `name` before calling it; not reachable). The rest below
carry the confidence of a careful single-pass read, not an exhaustive proof —
treat P3/P4 items as "worth a look," not certainties.

## P1 — user-visible correctness / data loss

### 13. Demoting a private room's only occupant produces total silence (`backend/lib/narrator.js:31-36`)
```js
if (presentCount === 0) return true;
if (placeType === 'private' && presentCount === 1) return false;   // ← fires first
if (backgroundCount > 0) return true;                              // ← never reached
```
The "private + 1 person = no narrator" rule is checked *before* the "anyone
present-but-inactive should always be narrated" rule, even though that second
rule's own comment says it's "the only thing standing between the user and
total silence." **Confirmed reachable:** `runReactionRound`'s narrator check
(`server.js:3399`) passes `presentCount: presentIds.length, backgroundCount:
backgroundIds.length` where `backgroundIds = presentIds.filter(id =>
!reactIds.includes(id))` — so a private place with exactly one character, who
is then demoted to background/inactive, hits `presentCount===1,
backgroundCount===1`, and line 34 (private+1) returns `false` first. Nobody
replies (character inactive) and the narrator is blocked too — the user is
stuck with no response and no visible way out short of re-promoting the
character.
**Fix:** swap the order — check `backgroundCount > 0` before the private+1
short-circuit.

### 14. `/api/places/:placeId/regenerate` can silently discard concurrent writes (`backend/server.js:3643-3714`)
The full chat `log` array is loaded once at 3643, then held across two
awaited operations — `detachEntryFromMemories` (3684) and the actual LLM
generation via `generateCharacterTurn` (3703, real network latency) — before
`log.splice(...)` and `saveChatLog(...)` at 3713-3714 write back that same
stale array. **Confirmed:** every other mutating route re-reads or appends
without holding a log reference across an await this long. If any other
request appends to the same place's log during that window (e.g. the user
sends a new message right after clicking regenerate on an older one),
regenerate's final save silently erases it — last-write-wins with no
warning.
**Fix:** re-load the log fresh immediately before the splice/save, and bail
(or re-locate the target index) if it's changed underneath.

### 15. `calls.json` read-modify-write race across concurrent calls in different places (`backend/server.js:2354-2388`, `backend/lib/calls.js:23-33`)
`loadCalls`/`saveCalls` read/write *all* places' call state as one JSON blob.
`/api/calls/:characterId/say` loads it, saves once, then — after an awaited
LLM call — saves again using the same in-memory object. **Confirmed:** if a
call in a *different* place completes its own load→save cycle during that
await, this handler's second save overwrites it with a stale copy, silently
reverting or losing the other call's state.
**Fix:** re-load `calls.json` immediately before the second save, or narrow
the read-modify-write to per-place granularity.

## P2 — races and inconsistent scoping

### 16. `phone.loading`/`groups.loading` and `streamingState` aren't scoped to the conversation being viewed
Independently flagged by two separate audits (backend/frontend split) and
directly confirmed against the file contents already read earlier this
session:
- `PhoneThread.vue`'s `showRetry` (`:46-49`) checks only `!phone.streamingState`
  — never `.characterId === props.characterId` — unlike its own sibling
  `showTyping` (`:30-33`), which does check it.
- `GroupThread.vue`'s `showRetry` (`:52-55`) has the identical gap versus its
  own `showTyping`/`typingName` (`:28-38`), which the file's own inline
  comment explains is checked *because* `groups.streamingState` is shared
  store-wide state.
- Both stores' `loading` flag is one boolean shared across every
  characterId/groupId (`phone.js:19`, `groups.js:18`), and both threads'
  textarea/Send-button `:disabled` and typing-fallback (`PhoneThread.vue:127,134,137`,
  `GroupThread.vue:153,163,166`) key off the bare flag with no per-conversation check.
**Failure scenario:** message Character A, leave the reply in flight, switch
to Character B's thread — B's textarea/Send disable, B shows a bogus
"typing…" bubble, and if B has its own unanswered message, B's Retry button
hides — all driven by A's unrelated request, until A's reply lands.
**Fix:** scope `showRetry` (and the loading-driven UI in both threads) to the
current characterId/groupId the same way `showTyping` already does.

### 17. `endCall()` has no re-entrancy guard, unlike `startCall()` (`frontend/src/stores/chat.js:347-363` vs `:296-311`)
`startCall` checks `this.loading || this.entering || ... || this.activeCall`
before proceeding; `endCall` only checks `!this.activeCall`. **Confirmed:**
sending a call message sets `this.loading = true` while awaiting the reply
(`sendCallMessage`, line 320); hanging up during that window fires
`endCallApi` concurrently with the in-flight reply request, and whichever
resolves last overwrites `logs[placeId]`/`activeCall`, which can silently
drop the in-flight reply.
**Fix:** add the same guard `endCall` is missing — `if (this.loading || ...)
return;` (or block hang-up while a message is in flight, surfaced in the UI).

### 18. Streaming say/retry/regenerate requests bypass the stale-world auto-recovery (`frontend/src/api/chat.js:22-27`, `phone.js`, `groups.js`, `calls.js` equivalents)
These use raw `fetch()` with their own `streamHeaders()`, never going through
`http.js`'s `request()`, which is where the `UNKNOWN_WORLD` →
`location.reload()` recovery lives (see item #13/known-issue-13 above on that
mechanism). **Confirmed** by reading `api/chat.js` directly — the streaming
functions construct headers and call `fetch` standalone. If a world is
deleted from another tab while streaming is on, every streamed send just
throws a generic error forever instead of self-recovering the way
non-streaming requests do.
**Fix:** have the streaming helpers check for `UNKNOWN_WORLD` the same way
(or centralize the check in the SSE-consume loop, alongside the SSE-parser
dedup in item #10).

### 19. `saveMessageEdit`/`deleteMessage` (chat.js) and rename-on-blur (GroupInfoPanel.vue) have no in-flight guard
`frontend/src/stores/chat.js:393-405` and `:407-416` have no `if
(this.loading) return;`, unlike every other mutating action in the same
store. Double-clicking Save/Delete can fire two concurrent requests whose
responses may resolve out of order, silently reverting a saved edit.
Separately, `GroupInfoPanel.vue`'s rename field (`:28-34,63-66`) binds
`saveName()` to both `@blur` and `@keydown.enter` with no in-flight guard —
pressing Enter then tabbing away before the response lands fires a second
identical rename request.
**Fix:** add the same `loading`-style guard used elsewhere in each store/component.

### 20. `switchWorld` can race when two world switches overlap (`frontend/src/stores/worlds.js:58-67`, `components/worlds/WorldCard.vue:70-74`)
Each `WorldCard`'s Switch button is disabled only by its own local `busy` ref,
not a global lock, so clicking Switch on one world then another before the
first resolves is possible; `api/http.js` reads the active world id fresh per
fetch, so the first switch's still-pending `loadWorldState()` can execute
against the second world's data, and the two calls' resets can interleave.
Not independently re-verified this session — flagged with medium confidence
from the audit; worth a look before treating as certain.

### 21. Deleting a character doesn't clean up `groups.json` (`backend/server.js:946-982`)
`DELETE /api/characters/:id` cleans up placements, place `ownerIds`, memories,
relationships, and embeddings, but never scans `groups.json` for
`participantIds` referencing the deleted character — unlike group
creation/editing, which enforces a 2-participant minimum everywhere else.
Can leave a group below that minimum, and makes `runGroupCascade`'s `if
(!character) break; // shouldn't happen` (`server.js:1976`) actually reachable.
**Fix:** on character delete, remove them from every group's `participantIds`
(and decide what happens to a group that drops below 2 — auto-delete it, or
relax the minimum for existing groups).

### 22. Group texting never triggers proactive texts (`backend/server.js` — confirmed via grep: only 2 call sites of `maybeSendProactiveTexts`, lines 1762 and 3517)
`/api/places/:placeId/say` and `/api/texts/:characterId/send` both call
`maybeSendProactiveTexts`; `/api/groups/:groupId/send` (and `/retry`) never
do, despite being documented as mirroring the other two routes. Other
characters can never spontaneously text the user as a side effect of a group
conversation.
**Fix:** add the same `maybeSendProactiveTexts` call to the group send/retry routes.

## P3 — performance / data-integrity edge cases

### 23. `generateGroupReply`/`runGroupCascade` reloads `loadPersonas`/`loadWorld`/`loadPlaces` per cascade reply (`backend/server.js:1904-1949`, loop at `1960-2001`)
Same shape as the already-known `buildTurnRequest` issue (#6 above), but in
the group-texting cascade rather than the scene-chat path. Only the chat log
needs re-reading each iteration.

### 24. Non-atomic JSON writes + silent-corruption swallow can lose data outright (`backend/lib/chatStore.js:14-25`, `weather.js:53-63`, `calls.js:23-33`, `groups.js:11-21`, and the same pattern elsewhere)
Every JSON store writes directly to its real path (no temp-file-then-rename)
and every loader wraps `JSON.parse` in a bare `try/catch` that returns an
empty default on any failure. A crash/kill mid-write truncates the file; the
next load doesn't error, it silently reports "no history" — real data loss
with no log line indicating corruption occurred. This is a broader/lower-level
version of the same shape as #14/#15 above.
**Fix (if pursued):** write-to-temp-then-rename for these stores; consider
logging a warning (not just swallowing) when `JSON.parse` fails on a
non-empty file, since that's a real corruption signal distinct from
"file doesn't exist yet."

### 25. `rebuildMemories` issues multiple un-transacted DELETEs on ordinary message edits, not just the admin rebuild (`backend/lib/memoryStore.js:440-466`)
Runs on every message edit/delete/regenerate sync (not the already-known bulk
`rebuildAllMemoryEmbeddings`): four separate un-transacted statements
(`memories`, `memory_entries`, `memory_participants`, `deleteMemoryVectors`).
A crash between them can leave `memory_entries`/`memory_vectors` rows
pointing at a memory id that no longer exists, corrupting later joins like
`findMemoriesWitnessing`. Same fix shape as item #11 above, but this one is
on a much hotter path (every edit), so worth prioritizing above #11 if only
one gets done.

### 26. `weather.js`'s `snowy` condition is a one-way trap (`backend/lib/weather.js:19-28`)
The `TRANSITIONS` table has no row that lists `snowy` as a reachable next
condition except `snowy`'s own self-loop (weight 3/7, ~43%). **Confirmed** by
reading the table directly — once an area auto-rolls away from snow (~57%
chance each day), it can never roll back to it; only a brand-new area's
uniform random seed or a manual override can produce snow again.
**Fix:** add `snowy` as a low-weight option to at least `overcast`/`stormy`/`foggy`'s rows.

### 27. `express.static` handler cache leaks one entry per deleted world (`backend/server.js` — `avatarStatics` Map, `:409-419` vs `DELETE /api/worlds/:id` at `:680-687`)
Each world's lazily-built static handler is cached in a module-level Map that
`DELETE /api/worlds/:id` never prunes. Grows indefinitely (bounded by however
many worlds are ever created-then-deleted in a process's lifetime) — low
practical impact for a single-user local app, but a genuine unbounded-growth bug.

### 28. Failed world import leaves an orphaned empty world (`backend/server.js:727-751`)
`registry.create({ mode: 'empty' })` runs before `importWorldBundle`/embedding
rebuilds are awaited; if any of those throw, the catch block only returns an
error response and never calls `registry.remove(entry.id)` — the user is left
with a phantom empty "Imported World" save slot with no indication the import
actually failed.

## P4 — smaller/cosmetic, or unconfirmed

### 29. `RelationsGraph.vue`'s "You" node silently no-ops with no active persona (`:124-131`)
The node can appear (whenever a relationship targets `'user'`) without an
active persona existing; clicking it then does nothing, contradicting the
view's own stated "click a node to open it" affordance. Minor UX gap, not a
correctness bug.

### 30. PNG card re-export can't strip a same-keyword `iTXt` chunk (`backend/lib/pngCard.js:50-54,59-68`)
`chunkKeyword` returns `null` for `iTXt`, so `appendOrReplaceTextChunk` only
strips stale `tEXt`/`zTXt` copies. Re-exporting a character/persona/place
whose avatar PNG originally carried card data as `iTXt` (a form
`tavernCard.js`'s own reader supports) leaves the stale `iTXt` payload in the
file permanently while appending a new `zTXt` copy — the file grows and
carries duplicate/stale data on every re-export. Not independently
re-verified this session.

### 31. `openConversation` swallows fetch failures silently (`frontend/src/stores/phone.js:25-35`, `groups.js:60-67`)
If `getTextLog`/`getGroupLog` fails, nothing happens — no `showError`, unlike
`chat.js`'s `enterPlace`. A real network/server error just renders as an
empty "No messages yet" thread with no indication anything went wrong.

### 32. `characterEmbeddings.js` lazy first-use embedding isn't guarded against concurrent calls (`:33-46`)
Two simultaneous requests needing the same not-yet-embedded character both
compute and write independently — last write wins, no duplication, but
redundant model calls. Low impact, not independently re-verified.

### False positive caught during verification: `groups.js:23-31`'s `createGroup`
Flagged as "`name.trim()` with no validation, throws uncaught TypeError" — but
its only call site (`server.js:1867`) already validates `typeof name ===
'string' && name.trim()` before calling it. Not reachable in practice;
excluded from the list above.
