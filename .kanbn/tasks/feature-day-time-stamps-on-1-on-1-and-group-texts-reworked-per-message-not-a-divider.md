---
tags:
  - 'priority:high'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Feature: day/time stamps on 1-on-1 and group texts (reworked: per-message, not a divider)

USER UPDATE: Checked it, the way date/time-of-day view isn't good enough.
Each message should show it, not like a tiny separator in between time
changes. — reworked accordingly.

## Sub-tasks

- [x] Backend: unchanged — every new texting/group entry still carries `day`/`timeOfDay`
- [x] Frontend rework: `PhoneThread.vue`/`GroupThread.vue` dropped the sparse `dayDividerLabels()` divider entirely and now render a small timestamp (`formatDayTime`) on every single message instead, per feedback that the divider was too easy to miss
- [x] New `.msg-bubble-col`/`.msg-timestamp` wrapper so the per-message stamp stacks correctly under the bubble even where the shared `.msg.char` rule is `display:flex` (a row, for scene chat's avatar+body layout) — otherwise the timestamp would've been squeezed in sideways next to the delete button instead of appearing underneath
- [x] Scene chat's own divider (separate kanban item, not flagged in this feedback) left untouched
- [x] Frontend build clean
- [x] Manual: re-check with the reworked per-message display — confirm every message (not just the boundary) shows its day/time, in both a 1-on-1 and a group thread

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
