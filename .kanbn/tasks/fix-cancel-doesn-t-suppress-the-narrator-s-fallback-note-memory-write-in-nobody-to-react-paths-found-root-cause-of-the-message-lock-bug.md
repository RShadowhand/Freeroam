---
tags:
  - 'priority:high'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: cancel doesn't suppress the narrator's fallback note/memory write in "nobody to react" paths (+ found root cause of the message-lock bug)

USER UPDATE: This works correctly, but user message can't be
deleted/edited without moving to another place and coming back when
this happens. — root-caused and fixed; see steps above.

## Sub-tasks

- [x] Original cancel-suppression fix from last round, unchanged and still verified
- [x] Root-caused the "user message can't be deleted/edited without leaving and returning" report: `narrateEmptyPlaceOrEcho`/`recordSilentRound`'s enclosing `/say`/`/retry` branches always answered with plain JSON regardless of `cfg.streaming` (which wasn't even loaded until after those branches) — but the frontend picks streaming vs. non-streaming fetch *before* it knows the room is empty/all-inactive. A streaming client parsing a plain-JSON body through its SSE reader gets zero events, so `logs[placeId]` never advances past the id-less optimistic placeholder pushed for the user's own line — and Delete/Edit both require a real id, hence stuck until leaving and re-entering (which does a fresh, non-streaming-path GET).
- [x] Fix: new shared `respondAfterSilentBranch` helper — sends the same `ack`/`done` SSE shape the main reaction round already uses when streaming's on, plain JSON otherwise, for both `/say` and `/retry`'s empty-place and all-inactive branches
- [x] Two new regression tests (empty place, all-inactive-present) confirming a streaming `/say` response is valid SSE whose `done` event's log carries a real-id user line, not a malformed body a streaming client can't parse — 705/705 passing
- [x] Frontend build clean
- [x] Manual: with streaming ON, say something in an empty or all-inactive room — confirm your own message is immediately deletable/editable without leaving and re-entering the place

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
