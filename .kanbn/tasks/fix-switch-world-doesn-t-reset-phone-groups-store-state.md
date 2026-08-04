---
tags:
  - 'priority:low'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: `switchWorld` doesn't reset phone/groups store state

Low visible impact today, but closes a latent state-accumulation gap.

## Sub-tasks

- [x] `worlds.js`'s `switchWorld()` now also calls `usePhoneStore().$reset()`/`useGroupsStore().$reset()` alongside the existing `chat`/`world` resets
- [x] Frontend build clean
- [x] Manual: open a 1-on-1/group text thread in world A, switch to world B, open TypeCast/Party Line — confirm no stale logs/unread counts from world A linger

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
