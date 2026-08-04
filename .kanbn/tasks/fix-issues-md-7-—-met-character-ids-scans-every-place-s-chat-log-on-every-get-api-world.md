---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #7 — `metCharacterIds` scans every place's chat log on every `GET /api/world`

## Sub-tasks

- [x] Added a per-world cache in `backend/server.js`, invalidated via the `appendPlaceChatEntries`/`savePlaceChatLog`/`deletePlaceChatLog` write wrappers instead of a full rescan per request.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
