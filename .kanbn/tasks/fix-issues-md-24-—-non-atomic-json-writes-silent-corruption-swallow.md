---
tags:
  - 'priority:low'
  - 'workload:Hard'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #24 — non-atomic JSON writes + silent-corruption swallow

## Sub-tasks

- [x] Added `backend/lib/jsonStore.js` (`writeJsonAtomic`/`warnIfCorrupt`) and routed `chatStore.js`/`weather.js`/`calls.js`/`groups.js` and friends through it.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
