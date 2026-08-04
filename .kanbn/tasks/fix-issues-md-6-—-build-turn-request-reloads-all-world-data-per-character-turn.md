---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #6 — `buildTurnRequest` reloads all world data per character turn

Caught the critical activePersonaId-missing bug along the way — see
the Errors/fixes note in this project's own history.

## Sub-tasks

- [x] Hoisted `loadWorld`/`loadPlaces`/`loadPersonas`/`loadPresets` out of `runReactionRound`'s per-character loop into `loadTurnContext(w)`, loaded once per round.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
