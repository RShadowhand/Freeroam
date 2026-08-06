---
created: 2026-08-06T10:04:41.731Z
updated: 2026-08-06T11:23:23.276Z
assigned: ""
progress: 0
tags:
  - 'priority:high'
  - 'workload:Easy'
completed: 2026-08-06T11:23:23.276Z
---

# Fix: Move changelog to its own dedicated page under Settings

Move Changelog to a dedicated page in Settings after Guides page

## Comments

- author: claude
  date: 2026-08-06T00:00:00.000Z
  Pulled Changelog out of `SystemView.vue`'s card list into its own route/page, matching the pattern the other Settings sub-pages already use (Connection, System, Prompts, Guides are each their own `/settings/*` route + `SubNav.vue` tab, not sections within one page).
  
  - New `frontend/src/views/ChangelogView.vue` — thin wrapper rendering `ChangelogCard` (unchanged) directly, following `SettingsView.vue`'s (Connection page) simple single-purpose-page pattern rather than `SystemView`/`GuidesView`'s multi-card anchor-nav shell, since there's only one card here.
  - New route `/settings/changelog` in `frontend/src/router/index.js`, placed right after `/settings/guides`.
  - New "Changelog" tab in `frontend/src/components/layout/SubNav.vue`'s `settingsTabs`, placed right after "Guides" per the task's ordering.
  - Removed the `changelog` anchor-section, its nav entry, and the `ChangelogCard` import from `SystemView.vue` — nothing else referenced the old anchor.
  
  `npm run build` is clean. Manual test: open Settings, confirm a "Changelog" tab appears after "Guides" in the sub-nav, and that it shows the same commit-history list `System` used to show under its old "Changelog" section (which should no longer appear there).

## History

- type: created
  date: 2026-08-06T10:04:41.731Z
  column: Todo
  fromProgress: 0
  toProgress: 0
- type: moved
  date: 2026-08-06T00:00:00.000Z
  fromColumn: Todo
  toColumn: In Progress
- type: moved
  date: 2026-08-06T00:00:01.000Z
  fromColumn: In Progress
  toColumn: Needs Human Testing
- type: moved
  date: 2026-08-06T11:23:23.276Z
  fromColumn: Needs Human Testing
  toColumn: Done
