---
created: 2026-08-05T13:56:44.707Z
updated: 2026-08-05T15:32:37.929Z
assigned: ""
progress: 0
tags:
  - 'priority:medium'
  - 'workload:Normal'
completed: 2026-08-05T15:32:37.929Z
---

# Feature: Trigger proactive text to group chats

An option for user to ask for a proactive text into a group message from one of the members. Character should have the option to be randomly picked, or specific character.

Built on `runGroupCascade`'s existing `triggerSpeakerId` parameter — its own
comment already anticipated this exact feature ("the user's own message
today, or ... a character's proactive one"), so the resulting message
naturally kicks off a normal cascade the rest of the group can react to,
not just a one-off isolated line. Deliberately non-streaming/non-cancellable,
matching 1-on-1 texting's own existing `/api/texts/:characterId/trigger`
"nudge" endpoint precedent exactly, rather than inventing a heavier pattern
for what's meant to be a quick, incidental action.

## Sub-tasks

- [x] `generateProactiveGroupText` (server.js) — reuses `buildTextingMessages`'
existing `proactive` + `groupMembers` flags together (already independently
composable, no changes needed there)
- [x] `POST /api/groups/:groupId/trigger` — optional `characterId`; random
participant chosen server-side when omitted; feeds the cascade via
`triggerSpeakerId`; records the round the same way `/send` does
- [x] Frontend: `groups.js`'s `triggerText(groupId, characterId?)`, guarded
by `loadingIds` (stricter than 1-on-1 texting's own ungated nudge — a
deliberate small improvement, not required for parity)
- [x] UI: a random-member nudge button in `GroupThread.vue`'s header, plus a
per-member nudge icon in `GroupInfoPanel.vue`'s roster (mirrors
`TypeCastApp.vue`'s existing per-contact nudge icon)
- [x] Backend tests: 5 new cases in `groups.test.js` (unknown group,
non-member characterId, specific-character trigger, random-pick trigger
that also kicks off a cascade, missing-API-key)
- [x] `npm test` (726/726) and `npm run build` both clean
- [x] Manual: nudge a specific member and a random member from both the
thread header and Group Info, with and without an API key configured

## History

- type: created
  date: 2026-08-05T13:56:44.707Z
  column: Todo
  fromProgress: 0
  toProgress: 0
- type: moved
  date: 2026-08-05T17:00:00.000Z
  fromColumn: Todo
  toColumn: Needs Human Testing
- type: moved
  date: 2026-08-05T15:32:37.929Z
  fromColumn: Needs Human Testing
  toColumn: Done
