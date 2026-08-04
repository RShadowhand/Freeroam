# Freeroam Board - Archive

## Done

### Fix: ISSUES.md #1 — long character names break reply-multiplex detection

- priority: high
- workload: Easy
- steps:
  - [x] Raised/unified the `NAME_LINE` regex cap in `backend/lib/context.js` so names up to a sane bound no longer collapse multi-character replies into one garbled bubble.
    ```md
    A name over ~31 chars made `allNameLines` fail, collapsing the whole
    multi-line reply into one entry with other characters' lines left as
    literal unstripped text.
    ```

### Fix: ISSUES.md #2 — typo in chat.js error messages ("goes wrong")

- priority: high
- workload: Easy
- steps:
  - [x] `s/goes wrong/went wrong/` at all 7 sites in `frontend/src/stores/chat.js`.

### Fix: ISSUES.md #3 — `openConversation` has no in-flight guard

- priority: medium
- workload: Easy
- steps:
  - [x] Added a synchronous `openingIds` re-entrancy guard to both `frontend/src/stores/phone.js` and `stores/groups.js`'s `openConversation`.

### Fix: ISSUES.md #4 — no timeout on OpenRouter API calls

- priority: medium
- workload: Normal
- steps:
  - [x] Added `timeoutController`/`LLM_TIMEOUT_MS` around `callOpenRouter`/`streamOpenRouter` in `backend/server.js`, surfacing a clear timeout error instead of hanging forever.
    ```md
    This same AbortController infrastructure later became the foundation
    for the cancel-generation feature.
    ```

### Fix: ISSUES.md #5 — `maybeSendProactiveTexts` has no concurrency limit

- priority: medium
- workload: Easy
- steps:
  - [x] Added `MAX_PROACTIVE_TEXTS_PER_ROUND` cap (with a shuffle so it doesn't always favor the oldest characters) in `backend/server.js`.

### Fix: ISSUES.md #6 — `buildTurnRequest` reloads all world data per character turn

- priority: low
- workload: Normal
- steps:
  - [x] Hoisted `loadWorld`/`loadPlaces`/`loadPersonas`/`loadPresets` out of `runReactionRound`'s per-character loop into `loadTurnContext(w)`, loaded once per round.
    ```md
    Caught the critical activePersonaId-missing bug along the way — see
    the Errors/fixes note in this project's own history.
    ```

### Fix: ISSUES.md #7 — `metCharacterIds` scans every place's chat log on every `GET /api/world`

- priority: low
- workload: Normal
- steps:
  - [x] Added a per-world cache in `backend/server.js`, invalidated via the `appendPlaceChatEntries`/`savePlaceChatLog`/`deletePlaceChatLog` write wrappers instead of a full rescan per request.

### Fix: ISSUES.md #8 — `countUnreadProactiveTexts` scans every text file every 20s

- priority: low
- workload: Normal
- steps:
  - [x] Same cache-with-invalidation pattern as #7, via `appendTextsEntries`/`saveTextsLog`/`deleteTextsLog`.
    ```md
    Later extended (follow-up plan) to return a per-characterId breakdown,
    not just the world-wide total, for the per-contact unread badge.
    ```

### Fix: ISSUES.md #9 — `backfillMemoryVectorIndex` loads all embeddings into JS memory at once

- priority: low
- workload: Easy
- steps:
  - [x] Confirmed this runs once per database's lifetime, not on every startup; left as a single `db.transaction()` batch rather than chunking, since it's a one-time cost.

### Fix: ISSUES.md #10 — triplicated SSE parser across chat.js/phone.js/groups.js

- priority: low
- workload: Normal
- steps:
  - [x] Extracted the shared SSE-frame-parsing helper into `frontend/src/utils/sse.js`, used by all three stores.

### Fix: ISSUES.md #11 — `rebuildAllMemoryEmbeddings` has no transaction guard

- priority: low
- workload: Normal
- steps:
  - [x] Split into an async embed-everything-first pass, then one synchronous `db.transaction()` for the writes, in `backend/lib/memoryStore.js`.

### Fix: ISSUES.md #12 — inconsistent id field naming (call vs. text transcripts)

- priority: low
- workload: Easy
- steps:
  - [x] Confirmed not a bug — `callState.transcript` deliberately re-keys `id` → `entryId`, a genuinely different shape. Documented with a comment at each site.

### Fix: ISSUES.md #13 — demoting a private room's only occupant produces total silence

- priority: high
- workload: Easy
- steps:
  - [x] Swapped the check order in `backend/lib/narrator.js`'s `shouldNarrate` so `backgroundCount > 0` is checked before the private+1 short-circuit.

### Fix: ISSUES.md #14 — `/regenerate` can silently discard concurrent writes

- priority: high
- workload: Normal
- steps:
  - [x] Re-load the chat log fresh immediately before the splice/save in `backend/server.js`'s regenerate route, and bail if the target entry moved/vanished underneath.

### Fix: ISSUES.md #15 — `calls.json` read-modify-write race across concurrent calls

- priority: high
- workload: Normal
- steps:
  - [x] Re-load `calls.json` immediately before the second save in `/api/calls/:characterId/say`, instead of reusing the stale in-memory object.

### Fix: ISSUES.md #16 — `phone.loading`/`groups.loading`/`streamingState` not scoped to the viewed conversation

- priority: medium
- workload: Hard
- steps:
  - [x] Scoped `showRetry`/typing/disabled state to the current characterId/groupId in `PhoneThread.vue`/`GroupThread.vue`, and switched `loading` to per-id `loadingIds` Sets in `phone.js`/`groups.js`.
    ```md
    Established the `isLoadingHere`-style per-conversation scoping pattern
    reused throughout the rest of the session (cancel-generation Stop
    buttons reuse it directly).
    ```

### Fix: ISSUES.md #17 — `endCall()` has no re-entrancy guard, unlike `startCall()`

- priority: medium
- workload: Easy
- steps:
  - [x] Added the same `loading`/`entering`/`activeCall` guard to `endCall()` in `frontend/src/stores/chat.js`.

### Fix: ISSUES.md #18 — streaming say/retry/regenerate bypass stale-world auto-recovery

- priority: medium
- workload: Easy
- steps:
  - [x] Confirmed already fixed — `consumeReactionSse`/`_consumeSse` in `chat.js`/`phone.js`/`groups.js` already call `handleUnknownWorld(res, data)` before anything else on a failed streaming response.
    ```md
    Initially mislabeled as still-open in the kanban due to a grep that
    only checked api/*.js, missing the actual fix one layer up in
    stores/*.js. Corrected — see project_kanban_workflow.md memory.
    ```

### Fix: ISSUES.md #19 — `saveMessageEdit`/`deleteMessage`/GroupInfoPanel rename have no in-flight guard

- priority: medium
- workload: Normal
- steps:
  - [x] Added `pendingMessageIds`-style guards to `chat.js`'s edit/delete, and a `saving` guard to `GroupInfoPanel.vue`'s rename.

### Fix: ISSUES.md #20 — `switchWorld` can race when two switches overlap

- priority: medium
- workload: Normal
- steps:
  - [x] Added a store-level `switching` lock in `frontend/src/stores/worlds.js`, re-verified as a real race and fixed (not just flagged by the audit).

### Fix: ISSUES.md #21 — deleting a character doesn't clean up `groups.json`

- priority: medium
- workload: Normal
- steps:
  - [x] `DELETE /api/characters/:id` now also removes the character from every group's `participantIds` in `backend/server.js`.

### Fix: ISSUES.md #22 — group texting never triggers proactive texts

- priority: medium
- workload: Easy
- steps:
  - [x] Added the `maybeSendProactiveTexts` call to `/api/groups/:groupId/send` and `/retry`, matching `/say` and 1-on-1 texting.

### Fix: ISSUES.md #23 — `generateGroupReply`/`runGroupCascade` reload personas/world/places per cascade reply

- priority: low
- workload: Normal
- steps:
  - [x] Added `loadGroupTurnContext(w)`, loaded once per cascade in `runGroupCascade` and threaded into `generateGroupReply`, mirroring the existing `loadTurnContext`/`buildTurnRequest` pattern.

### Fix: ISSUES.md #24 — non-atomic JSON writes + silent-corruption swallow

- priority: low
- workload: Hard
- steps:
  - [x] Added `backend/lib/jsonStore.js` (`writeJsonAtomic`/`warnIfCorrupt`) and routed `chatStore.js`/`weather.js`/`calls.js`/`groups.js` and friends through it.

### Fix: ISSUES.md #25 — `rebuildMemories` issues un-transacted deletes on ordinary edits

- priority: low
- workload: Normal
- steps:
  - [x] Same split-then-transact fix as #11, applied to the hotter per-edit path in `backend/lib/memoryStore.js`.

### Fix: ISSUES.md #26 — `weather.js`'s `snowy` condition is a one-way trap

- priority: low
- workload: Easy
- steps:
  - [x] Added `snowy` as a low-weight option to `overcast`/`stormy`/`foggy`'s rows in the `TRANSITIONS` table.

### Fix: ISSUES.md #27 — `express.static` handler cache leaks one entry per deleted world

- priority: low
- workload: Easy
- steps:
  - [x] `DELETE /api/worlds/:id` now prunes the `avatarStatics` Map entry for that world.

### Fix: ISSUES.md #28 — failed world import leaves an orphaned empty world

- priority: low
- workload: Normal
- steps:
  - [x] Catch block now calls `registry.remove(entry.id)` when `importWorldBundle`/embedding rebuilds throw, instead of leaving a phantom empty world.

### Fix: ISSUES.md #29 — RelationsGraph's "You" node silently no-ops with no active persona

- priority: low
- workload: Easy
- steps:
  - [x] Fixed the click affordance in `RelationsGraph.vue` for the no-active-persona case.

### Fix: ISSUES.md #30 — PNG card re-export can't strip a same-keyword `iTXt` chunk

- priority: low
- workload: Normal
- steps:
  - [x] `chunkKeyword`/`appendOrReplaceTextChunk` in `backend/lib/pngCard.js` now handle `iTXt` too, not just `tEXt`/`zTXt`.

### Fix: ISSUES.md #31 — `openConversation` swallows fetch failures silently

- priority: low
- workload: Easy
- steps:
  - [x] Added `useUiStore().showError(...)` on a failed `getTextLog`/`getGroupLog` in `phone.js`/`groups.js`, matching `chat.js`'s `enterPlace`.

### Fix: ISSUES.md #32 — `characterEmbeddings.js` lazy first-use embedding isn't guarded against concurrent calls

- priority: low
- workload: Normal
- steps:
  - [x] Added an `inFlightIdentityCompute` Map so two concurrent requests needing the same not-yet-embedded character share one computation.

## Stale

### Research: ISSUES.md — `groups.js` `createGroup` "no validation" claim

- priority: low
- workload: Easy
- steps:
  - [x] Investigated and found not reachable — the one call site (`server.js:1867`) already validates `typeof name === 'string' && name.trim()` before calling it. No fix needed; excluded from the actionable list.

