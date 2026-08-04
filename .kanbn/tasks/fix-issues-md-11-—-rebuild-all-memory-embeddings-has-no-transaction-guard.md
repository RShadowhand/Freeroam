---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #11 — `rebuildAllMemoryEmbeddings` has no transaction guard

## Sub-tasks

- [x] Split into an async embed-everything-first pass, then one synchronous `db.transaction()` for the writes, in `backend/lib/memoryStore.js`.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
