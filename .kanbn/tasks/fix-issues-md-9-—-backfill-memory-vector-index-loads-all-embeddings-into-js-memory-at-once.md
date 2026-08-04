---
tags:
  - 'priority:low'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #9 — `backfillMemoryVectorIndex` loads all embeddings into JS memory at once

## Sub-tasks

- [x] Confirmed this runs once per database's lifetime, not on every startup; left as a single `db.transaction()` batch rather than chunking, since it's a one-time cost.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
