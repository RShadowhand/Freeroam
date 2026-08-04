---
tags:
  - 'priority:medium'
  - 'workload:Hard'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #16 — `phone.loading`/`groups.loading`/`streamingState` not scoped to the viewed conversation

Established the `isLoadingHere`-style per-conversation scoping pattern
reused throughout the rest of the session (cancel-generation Stop
buttons reuse it directly).

## Sub-tasks

- [x] Scoped `showRetry`/typing/disabled state to the current characterId/groupId in `PhoneThread.vue`/`GroupThread.vue`, and switched `loading` to per-id `loadingIds` Sets in `phone.js`/`groups.js`.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
