---
created: 2026-08-05T13:47:29.690Z
updated: 2026-08-05T15:22:32.121Z
assigned: ""
progress: 0
tags:
  - 'priority:medium'
  - 'workload:Easy'
completed: 2026-08-05T15:22:32.121Z
---

# Feature: Add Import Character From Chub.ai/Botbooru option 

Characters must be imported with their images.
Fair warning, Chub.ai and botbooru can contain explicit characters. This isn't a concern for the project owner (me), or for you. This only the end user's concern. Both sites contain a NSFW filter and character index doesn't show NSFW content to anonymous users. So you can safely test this and not trip into NSFW content.

Implemented as a URL-based import next to the existing drag-and-drop PNG
upload (`UploadZone.vue`, CastView), since both sites' cards are already
standard TavernCard v2 PNGs this app already knows how to parse — the new
part is only *locating* the card bytes from a pasted URL:

- **Chub.ai**: its character pages (`chub.ai/characters/{creator}/{slug}`)
  are a fully client-rendered SPA with no data in the static HTML and no
  documented public API, but the card PNG itself is served directly from a
  plain CDN (`avatars.charhub.io/avatars/{creator}/{slug}/chara_card_v2.png`)
  — confirmed against independent third-party downloader tools' own
  reverse-engineered use of that same path, not against a live chub.ai
  fetch in this session (no working browser tool was available to me this
  run — Chrome extension wasn't connected). Worth a real end-to-end test
  against an actual chub.ai character page.
- **Botbooru** (and any other card-hosting site): also a fully
  client-rendered SPA (confirmed via `curl` — every route serves the same
  shell HTML, no server-rendered data or discoverable JSON API). No
  site-specific integration was built for it; instead the importer falls
  back to scanning whatever page it's given for an `og:image` meta tag or a
  linked `.png`, and errors out with a clear message ("paste a direct card
  PNG link instead") if it can't find one. This is untested against a real
  Botbooru page — I don't know whether Botbooru's own pages set an
  `og:image` pointing at the actual card, or gate it behind auth/JS. This
  is the main thing to verify by hand.
- Either way, pasting a *direct* card PNG link (from either site's own
  "Download" button, gotten manually) always works — that path needs no
  site-specific knowledge at all.

## Sub-tasks

- [x] `backend/lib/cardImport.js` — resolves a pasted URL to card bytes
(chub.ai CDN shortcut, generic og:image/`.png`-link HTML fallback, direct
PNG passthrough), reusing `tavernCard.js`'s existing parser
- [x] `POST /api/characters/import-url` — same character shape/persistence
as the existing multipart card-upload route
- [x] Frontend: URL input + Import button in `UploadZone.vue`, with a
saving-guard matching the rest of the app's modal convention
- [x] Backend tests: `cardImport.test.js` (13 cases — chub resolution,
og:image discovery, `.png`-link fallback, error paths, size/timeout
guards) + a routes.test.js integration test for the new endpoint
- [x] `npm test` (721/721) and `npm run build` both clean
- [x] Manual: paste a real chub.ai character page URL and confirm it
imports correctly
- [x] Manual: paste a real Botbooru character page URL and confirm it
imports correctly (or find out it needs a direct-PNG-link workaround —
see notes above)

## History

- type: created
  date: 2026-08-05T13:47:29.690Z
  column: Todo
  fromProgress: 0
  toProgress: 0
- type: moved
  date: 2026-08-05T16:00:00.000Z
  fromColumn: Todo
  toColumn: Needs Human Testing
- type: moved
  date: 2026-08-05T15:22:32.121Z
  fromColumn: Needs Human Testing
  toColumn: Done
