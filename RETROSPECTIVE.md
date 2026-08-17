# Freeroam Retrospective — architecture, lessons, and salvage map

*Covering 2026-07-16 → 2026-08-17, 98 commits. Written as the handoff document for the
next evolution: what exists, how it actually works, what it taught us, and what deserves
to survive the rewrite — with special attention to world/character handling, the rewrite's
stated focus.*

---

## 1. What Freeroam is

A self-hosted freeroam group-chat roleplay app. The core conceit: **place is the prompt
boundary** — only characters standing in the same place as you are in the LLM request;
everyone else doesn't exist for that call. Around that grew worlds (save slots), a phone
(1-on-1 texts, group cascades, live calls, unprompted texts), semantic memory on local
embeddings, personas, SillyTavern-compatible prompt presets, weather, an in-world clock,
and — the last month's arc — a measured, multi-generation intent-detection system that
turns what characters *say* into actions the app can *do*.

Stack: Express monolith (`backend/server.js`, ~4,900 lines) + 31 lib modules, Vue 3 +
Pinia + Vite frontend (10 views, 8 stores), per-world JSON dirs + SQLite, `node --test`
(837 tests), any OpenAI-compatible endpoint via server-side key.

---

## 2. System map — how it works today

### 2.1 Data model and worlds

- **World registry** (`lib/worldRegistry.js`): each world is a directory of JSON files
  (`characters/places/world/personas/groups` = curated data; `weather/calls/
  scheduledTexts` = runtime state, excluded from clone but included in export) plus a
  SQLite DB (`freeroam.db`) for memories, relationships, and embedding vectors. Worlds
  resolve per-request via an `X-World-Id` header — there is deliberately no server-side
  "current world," so two browser tabs can live in different worlds simultaneously.
- **All JSON writes are atomic** (`lib/jsonStore.js`: temp file + rename, `warnIfCorrupt`
  on read). This was retrofitted after crash-corruption bugs; the next evolution should
  have it from day one — or skip mutable JSON entirely (see §5).
- **Global vs. per-world**: LLM config, presets, and settings are global; everything
  fiction-side is per-world. The boundary proved correct and is worth keeping.

### 2.2 The world model

- **Places** are a flat editable list with `area` tags; areas drive weather. Private
  places have owners. The "map" is a list, not a graph — no adjacency, no travel cost.
- **Time** is `{ day, timeOfDay }` over a 7-value enum (`sunrise…night`, in
  `lib/context.js`). It only ever changes in one route (`POST /api/world/time`), which
  made it the natural hook point for everything time-driven: schedule placements, weather
  rerolls (on day change), and scheduled-text firing all live there. **This
  "single mutation point" accident became one of the most valuable properties in the
  codebase** — see §4.
- **Weather** (`lib/weather.js`) per area, auto-rerolled daily, fed into scene prompts.
- **Character schedules/placements**: `applyScheduledPlacements` moves characters between
  places when time changes — the primitive form of "characters have lives."

### 2.3 Characters, personas, presence

- **Characters** are Tavern-style cards (description/personality/scenario/example
  dialogue) + nicknames, avatars, relationships, schedules. Import/export as PNG cards
  (`lib/pngCard.js`, `lib/tavernCard.js`) and from URLs (Chub.ai/Botbooru,
  `lib/cardImport.js`).
- **Identity/alias resolution** is centralized in `lib/textUtils.js`:
  `characterAliases` (full name, first name, nicknames) →
  `characterMentionedIn` / `firstMentionedCharacter` / `orderByMentionIn`, built on
  `(?<!\w)…(?!\w)` lookarounds (learned the hard way: `\b` silently fails on names that
  start/end with punctuation, e.g. "Dr. Vane (Ret.)"). Everything that asks "is this
  character being talked about" goes through this one lib — beckon detection, reply-line
  speaker parsing, response ordering, texting target binding. **One of the clearest
  salvage-as-is candidates.**
- **Presence** is where the model is weakest: a character is "at a place" via
  `world.placements`, and "active vs. background" via a per-character flag
  (`lib/presence.js` helpers). Every feature re-derives its own view of who's present/
  active/background, and promote/demote/call-to-scene all mutate the same scattered
  state. It works, but it's flags-and-conventions, not a model. See §5.
- **Personas** are the user's identities; the active persona's name replaces "Visitor" in
  prompts, transcripts, and memory. A hard-won detail: the persona's *name* must be
  treated as radioactive in any model-facing classification prompt (§4).

### 2.4 The generation pipeline (scene chat)

`buildTurnRequest` assembles, per character turn: retrieved memories (embedding
similarity, current-interaction entries excluded to avoid self-quoting), relationship
knowledge, scene block (place/weather/time/others present), preset-assembled or default
system prompt, then fills the remaining context budget with role-tagged history
(`historyBudget` / token estimates). Reaction rounds run every active character in order —
mention order (via `orderByMentionIn`) layered over manual/stored order. A **narrator**
(`lib/narrator.js`) covers empty/solo/background scenes. Streaming is SSE with a shared
frontend parser (deduplicated across chat/phone/groups after being triplicated — a whole
ISSUES class by itself). Cancellation, retry, and regenerate all had to learn the same
lessons separately: guard re-entrancy, never wipe view state on cancel, suppress side
effects (memory writes, fallback notes) of cancelled rounds.

### 2.5 The phone stack

- **1-on-1 texting** and **calls** reuse a dedicated prompt builder (`lib/texting.js`) —
  deliberately NOT the scene pipeline (texting has no "place"); the same choice narrator
  made. Pattern worth keeping: distinct conversation surfaces get distinct small prompt
  builders instead of one mega-builder with flags.
- **Group texting** runs a probabilistic reply cascade (`lib/textCascade.js`: base chance,
  decay, per-character cap) with optional manual approval per step, and "addressed by
  name = guaranteed first replier" rather than forcing full deterministic order —
  preserving the cascade's dice-roll feel was an explicit design decision.
- **Proactive texts**: random rolls per user input (`lib/proactiveTexts.js`) generate
  unprompted texts. This machinery became the delivery mechanism for intent-detection's
  follow-through: the trigger endpoint accepts a `hint` (what the text should be about),
  which redirects the prompt directive from "text out of the blue" to "follow through on
  this specific promise." Arrival is signaled by an unread-badge poll (20s), cached
  server-side per world.
- **Scheduled texts** (`lib/scheduledTexts.js` + firing in the time route): the first real
  "world event" system — promises stored with `(day, timeOfDay)` due-slots, tuple-compared
  against the clock so time jumps fire them late instead of stranding them, capped per
  tick, pending-not-dropped when no API key. **This is the seed of the next evolution's
  event scheduler** (§7).

### 2.6 Memory and relationships

Local embedding model (bge-small via `@huggingface/transformers`, in-process ONNX, no
network), vectors in SQLite. Memories are recorded per round (shared row per exchange in
scenes; single rows for one-shot events like proactive texts), retrieved by cosine
similarity with a configurable floor. Relationship knowledge is a separate store with its
own embeddings. Rebuilds are transactional; embedding-model changes are versioned with a
staleness flag and explicit user-triggered rebuild. A Cytoscape relations graph
visualizes it.

### 2.7 Intent detection / suggested actions (the saga, final form)

Four modes on one setting (`suggestedActionsMode`):

- **regex** (default): fixed patterns; instant; structurally conservative (its step-back
  patterns are first-person-only, which made it accidentally immune to a failure the LLM
  never overcame).
- **ml / hybrid** (the current best local path): `bert-base-NER` for entities +
  **DeBERTa-v3-base (q8) multi-label zero-shot** for intent families, one classifier call
  + one NER call per message shared by all gates. Detects the classic four (destination /
  new-character / promote / demote) **plus texting promises** → `text-someone` /
  `scheduled-text`, via: whole-text family gate → per-sentence trigger localization →
  deterministic target binding (alias → "you"/persona → NER free-text) → tiered keyword
  time rules (trigger sentence, then its paragraph for explicit later-cues only) →
  the trigger sentence *verbatim* as the extractive reason. 75–102ms short replies, ~3s
  for 5-paragraph replies.
- **llm**: a sidecar call after the reply — grammar-constrained JSON locally
  (node-llama-cpp + Gemma4-E2B-QAT, auto-downloaded 3.3GB) or prompt-based JSON against
  the same/custom remote endpoint. Kept as the comparison mode; the ML path matched or
  beat it in production while being ~35–90x faster.

Suggestions render as one-click chips (shared shapes across both modes) — every chip is a
shortcut to a real app action: move/go-with, add place/character, promote/demote, bring
here, open thread, "have them send that text" (fires the proactive generator with the
promise as hint), and "schedule it" (stores the promise; fires when the clock arrives).

### 2.8 Testing

837 backend tests (`node --test`), all offline: deterministic fakes injected for
NER/classifier calls, `mockOpenRouterFetch` intercepting only `/chat/completions` (pass
everything else through, or the test server's own HTTP dies — a subtle trap that bit
once). Route tests spin isolated temp worlds. Two untracked scratch harnesses hold the
**real-model golden set** (`backend/scratch-ml-smoke.mjs` — 5 production replies with
expected outputs; `backend/scratch-multilabel-spotcheck.mjs` — the 18-case calibration
methodology, pinned to q8). Known flake: one narrator test intermittently fails on a
120s real-network timeout when the full suite shares a process; passes on rerun/isolation.

---

## 3. Case study: the intent-detection arc (what actually happened)

Worth recording because the *sequence* is the lesson:

1. **Local classifiers measured near-noise** (Check investigation): MobileBERT's 2-label
   "X vs. none-of-the-above" calls false-fired ~50% on neutral narration; the 3-way call
   was fine → hypothesis: the *framing*, not zero-shot itself, was broken.
2. **Bigger classifiers ≠ better**: BART-large *regressed* (55% vs. MobileBERT's 70%);
   DeBERTa merely moved the errors. Spot-check before believing "bigger fixes it."
3. **Tiny LLMs, three ways**: transformers.js Qwen2.5-0.5B couldn't hold JSON (1/6
   parseable); FunctionGemma-270M emitted perfectly-formed calls but bound the target to
   the *speaker* 6/6 times (format ≠ comprehension); abliterated Qwen3 GGUFs never
   emitted the tool-call token at all (fine-tuning ablation collaterally killed
   tool-calling — stock checkpoints didn't have this).
4. **Two false conclusions from our own harness bugs**: a `maxTokens` too small for
   Qwen3's thinking mode produced a universal "mechanism never engages" verdict
   (wrong); fp32-calibrated thresholds deployed on q8 broke two gates (quantization
   shifts scores — **thresholds and dtype are a matched set**).
5. **Grammar-constrained plain JSON beat native tool-calling**: no trigger token for the
   model to decline to emit, faster, and Gemma4-E2B-QAT went 3/3 on realistic multi-turn
   scenarios once the prompt (a) explained each intent type in one line and (b) **never
   showed the persona's real name** (telling the model to ignore a visible name never
   worked; omitting it always did).
6. **LLM mode in production still lost** to prompt-fix whack-a-mole: `reason` took three
   iterations (restatement → timing-explanation → bare pronoun) and the
   dismissal-vs-demote misclassification survived four prompt attempts — a genuine
   small-model ceiling, deterministic (temp 0) and unfixable by wording.
7. **The reframed ML path won**: multi-label independence (no crowding-out), one
   "texting" label with rules doing the now/later split every LLM fumbled, slot-gating
   neutralizing intent-space overlap, extractive reasons that cannot hallucinate, and a
   first-person sentence filter making the dismissal trap *structurally impossible*
   instead of threshold-unlikely.
8. **Detection became action**: chips → proactive-text trigger with hint; promises →
   scheduled texts fired by the world clock.

Calibrated values worth carrying (valid for DeBERTa-v3-base **q8** only):
`'the speaker promises to text someone'` thr 0.85 · invite/beckon thr 0.9 (slot-gated) ·
leaving: whole-text pre-gate 0.5 + first-person sentences ≥ 0.8 · label wording is a
hyperparameter — near-synonyms measured +0.561 vs. −0.717 separation.

---

## 4. What we learned (transferable)

**Working with models:**
- *Measure, don't guess.* Every accuracy assumption tested this month was wrong at least
  once — including "bigger is better," "fine-tuned-for-function-calling is better," and
  two of our own test harnesses. A 20-case spot-check with per-label separation analysis
  repeatedly settled in an afternoon what speculation couldn't.
- *Zero-shot label wording is a tuned hyperparameter.* Treat label strings like
  calibrated constants; never reword without rerunning the harness.
- *Thresholds and quantization dtype are a matched set.* Calibrate on exactly what ships.
- *Decompose LLM-shaped jobs.* "Understand the reply" split into detect / bind / time /
  summarize — and three of the four got *better* as rules or extraction: enum time math
  wants a lookup table, target binding wants alias matching + a pronoun rule, and a
  verbatim quote beats a small model's summary whenever the downstream consumer is a big
  LLM anyway.
- *Prefer structural immunity over threshold tuning.* First-person filter for demote,
  slot-gating for invite/beckon, hiding the persona's name, multi-label independence —
  each made a failure *impossible* rather than unlikely. Every prompt-wording fix, by
  contrast, had to be re-litigated.
- *Small-model ceilings are real and specific.* Formats can be perfect while semantics
  fail (FunctionGemma's 6/6 speaker-as-target). When three wording attempts don't move a
  deterministic misclassification, stop prompting and change the architecture.
- *The per-call-unreliable LLM is still a fine offline batch teacher* (unused this
  project, documented for the fine-tuning path: synthetic data + LLM labeling + human
  spot-check → train the small model).
- *Keep a golden set of real production failures.* The five replies in the smoke harness
  caught every regression that unit fakes couldn't.

**Architecture:**
- *Single mutation points pay compound interest.* Because world time changed in exactly
  one route, placements, weather, and scheduled texts all hooked one line. Generalize
  this on purpose next time (§7).
- *A degradation contract beats error handling.* "Worst case is zero suggestions, never
  an error" made every detection mode, model failure, and malformed output a non-event.
- *Never trust a model-supplied ID as a foreign key* — resolve names server-side against
  the real cast, always.
- *Fire-and-forget + catch-log + caps* for anything spending tokens in the background;
  remove-before-generate beats remove-on-success when double-sends are worse than drops.
- *The dominant bug class was JSON read-modify-write races and missing in-flight guards*
  (a large share of the 32-item ISSUES sweep). Mutable shared state in JSON files
  requires discipline the design never enforced — see §5.
- *Denormalize display names into stored records; keep IDs for logic.*

**Process:**
- *The kanbn board as lab notebook worked.* Research tasks accumulated verbatim agent
  findings, decisions, calibration data, and post-mortems as comments; this document was
  writable largely because that record exists. (Also learned: never invent schema for a
  strictly-parsed external format — verify docs first.)
- *Spot-check before building; build behind the existing setting; keep old modes intact*
  — every risky idea shipped as an additive option, comparable live against its
  predecessor.
- *Environment rules that saved real pain:* one local model loaded at a time (VRAM);
  calibration harnesses pinned to production dtype; test fakes mirroring real contracts
  exactly.

---

## 5. Pain points the rewrite should fix

1. **`server.js` is a 4,900-line monolith** — routes, domain logic, prompt assembly, and
   orchestration interleaved. Libs are clean; the core isn't.
2. **No entity/presence model.** "Who is where, active, background, on a call, texting"
   is flags + placements + per-feature derivation. Promote/demote/call-to-scene/schedules
   all poke at it differently. This is the heart of "better world/character handling."
3. **No general event system.** Scheduled texts hand-built what should be a world-clock
   scheduler; placements and weather are more hand-built consumers of the same moment.
   Character schedules, promised texts, weather, and future ambitions (NPC↔NPC texting,
   off-screen events) are all "something happens when time reaches X."
4. **Conversation surfaces were triplicated, then painfully unified.** Scene/text/group/
   call each grew their own SSE consumption, entry shapes, loading flags, and race guards;
   half the ISSUES sweep was paying that back. One conversation abstraction with
   per-surface prompt builders is the shape the code kept trying to become.
5. **Mutable state in JSON files** bred the race/guard bug class. SQLite (already present
   for memory) or an in-process single-writer layer should own anything mutated
   concurrently.
6. **Identity resolution is centralized but adoption is per-call-site** — each feature
   chooses to use `textUtils` correctly. In the next design, references (name → entity)
   should be resolved at one boundary, not by convention.

---

## 6. Salvage map

**Carry as-is (libs that earned it):**
- `textUtils.js` — alias model + lookaround matching + mention ordering.
- `jsonStore.js` — atomic writes + corruption warnings (until/unless SQLite replaces it).
- `scheduledTexts.js` — the due-tuple pattern; generalizes into the event scheduler.
- `suggestedActions.js` + `nlp.js` — the calibrated ML detection core (families, tiered
  time rules, binding, extractive reason) and the multi-label classifier wrapper.
- `llmSuggestedActions.js` — grammar-JSON sidecar + `parseIntents` revalidation, kept as
  the comparison/fallback mode.
- `texting.js` prompt builder incl. the `proactiveHint` directive; `embeddings.js` /
  `memoryStore.js` / `relationshipStore.js`; `pngCard.js` / `tavernCard.js` /
  `cardImport.js`; the log module; the test harness patterns and both scratch calibration
  harnesses (untracked — copy them out before archiving this repo).

**Carry the design, rewrite the implementation:**
- World registry (per-world isolation, header-based resolution, curated-vs-runtime file
  split) — rebuild on a cleaner storage layer.
- Presence/participation semantics (active/background, beckon/step-back as first-class
  moves) — rebuild on a real entity model.
- Cascade feel (probabilistic with named-first-replier and manual approval).
- The four-mode detection setting as a permanent A/B surface.
- The generation pipeline's budgeting and memory-exclusion logic.

**Don't rebuild:**
- MobileBERT-MNLI as backbone; 2-label vs-none framing; native tool-calling for intent
  extraction; abliterated fine-tunes for anything tool-shaped; abstractive reasons from
  small models; global one-size thresholds.

---

## 7. Sketch: world/character handling for the next evolution

The shortest honest summary of a month of evidence:

- **Entities first.** Characters, personas, places, groups as one entity table with
  stable IDs, aliases as data (not per-feature parsing), and a single reference-resolution
  boundary every subsystem calls. `characterAliases` is the proto-version.
- **State as records, not flags.** Presence = `(entity, place, role: active|background,
  since)`. Conversations = first-class objects (scene/text/group/call are surface types
  over one shape). Every mutation through one writer.
- **A world-clock event queue as the spine.** `schedule(event, dueAt{day,timeOfDay})` +
  one dispatcher on time change. Placements, weather, promised texts, NPC routines, and
  anything detection produces become event producers/consumers instead of bespoke hooks.
  The due-tuple semantics (fire-late-not-never, caps, pending-without-prereqs) are
  already proven.
- **Detection as a pipeline, not a mode.** Detect (multi-label, calibrated) → bind
  (aliases/rules) → temporalize (rules) → excerpt (verbatim) → *propose* (chips) →
  *commit* (events). The last step is what Freeroam only reached in its final week —
  design for it from the start, keeping the human-approval chip step; auto-commit can be
  a per-action-type setting later.
- **Keep the degradation contract, the golden set, and the calibration harness** as
  standing infrastructure from day one.

*Written 2026-08-17. The kanbn task
`research-character-intent-action-detection-llm-modes-tool-calling-and-local-model-upgrades`
holds the full lab notebook behind §3–4, including every measurement quoted here.*
