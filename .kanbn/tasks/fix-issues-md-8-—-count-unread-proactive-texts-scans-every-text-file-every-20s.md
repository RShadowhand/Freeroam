---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #8 — `countUnreadProactiveTexts` scans every text file every 20s

Later extended (follow-up plan) to return a per-characterId breakdown,
not just the world-wide total, for the per-contact unread badge.

## Sub-tasks

- [x] Same cache-with-invalidation pattern as #7, via `appendTextsEntries`/`saveTextsLog`/`deleteTextsLog`.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
