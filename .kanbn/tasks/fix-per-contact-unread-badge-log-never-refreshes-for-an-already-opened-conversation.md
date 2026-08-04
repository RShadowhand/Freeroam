---
tags:
  - 'priority:high'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: per-contact unread badge/log never refreshes for an already-opened conversation

This staleness predates the per-contact badge feature but was invisible
before it — the badge is what turned "reopen a thread to see a new
message" into an actual expected user flow.

## Sub-tasks

- [x] `openConversation` (`frontend/src/stores/phone.js`) now re-fetches whenever `unreadByCharacterId[characterId] > 0`, even if already loaded once — no longer gated solely on `loadedIds`
- [x] 703/703 backend tests passing (frontend-only fix); frontend build clean
- [x] Manual: open a contact's thread once, trigger a proactive text for that same contact later (high `textingChancePerChar`), reopen the thread — confirm the new message appears and the badge clears

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
