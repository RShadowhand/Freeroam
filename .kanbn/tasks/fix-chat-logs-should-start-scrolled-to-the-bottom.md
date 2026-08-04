---
tags:
  - 'priority:medium'
  - 'workload:Easy'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: Chat logs should start scrolled to the bottom

When moving to an area or opening a text/groupchat, the chatlog scroll
area starts at the top. Must be at the bottom for quicker start to
chatting.

## Sub-tasks

- [x] Root cause: the existing scroll-to-bottom watchers only fire on a *subsequent* change to the log/place — none of the three message-list components (`MessageList.vue`, `PhoneThread.vue`, `GroupThread.vue`) re-scrolled on their own first mount when the underlying data hadn't actually changed (e.g. navigating back to Freeroam from another tab remounts the component fresh with the same already-loaded log)
- [x] Fix: `watch(box, (el) => { if (el) nextTick(scrollToBottom); })` added to all three — fires exactly once when the scroll container is first attached to the DOM (or re-attached, if gated behind a `v-if` that was initially false), independent of whether the log/place data itself changed
- [x] Frontend build clean
- [x] Manual: navigate away from Freeroam and back, open a text/group thread fresh — confirm the log starts scrolled to the bottom in all three surfaces

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
