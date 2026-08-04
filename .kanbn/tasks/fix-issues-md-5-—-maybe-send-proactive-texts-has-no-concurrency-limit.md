---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #5 — `maybeSendProactiveTexts` has no concurrency limit

## Sub-tasks

- [x] Added `MAX_PROACTIVE_TEXTS_PER_ROUND` cap (with a shuffle so it doesn't always favor the oldest characters) in `backend/server.js`.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
