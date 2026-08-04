---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #18 — streaming say/retry/regenerate bypass stale-world auto-recovery

Initially mislabeled as still-open in the kanban due to a grep that
only checked api/*.js, missing the actual fix one layer up in
stores/*.js. Corrected — see project_kanban_workflow.md memory.

## Sub-tasks

- [x] Confirmed already fixed — `consumeReactionSse`/`_consumeSse` in `chat.js`/`phone.js`/`groups.js` already call `handleUnknownWorld(res, data)` before anything else on a failed streaming response.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
