---
created: 2026-08-05T20:06:46.212Z
updated: 2026-08-06T09:34:11.251Z
assigned: ""
progress: 0
tags:
  - 'priority:high'
  - 'workload:Easy'
completed: 2026-08-06T09:34:11.251Z
---

# Feature: Character nickname system

Characters should have a nickname system, as an array of nicknames. This should be used for character matching wherever needed.

## Comments

- author: claude
  date: 2026-08-06T00:00:00.000Z
  Implemented as `character.nicknames: string[]` (default `[]`, sanitized/deduped case-insensitively on save). The actual "matching wherever needed" work landed as a shared `backend/lib/textUtils.js` API — `characterAliases`, `characterMentionedIn`, `firstMentionedCharacter`, `orderByMentionIn` — covering name + first name + nicknames from one place, since this is also the foundation the sibling response-order task builds on.
  
  - `POST /api/characters` and `PUT /api/characters/:id` accept `nicknames` (real JSON array, or a comma-separated string for the multipart-with-avatar wire shape).
  - Wired into `suggestedActions.js`'s beckon/step-back matching (previously first-name-only) and `context.js`'s `parseReplyLines` present-speaker resolution — both now recognize nicknames, not just name/first-name.
  - Frontend: a comma-separated "Nicknames" field in `CharacterModal.vue`'s Details tab.
  - Tests: `backend/test/textUtils.test.js` (new, 19 cases) + 5 new nickname-specific cases in `routes.test.js`.
  - Found and fixed a real pre-existing edge case while writing tests: the old `\b...\b` word-boundary regex silently fails to match a name that itself starts/ends on punctuation (e.g. "Dr. Vane (Ret.)") — switched to `(?<!\w)...(?!\w)` lookaround, which doesn't have that blind spot.
  - `npm test` (782/782) and `npm run build` both clean. Not yet visually checked in a browser — the Chrome extension wasn't connected this session, and port 3001 was already occupied by another process, so I didn't spin up a competing dev server either. Please check the Nicknames field in Cast → edit a character.

## History

- type: created
  date: 2026-08-05T20:06:46.212Z
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
  date: 2026-08-06T09:34:11.251Z
  fromColumn: Needs Human Testing
  toColumn: Done
