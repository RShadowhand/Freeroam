# Freeroam

A freeroam group-chat roleplay app: only the characters standing in the same
**place** as you get fed into the AI as a group chat, and they react when you
arrive. Backed by a small Express server that proxies chat requests to any
OpenAI-compatible endpoint (defaulting to [OpenRouter](https://openrouter.ai)),
so the API key lives on the server and you switch model/provider from a
settings page instead of editing code.

The map isn't a fixed layout — it's a flat, editable list of **places** you
manage from the app itself. It could be a city, a neighborhood, a house, a
tower, whatever fits your setting; a fresh install seeds a small demo
neighborhood just to have something to click around on.

## Highlights

- **Location-scoped scenes** — moving to a place builds the prompt only from
  the characters placed there; everyone else is never in the request.
- **Multiple worlds (save slots)** — each world is its own cast, places, chat
  history, and memory. Different browser tabs can be in different worlds on one
  running server at the same time (see [Worlds](#worlds-save-slots)).
- **Semantic memory & relationships** — characters remember past scenes and
  know who's who, retrieved by a local embedding model (no per-message network
  call, no LLM cost); see [How memory works](#how-memory-works).
- **The Phone** — 1-on-1 texting (TypeCast), group texting with a reply cascade
  (Party Line), and live calls (Wavelength), plus optional unprompted texts from
  characters.
- **Personas** — your own in-world identity; the active one replaces the generic
  "the visitor" label in prompts and transcripts.
- **Prompt presets** — a SillyTavern-compatible Chat Completion prompt manager;
  real ST preset exports import slot-for-slot.
- **Character / persona / place cards** — import & export as TavernCard-style
  PNGs or JSON, and whole worlds as `.zip` bundles.
- **A narrator, weather, an in-world clock, and character schedules** — ambient
  scene texture and a world that has a time of day.
- **Suggested actions** — quick-action chips under a reply (send/go somewhere,
  add a new place or character, bring someone into or out of the scene),
  detected locally with no extra LLM call; see
  [Suggested actions](#suggested-actions).

## Structure

```
freeroam/
├── package.json             root npm workspace — see "Run it" below
├── backend/                 Express app + all game logic
│   ├── server.js            routes: serves the frontend build + every /api/* endpoint
│   ├── lib/                 context assembly, memory/relationship stores, embeddings,
│   │                        NLP, TavernCard/PNG parsing, texting/calls/groups, worldRegistry, ...
│   ├── test/                node:test suites (run with `npm test`)
│   ├── config.json          created on first run: API key + model — global, shared by every world (gitignored)
│   ├── data/
│   │   ├── worlds.json      registry: [{ id, name, createdAt, lastPlayedAt }], defaultWorldId (gitignored)
│   │   └── worlds/<id>/     one world (save slot) per dir: characters/places/world/personas/presets/
│   │                        groups JSON, chats/ + texts/ logs, and its own memory/relationship SQLite db (gitignored)
│   └── uploads/avatars/<id>/  uploaded avatars, world-scoped, served at /avatars/<worldId>/... (gitignored)
├── frontend/                Vue 3 + Vite SPA (hash-based routing)
│   └── src/
│       ├── router/          hash routes (#/world/..., #/settings/...)
│       ├── stores/          Pinia: world, chat, settings, theme, ui, phone, groups, worlds
│       ├── api/             thin fetch wrappers, one file per backend resource
│       ├── composables/     shared singleton UI state (modals, popovers)
│       ├── components/      layout/, freeroam/, world/, cast/, persona/, phone/, prompts/, settings/, onboarding/, guides/, shared/
│       ├── views/           one per route
│       └── styles/          shared.css (theme CSS variables) + main.css (everything else)
└── frontend-design/         a backend-free copy of frontend/ for standalone visual editing (see below)
```

`backend/` and `frontend/` are two npm workspaces under the root
`package.json` — one `npm install` at the repo root installs both, and the
root `npm start` builds the frontend then launches the backend that serves it.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3001**. `npm start` always rebuilds the frontend
first, so pulling changes and re-running `npm start` is all you need — no
separate build step.

For frontend development with hot-reload, run `npm run dev` from the repo root
(Vite serves the SPA and proxies `/api` + `/avatars` to the backend on :3001,
which you still need running separately — `npm start --workspace=backend`) and
open the URL Vite prints.

A first-run onboarding walkthrough covers the essentials in-app; the short
version:

1. Go to **Settings** and paste an API key (OpenRouter keys at
   https://openrouter.ai/keys), then pick a model — the list is pulled live
   from the endpoint, covering whatever's currently available.
2. Go to **Places** to see, add, edit, or remove locations, and **Cast** to
   manage characters and place them.
3. Head to **Freeroam** and start walking around. Settings → **Guides** has a
   searchable manual for everything else.

> **Note:** this is a local, single-user-oriented app — the API is not
> hardened for untrusted public exposure (permissive CORS, no auth, a generous
> JSON body limit). Run it on your own machine or a trusted network, not as an
> open public service.

## Worlds (save slots)

A **world** is a full save slot: its own cast, places, chat history, and
memory — switching worlds is a clean break, not a shared space. Everything is
world-scoped except `config.json` (the API key/model and narrator/memory
settings, which apply everywhere).

- The **world name chip** at the right of the nav bar shows which world you're
  in and links to **Worlds**, where you can switch, rename, duplicate
  (optionally without chat history — a "restart the campaign" reset that keeps
  the cast/places/relationships), export/import a world as a `.zip` bundle, or
  delete a world (the last remaining one can't be deleted).
- **Multiple people can use one running instance in different worlds at the
  same time** — each browser tracks its own current world via a header sent
  with every request (`X-World-Id`), not the server. Running more than one
  *server process* against the same `backend/data` at once is still
  unsupported.
- **Upgrading from before this feature existed**: the first time the server
  starts, existing single-world data is automatically moved into
  `data/worlds/<id>/` as "My World" and set as the default — no action needed.

## Places

A place is the unit of navigation — no forced hierarchy (no required floors,
districts, or rooms). Each place has a `name`/`desc`, a `type` (`communal`,
open to anyone, or `private`, belonging to residents), `ownerIds` (for private
places — supports more than one owner), and a free-text `area` label used only
for grouping in the UI. Type a new area and it becomes a group automatically;
leave it blank and the place shows up under "Unsorted."

Manage all of this from the **Places** view. Deleting a place unplaces anyone
standing there and clears its ownership. The seed data (`SEED_PLACES` in
`server.js`) sets up a small neighborhood just so there's something on the map
the first time you run it — edit or delete every bit of it.

## Cast & character cards

Go to **Cast** to manage who's around:

- **Create from scratch** or **upload a `TavernCard` PNG** (the SillyTavern
  export format — character data embedded in a `chara` text chunk; legacy v1
  and v2/v3 both work). The backend reads the PNG's chunks directly
  (`backend/lib/tavernCard.js`), no image library needed, pulling out
  `description`, `personality`, `scenario`, `mes_example`, and greetings as
  separate opt-in prompt fields.
- **Attach or replace an avatar** on any existing character or persona (PNG /
  JPEG / WebP) from its edit form.
- **Place** each character manually (a dropdown grouped by area) or **randomly**
  ("Randomize placements" scatters everyone across the map).
- **Choose an opening line** — `first_mes` and `alternate_greetings` become a
  per-character greeting list; pick which one they say verbatim the first time
  you arrive, or "No greeting" to let the AI improvise the arrival reaction.
- **Schedules** — optionally give a character a weekly routine
  (`{ weekday: { timeOfDay: { placeId } } }`); they move automatically as the
  in-world clock advances.
- **Relationships & memories** — edit a character's known relationships and
  browse/add/edit their memories from the same modal.
- **Remove** any character (including the built-in demo cast), which also
  deletes its avatar, placement, place ownership, memories, and relationships.

Everything is stored server-side per world, so it persists between sessions and
is shared across anyone hitting the same world.

## How a scene is generated

- The frontend owns and renders the per-place chat log, but the backend owns
  everything about the request: entering a place and every message go through
  `/api/places/:id/*`.
- Only characters whose placement points at the current place are considered;
  of those, "active" ones take a turn (a crowd can be trimmed by demoting some
  to background). Each turn is generated independently so characters reason
  separately, with relevant memories and relationship knowledge injected.
- `backend/server.js` loads the API key + model from `config.json` and forwards
  to the endpoint's `/chat/completions` (streaming or not). The key never
  touches the browser. A separate **narrator** pass adds ambient scene texture
  for empty, solo, or background-heavy scenes.

## Suggested actions

A generated reply is scanned for a small set of high-value cues and turned
into one-click suggestion chips under the message — a nudge, not a
generation, so every chip is just a shortcut to something you could already
do manually:

- **Destination** — the reply invites you somewhere (a known place: "Send to"
  / "Go with"; an unrecognized name: "Add place").
- **New character** — a name gets introduced that isn't in the cast yet
  ("Add character").
- **Promote / demote** — a present-but-background character gets beckoned into
  the conversation, or the speaker steps back from it (adjusts who's "active"
  at that place — see [How a scene is generated](#how-a-scene-is-generated)).

More than one suggestion on a message collapses into a single "N
suggestions…" button that opens a grouped modal instead of a wrapping row of
chips. Detection is entirely local (`backend/lib/suggestedActions.js`) — no
extra LLM call — via three modes, set in Settings → **Suggested actions**:

- **Regex only** — fixed trigger phrases, instant, but only fires on
  phrasing it was written for.
- **ML only** — a local NER + zero-shot intent-classification model
  (same in-process ONNX approach as embeddings), more robust to varied
  phrasing, slower per message.
- **Regex + ML** — runs both and merges, regex hits taking priority.

## How memory works

Memories and relationships live in a per-world SQLite database
(`backend/lib/db.js`), vector-indexed with `sqlite-vec`. Embeddings are
computed **locally and in-process** via a small ONNX model
(`@huggingface/transformers`) — no per-embedding network call and no LLM cost.
A recorded scene is stored once and shared by everyone who witnessed it;
retrieval blends semantic similarity with recency, and long text is chunked so
a short specific detail doesn't get averaged away.

The first embedding after a fresh install downloads the model once (needs
internet), then caches it under `backend/.cache/`. Changing the embedding model
makes stored vectors incompatible; Settings has an explicit "rebuild
embeddings" action rather than silently re-embedding on startup.

## frontend-design/

`frontend-design/` is a standalone copy of `frontend/` for visual/UX editing
with **no backend required**. Its `src/mock/mockBackend.js` patches
`window.fetch` to answer every `/api/*` call in-browser with seeded demo data
(replies are canned, not real generations), so `npm run dev` inside it runs the
whole UI with zero network dependency. Edit the `.vue`/`.css` files there and
see changes live; it's kept in sync with the real `frontend/` by hand.

## Tests

Backend tests are plain `node:test` suites — run them from the repo root:

```bash
npm test
```

They point the app at a disposable temp directory (`FREEROAM_TEST_ROOT`), so
they never touch real `backend/data` or `config.json`, and never make a real
paid LLM call — the OpenRouter-backed paths are only exercised up through their
validation branches, while the local embedding model (free) is used for real.
