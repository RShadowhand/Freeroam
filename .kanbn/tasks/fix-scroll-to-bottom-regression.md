---
created: 2026-08-06T09:27:16.280Z
updated: 2026-08-06T11:23:19.029Z
assigned: ""
progress: 0
tags:
  - 'priority:high'
  - 'workload:Easy'
completed: 2026-08-06T11:23:19.029Z
---

# Fix: Scroll-to-bottom regression

First visit to the application doesn't scroll chat area to the bottom.

## Comments

- author: claude
  date: 2026-08-06T00:00:00.000Z
  Root cause: `FreeroamView.vue` hid the whole layout (including `ChatPanel`/`MessageList`) behind `v-show="ready"` while `initFreeroam()` loaded the starting place's log. `MessageList.vue`'s scroll-to-bottom watchers fire correctly on that reactive update, but the container is still `display:none` at that moment, so `scrollHeight` reads 0 and the scroll-to-bottom assignment is a no-op — nothing re-triggers it once `ready` flips true and the panel becomes visible. `PhoneThread.vue`/`GroupThread.vue` don't have this problem since they're gated by `v-if`, which only mounts once their data is already available.
  
  Fix: changed `v-show="ready"` to `v-if="ready"` in `frontend/src/views/FreeroamView.vue` (`ready` only ever transitions false→true once, so this is a behavior-neutral swap outside of the initial-mount timing). Now the layout — and `MessageList`'s "first mount" scroll watcher — only mounts once the log is already loaded and the container is actually visible.
  
  Manual test: on a fresh/first load of the app (or after clearing `world.activePersona`'s `lastPlaceId` state / entering a place with a long log for the first time), confirm the chat area opens already scrolled to the bottom instead of the top. `npm run build` is clean.

## History

- type: created
  date: 2026-08-06T09:27:16.280Z
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
  date: 2026-08-06T11:23:19.029Z
  fromColumn: Needs Human Testing
  toColumn: Done
