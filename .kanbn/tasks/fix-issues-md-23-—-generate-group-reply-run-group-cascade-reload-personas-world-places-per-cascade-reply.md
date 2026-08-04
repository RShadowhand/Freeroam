---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #23 — `generateGroupReply`/`runGroupCascade` reload personas/world/places per cascade reply

## Sub-tasks

- [x] Added `loadGroupTurnContext(w)`, loaded once per cascade in `runGroupCascade` and threaded into `generateGroupReply`, mirroring the existing `loadTurnContext`/`buildTurnRequest` pattern.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
