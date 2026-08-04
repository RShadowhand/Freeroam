---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: `appendPlaceChatEntries` re-reads `world.json` from disk redundantly

Performance only, no behavior change.

## Sub-tasks

- [x] `appendPlaceChatEntries` now accepts an optional already-loaded `time`, falling back to `loadWorld(w).time` only when none is supplied
- [x] Threaded an already-in-scope `world.time`/`turnContext.world.time` through every call site where one was already loaded nearby (call start/end, call replies + bystander narration, `runReactionRound`'s per-character loop and narrator addendum, place-enter greetings, `recordSilentRound` — which also had its own separate redundant `loadWorld()` inside the same function, now loaded once and reused for both the append and `recordRound`)
- [x] Left the couple of sites with no already-loaded world in scope as single, necessary reads (adding a load just to pass it through would eliminate nothing)
- [x] 703/703 passing; frontend build clean
- [x] Manual: not really human-testable (pure performance refactor, same external behavior) — safe to move straight to Done once reviewed

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
