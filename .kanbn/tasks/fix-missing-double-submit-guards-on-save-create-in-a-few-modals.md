---
tags:
  - 'priority:low'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: missing double-submit guards on Save/Create in a few modals

Consistency pass — the guard pattern already existed correctly in
sibling components, this just filled the gap in these three.

## Sub-tasks

- [x] `NpcModal.vue`, `CharacterModal.vue`, `PersonaModal.vue` all now have a `saving` guard (blocks re-entry + disables the Save button while in flight), matching `GroupInfoPanel`'s existing pattern
- [x] Frontend build clean
- [x] Manual: rapid double-click Save on a new character/persona/NPC-promotion — confirm only one record gets created

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
