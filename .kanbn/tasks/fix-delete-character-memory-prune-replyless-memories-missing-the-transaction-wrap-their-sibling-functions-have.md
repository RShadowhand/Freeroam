---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: `deleteCharacterMemory`/`pruneReplylessMemories` missing the transaction wrap their sibling functions have

Every other memory-mutating function in the file was already hardened
per the crash-hardening work; these two were missed.

## Sub-tasks

- [x] Both functions (`backend/lib/memoryStore.js`) now wrap their multi-statement deletes in `db.transaction()`, matching `deleteAllCharacterMemories` right next to them — same external behavior/return values, existing test coverage (already extensive for both functions) still passes unchanged
- [x] 702/702 passing
- [x] Manual: not really human-testable (a crash-atomicity hardening fix, same shape as the already-shipped `rebuildMemories` one) — safe to move straight to Done once reviewed

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
