---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: `GroupInfoPanel.vue` add/remove member has a read-modify-write race

Same race `saveName` was already fixed for; add/remove were missed.

User Note: This is pretty much impossible for a human to do, unless this was a bug that could be caused with 500+ ms in between actions.

## Sub-tasks

- [x] `addMember`/`removeMember` now use the same `saving`-style guard `saveName` already had, plus `:disabled="saving"` on both buttons
- [x] Frontend build clean
- [x] Manual: open a group's info panel, rapid-fire remove two different members (or add then remove quickly) — confirm the roster ends up correct, not reverted by a stale overwrite

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
