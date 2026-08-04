---
tags:
  - 'priority:high'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: cancelling a streaming regenerate wipes the message from view

A real regression from this session's own cancel-generation work
interacting with a pre-existing optimistic-UI pattern that never had a
cancellation path to hit before.

## Sub-tasks

- [x] `regenerateMessage`'s catch block (`frontend/src/stores/chat.js`) now re-fetches the authoritative log from the server on an `AbortError`, instead of leaving the optimistically-filtered entry permanently missing
- [x] 702/702 backend tests passing (unaffected — frontend-only fix); frontend build clean
- [x] Manual: regenerate a reply with streaming on, click Stop mid-stream, confirm the original message reappears (not permanently gone)

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
