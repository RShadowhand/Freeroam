---
tags:
  - 'priority:high'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #1 — long character names break reply-multiplex detection

A name over ~31 chars made `allNameLines` fail, collapsing the whole
multi-line reply into one entry with other characters' lines left as
literal unstripped text.

## Sub-tasks

- [x] Raised/unified the `NAME_LINE` regex cap in `backend/lib/context.js` so names up to a sane bound no longer collapse multi-character replies into one garbled bubble.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
