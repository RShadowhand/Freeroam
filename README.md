# Freeroam

A freeroam group-chat prototype: only the characters standing in the same
place as you get fed into the AI as a group chat, and they react when you
arrive. Backed by a small Express server that proxies chat requests to
[OpenRouter](https://openrouter.ai), so the API key lives on the server and
you can switch model/provider from a settings page instead of editing code.

The map isn't a fixed layout — it's a flat, editable list of **places** you
manage from the app itself. It could be a city, a neighborhood, a house, a
tower, whatever fits your setting; the seed data seeds a small neighborhood
just to have something to click around on.

## Structure

```
freeroam/
├── package.json             root of the npm workspace — see "Run it" below
├── backend/
│   ├── server.js            Express app: serves the frontend build + /api routes
│   ├── lib/                 context assembly, memory, relationships, NLP, TavernCard parsing, worldRegistry, ...
│   ├── package.json
│   ├── config.json          created on first run: OpenRouter key + model — global, shared by every world (gitignored)
│   ├── data/
│   │   ├── worlds.json      registry: [{ id, name, createdAt, lastPlayedAt }], defaultWorldId (gitignored)
│   │   └── worlds/<id>/     one world (save slot) per directory — its own characters/places/world/
│   │                        personas/presets JSON, its own chats/, its own memory/relationship SQLite db (gitignored)
│   └── uploads/avatars/<id>/  uploaded card PNGs, world-scoped, served at /avatars/<worldId>/<id>.png (gitignored)
└── frontend/                Vue 3 + Vite SPA (hash-based routing)
    ├── index.html           Vite entry point
    ├── package.json
    ├── vite.config.js       dev-server proxy for /api and /avatars -> :3001
    ├── dist/                production build server.js serves (gitignored — built automatically, see below)
    └── src/
        ├── main.js
        ├── App.vue
        ├── router/          hash-based routes, mirrors the original #/world/..., #/settings/... scheme
        ├── stores/          Pinia: world, chat, settings, theme, ui
        ├── api/             thin fetch wrappers, one file per backend resource
        ├── composables/     shared singleton UI state (modals, quick-move popover, quick-add-place)
        ├── components/      layout/, freeroam/, world/, cast/, persona/, prompts/, settings/, shared/
        ├── views/           one per route
        └── styles/          shared.css (theme CSS custom properties) + main.css (everything else)
```

`backend/` and `frontend/` are two npm workspaces under the root
`package.json` — one `npm install` at the repo root installs both (into a
single root `node_modules`), and the root `npm start` builds the frontend
then launches the backend that serves it.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3001**. `npm start` always rebuilds the
frontend first, so pulling frontend changes and re-running `npm start` is
all you need — no separate build step.

For frontend development with hot-reload instead, run `npm run dev` from
the repo root (Vite serves the SPA itself and proxies `/api`/`/avatars`
requests through to the backend on :3001, which you still need to run
separately — `npm start --workspace=backend`) and open the URL Vite prints.

1. Go to **Settings** and paste an OpenRouter API key
   (get one at https://openrouter.ai/keys), then pick a model — the list is
   pulled live from OpenRouter, so it covers whatever's currently available
   across Anthropic, OpenAI, Google, Meta, and the rest of their catalog.
2. Go to **Places** to see, add, edit, or remove locations.
3. Go to **Cast** to see the built-in characters, upload your own, and place
   anyone in any place.
4. Head back to **Freeroam** and start walking around.

## Worlds (save slots)

A **world** is a full save slot: its own cast, places, chat history, and
memory — switching worlds is a clean break, not a shared space. Everything
is world-scoped except `config.json` (the OpenRouter key/model and
narrator/memory settings, which apply everywhere).

- The **💾 world name** chip at the right of the nav bar shows which world
  you're in and links to **Worlds**, where you can switch, rename,
  duplicate (optionally without chat history — a "restart the campaign"
  reset that keeps the cast/places/relationships), or delete a world (the
  last remaining one can't be deleted).
- **Multiple people can use one running instance in different worlds at
  the same time** — each browser tracks its own current world (a header
  sent with every request), not the server. This means multiple *browser
  tabs/users* work fine; running more than one *server process* against
  the same `backend/data` at once is still unsupported, same as before.
- **Upgrading from before this feature existed**: the first time the
  server starts, your existing single world of data is automatically moved
  (not copied) into `data/worlds/<a-new-id>/` as a world named "My World"
  and set as the default — no action needed, and old bookmarks/tabs land on
  it exactly as before.

## Places

A place is the actual unit of navigation — there's no forced hierarchy (no
required floors, districts, or rooms). Each place has:

- `name`, `desc` — what it's called and what it feels like
- `type` — `communal` (open to anyone) or `private` (belongs to a resident)
- `ownerId` — for private places, which character it belongs to
- `area` — a free-text label used only for grouping in the UI (a
  neighborhood, a district, a floor, whatever makes sense). Leave it blank
  and the place shows up under "Unsorted." Type a new one and it becomes a
  new group automatically — there's no separate list of areas to maintain.

Manage all of this from **places.html**: add a place with the form at the
top, or edit/remove any existing one inline. Deleting a place automatically
unplaces anyone standing there and clears it as anyone's home if it was
private.

The seed data (`SEED_PLACES` in `server.js`) sets up a small neighborhood —
Town Square, a couple of private homes, a greenhouse — just so there's
something on the map the first time you run it. Edit or delete every bit of
it; nothing in the app logic depends on those specific places existing.

## Character cards

Go to **Cast** to manage who's around:

- **Upload**: drop in one or more `TavernCard V2` PNGs (the standard SillyTavern
  export format — a normal-looking PNG with character data embedded in a
  `chara` text chunk, base64-encoded JSON). Legacy v1 cards work too. The
  backend reads the PNG's chunks directly (`backend/lib/tavernCard.js`) —
  no image library needed — pulls out `description`, `personality`,
  `scenario`, `mes_example`, and `system_prompt`, and folds them into one
  persona string. The PNG itself becomes the character's avatar.
- **Place manually**: each character card has a place dropdown, grouped by
  area, showing whether each place is communal or private (and whose, if
  private).
- **Place randomly**: "🎲 Randomize placements" scatters every character
  (built-in and uploaded) across every place on the map. Randomized
  placements always start with no scripted greeting.
- **Choose an opening line**: `first_mes` and every entry in
  `alternate_greetings` are parsed into one `greetings` list per character.
  Once a character is placed, an "Opening line" dropdown lets you pick which
  one they'll say verbatim the first time you arrive there — or choose
  "No greeting" to skip the script and let the AI improvise the arrival
  reaction instead (useful for a first encounter you don't want scripted).
  The greeting only fires once per place per session; return visits and any
  reply you send always go through the AI, using every character present.
- **Remove**: uploaded characters can be deleted, which also deletes their
  avatar file, clears their placement, and un-assigns them as the owner of
  any private place. Built-in characters aren't deletable from the UI.

Placements are stored server-side (`data/world.json`), so they persist
between sessions and are shared across anyone hitting the same backend —
place someone on the Cast page in one tab, and Freeroam in another tab will
pick up the change next time you walk into a new place (it refetches world
state on every move).

## How the location-filtering works

- `frontend/index.html` fetches `places`, `placements`, and `characters`
  from the backend on load and every time you enter a place.
- Moving to a place only ever builds a system prompt from the characters
  whose placement points at that place's id — characters elsewhere are never
  included in the request.
- The frontend sends `{ system, messages }` to `POST /api/chat`.
- `backend/server.js` loads the saved API key + model from `config.json` and
  forwards the request to OpenRouter's `/chat/completions` endpoint, then
  returns just the reply text. The key never touches the browser.

## Extending this

- **Per-character calls**: right now one API call generates lines for every
  present character at once (parsed by `Name: line`). For more independent
  character reasoning, call `/api/chat` once per character instead, each with
  only that character's persona in the system prompt.
- **Characters that move on their own**: placement is currently only changed
  by the user (via Cast) or the randomize button. A fuller version could move
  characters on a schedule, have them follow the visitor, or react to events
  by calling `POST /api/characters/:id/place` from a server-side scheduler.
- **Enforcing private places**: right now "private" is descriptive — it
  changes the system prompt's framing but doesn't block the visitor or other
  characters from entering. Adding real access rules (e.g. only the resident
  greets you unless invited) would live in the arrival logic in
  `enterPlace()`.
- **Connections between places**: there's no travel graph — every place is
  reachable directly from the map. If you want walking distance or line-of-
  sight to matter, you'd add a `connections: [placeId, ...]` field to places
  and only show/allow moves to adjacent ones.
- **Lorebooks**: TavernCard v2 also supports `character_book`, a set of
  keyword-triggered lore entries injected into context when a keyword
  appears in the conversation. `tavernCard.js` doesn't parse this yet —
  worth adding if you want that kind of dynamic lore injection.
- **Multiple saved profiles**: `config.json` currently holds one key/model
  pair. If you want several provider profiles to switch between, change it
  to an array of named profiles and add a "which profile is active" field.
