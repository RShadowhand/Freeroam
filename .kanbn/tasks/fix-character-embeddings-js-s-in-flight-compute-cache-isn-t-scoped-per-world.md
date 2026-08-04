---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: `characterEmbeddings.js`'s in-flight compute cache isn't scoped per world

Verified characters.json is copied verbatim on world-duplicate, and the
app explicitly supports concurrent multi-world use from different
browsers on one instance.

## Sub-tasks

- [x] `inFlightIdentityCompute` is now a `WeakMap<db, Map<characterId, Promise>>` instead of a plain `Map<characterId, Promise>`, so two worlds (even with colliding character ids from a duplicate) never share an in-flight computation
- [x] New regression test (two `:memory:` dbs, same character id, concurrent calls, verifies each computes and persists independently) — 702/702 passing
- [x] Manual: not really human-testable (a backend cache-scoping fix) — safe to move straight to Done once reviewed

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
