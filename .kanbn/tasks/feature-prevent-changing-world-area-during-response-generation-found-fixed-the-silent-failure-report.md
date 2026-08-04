---
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:34:37.000Z
completed: 2026-08-04T21:34:37.000Z
assigned: ""
progress: 0
tags:
  - 'priority:medium'
  - 'workload:Normal'
---

# Feature: Prevent changing world/area during response generation (found + fixed the silent-failure report)

User shouldn't be able to change worlds or area while a generation
request is happening.

USER UPDATE: Clicking the worlds button to bring the list of worlds
silently fails, no information is shown. — root-caused (two stacked
bugs in the boot-time picker specifically) and fixed; see steps above.

## Sub-tasks

- [x] Area-switching was already prevented — `chat.js`'s `enterPlace()` already no-ops while `this.loading` is true, unchanged from last round
- [x] World-switching guard from last round, unchanged: `switchWorld()` blocks and shows an error when a generation is in flight
- [x] Root-caused the "silently fails, no information shown" report: two separate bugs, both around the boot-time picker specifically (`WorldCard.vue`'s plain Switch button was never affected) — 1. `WorldPickerOverlay.vue`'s `pick()` called `picker.close()` unconditionally after `switchWorld()`, even when the switch was blocked — the picker just closed as if nothing happened, discarding the block instead of showing it 2. Even after fixing that, the block's error is raised via the *global* `ErrorBanner` — but the picker is a full-viewport `.modal-overlay` at `z-index:1000` with no z-index of its own on the banner, so the global banner would still render **completely hidden behind the picker's own darkened background**. Same reason every other modal in this app (`CharacterModal`, `PersonaModal`, `NpcModal`, `GroupInfoPanel`) shows its own local error/status text instead of relying on the global banner — this one didn't yet.
- [x] Fix: `switchWorld()` now returns `true`/`false` (switched vs. blocked/no-op); `pick()` only closes the picker on `true`, and shows its own local `.form-status` error text when blocked, matching the rest of the app's modal convention
- [x] Frontend build clean; no backend changes touched, so no new backend test run needed this round
- [x] Manual: start a generation, open the world picker (or `/worlds`), try switching — confirm you now see a clear in-picker message instead of the picker just silently closing

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Needs Human Testing
- type: moved
  date: 2026-08-04T21:34:37.000Z
  fromColumn: Needs Human Testing
  toColumn: Done
