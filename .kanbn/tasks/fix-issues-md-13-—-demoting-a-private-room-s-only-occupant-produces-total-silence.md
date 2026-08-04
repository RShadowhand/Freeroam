---
tags:
  - 'priority:high'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #13 — demoting a private room's only occupant produces total silence

## Sub-tasks

- [x] Swapped the check order in `backend/lib/narrator.js`'s `shouldNarrate` so `backgroundCount > 0` is checked before the private+1 short-circuit.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
