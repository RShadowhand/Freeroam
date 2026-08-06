---
created: 2026-08-05T20:05:46.601Z
updated: 2026-08-06T09:34:05.220Z
assigned: ""
progress: 0
tags:
  - 'priority:high'
  - 'workload:Normal'
completed: 2026-08-06T09:34:05.220Z
---

# Fix: Area/grouptext chats character order should be dynamic/settable manually

Currently, there's no way to set the character response order, it's alphabetical.
Characters in an active area chat or in a group chat should be able to be set dynamically, either by hand by user, or by name/nickname matching.
E.g. user sends "*pets Soot* good little kitty *then turns to look at Erza* left the book on the desk over there" should automatically set response order to be "Soot, then Erza" even though Erza is alphabetically first. You can copy SillyTavern's homework.

## Design decisions (read before testing)

- **Area/scene chat and group-text cascades needed different treatments**,
  since they're mechanically different: a scene reaction round is
  deterministic (everyone active takes a turn, in order), while a group
  cascade is a probabilistic dice-roll chain (nobody's guaranteed to reply
  at all). "Order" means different things in each:
  - **Scene chat**: full manual ordering, persisted per-place
    (`placement.order`, new `PUT /api/places/:placeId/order`), plus a
    dynamic per-message override — `reactOrderForMessage` reorders that
    round's repliers by where each present character is first
    mentioned/addressed (name or nickname) in the user's own message,
    layered on top of the manual order (unmentioned characters keep their
    existing relative order). This is the literal "pets Soot, turns to
    Erza" case from the task description.
  - **Group chat**: rather than force a probabilistic system into a fixed
    sequence, addressing a member by name/nickname makes them the
    *guaranteed first replier* for that round (skipping the normal
    continue-roll for just that first pick) — matching "if you name them,
    they answer" — while every reply after that goes back through the
    existing random cascade untouched. A message mentioning nobody behaves
    exactly as before. Manual `participantIds` reordering already worked
    via the existing group-edit endpoint but never influenced anything
    (cascade picks are uniform-random regardless of list order); I left
    that as-is rather than making manual order also bias cascade
    probability, since that would change today's already-tested "any
    active member might jump in" feel for every ordinary message, not just
    ones the user actually cares about ordering.
- `lib/presence.js`'s `presentCharIds`/`activeCharIds` now sort by
  `placement.order` (missing = sorts last, stable otherwise) — this is
  shared by every place-chat route, not just `/say`.
- Reused the nickname-matching infrastructure from the sibling nickname
  task (`textUtils.js`'s `characterAliases`/`orderByMentionIn`/
  `firstMentionedCharacter`) rather than duplicating name-matching logic a
  third time.

## Sub-tasks

- [x] `lib/presence.js`: `presentCharIds`/`activeCharIds` sort by
`placement.order`
- [x] `PUT /api/places/:placeId/order` — sets manual order for characters
present at a place; ids not actually present are silently ignored
- [x] `/say` and `/retry` (scene chat): reorder `reactIds` by mention
before running the reaction round
- [x] `/api/groups/:groupId/send` and `/retry`: a mentioned member becomes
the guaranteed first cascade replier (`runGroupCascade`/`beginGroupCascade`'s
new `preferredFirstReplierId`), covering both the auto-cascade and
manual-approval paths
- [x] Frontend: drag-free ▲/▼ reorder buttons on `PresentChip.vue` (wired
up in `CurrentAreaPanel.vue`), `stores/world.js`'s `setPlaceOrder` +
updated `charsInPlace` sort
- [x] Backend tests: 4 new `presence.test.js` order cases, 7 new
`routes.test.js` cases (manual order, ignored-unplaced-id, bad body,
mention override, nickname-mention override, no-mention-no-change), 3 new
`groups.test.js` cases (mention override including via retry, no-mention
control)
- [x] `npm test` (782/782) and `npm run build` both clean
- [x] Manual: reorder present characters by hand in the Current Area panel and confirm the next reply round follows it; send a message naming two present characters out of their current order and confirm they reply in the order named; try the same in a group chat and confirm the named member replies first
- [x] Not yet visually checked in a browser this session (Chrome extension
wasn't connected; port 3001 was already occupied by another process, so no
competing dev server was started either) — the manual checklist above is
unverified

## History

- type: created
  date: 2026-08-05T20:05:46.601Z
  column: Todo
  fromProgress: 0
  toProgress: 0
- type: moved
  date: 2026-08-05T20:18:00.000Z
  fromColumn: Todo
  toColumn: In Progress
- type: moved
  date: 2026-08-06T00:00:00.000Z
  fromColumn: In Progress
  toColumn: Needs Human Testing
- type: moved
  date: 2026-08-06T09:34:05.220Z
  fromColumn: Needs Human Testing
  toColumn: Done
