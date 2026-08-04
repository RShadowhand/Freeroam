---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Feature: Date/Time Divider for area chats

User has no way of knowing when a last message was sent when they enter
a new room. Same shape as the day/time dividers just added to
1-on-1/group texting, applied to scene chat instead.

## Sub-tasks

- [x] Backend: `appendPlaceChatEntries` (the one chokepoint every place-chat write already goes through) now stamps `day`/`timeOfDay` on any entry missing it — covers all dozen call sites (user lines, char/narrator turns, call system markers) for free
- [x] Frontend: `MessageList.vue` renders a "Day N (Weekday) · timeOfDay" divider via `utils/time.js`'s `dayDividerLabels()`, same as the texting threads
- [x] Backend test added, 697/697 passing; frontend build clean
- [x] Manual: walk between rooms / jump time via the Freeroam time-jump control, confirm a divider appears at the right point in the scene chat, and pre-existing history renders unchanged (no divider)

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
