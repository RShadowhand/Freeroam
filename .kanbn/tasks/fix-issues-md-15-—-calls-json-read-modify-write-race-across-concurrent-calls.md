---
tags:
  - 'priority:high'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #15 — `calls.json` read-modify-write race across concurrent calls

## Sub-tasks

- [x] Re-load `calls.json` immediately before the second save in `/api/calls/:characterId/say`, instead of reusing the stale in-memory object.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
