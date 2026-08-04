---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: `streamingState` isn't scoped per-conversation in phone.js/groups.js

Cosmetic-only fix (a flicker/wrong-fallback-text case, never a stuck
state) — newly relevant now that concurrent multi-conversation
generation is a formalized, intended case.

## Sub-tasks

- [x] Both stores now have a `clearStreamingStateFor(id)` action that only clears `streamingState` when it still belongs to that conversation's id — used in place of the unconditional clears in `_consumeSse`'s turn-event handler, its post-loop clear, and both `sendText`/`retryText`'s `finally` blocks
- [x] 703/703 passing; frontend build clean
- [x] Manual: send in two different 1-on-1 (or group) threads back to back before the first reply lands, confirm each thread's typing indicator reflects its own state, not the other's

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
