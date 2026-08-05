---
created: 2026-08-05T14:03:44.969Z
updated: 2026-08-05T15:31:23.409Z
assigned: ""
progress: 0
tags:
  - 'workload:Hard'
  - 'priority:High'
completed: 2026-08-05T15:31:23.409Z
---

# Feature: Manual message steps in group chat message cascades.

When a character is picked to respond in a group chat cascade (after the first message from one character), user should be presented with a button that says "xyz wants to respond, allow?" so that there's a manual flow of this. Also another button next to it for "auto allow until cascade is over".

## Design decisions (read before testing)

- **Shipped as an opt-in Settings toggle** (`groupCascadeManualApproval`,
  default off), not a hardcoded new default — every other cascade-shape
  setting in this app (`textingTypingIndicator`, `suggestedActionsMode`,
  etc.) is opt-in, and this is a big enough UX change (every group reply
  needs a click instead of arriving automatically) that silently changing
  existing users' behavior felt wrong. Flip it on in Settings → Texting →
  "Group text reply cascade" to test this feature at all.
- Gating applies to **every** cascade reply, including the very first one
  after the trigger message — not just the second reply onward. Re-read the
  task wording a few times; this seemed like the more literal reading
  ("when a character is picked to respond ... after the first message").
- HTTP is request/response, not bidirectional — a live request can't
  literally "pause" waiting for a click. So a paused cascade is a small
  server-side state machine (`pendingCascadeSteps`, keyed by groupId, in
  `server.js`) that a step gets parked into, resumed by two new endpoints
  when the user answers. No reply text is ever generated before the user
  sees the "wants to respond" prompt — the whole point of asking first.
- Manual-approval mode is **never streamed**, regardless of the Streaming
  setting — each step is already separated by a real user interaction, so
  there's nothing to stream, and it keeps this mode's response shape simple
  (always plain JSON) rather than needing SSE machinery for a single reply.
- Declining (**"Not now"**, not asked for in the task text but added anyway
  — every other confirm-style UI in this app has a way to back out) ends
  the cascade round right there; it does **not** reroll to a different
  member. A definitive no, not a retry.
- Abandoning a pending prompt (sending a new message without answering it
  first) doesn't lose data: whatever had already been approved earlier in
  that round is still recorded into memory before the new round starts.

## Sub-tasks

- [x] `textCascade.js`: new `nextCascadeStep` pure function (roll + pick,
one step) factored out of the existing full-auto loop, so both the
auto-cascade and the pausable one can share the exact same decision logic
- [x] `runGroupCascade` refactored onto `nextCascadeStep` — behavior-
preserving (same math, same order), verified by the full existing test
suite passing unchanged
- [x] New setting `groupCascadeManualApproval` (DEFAULT_CONFIG,
publicConfig, POST /api/settings) + Settings UI toggle in `TextingCard.vue`
- [x] `pendingCascadeSteps` in-memory map + `beginGroupCascade` shared
orchestrator, used by `/send`, `/retry`, and `/trigger` alike (all three
now behave identically re: manual approval)
- [x] `POST /api/groups/:groupId/cascade/allow` (`{ autoAllow }`) and
`POST /api/groups/:groupId/cascade/deny`
- [x] `GET /api/groups/:groupId` now includes `pendingReply` when one
exists, so reopening a conversation re-shows an unanswered prompt
- [x] `DELETE /api/groups/:groupId` clears any pending state for that group
- [x] Frontend: `groups.js` store (`pendingReplies`, `allowPendingReply`,
`denyPendingReply`, streaming-path guarded against manual-approval mode
in `sendText`/`retryText`), `settings.js` store, API functions
- [x] UI: prompt bar in `GroupThread.vue` (Allow / Allow & auto-continue /
Not now), compose box disabled while a reply is pending
- [x] Fixed a bug caught while wiring `/trigger` through the shared
orchestrator: it would have started streaming SSE through `triggerText`'s
plain-JSON API call and silently produced nothing — added an
`allowStreaming` override so `/trigger` stays deliberately simple
- [x] Fixed a data-safety gap: abandoning a pending step now records
whatever had already landed in that round instead of discarding it
- [x] Backend tests: 5 new `nextCascadeStep` unit tests
(`textCascade.test.js`) + 9 new integration tests covering no-API-key,
failed-roll, pending-before-generation (asserts the LLM is NOT called),
allow/deny/auto-allow, 400s on nothing-pending, and the abandon-and-record
path (`groups.test.js`)
- [x] `npm test` (740/740) and `npm run build` both clean
- [x] Manual: turn the setting on, send a group message, confirm the
"X wants to respond" prompt appears with no reply visible yet; try Allow,
Allow & auto-continue, and Not now; reopen the conversation mid-prompt to
confirm it re-shows; confirm `/trigger`'s nudge buttons still work
identically with the setting on

## History

- type: created
  date: 2026-08-05T14:03:44.969Z
  column: Todo
  fromProgress: 0
  toProgress: 0
- type: moved
  date: 2026-08-05T18:00:00.000Z
  fromColumn: Todo
  toColumn: Needs Human Testing
- type: moved
  date: 2026-08-05T15:31:23.409Z
  fromColumn: Needs Human Testing
  toColumn: Done
