---
tags:
  - 'priority:medium'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Feature: per-contact unread badge in TypeCast

Replaces the single global unread count/badge with a per-contact
breakdown, so the user doesn't have to open every conversation to find
out who actually texted.

## Sub-tasks

- [x] Backend: `countUnreadProactiveTexts(w)` returns `{ total, byCharacterId }`; `GET /api/texts/unread` updated to match
- [x] Frontend: `phone.js` store tracks `unreadByCharacterId`; badge added to `PhoneContacts.vue`'s `#trailing` slot via `TypeCastApp.vue`
- [x] Backend tests updated, 696/696 passing; frontend build clean
- [x] Manual: trigger a proactive text for one contact (high `textingChancePerChar` in Settings), confirm only that contact shows the badge in TypeCast's contacts list, and it clears once the thread is opened

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
