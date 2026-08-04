---
tags:
  - 'priority:medium'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Feature: world picker on boot + backend-persisted onboarding flag

The onboarding flag lived in localStorage, which doesn't persist across a
fresh private-browsing session, so the tour kept reappearing there.
There was also no way to see/pick which world (save slot) is active
without already knowing about the small chip in MainNav.vue.

## Sub-tasks

- [x] Backend: `onboarded` flag added to `config.json`/`publicConfig()`/`POST /api/settings`
- [x] Frontend: `useOnboardingModal.js` moved off `localStorage` onto the backend flag
- [x] Frontend: new `useWorldPicker.js` + `WorldPickerOverlay.vue`, shown once per boot when 2+ worlds exist, suppressed while onboarding is open
- [x] Frontend build clean
- [x] Manual: with 2+ worlds, hard-reload and confirm the picker appears/switches correctly and stays suppressed while onboarding is open
- [x] Manual: confirm onboarding does NOT reappear in a fresh private/incognito window

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
