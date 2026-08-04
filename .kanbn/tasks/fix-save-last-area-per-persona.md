---
tags:
  - 'priority:high'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: Save last area per persona

The old mechanism was localStorage-keyed per world only, not per
persona, and didn't survive a different browser/private window either.

## Sub-tasks

- [x] Backend: `recordLastPlaceForActivePersona(w, placeId)` sets `lastPlaceId` on the active persona in `personas.json`, called from `/api/places/:placeId/enter` — a no-op with no active persona
- [x] Backend: `lastPlaceId` stripped from both persona export routes — meaningless across an import boundary, same reasoning as `activePersonaId` being left out of the export shape
- [x] Frontend: `chat.js`'s `initFreeroam()` now resumes from `world.activePersona.lastPlaceId` instead of the old per-world (not per-persona) `localStorage` key, which is removed entirely along with its legacy-key forward-copy migration
- [x] Backend tests added (3 new), 700/700 passing; frontend build clean
- [x] Manual: as a persona, visit a place, switch worlds (or reload after a while), switch back — confirm you resume in that same place; switch personas and confirm each resumes independently; confirm a no-persona ("Visitor") session still falls back to the first place

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
