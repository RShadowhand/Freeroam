---
created: 2026-08-05T13:50:24.633Z
updated: 2026-08-06T00:00:00.000Z
assigned: ""
progress: 0
tags:
  - 'priority:medium'
  - 'workload:Extreme'
---

# Research: Character intent/action detection (LLM modes, tool-calling, and local-model upgrades)

Second-generation merge. Combines three earlier tasks — a Check (diagnosed
why today's local classifier is inaccurate), a Research (proposed replacing
it with an LLM sidecar call), and a second Research (proposed backend
tool-calling for character/world/state info and actions) — into one
concrete plan, now also incorporating Developer's two rounds of feedback
(tiny-local-LLM idea, then bigger local models + a 3-way LLM mode split).
All original write-ups are preserved verbatim under `## Comments` below;
this section is the resulting plan, not a fourth summary of the same
ground.

## The problem

`suggestedActionsMode`'s `'ml'`/`'hybrid'` paths (local NER + zero-shot
classification, `backend/lib/nlp.js`) are measurably unreliable — live
testing found the beckon/step-back zero-shot calls false-firing on
plainly neutral text roughly half the time at the current threshold, and
NER confidence often at-or-below a coin flip even on correctly-identified
names. `'regex'` (the default) is reliable but only catches phrasing it
was explicitly written for. Neither gives good coverage of open-ended
intent, and neither can act on that intent even when detected — today's
tools only ever produce a suggestion chip, never a real app-state effect
(sending a text, scheduling something, moving a character).

## The fix

Two parallel branches, not a single linear path — Developer's latest
comment explicitly asked for this rather than one committed mechanism:

**Branch A — bigger local zero-shot/NER models.** Before assuming the fix
requires an LLM call at all, spot-check stronger local NLI/NER models
(BART-large-MNLI, DeBERTa-MNLI zero-shot; a better-tuned NER model than
bert-base-NER) against the same realistic dialogue lines the Check
investigation already used, measuring both accuracy and CPU latency. If
one of these clears the bar, it's a strictly cheaper fix than any LLM-based
mode (no network call, no API cost) and can ship as an upgrade to `'ml'`/
`'hybrid'` on its own, independent of Branch B.

**Branch B — a new `'llm'` mode** that asks an LLM (not a second local
classifier) to identify intents/new characters and, going forward,
actually act on them via tools. Concretely:

- A **second, fire-and-forget call** after the character's reply has
  already finished streaming (mirrors `maybeSendProactiveTexts`'s
  pattern) — not merged into the same completion as the reply, so the
  roleplay voice is never contaminated by meta-instructions and the SSE
  streaming parser doesn't need to detect "prose is done, sidecar begins"
  mid-stream.
- **Three model-source sub-options for this call**, per Developer's
  latest comment — `'llm'` mode is not one hardcoded path:
  1. **Same backend/model** — reuse `cfg.model`/`cfg.apiBase` as-is
     (simplest, default).
  2. **Different backend/model** — a separate model/endpoint config
     surface for this specific meta-task (e.g. pin a cheaper/faster model
     for the sidecar call while the main reply uses a bigger one).
  3. **Tiny local LLM on CPU** — an ONNX-exportable small instruct model
     (Qwen2.5-0.5B/1.5B-Instruct, Llama-3.2-1B-Instruct, SmolLM2, etc.),
     zero marginal cost and fully offline, following the same delivery
     pattern the app already uses for NER/zero-shot (`@huggingface/transformers`
     in `backend/lib/nlp.js`). Per the existing `claude` comment below,
     this needs an actual accuracy spot-check before being trusted, since
     the whole task exists because a different small local model turned
     out to be unreliable — "local" isn't automatically better or worse
     without testing.
- **Native tool-calling as the primary mechanism, prompt-based JSON as the
  fallback** — per the research comment below, tool/function-calling has
  broader endpoint support on OpenRouter than `response_format: json_schema`
  and lets the model pull only the context it actually needs instead of
  everything being front-loaded into the prompt. Still needs a lenient
  prompt-based-JSON fallback path for endpoints without tool-calling
  support, consistent with the app's "must work with any OpenAI-compatible
  endpoint" constraint.
- **Read tools**, folded in from the tool-calling research task, available
  to the sidecar call (whichever of the 3 model sources is active) so it
  can query on demand instead of everything being pre-stuffed into the
  prompt:
  - character info: name/nicknames/definition, relationships, schedule,
    matching memories (not all — only relevant ones)
  - world info: location name, area name, current day/time-of-day, list
    of locations, weather
- **Action types**: the existing plan's 7 (`destination`, `new-character`,
  `promote`, `demote`, `text-someone`, `call-to-scene`, `scheduled-text`)
  plus two more proposed by the tool-calling task — **move-to-location**
  and **invite-character-over** — with overlap against `destination`/
  `promote` to be resolved during implementation scoping (the tool-calling
  task explicitly invited "more appropriate actions" too; revisit whether
  any further types are worth adding once the tool surface is real).
- **Never trust an LLM-supplied id as a foreign key** — resolve
  name -> id server-side after the call returns (same convention as
  `nameAppearsIn` in `lib/suggestedActions.js`), revalidating against the
  real cast before use. This is also the main mitigation against a
  character's own (untrusted, possibly adversarial) generated text
  manipulating the sidecar call into fabricating actions.
- **`'llm'` is additive and off by default** — `'regex'`/`'ml'`/`'hybrid'`
  are untouched by Branch B. Whether to eventually deprecate `'ml'`/
  `'hybrid'` depends on how Branch A's spot-check comes out — a separate
  decision, not a blocker for shipping `'llm'`.

## Explicitly out of scope for this task

- The scheduled-text **firing loop** (checking "has world time reached
  day 2 evening yet?" and actually generating the text) — this task only
  covers detecting and storing the intent; the scheduler is unbuilt
  infrastructure and deserves its own task.
- Per-endpoint capability probing/caching for tool-calling/`response_format`
  support — v1 always uses the prompt-based fallback path uniformly where
  unsupported, per the research's own leaning (simpler, avoids
  doomed-request complexity).

## Sub-tasks

- [x] Branch A: spot-check BART-large-MNLI / DeBERTa-MNLI zero-shot and a
      stronger NER model against the Check investigation's realistic-line
      methodology; measure accuracy AND CPU latency; decide go/no-go on
      swapping `'ml'`/`'hybrid'`'s underlying models independent of Branch B
      — **done, result: no-go on both candidates as tested (see Comments)**
- [x] Branch B: add `'llm'` to `suggestedActionsMode`'s accepted values
      (`backend/server.js` DEFAULT_CONFIG, `publicConfig`, `POST
      /api/settings` validation) + a Settings UI option in
      `SuggestedActionsCard.vue` with the 3 model-source sub-options
      (same backend/model, different backend/model, tiny local LLM),
      default unchanged (`'regex'`) — **built, see Comments**
- [x] Tiny-local-LLM sub-option: accuracy spot-check a CPU-runnable small
      instruct model (Qwen2.5-0.5B/1.5B-Instruct or similar) on the same
      JSON-emission task before trusting it as a shipped option
      — **done for 0.5B, result: no-go as tested (see Comments); 1.5B not
      yet tried**
- [x] New sidecar-call module (`backend/lib/llmSuggestedActions.js`) —
      **grammar-constrained JSON, not native tool-calling** (deviates from
      this sub-task's original wording — see Comments for why), dispatching
      to whichever of the 3 model sources is configured
- [~] Read-tool implementations — **not built as callable tools**; simplified
      to prompt-stuffed context instead (known places/characters/background
      characters listed directly in the prompt). Reasonable for the cast
      sizes this app deals with; genuine on-demand tool-calling for
      character schedules/memories/relationships is still unbuilt if a
      world's cast grows large enough that prompt-stuffing gets expensive.
- [x] Action-tool schema — **7 types built** (`destination`, `new-character`,
      `promote`, `demote`, `text-someone`, `call-to-scene`, `scheduled-text`).
      `move-to-location`/`invite-character-over` were not added as separate
      types — resolved the noted overlap by folding them into
      `destination`/`call-to-scene` rather than adding two more. Per-item
      `try`/`catch` in `parseIntents` — one malformed intent doesn't drop
      the batch.
- [x] Server-side name -> id resolution + revalidation for every resolved
      target, against the real cast/place list passed in — never trusts a
      model-supplied id (there isn't one; targets are resolved by name only)
- [~] Sidecar call is **synchronous/awaited**, not fire-and-forget — a
      deliberate scope cut, see Comments for the tradeoff
- [x] Frontend: `SuggestionButton.vue` handles all 3 new types (`call-to-scene`
      reuses the existing move-character primitive; `text-someone` opens the
      target's phone thread when resolved to a real character; `scheduled-text`
      is informational-only, matching this task's own "firing loop is out of
      scope" decision). `SuggestionOverflowModal.vue`'s category grouping
      updated too (new "Messaging" category; `call-to-scene` joins
      "Conversation" alongside promote/demote).
- [x] Backend tests: `backend/test/llmSuggestedActions.test.js`, 25 tests
      covering `parseIntents`/`extractJsonLenient`/`buildIntentPrompt` —
      pure-logic unit tests, matching this app's own established convention
      of not exercising real models in the automated suite (same as
      `'ml'`/`'hybrid'` mode's own tests)
- [x] `npm test` (807/807) and `npm run build` both clean
- [x] Manual: verified end-to-end against the real cached Gemma4-E2B-QAT
      model by calling `detectViaBuiltinLlm` directly with a realistic
      multi-action scenario — correct multi-action extraction, correct
      real character-id resolution, correct day/time inference (see
      Comments for the actual output). Not yet manually tested through the
      live app UI (Settings toggle -> actual character turn) — that's the
      one item still worth doing before calling this fully verified.

## Comments

- author: investigation-agent
  date: 2026-08-05T14:52:20.772Z
  [Check task findings] Investigated end-to-end (`backend/lib/nlp.js`, `backend/lib/suggestedActions.js`, `backend/test/suggestedActions.test.js`, frontend settings). This was NOT a read-only-code-analysis exercise — the real model weights were already present in `backend/.cache/transformers/` (bert-base-NER and mobilebert-uncased-mnli), so live inference was run against both models with a scratch script exercising `extractEntities`/`classifyIntent` directly against ~20 realistic character-dialogue lines. No fixes were made; findings below are backed by that live evidence plus code reading.
  
  **Scope check first: most users are not actually exposed to this.** `suggestedActionsMode` defaults to `'regex'` both server-side (`server.js` `DEFAULT_CONFIG`) and in the frontend store, and the settings card requires an explicit opt-in to "ML only" or "Regex + ML". So the reported inaccuracy, if it's affecting the reporter, implies they've turned ML/hybrid on — worth confirming with them directly.
  
  **Live evidence — the zero-shot intent classifier is close to noise level at the current threshold.** `INTENT_THRESHOLD = 0.55` is explicitly flagged in the code as "picked by feel, not a benchmark," and testing bears that out. Running the actual 2-label calls production uses (`[INTENT_BECKON, INTENT_NONE]` and `[INTENT_STEP_BACK, INTENT_NONE]`) against plainly neutral, unrelated narration (e.g. "The market was crowded with vendors selling fruit and spices.", "He shrugged and said nothing, turning back to his book.") produced confident (0.60–0.88) false-fire scores on both intents roughly half the time — i.e. scores cluster densely around 0.5–0.9 regardless of whether the label actually applies, so 0.55 doesn't cleanly separate signal from noise for these two intents. By contrast, the 3-way destination call (`[INTENT_INVITE, INTENT_INTRODUCE, INTENT_NONE]`) behaved much better in testing — correctly ranked invite vs. introduce vs. neither on every example tried, including a deliberately ambiguous "you should meet Kestrel down there" line (correctly top-ranked INTRODUCE at 0.81). This suggests the 2-label-vs-"none of the above" framing used for beckon/step-back is specifically the weak point, not zero-shot classification in general — a generic single negative label seems to give MobileBERT-MNLI much less to discriminate against than a fuller label set does.
  
  **Live evidence — NER confidence is often low even on unambiguous names**, consistent with bert-base-NER being a general-English model not tuned for fictional/character-dialogue names: "Fenwick Oduya" scored 0.469, "Kestrel" 0.377, "Xhirzsyth" (deliberately invented) 0.52 — all correctly identified as PER, but with confidence around or below a coin flip, meaning any confidence-based filtering (there currently is none in `suggestedActions.js` — all PER hits are used regardless of score) is one likely place accuracy silently degrades.
  
  **Live evidence — NER false positive on non-human named entities.** "Fluffy the tavern cat curls up near the hearth" tagged "Fluffy" as PER (0.587), which would surface a spurious "add character" suggestion for an animal. Note: this is a different, milder issue than the historical wordpiece-fragmentation bug documented in `nlp.js`'s own comments (`ignore_labels: []` was added specifically to stop a rare-token "O" mistag from producing garbage like "Fffy" for "Fluffy") — that fix does appear to be working correctly; wordpiece aggregation reassembled multi-piece names correctly in every test case, including the invented "Xhirzsyth".
  
  **Model choice caveat (design-level, not newly discovered but confirmed relevant):** `ZERO_SHOT_MODEL_ID` is MobileBERT-MNLI, chosen per the code comment for CPU latency over accuracy. It is a materially weaker NLI model than e.g. BART-large-MNLI or DeBERTa-MNLI zero-shot variants commonly used for this task. The noisy beckon/step-back scores above are consistent with that tradeoff actually costing real accuracy, not just being a theoretical risk.
  
  **Test coverage gap.** All existing `'ml'`/`'hybrid'` tests in `suggestedActions.test.js` use fully deterministic fake `extractEntitiesFn`/`classifyIntentFn` stand-ins that assert `suggestedActions.js`'s own merge/threshold/exclusion logic — none of them exercise the real models' actual accuracy. That's a reasonable and deliberate choice for unit-test stability (documented inline: real-model fixtures "stop reproducing the moment the model updates"), but it also means there is currently no automated signal at all for the specific failure mode reported here (real-model accuracy drift), and this investigation is the first time the actual models were exercised end-to-end against realistic dialogue in this environment.
  
  **Confidence:** High confidence that the beckon/step-back 2-label zero-shot calls are unreliable at the current threshold (directly measured, reproducible). Medium confidence that this is the reporter's actual complaint, since it requires ML/hybrid mode to be enabled, which isn't the default. Lower confidence on how much the NER-confidence and Fluffy-style false-positive issues matter in practice, since they only affect a minority of messages containing unusual/non-human names.
  
  **Possible directions (not implemented — superseded by the plan above, kept for context):**
  - Confirm with the reporter whether they have `suggestedActionsMode` set to `ml`/`hybrid`, since `regex` (default) doesn't touch any of this.
  - Re-tune or raise `INTENT_THRESHOLD`, and/or calibrate it per-label-set (beckon/step-back 2-way calls may need a different threshold than the 3-way destination call) rather than one global constant.
  - Try adding a more semantically specific negative label instead of (or alongside) the generic "none of the above" for the beckon/step-back binary calls, since the 3-label destination call performed noticeably better in testing.
  - Consider a stronger zero-shot NLI base model (e.g. a distilled BART-MNLI or DeBERTa-MNLI ONNX export) and measure the CPU latency cost against the accuracy gain, given the current model was picked for speed rather than accuracy.
  - Add a minimum-confidence floor for NER PER/LOC hits used by `mlSuggestions` (currently any non-zero-confidence hit is used) to cut down on low-confidence guesses.
  - Add a small "golden set" integration test (skipped by default / opt-in, since it needs the real cached models) that runs `extractEntities`/`classifyIntent` against a fixed list of realistic lines and checks aggregate accuracy — to catch regressions from model or label-string changes, distinct from today's fully-mocked unit tests.
- author: research-agent
  date: 2026-08-05T14:52:08.463Z
  [Research task findings]
  
  #### 1. Structured-output support today
  
  **OpenRouter.** OpenRouter standardizes `response_format` across providers in two modes:
  - `json_object` — "output valid JSON" with no schema enforcement. Broad support, low risk.
  - `json_schema` (+ `strict: true`, `additionalProperties: false`) — schema-conformant output. Only works on "select models," and support varies **per provider endpoint serving that model**, not just per model — the docs explicitly warn the same model ID may be structured-output-capable on one backing provider and not another. If a request hits an unsupported endpoint, "the request will fail with an error indicating lack of support," and invalid schemas themselves also error. OpenRouter exposes `provider.require_parameters: true` to keep routing from ever landing on a non-conforming endpoint. Enforcement strength also varies: "some [providers] guarantee schema-conforming output, while others translate your schema into their own structured-output format or treat it as a strong hint" — so even a 200 response isn't a hard guarantee of schema validity everywhere. There's an optional "Response Healing" plugin for non-streaming requests that repairs near-miss JSON. `json_schema` + `stream: true` is supported together (streams valid partial JSON that resolves to the full schema).
  - Tool/function calling is a separate, more universally-supported mechanism (most modern models on OpenRouter support it even where `json_schema` isn't listed) and is commonly used as a structured-output workaround: define a single "emit_result" tool with a JSON-schema `parameters` block and force it via `tool_choice`. Worth evaluating as the primary mechanism instead of `response_format`, precisely because coverage is broader.
  - Net: nothing here is a blanket guarantee. Any implementation has to treat structured output as "ask nicely, then validate," not "trust the wire."
  
  **Generic OpenAI-spec endpoints (`cfg.apiBase`).** This app already supports arbitrary custom endpoints, which in practice cover self-hosted servers like llama.cpp's `llama-server`, Ollama's OpenAI-compat surface, vLLM, etc. These increasingly ship OpenAI-compatible `/chat/completions` with some combination of function calling and/or `response_format`, but version/build dependent — there's no way to assume it's there. Practical implication: **feature-detect, don't assume.** Two reasonable strategies, not mutually exclusive:
    (a) Try `response_format: json_schema` (or a forced tool call) first; on a 4xx that looks like "unsupported parameter" (OpenRouter is explicit about this; generic endpoints are less predictable — could be a generic 400, a 422, or the field just gets silently ignored and the model free-texts anyway), fall back to prompt-based JSON.
    (b) Always use prompt-based "emit a fenced JSON block matching this shape" instructions with a lenient parser (extract first balanced `{...}` or ```json fence, `JSON.parse`, then validate/sanitize field-by-field — never trust the values), and treat `response_format`/tool-calling as an *optional accuracy booster* layered on top when the endpoint advertises support, rather than a hard requirement. This is the safer default given the app's "must work with any OpenAI-compatible endpoint" constraint — it degrades gracefully everywhere instead of needing per-endpoint capability detection logic to avoid hard failures.
    Given today's `detectSuggestedActions` already tolerates total failure ("no suggestions" is not an error — see `lib/suggestedActions.js` header comment), (b)'s prompt-based approach with a forgiving parser fits the existing failure philosophy best: worst case, malformed/missing structured output just yields zero suggestions, same as today when the local model fails to load.
  
  #### 2. Architecture: separate call vs. combined with the reply
  
  **Where suggestion detection sits today matters:** `turnEntriesFrom` (`backend/server.js` ~3537) calls `detectSuggestedActions` *after* the reply text is already fully generated/streamed to the client (`generateCharacterTurn`, ~3569-3585) — suggestions get attached to the persisted turn entry, not blocked on by the visible SSE stream. This means a second LLM call for suggestions delays only *when the suggestion chips show up*, not the reply itself — a meaningfully smaller latency cost than it first sounds, since users already perceive the reply as "done" once streaming finishes and chips are a secondary/async UI element (`SuggestionButton.vue` renders standalone chips attached to an entry).
  
  **Option A — second call, after the reply (recommended default).**
  - Pros: keeps the primary reply prompt/character voice completely uncontaminated by meta-instructions (no risk of the model narrating "I am now calling my sister" because the prompt asked it to think about intents); can reuse the *same* text across multiple detectors without re-prompting the character; simpler to reason about/test in isolation (one call, one job); can be made conditional (skip entirely if `suggestedActionsMode !== 'llm'` or below some cheap heuristic pre-filter, e.g. only fire it when the regex layer's fast fixed patterns almost-hit, cutting a lot of avoidable calls).
  - Cons: real added cost — one extra OpenRouter call per reply, on the user's own token budget (small if the reply text + a short schema prompt uses a cheap/fast model, but non-zero, and doubles the round trips for the same conversational turn if unfiltered); a second point of failure/timeout risk under `LLM_TIMEOUT_MS`; if run serially, adds wall-clock delay before chips appear (mitigated by firing it fire-and-forget the same way `maybeSendProactiveTexts` already does, i.e. don't block the response).
  
  **Option B — combined single call (reply + structured sidecar in one completion).**
  - Pros: no extra network round trip or extra token cost for a second system+context prompt; one model call total.
  - Cons: couples two very different asks (in-character prose vs. a structured JSON meta-object) into one prompt, which risks (a) leaking meta-instructions into the roleplay voice, (b) breaking the streaming UX — the app streams reply text live via SSE for the visible-typing feel; a trailing JSON blob has to be excluded from what's shown to the user, i.e. the streaming parser now needs to reliably detect "prose is done, sidecar begins" mid-stream, which is a real parsing problem, especially if the model doesn't cleanly delimit the two; (c) forces every reply-generation call (the hot path, happens every turn) to carry the extra schema/instruction overhead even for messages where no suggestion signal would fire, unlike Option A which can be made conditional; (d) makes function/tool-calling as the structured mechanism awkward, since the reply itself isn't a tool call — you'd be stuck with prompt-based JSON-in-text for the sidecar specifically, forgoing OpenRouter's better-supported structured mechanisms.
  - On balance Option B saves cost/latency but at real risk to reply quality and streaming architecture; Option A costs more but is far more surgical and keeps blast radius contained to a feature that's explicitly allowed to degrade to "no suggestions." **Recommendation: Option A**, fired fire-and-forget after the stream completes (same pattern as `maybeSendProactiveTexts`), gated so it only runs when `suggestedActionsMode === 'llm'` (a new mode, not forced on everyone), and ideally using a cheap/fast model call (could reuse `cfg.model`, but a future enhancement could let a separate cheaper model be configured for this specific meta-task, similar to how OpenRouter provider preferences already exist in `cfg.providers`).
  
  #### 3. Proposed intent schema sketch (not implementation)
  
  Rough JSON shape the sidecar call would be asked to emit — one object per detected signal, array possibly empty:
  
  ```jsonc
  {
    "actions": [
      // Existing 4, reshaped for consistency:
      { "type": "destination", "placeName": "The Old Pier", "placeId": "known-place-id-or-null" },
      { "type": "new-character", "name": "Professor Halden" },
      { "type": "promote", "charId": "existing-background-char-id" },   // beckoned into scene
      { "type": "demote", "charId": "existing-speaker-id" },            // steps back
  
      // New:
      { "type": "text-someone",
        "targetKind": "character" | "persona" | "group" | "new-character",
        "targetId": "known-char-id-or-group-id-or-null",
        "targetName": "free-text name when targetKind is new-character or unresolved",
        "summary": "here's the details about the assignment from professor" },
  
      { "type": "call-to-scene",
        "targets": [ { "charId": "known-id" }, { "name": "free-text, not-yet-a-character" } ],
        "placeId": "scene this would happen at, usually currentPlaceId" },
  
      { "type": "scheduled-text",
        "charId": "speaker-id",
        "targetKind": "persona" | "character" | "group",
        "targetId": "...",
        "when": { "day": 2, "timeOfDay": "evening" },   // relative-to-absolute resolved using world.time, see below
        "reason": "free-text gist of what the text will be about"
      }
    ]
  }
  ```
  
  Notes on resolution, mirroring what `suggestedActions.js` already does for `new-character`:
  - **Name -> id resolution** should stay a two-tier affair the frontend already understands: if the model's `targetName`/`name` matches an existing character (case-insensitive, first-name-sufficient — same convention as `nameAppearsIn` in `lib/suggestedActions.js`), resolve `targetId` server-side after the call returns, rather than trusting the model to know internal ids (it shouldn't be given ids in the prompt it can't see, or if it is, ids should still be revalidated against the real cast before use — never trust an LLM-supplied id as an FK without a lookup). If no match, keep it as a free-text `new-character` candidate, exactly like today's "+ Add character" chip, and `text-someone`/`call-to-scene` targeting an unresolved name should logically first prompt "add this character" before "text them"/"call them over" makes sense as an action.
  - **`scheduled-text.when`** should reuse the world's existing `day`/`timeOfDay` time model (`world.time`, `TIMES_OF_DAY` enum already used by `character.schedule` — see `backend/server.js` ~297-330, ~1078-1102) rather than inventing a new time representation. The LLM would be asked to resolve relative phrases ("tonight", "in the morning") into that same `{ day, timeOfDay }` shape given the current world time in its prompt context — this is squarely a "let the LLM interpret relative time" problem, consistent with the rest of this proposal's premise. This is a genuinely new mechanism, not a rename of `lib/proactiveTexts.js`: `rollsProactiveText`/`maybeSendProactiveTexts` is a content-blind random dice roll fired on every user input, unrelated to anything actually said; a scheduled text is content-anchored (tied to a specific promise a character made) and time-anchored (tied to a specific future `day`/`timeOfDay`, not "eventually, maybe"). The actual firing mechanism (something has to check "has world time reached day 2 evening yet?" and then trigger a real reply generation through `generateProactiveText` or similar) is unbuilt infrastructure and probably deserves its own scoping task rather than folding into this one — this schema only proposes how the *intent* would be captured and stored, not the scheduler/trigger loop that consumes it.
  - **`call-to-scene`** is a fairly direct generalization of the existing `promote` action (beckon a *background* character in) to *any* known or new character, present or not — likely implementable as a superset that subsumes `promote` rather than a fully separate type, worth deciding during implementation scoping rather than here.
  
  #### 4. Migration / rollout thoughts
  
  - Adding `'llm'` as a fifth-ish value alongside `'regex' | 'hybrid' | 'ml'` in `suggestedActionsMode` (`backend/server.js` DEFAULT_CONFIG ~155, validated at ~564; UI in `frontend/src/components/settings/SuggestedActionsCard.vue`) is a clean, low-risk way to ship this — the existing modes are already fully swappable per the `detectSuggestedActions(text, { mode, ... })` signature, so `'llm'` is just another branch, not a rewrite of the dispatch logic in `lib/suggestedActions.js`.
  - If the Check findings above hold up (local ML mode isn't worth keeping), `'ml'`/`'hybrid'` could eventually be deprecated/removed in favor of `'regex'` (cheap fallback, zero network dependency) and `'llm'` (accurate but costs a call) as the two real choices — but that's a separate decision and shouldn't block shipping `'llm'` as an additive option first.
  - `'llm'` mode should probably be **off by default** (default stays `'regex'`) since it's the first mode in this app that spends the user's own API budget on a feature that isn't the visible reply — that's a meaningfully different cost profile than local ONNX inference and users should opt in knowingly, similar to how `textingChancePerChar` defaults to a small non-zero value rather than being silently expensive.
  - Test integration looks straightforward given `mockOpenRouterFetch` (`backend/test/routes.test.js` ~271) — it intercepts on URL match against `/chat/completions` regardless of call site, so a second sidecar call is mockable exactly like the existing reply-generation call; tests would need to mock two sequential fetches (reply, then sidecar) rather than one, which the existing harness already supports since each `mockOpenRouterFetch(handler)` call can inspect `opts.body` to distinguish which call is which.
  
  #### 5. Open questions / risks for implementation scoping
  
  - **Cost transparency**: should the sidecar call's token usage be surfaced to the user (it already tracks `usage`/`buildGenerationStats` for the main reply) so a chatty session's real double-call cost isn't hidden?
  - **Model choice for the sidecar call**: reuse `cfg.model` (simplest, consistent capability) vs. let power users pin a cheaper/faster model for this specific meta-task (more complexity, more config surface).
  - **Validation strictness**: how much should a malformed/partial JSON response degrade (drop the whole batch of suggestions vs. best-effort salvage per-action)? Given the "never an error, worst case zero suggestions" philosophy already established, probably lean toward per-action validation with `try/catch`-per-item rather than all-or-nothing.
  - **Prompt injection surface**: the sidecar prompt would need to include the character's own generated reply text as untrusted input to a second LLM call — worth a sanity check that a scene/character with malicious/adversarial content in play (e.g. a character intentionally roleplaying a prompt-injection attempt) can't manipulate the sidecar call into fabricating actions with attacker-chosen `targetId`s; server-side id revalidation (see schema notes above) is the main mitigation.
  - **`call-to-scene` vs. `promote` overlap**: decide during scoping whether these merge into one type or stay distinct action kinds with different frontend chip affordances.
  - **Scheduled-text firing loop is out of scope here**: this research only covers *detecting the intent*; a scheduler that periodically checks pending scheduled texts against current world time and actually fires `generateProactiveText`-equivalent generation is unbuilt and should be its own task.
  - **Endpoint capability detection**: does the app want to probe/cache "does this endpoint support `response_format`/tool calling" per configured endpoint (extra complexity, avoids doomed requests) or just always use the prompt-based fallback path uniformly for robustness (simpler, marginally less accurate on capable endpoints)? Leaning toward the latter for v1 given the app's single-file-config simplicity so far.
- author: Developer
  date: 2026-08-05T19:15:46.896Z
  As an alternative to another OpenRouter request/model, what about a tiny LLM that can run locally on the CPU? Since it'll just read the current world info and last message, and output a tiny JSON thing, a tiny local LLM could be good here.
- author: claude
  date: 2026-08-05T20:17:13.000Z
  **Reviewed against "Research: Tools for the backend toolcalling for character/location/state information" — recommend merging them, not keeping them separate.**
  
  They're two candidate *mechanisms* for the same underlying goal (a character's intent producing a real app-state effect — texting someone, scheduling something, moving/inviting a character), not two separate features:
  - This task's action schema (`text-someone`, `call-to-scene`, `scheduled-text`) is close to a 1:1 match with the other task's proposed "Character Action" tools (send text, set timed action, move location, invite character over).
  - The other task's proposed read tools (character info incl. nicknames/relationships/schedule/memories; world info incl. location/time/weather) fill a real gap in *this* plan too — right now the sidecar call's prompt has to front-load all of that context; native tool-calling would let the model query only what it actually needs, on demand, instead.
  - This task's own research comment above already flagged tool/function-calling as a candidate mechanism ("worth evaluating as the primary mechanism instead of response_format") — the two tasks aren't adjacent, one is a sharper version of the other's open mechanism question.
  
  Merging avoids two overlapping implementations (one sidecar-JSON, one full tool-calling) getting built independently and needing reconciling later.
  
  **On the tiny-local-LLM idea directly above:** worth taking seriously, not dismissing — this app already ships small ONNX models via `@huggingface/transformers` for NER/zero-shot (`backend/lib/nlp.js`), and small instruct models capable of decent JSON-following (Qwen2.5-0.5B/1.5B-Instruct, Llama-3.2-1B-Instruct, SmolLM2, etc.) are realistic CPU/ONNX candidates now. Zero marginal cost, no network round trip, fully offline.
  
  The real risk: **this task exists in the first place because the current local model (bert-base-NER + MobileBERT-zero-shot) turned out to be measurably inaccurate** (see the Check findings above — beckon/step-back near-noise-level, low NER confidence). A tiny local LLM is still a *small* model, and small models are generally worse at reliable JSON-schema-following than large ones — swapping one small, unreliable local model for a different small, local model risks recreating exactly the problem this whole effort started from, just with a different architecture.
  
  Recommend treating this as a genuine third mechanism option (alongside sidecar-remote-JSON and native-remote-tool-calling) — decided by an actual accuracy spot-check against realistic lines (same methodology the Check investigation already used) before committing, rather than assuming "local" is better or worse without testing, given local was the accuracy problem last time.
  
  **Bottom line:** this merged task should own the mechanism decision (sidecar remote call / native tool-calling / tiny local model — or a phased approach, e.g. ship the already-scoped sidecar version first and evaluate the other two as follow-ups) rather than three overlapping tasks each quietly assuming a different one.
- author: claude
  date: 2026-08-05T20:17:13.000Z
  [Originally posted on "Research: Tools for the backend toolcalling for character/location/state information" — kept here verbatim for provenance now that the two tasks are merged.] Reviewed alongside "Research: LLM-based intent/new-character detection mode (replaces unreliable local classifier)" — recommend merging into that task rather than keeping this separate. Your proposed Character Action tools (send text, set timed action, move location, invite character over) are close to a 1:1 match with that task's already-scoped action schema (`text-someone`, `call-to-scene`, `scheduled-text`), and your read tools (character/world info) solve a real gap in that task's current plan (front-loading everything into one prompt vs. letting the model query on demand). Full reasoning, plus an evaluation of a tiny-local-LLM alternative someone else proposed there, is on that task's own Comments. Recommend that task absorb this one and own the mechanism decision (sidecar prompt-JSON vs. native tool-calling vs. tiny local model) rather than three overlapping tasks each assuming a different one.
- author: Developer
  date: 2026-08-06T09:34:56.291Z
  Things to try in different branches:
  1) Bigger NER/NLP models, like BART-large-MNLI or DeBERTa-MNLI zero-shot
  2) LLM mode without removing the existing options. LLM mode should have the following options:
    - same backend / model
    - different backend / model
    - tiny local LLM that can run on the CPU.
- author: claude
  date: 2026-08-06T00:00:00.000Z
  Merged "Research: Tools for the backend toolcalling for character/location/state information" into this task per your request — its read/action tool proposals are now folded into `## The fix` and `## Sub-tasks` above (read tools for character/world info; two more action types, `move-to-location`/`invite-character-over`; native tool-calling promoted to the primary mechanism with prompt-based JSON as fallback), and its own `claude` comment is preserved above for provenance.
  
  Also incorporated your 2026-08-06 comment directly: split this into two explicit branches rather than one committed path. **Branch A** (bigger local zero-shot/NER models — BART-large-MNLI, DeBERTa-MNLI) is now its own sub-task, spot-checked with the same methodology the Check investigation used, independent of and not blocking Branch B. **Branch B** (`'llm'` mode) now explicitly has the 3 model-source sub-options you listed — same backend/model, different backend/model, tiny local LLM — rather than assuming one. This also folds in the tiny-local-LLM idea from your earlier comment as option 3 of Branch B specifically, instead of a separate standalone proposal, per my previous comment's recommendation to treat it as one candidate mechanism among several rather than a given.
  
  Kept the `Research:` title prefix rather than reverting to my earlier `Feature:` framing — this is still two open branches with real unknowns (does a bigger local model actually clear the bar? does the tiny local LLM hold up on a JSON-following spot-check?), not a fully-scoped build yet.
- author: claude
  date: 2026-08-06T00:00:03.000Z
  **Branch A spot-check: BART-large-MNLI and DeBERTa-v3-base-MNLI vs. the current MobileBERT-MNLI baseline. Result: no clean win — recommend not swapping `'ml'`/`'hybrid'`'s model on this evidence.**
  
  Methodology mirrors the original Check investigation: the exact production call shapes from `lib/suggestedActions.js` (2-label beckon `[BECKON, NONE]`, 2-label step-back `[STEP_BACK, NONE]`, 3-label destination `[INVITE, INTRODUCE, NONE]`, `THRESHOLD = 0.55`), run against a labeled 20-line set (7 beckon cases, 7 step-back cases, 6 destination cases — mix of true positives per intent and neutral narration that should fire nothing), scored for both correctness and latency. Models tested via `@huggingface/transformers` (Xenova ONNX ports, `dtype: 'q8'` for the two candidates — same int8-quantized tier the app already uses for MobileBERT, so latency stays comparable and the "favor CPU latency" constraint holds):
  
  | Model | Beckon | Step-back | Destination(3-way) | **Total** | Load time | Per-call latency |
  |---|---|---|---|---|---|---|
  | `Xenova/mobilebert-uncased-mnli` (current) | 4/7 | 4/7 | 6/6 | **14/20 (70%)** | 1.5s | ~20-30ms |
  | `Xenova/nli-deberta-v3-base` (candidate) | 6/7 | 3/7 | 5/6 | **14/20 (70%)** | 12.8s | ~40-70ms |
  | `Xenova/bart-large-mnli` (candidate) | 5/7 | 3/7 | 3/6 | **11/20 (55%)** | 6.5s | ~55-95ms |
  
  **DeBERTa-v3-base ties MobileBERT overall (70%) but doesn't fix the actual problem — it moves it.** Beckon improved a lot (4/7 -> 6/7, and the true positives now score 0.99+ instead of 0.94-0.98, a real confidence improvement), but step-back got *worse* (4/7 -> 3/7), with high-confidence false-fires on plainly neutral lines ("The market was crowded..." at 0.87, "He shrugged and said nothing..." at 0.76) that are worse than MobileBERT's false-fires on the same lines (0.55-0.6, i.e. barely over threshold). It also introduced one new destination false-positive that MobileBERT didn't have. Net: same overall accuracy, different unreliable label — not a fix.
  
  **BART-large-MNLI did worse across the board, including on the 3-way call that was previously solid.** 11/20 (55%), with destination accuracy collapsing from 6/6 to 3/6 — it now confuses "introduces a new character" with "invites the user to go to another place" on both introduce-cases, and adds a false-fire on a neutral line. Confidence scores were also uniformly flatter/lower (mostly 0.4-0.7, never above 0.7) versus the other two models' typical 0.9+ on real positives, suggesting either the q8 ONNX conversion is lossier for this larger model (quantization error plausibly compounds more on a bigger model — not verified, would need the fp32 version to isolate, a ~1.6GB download not attempted in this pass) or this label-phrasing style just doesn't suit BART's NLI training distribution as well as MobileBERT/DeBERTa's. Bigger is not automatically better here, and this result argues against assuming it would be without testing — which is exactly why this was spot-checked before committing to either candidate.
  
  **Recommendation:** don't swap `'ml'`/`'hybrid'`'s underlying model based on this pass. Neither candidate reliably solves the beckon/step-back unreliability the original Check investigation found — DeBERTa is a lateral move (different unreliable label, same overall score) and BART is a regression. Cheaper things worth trying before reaching for yet another model swap, per the original Check's own "possible directions" list: per-label-set threshold tuning (each label pair showed a different natural score band in this data), and/or a more specific negative label than generic "none of the above" for the beckon/step-back binary calls specifically (the one thing that stayed reliably strong across all three models was the 3-label destination call, which has a fuller label set to discriminate against — consistent with the original hypothesis that the 2-label "vs. none" framing itself is the weak point, not the model). This makes **Branch B (the `'llm'` mode) the more promising path to actually fixing this**, rather than Branch A being a cheap parallel win — Branch A's real value turned out to be ruling two candidates out with data instead of assuming either one "obviously" helps.
  
  Note for whoever picks up Branch B: this pass downloaded and cached `Xenova/nli-deberta-v3-base` (242MB) and `Xenova/bart-large-mnli` (395MB) into `backend/.cache/transformers/` (gitignored, ~640MB added, not committed) in case either is worth revisiting later (e.g. threshold-tuned, or with a different negative label) — safe to delete if reclaiming the disk space and not continuing down this branch.
- author: claude
  date: 2026-08-06T00:00:04.000Z
  **Branch B, tiny-local-LLM sub-option: spot-checked `onnx-community/Qwen2.5-0.5B-Instruct` (q8) on the actual JSON-emission task. Result: no-go as tested — 0.5B is not reliable enough for this, at least with plain zero-shot prompting.**
  
  Methodology: a system prompt describing the exact action schema from the research comment above (`text-someone`/`call-to-scene`/`scheduled-text`, JSON-only, no prose), 6 test cases (4 should produce a specific action type, 2 neutral lines should produce `{"actions":[]}`), scored on (a) did it even return parseable JSON, (b) did the action type(s) match expectation.
  
  **1/6 valid JSON. 0/6 correct action type(s).** Concretely, on CPU:
  - One response ignored the "JSON only" instruction entirely and wrote a paragraph of prose analyzing the line instead ("The spoken line appears to be from a story or narrative in which someone is giving advice on how to navigate through life...").
  - Several responses were superficially JSON-shaped but invalid/malformed — wrong top-level shape (a bare array instead of `{"actions":[...]}`), hallucinated fields not in the schema, `"day": "morning"` where an integer was specified, a `when` object with `"evening": "night"` as a stray extra key.
  - The one syntactically-valid response still got the action type wrong (fired `text-someone` on "The market was crowded with vendors selling fruit and spices," a neutral line that should have produced `{"actions":[]}`) and had the same malformed `when`-on-the-wrong-action-type issue.
  - Latency was also a real concern independent of accuracy: 2.7s–13.2s per call on CPU (vs. low-tens-of-ms for the zero-shot classifiers in the Branch A test above) — an order of magnitude slower, since this is autoregressive generation, not a single classification forward pass. "Fire-and-forget after the reply" tolerates more latency than a blocking call, but 13s for one suggestion-detection pass is still a lot to hide.
  
  This matches the accuracy-risk concern already raised earlier on this task (my 2026-08-05 comment above): a tiny local *LLM* is still a small model, and small models are generally worse at reliable JSON-schema-following than large ones — this is empirical confirmation, not just the theoretical risk. **Recommend against shipping the tiny-local-LLM option as a bare zero-shot prompt.** Not fully ruling it out — things not tried in this pass that could plausibly change the result: a larger tiny model (1.5B, per the sub-task's own suggested range), few-shot examples in the prompt instead of instructions alone, or constrained/grammar-based JSON decoding (transformers.js doesn't have a built-in grammar-constrained decoding API the way some other runtimes do, so this would need custom logit-masking work — a real added-complexity cost, not a quick add-on). As tested, though, this option is not shippable.
  
  Combined with Branch A's result above, both "avoid a full LLM call" paths (bigger local classifier, tiny local generator) came back negative on this pass. That leaves the other two `'llm'`-mode model-source options — same backend/model, different backend/model, both of which lean on an already-capable remote/configured model rather than a small local one — as the more likely to actually work; the sidecar module should probably default to and prioritize those two, with tiny-local-LLM revisited later only if someone wants to invest in the grammar-constrained-decoding route. Cached model: `onnx-community/Qwen2.5-0.5B-Instruct` (496MB, gitignored, not committed) — safe to delete if not continuing down this path.
- author: claude
  date: 2026-08-06T00:00:05.000Z
  **Per your ask to search before fully closing tiny-local-LLM: found and spot-checked a genuinely different, purpose-built candidate — Google's FunctionGemma-270M. Result: still no-go as tested, but for a more interesting/specific reason than the generic-instruct failure above.**
  
  Web search (results below) turned up a real, non-obvious candidate I didn't know about: **[FunctionGemma](https://ai.google.dev/gemma/docs/functiongemma)**, a Gemma-3-270M variant Google fine-tuned *specifically* for function calling (not general instruction-following) — smaller than the Qwen2.5-0.5B tested above (270M vs. 500M params), purpose-built for exactly this kind of "small model calls a tool" task, and with an official ONNX/transformers.js port (`onnx-community/functiongemma-270m-it-ONNX`). Google's own material reports fine-tuning improved their internal "Mobile Actions" eval from 58% to 85% — a meaningfully better starting point than a generic instruct model, worth taking seriously rather than assuming the Qwen result generalizes to every small model.
  
  Other candidates the search surfaced, for the record, but not spot-checked (either not ONNX/transformers.js-compatible for this app's CPU/Node stack, or not obviously stronger than FunctionGemma for this specific task): Mistral NeMo, Nemotron-mini (4B, too big for "tiny"), Phi-4-mini (3.8B, also on the larger side but has real ONNX + native JSON function-calling support if a bigger local option is ever wanted), SmolLM3-3B (native tool-calling, Apache 2.0).
  
  **Spot-check**: same 6 cases as the Qwen test above, but using FunctionGemma's actual native tool-calling format (not freeform JSON-in-prompt) — an `AutoTokenizer`/`AutoModelForCausalLM` pipeline with a proper `tools` array (OpenAI-style function-schema JSON) passed to `apply_chat_template()`, matching how the model was actually trained per its own docs.
  
  First pass mis-scored as 0/6 "parse errors" — turned out to be a bug in my own test harness, not the model: FunctionGemma's output isn't JSON inside its `<start_function_call>`/`<end_function_call>` tokens, it's a custom `call:functionName{key:<escape>value<escape>,...}` serialization that a plain `JSON.parse` chokes on. Wrote a matching parser for that format and re-scored the same captured outputs:
  
  - **It called `scheduled_text` for all 6 cases, with zero variation** — including the 2 cases that should have called `call_to_scene`/`text_someone` instead, and both neutral lines that should have produced no call at all. 2/4 positive cases "matched" only because `scheduled_text` happened to be one of the two acceptable answers for those specific lines — not because the model discriminated between the three tools.
  - **Both neutral lines produced a false-positive call** ("The market was crowded...", "He shrugged and said nothing..." — the same two lines used in the Branch A false-positive tests above), each with a garbled/repetitive `reason` field suggesting real generation instability at this size, not just a wrong-but-coherent guess.
  - **`targetName` was the speaking character's own name in all 6 cases, never the actual addressee** — e.g. for "I'll text my sister Elin about this later tonight," `targetName` came back `"Mara"` (the speaker) instead of `"Elin"` (the person actually being texted). This is a consistent, 6-for-6 speaker/target entity-binding failure, not occasional noise — the model appears to default to "whoever is speaking" rather than parsing who the line is actually about.
  - Requiring the target entity to also be correct (not just the function name): **0/6.**
  
  This reads less like "the model doesn't understand function calling" (the output format itself is well-formed and consistent — it reliably emits *a* function call in valid-for-its-own-schema syntax) and more like "270M zero-shot is too small to do multi-entity disambiguation reliably on this app's specific task," which lines up with Google's own framing of FunctionGemma as "a strong base for further training," not a zero-shot-ready product — their quoted 58%->85% jump was specifically *after* task-specific fine-tuning, and this app has done none. **Still no-go as a zero-shot/prompted option**, but the door isn't fully shut: if `'llm'` mode's tiny-local-LLM option is ever revisited, fine-tuning FunctionGemma-270M on a handful of this app's own examples (not full training — the model card frames it as cheap to adapt) is a more promising next experiment than trying yet another off-the-shelf model zero-shot.
  
  Cached model: `onnx-community/functiongemma-270m-it-ONNX` (784MB at q4 — larger than expected going in, likely due to Gemma's large 256k-token vocabulary/embedding table not shrinking much under quantization; gitignored, not committed). Combined with the two Branch A models and Qwen above, this pass added ~1.9GB total to `backend/.cache/transformers/` (now 2.6GB) — worth a cleanup pass (`rm -rf backend/.cache/transformers/{onnx-community,Xenova/nli-deberta-v3-base,Xenova/bart-large-mnli}`) if none of these get revisited.
  
  Sources: [FunctionGemma model overview](https://ai.google.dev/gemma/docs/functiongemma), [google/functiongemma-270m-it on Hugging Face](https://huggingface.co/google/functiongemma-270m-it), [onnx-community/functiongemma-270m-it-ONNX](https://huggingface.co/onnx-community/functiongemma-270m-it-ONNX), [From Gemma 3 270M to FunctionGemma (MarkTechPost)](https://www.marktechpost.com/2025/12/26/from-gemma-3-270m-to-functiongemma-how-google-ai-built-a-compact-function-calling-specialist-for-edge-workloads/), [Phi-4-mini function calling](https://github.com/microsoft/PhiCookBook/blob/main/md/02.Application/07.FunctionCalling/Phi4/FunctionCallingBasic/README.md), [SmolLM3-3B overview](https://tinyweights.dev/posts/smollm3-3b-the-fully-ope/).

- author: claude
  date: 2026-08-06T00:00:06.000Z
  **Branch B, tiny-local-LLM: spot-checked node-llama-cpp's GBNF-grammar-constrained function calling against two Developer-supplied candidates. Result: still no-go, but a third and different failure mode — the constrained-decoding mechanism never actually activates for either model.**
  
  Context: you asked whether [dottxt-ai/outlines](https://github.com/dottxt-ai/outlines) (Python, grammar/JSON-schema-constrained decoding via HF Transformers/llama.cpp/vLLM backends — no ONNX support, doesn't fit this app's in-process transformers.js architecture without adding a whole Python runtime) could help. It's the right *technique* for half the problem — it guarantees output shape, not correctness — but the Node-native equivalent for this app's stack is [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (GBNF grammar + native function-calling, runs quantized GGUF on CPU). You then supplied two candidate GGUF models to try it against: `Andycurrent/Qwen3-0.6B-heretic-abliterated-uncensored-GGUF` and `mradermacher/Qwen3-1.7B-uncensored-i1-GGUF`.
  
  Tested in an isolated git worktree/branch (`experiment/node-llama-cpp-slm-spotcheck`, sibling directory `../freeroam-slm-experiment`) rather than the main tree, since this meant installing a brand-new dependency (`node-llama-cpp`, native bindings) purely to spike the idea — not something to land in `package.json` until/unless this path is actually chosen. Same 6 test cases, same 3 tool schemas (`text_someone`/`call_to_scene`/`scheduled_text`) as the FunctionGemma spot-check above, this time via node-llama-cpp's real `defineChatSessionFunction` API (Q4 quantized GGUF, `Q4_k_m` for the 0.6B, `i1-Q4_K_M` for the 1.7B).
  
  **Both models: 0/4 on the positive cases, 2/6 overall (both "wins" are the two neutral lines correctly producing no call — which is worth nothing here, since neither model called *any* function on *any* of the 6 cases, so "correctly calling nothing" happened by never calling anything at all).**
  
  Diagnosed why, rather than leaving it as an unexplained failure: node-llama-cpp auto-selected `QwenChatWrapper` for both models — the correct, purpose-built wrapper whose grammar is keyed on Qwen's native `<tool_call>`/`</tool_call>` special tokens, confirmed by inspecting `session.chatWrapper` directly. So the constrained-decoding setup itself was right, not a config/wrapper-detection mistake on my end. The actual problem: **neither model ever emitted the `<tool_call>` token to enter that grammar branch in the first place.** Grammar constraints only take effect once generation is inside the constrained branch — they can force *what* gets generated there, but can't force the model to *choose* that branch over plain text. Both models instead free-generated plain text that loosely imitates the JSON tool-call shape from memory (e.g. a raw `{"name": "text_someone", "` fragment, or literally the words `{"name": "none", "arguments": {}}` as assistant prose) rather than triggering the actual mechanism.
  
  Most likely explanation: these are community "heretic-abliterated"/"uncensored" fine-tunes of Qwen3, not the stock Qwen3-Instruct checkpoints. Refusal-direction ablation and further uncensoring fine-tuning target removing safety refusals, not preserving every other instruction-tuned behavior — native tool-calling is a specific learned association (a special token the base model was trained to emit in the right context) that this kind of fine-tuning has no reason to protect, and plausibly degrades as a side effect. This isn't a knock against the technique (GBNF-grammar function calling) or against small models in general — it's specific to *these* particular fine-tunes.
  
  **Recommendation:** if the tiny-local-LLM option is revisited, retest node-llama-cpp + GBNF grammar against the **stock Qwen3-Instruct** checkpoint (0.6B or 1.7B, not an abliterated/uncensored variant) before concluding the technique itself doesn't work — this test showed the infrastructure (wrapper detection, grammar setup) is sound, it's these two specific models that don't reliably trigger it. That would also be a fairer comparison against FunctionGemma-270M above, which — unlike these two — DID reliably engage its function-calling format; its problem was semantic (wrong function, wrong target entity), a level further than these two models even got to.
  
  Cleanup: the experiment lives in `../freeroam-slm-experiment` (worktree) on branch `experiment/node-llama-cpp-slm-spotcheck`, not merged/pushed — kept around in case it's worth continuing (e.g. retesting against stock Qwen3-Instruct) rather than torn down immediately. Downloaded there: `Qwen3-0.6B-heretic-abliterated-uncensored_Q4_k_m.gguf` (397MB) and `Qwen3-1.7B-uncensored.i1-Q4_K_M.gguf` (1.1GB), plus `node_modules` from the `node-llama-cpp` install — all inside that separate worktree directory, none of it touches the main working tree or `backend/.cache/transformers/`.

- author: claude
  date: 2026-08-06T00:00:07.000Z
  **Correction + major update to the previous node-llama-cpp comment: the "mechanism never engages" conclusion was wrong — it was a bug in my own test script (`maxTokens` too low for Qwen3's thinking-mode overhead), not a real finding about the models. Retested properly, and the corrected results are the best of this entire investigation.**
  
  What happened: Qwen3 models generate an internal `<think>...</think>` reasoning block by default before any actual answer or tool call. My harness capped generation at `maxTokens: 200`/`256`, which was consumed entirely by that thinking preamble on most cases — so every Qwen3 test so far (both abliterated models in the previous comment, plus initial stock-model reruns) was cut off before generation ever reached a `<tool_call>` decision point. That produced a uniform, misleading "0/4 on positive cases, mechanism never activates" result across every Qwen3 variant regardless of model quality, which I then over-interpreted as being specifically about abliteration. Caught this by testing with `maxTokens: 600` on a single case and watching a real tool call fire correctly. Fixed the harness to `maxTokens: 700` and reran everything properly — one model at a time this time (running two node-llama-cpp model loads concurrently exceeded available VRAM and had to be stopped mid-run; noted for any future local-model testing in this environment: **never load more than one GGUF model at a time here**).
  
  You separately asked (1) to try the official, non-abliterated Qwen models, and (2) how realistic Gemma4-E2B-QAT is. Tested both, alongside a clean rerun of the abliterated 0.6B for a fair same-token-budget comparison:
  
  | Model | Any-match | Real `<tool_call>` engagement |
  |---|---|---|
  | Stock `Qwen/Qwen3-0.6B` (bartowski GGUF, Q4_K_M) | 3/6 | Mixed — fires correctly some of the time, stays in free-text prose other times |
  | **Stock `Qwen/Qwen3-1.7B` (bartowski GGUF, Q4_K_M)** | **5/6** | **Reliable — correct function + correct target entity on every real call** |
  | `Andycurrent/…heretic-abliterated-uncensored` 0.6B (rerun, clean) | 2/6 | **Never** — 0/6 real calls; consistently free-texts a JSON-shaped guess instead, even though that guess is often semantically reasonable |
  | **`google/gemma-4-E2B-it-qat-q4_0-gguf` (official, QAT)** | **4/6** | **Reliable — correct function + correct target entity on every real call** |
  
  **This now actually supports the abliteration theory from my previous comment, with clean data instead of a bugged test:** at the identical, correct token budget, stock Qwen3-0.6B sometimes triggers real grammar-constrained tool calls while the abliterated 0.6B never does — same size, same architecture, same harness, only the fine-tuning differs. Abliteration/uncensoring fine-tuning appears to specifically suppress the model's tendency to emit the `<tool_call>` trigger token, without necessarily destroying its underlying understanding of the task (its leaked free-text guesses were often the right function + right target).
  
  **Stock Qwen3-1.7B is the best result of this whole investigation** — 5/6, and every real tool call it made had the correct target entity, not the speaker (the entity-binding bug that broke FunctionGemma-270M completely). At 1.7B/Q4_K_M (~1.28GB on disk) this is a genuinely small, realistic local model.
  
  **On "how realistic is Gemma4-E2B-QAT": very.** It's Google's official QAT-trained checkpoint (`google/gemma-4-E2B-it-qat-q4_0-gguf`), 2.3B effective parameters (5.1B raw, reduced via Per-Layer-Embedding caching — the "E" in E2B), explicitly designed to run on-device including phones, with native function-calling support baked into training. node-llama-cpp auto-detected a purpose-built `Gemma4ChatWrapper` for it (unlike Qwen3, no thinking-mode token tax to work around). It scored 4/6 with reliable engagement and correct entity binding — second only to stock Qwen3-1.7B. The official `q4_0` GGUF is 3.35GB on disk (larger than the ~1.1GB "mobile-optimized" figure quoted in Google's own marketing, which refers to a more aggressively compressed mobile-specific format, not this standard GGUF quant) — still a real, runnable local footprint, just worth knowing which number is which.
  
  **Both "misses" in every decent model's results (Qwen3-1.7B, Gemma4-E2B, and Gemma4's near-misses) were the exact same two test cases** — "Let me text you the address" and "I'll send you a message tomorrow morning," both of which never name an actual recipient (just "you"). That's very likely a **flaw in this experiment's simplified 3-tool test schema**, not a real model failure: unlike the full production schema sketched earlier on this task (which includes `targetKind: "persona"` specifically for "text the user/persona"), this test's tool definitions only accepted a `targetName` string, giving models no valid way to express "the person I'm talking to" without inventing a name. Worth fixing in any follow-up test — this may be undercounting real capability by 1-2 cases across the board.
  
  **Updated recommendation:** stock Qwen3-1.7B and Gemma4-E2B-QAT are both genuinely promising local candidates for the tiny-local-LLM `'llm'`-mode option — a real reversal from the earlier "no-go" verdict, which was built on a buggy test. If this gets picked up for real implementation, start with stock Qwen3-1.7B (best score, small footprint) or Gemma4-E2B-QAT (official on-device-optimized release, still solid), both via node-llama-cpp's native GBNF-grammar function calling — not the abliterated/uncensored variants, and not the transformers.js/ONNX path tested earlier (Qwen2.5-0.5B-Instruct, FunctionGemma-270M), which lacks constrained decoding entirely. Re-run with a corrected test schema (add `targetKind`/persona support) before trusting the exact scores further.
  
  Remaining untested for full symmetry: abliterated Qwen3-1.7B (would complete the abliteration comparison at the larger size) — not done yet, straightforward to add if useful. Models live in `../freeroam-slm-experiment/backend/models/`: `Qwen_Qwen3-0.6B-Q4_K_M.gguf` (484MB), `Qwen_Qwen3-1.7B-Q4_K_M.gguf` (1.28GB), `gemma-4-E2B-it-qat-q4_0.gguf` (3.35GB), plus the two abliterated models from the previous comment — none committed, all in the gitignored worktree.
- author: claude
  date: 2026-08-06T00:00:08.000Z
  **Fixed the test-schema flaw flagged above (no `targetKind: "persona"` option) and reran stock Qwen3-1.7B and Gemma4-E2B-QAT. Both now score 5/6 — tied for the best result of the whole investigation.**
  
  Added `targetKind: "character" | "persona" | "group"` to the `text_someone`/`scheduled_text` tool schemas (matching the real production schema sketched earlier on this task), so a model addressing "you"/the reader with no name given has a valid way to say that instead of being forced to either invent a name or skip the call entirely. Ran strictly one model at a time this round (see the concurrent-load note above — running two node-llama-cpp loads in parallel exceeded this machine's VRAM and had to be manually stopped mid-run last time).
  
  - **Stock Qwen3-1.7B: still 5/6**, but qualitatively better — the case that previously "succeeded" by wrongly naming the speaker as the target (`targetName: "Priya"`) now correctly fires `{"targetKind":"persona","targetName":""}`, no invented name. The other miss (case 3, "text you the address") still doesn't fire at all.
  - **Gemma4-E2B-QAT: improved 4/6 -> 5/6** — case 3 now fires correctly (`targetKind: "persona"`, `targetName: "you"` — a harmless literal echo rather than a hallucinated third-party name). Its remaining miss flipped to the other ambiguous case (case 6, "send you a message tomorrow") — no call fired there.
  
  Net: the two models are now genuinely tied, 5/6 apiece, each with correct entity/persona binding on every real call it made — they just miss on opposite halves of the same underlying "no explicit target name" case pattern, which is a smaller and more forgivable gap than anything seen from any other model/mechanism tested this whole investigation (transformers.js Qwen2.5-0.5B-Instruct, FunctionGemma-270M, or either abliterated Qwen3 variant). Both remain the two strongest tiny-local-LLM candidates if this branch gets built.

- author: claude
  date: 2026-08-06T00:00:09.000Z
  **Final test: expanded to all 7 intent types this task has ever scoped for LLM mode (not just the 3 new ones) — the 4 already-live-via-regex/ml/hybrid actions (`destination`, `new_character`, `promote`, `demote`) plus the 3 already-spot-checked new ones (`text_someone`, `call_to_scene`, `scheduled_text`). 16 test cases (2 positive per intent + 4 neutral), same node-llama-cpp native grammar-constrained function calling, run one model at a time against the two tied-best candidates.**
  
  | Model | Any-match | Fully correct (function + entity/targetKind) |
  |---|---|---|
  | Stock `Qwen/Qwen3-1.7B` | 11/16 (69%) | 11/16 |
  | **`google/gemma-4-E2B-it-qat-q4_0-gguf`** | **15/16 (94%)** | **15/16** |
  
  **Gemma4-E2B-QAT is the clear winner once the full intent set is in play — the best result of this entire investigation by a wide margin.** Every call it made was correct: right function, right entity, no invented names, no speaker/target confusion, clean single calls (no duplicates). It correctly stayed silent on all 4 neutral lines too. Its one miss (`new_character` on "You should meet Bram down there, he knows everything about the docks") produced no call at all rather than a wrong one — a silent miss, not a wrong guess.
  
  **Stock Qwen3-1.7B held up worse than its earlier narrow-test score suggested** (5/6 -> 11/16, i.e. 83% -> 69%) — with more tools available it missed `call_to_scene` entirely this round (no call, despite nailing it in every earlier run), missed `promote` on one case, and misclassified "You should meet Bram down there" as `text_someone` instead of `new_character` (an understandable confusion — "meet" reads similarly to both "introduce" and "text," but it's still a miss). It also reliably double-fired several calls (`destination`, `promote`, `demote` each called twice with identical arguments) — harmless for correctness scoring here, but a real behavioral quirk worth knowing about (Qwen3's thinking-mode + tool-call loop seems to sometimes re-emit a call after the handler returns, unlike Gemma4 which never did this).
  
  **Bottom line for this research task:** if the tiny-local-LLM `'llm'`-mode option gets built, **Gemma4-E2B-QAT (`google/gemma-4-E2B-it-qat-q4_0-gguf`) is the clear pick** over both Qwen3 candidates and every other model tested this investigation — official Google release, QAT-trained, native function-calling, 94% on a realistic 16-case test spanning the full intent surface, no observed entity-binding or speaker-confusion errors anywhere in this run. Stock Qwen3-1.7B remains a reasonable second choice (smaller footprint, ~1.28GB vs. Gemma4's 3.35GB) if disk/memory budget is the deciding factor over accuracy.

- author: claude
  date: 2026-08-06T00:00:10.000Z
  **You correctly flagged that every test so far was unrealistic — an isolated line with a fabricated one-line "context" string, not what the sidecar call actually sees in production (the persona's preceding message, plus a reply that can legitimately imply more than one action). Built a proper multi-turn test using your exact scenario plus two variations, and it materially changes the picture: multi-action extraction is a real, separate weak point neither top candidate handled well by default.**
  
  Scenario: persona says "Can you text me that spreadsheet this evening? Also let Wren know too," character replies "Sure, I'll send the stuff tonight — texting Wren now." — correct behavior is TWO calls: an immediate `text_someone` to Wren, and a `scheduled_text` back to the persona for this evening. Two more variations (reordered clauses; a single-action edge case) added for coverage. Same 7-tool setup as the full test, prompt now includes both turns instead of one isolated line.
  
  **With the same system prompt style used everywhere else on this task: 0/3 scenarios fully correct, for both models.** Both consistently caught only ONE of the two implied actions (almost always the immediate one — "texting Wren now" — never the scheduled one in the same reply), and both completely whiffed the reversed-clause variation (zero calls at all). This is a real, distinct failure mode from anything the single-line tests surfaced — the model reliably resolves a single implied action per reply but doesn't naturally check "are there more."
  
  **Confirmed this is a prompting gap, not a hard architectural limit**, before writing it off: node-llama-cpp's function-calling loop does support multiple sequential calls per turn (continues generating after a handler returns, so a second call is architecturally possible) — the model just wasn't being told to look for more than one. Strengthened the system prompt to explicitly say to count distinct actionable items in the reply first, then call one function per item, and reran:
  
  - **Gemma4-E2B-QAT**: scenario 1 now fires both calls (up from one), but the scheduled one came back `targetKind: "character", targetName: "Jordan"` instead of `targetKind: "persona"`. Scenario 2 (reordered variant): now fully correct, both calls right. Scenario 3: still misses the scheduled half.
  - **Stock Qwen3-1.7B**: scenario 1 now fully correct (both calls, right targetKind). Scenario 2: still a complete miss, zero calls. Scenario 3: fired, but mislabeled the persona as `targetKind: "character", targetName: "Ash"`.
  
  Neither model is clearly ahead here — each gets exactly one of the three scenarios fully right and struggles differently on the others. This is a meaningfully weaker showing than the single-line tests' 94%/69%, and confirms your instinct: isolated-line accuracy was overstating how ready either model is for the real multi-turn, multi-action shape of this problem.
  
  **A concrete, actionable design lesson surfaced by this test**: both models' `targetKind` mistakes (labeling the persona as a named "character" instead of "persona") only happened in scenarios where the persona's actual name ("Jordan," "Ash") was visible in the prompt. In the earlier single-line tests, the persona was never named — only referred to as "you" — and `targetKind: "persona"` resolution was reliable there. **The sidecar prompt should probably never expose the persona's literal name**, referring to them only as "the persona"/"you," specifically to avoid inviting the model to treat them as just another named character. Worth carrying into any real implementation.
  
  Also worth flagging as a schema gap rather than a model failure: scenario 3 ("I'll text you the second I'm through the door") doesn't map cleanly onto the `scheduled_text` schema's `day`+`timeOfDay` shape — it's an event-triggered promise ("the moment X happens"), not a scheduled day/time. Both models treated it as an immediate action instead, which is a defensible reading given the schema only offers day/timeOfDay as the "later" option. A real implementation may want a third temporal shape for "as soon as X" promises, distinct from both "right now" and "at a specific future day/time."
  
  **Updated bottom line**: single-action, single-line accuracy (the 15/16 and 11/16 results) is real, but multi-action extraction from realistic multi-turn context needs real prompt engineering (the "count distinct actions first" instruction) to get anywhere close to reliable, and even then neither model is close to solid yet — this is the actual hard part of the `'llm'`-mode sidecar, more than model choice. Any real implementation should test against multi-action scenarios like these as a first-class part of its own validation, not just single-action lines.

- author: claude
  date: 2026-08-06T00:00:11.000Z
  **You asked whether plain JSON intent-classification (not tool-calling) would work better, and — as a fallback — whether combining LLM output with the existing NER/zero-shot classifiers might help if neither works alone. Tested the JSON approach properly; it turned out to fully solve the problem for one candidate, so the NER-hybrid fallback wasn't needed.**
  
  Switched from node-llama-cpp's function-calling API to `llama.createGrammarForJsonSchema()` + `session.prompt(prompt, { grammar })` — grammar-constrained plain JSON generation, no `<tool_call>` trigger token to rely on, no function-calling ceremony. Schema: `{ intents: [{ type, from, to, when, timeOfDay }] }`, simpler than the tool-calling params. Same 3 realistic multi-turn scenarios as the previous comment.
  
  **First pass (bare enum, no per-type explanation): mixed, not a clean win.** Gemma4-E2B-QAT got close on scenario 1 (found both intents, every field right except the type label itself — `"text-someone"` instead of `"scheduled-text"` for the delayed one) but confused `call-to-scene` with texting on scenario 2, and both models still leaked the persona's real name into `to` despite an explicit "always write persona, never their real name" instruction.
  
  **Root causes, both fixed:**
  1. The JSON schema's bare `type` enum carries no per-value explanation the way `defineChatSessionFunction`'s individual `description` fields did — added explicit meanings for all 7 types to the system prompt (what distinguishes `text-someone`/now from `scheduled-text`/later from `call-to-scene`/in-person, etc.).
  2. Telling the model to ignore a name it can see wasn't reliable — so instead of showing the persona's real name and instructing the model not to use it, **the persona's name is now never shown in the prompt at all** (referred to only as "the persona"). Can't leak what it never sees.
  
  **With both fixes: Gemma4-E2B-QAT — 3/3, every field correct in every scenario**, and meaningfully faster than the tool-calling approach too (1.2-1.8s/case vs. 3-6s — no handler-execution loop overhead, just one constrained generation pass). This is a clean, complete result — the best of the entire investigation, full stop.
  
  **Stock Qwen3-1.7B — 0/3 with the identical fixed setup, but for a narrower, more specific reason than anything seen before**: entity resolution (`from`/`to`) is now perfect in all 3 scenarios, but it consistently fails to distinguish "now" from "later" for texting — it defaults to `type: "text-someone", when: "now"` even when the reply explicitly says "tonight" or "this afternoon," across every scenario tested. A real, consistent blind spot, not random noise.
  
  **Conclusion: plain grammar-constrained JSON classification, not native tool-calling, is the better mechanism for this app's sidecar call** — it sidesteps the model's own (unreliable) decision to trigger a tool-call token, is faster, and once properly prompted (per-type semantic descriptions; never exposing the persona's real name), it's fully reliable for Gemma4-E2B-QAT on every scenario tested. **Gemma4-E2B-QAT is the clear, decisive winner of this whole investigation** — Qwen3-1.7B is not competitive with it once this refinement is applied. The NER/zero-shot-classifier hybrid-fallback idea wasn't pursued since the JSON approach alone reached a clean 3/3 — worth revisiting only if a future, larger test set finds cases this approach still misses.
  
  **For whoever implements this for real**: use grammar-constrained JSON output (matching the schema style tested here), not native function-calling; give every intent type an explicit one-line meaning in the prompt, don't rely on a bare enum; and never surface the persona's real name in the sidecar prompt, refer to them only as "the persona."

- author: claude
  date: 2026-08-06T00:00:12.000Z
  **Built the real `'llm'` mode, per your ask — in the same isolated fork/worktree as all the model testing (`../freeroam-slm-experiment`, branch `experiment/node-llama-cpp-slm-spotcheck`), not main. `npm test` (807/807) and `npm run build` both clean; verified end-to-end against the real cached Gemma4-E2B-QAT model.**
  
  **What's new:**
  - `backend/lib/llmSuggestedActions.js` — the sidecar module. Exports pure, independently-tested functions (`buildIntentPrompt`, `parseIntents`, `extractJsonLenient`) plus `detectViaBuiltinLlm` (the local node-llama-cpp path).
  - `suggestedActionsMode: 'llm'` + `suggestedActionsLlmSource: 'builtin' | 'same' | 'custom'` in config, `POST /api/settings` validation, and `publicConfig` (custom key masked as `hasCustomLlmKey`, same convention as the main `apiKey`/`hasKey`).
  - `SuggestedActionsCard.vue` — mode dropdown gets an "LLM" option; picking it reveals the 3-way source picker plus custom endpoint/model/key fields when "Custom" is chosen.
  - `SuggestionButton.vue` + `SuggestionOverflowModal.vue` — chips for all 3 new types, folded into the existing suggestion-chip system (no new rendering pathway).
  - `backend/test/llmSuggestedActions.test.js` — 25 new tests.
  
  **Mechanism: grammar-constrained JSON, not native tool-calling — a deliberate deviation from this task's original plan.** The plan (written before the research ran) assumed native tool-calling as the primary mechanism. The research that followed found the opposite: `llama.createGrammarForJsonSchema` + plain JSON was more reliable AND faster than `defineChatSessionFunction`-based tool-calling for this exact task (see the two node-llama-cpp comments above) — tool-calling depends on the model choosing to emit a `<tool_call>` trigger token, which was unreliable even for the best-performing models, while grammar-constrained JSON generation is valid from the first token, no trigger-token gamble. Built on what the research actually found, not the original plan's guess.
  
  **The persona's real name is never included in the sidecar prompt** — referred to only as "the persona." This was the single highest-impact finding from the multi-turn testing (your feedback about unrealistic tests): showing the name and instructing the model to ignore it was unreliable; omitting it entirely was 100% reliable across every test after that fix. Baked directly into `buildIntentPrompt`, with its own dedicated test asserting the name never appears in either prompt string.
  
  **Two scope cuts, both deliberate, both worth flagging:**
  1. **Synchronous, not fire-and-forget.** The original plan called for firing the sidecar call after the reply stream completes (mirroring `maybeSendProactiveTexts`). This build keeps it synchronous/awaited inside `turnEntriesFrom`, same as `'regex'`/`'ml'`/`'hybrid'` already are — simpler (no new "patch a suggestions field onto an already-persisted entry" machinery needed), at the cost of adding real latency (multiple seconds for `'builtin'`) to every character turn while `'llm'` mode is on. Given `'llm'` mode is opt-in and off by default, this seemed like the right tradeoff for a first working version; making it truly async is a reasonable follow-up if the latency proves annoying in practice.
  2. **No read-tools, no group-targeting.** Instead of on-demand queryable tools for character/world info (the original plan's ambition), the sidecar prompt just lists known places/characters/background characters directly — works fine at the cast sizes this app deals with, avoids a much bigger chunk of implementation. `targetKind` is `'character' | 'persona'` only, no `'group'` — group-text resolution needs group-id plumbing that wasn't wired in.
  
  **Frontend chip actions are scoped to what maps onto existing app primitives**, not to everything the schema can express: `call-to-scene` reuses `chat.moveCharacter` (moves the target character to wherever the chip was clicked); `text-someone` opens the target's phone thread (`phone.openConversation`) rather than auto-generating and sending message content on the character's behalf — that would be a real content-generation feature this session never researched or tested; `scheduled-text` renders as informational-only, no click action, matching this task's own explicit "the firing loop is out of scope" scoping decision from the original plan.
  
  **End-to-end verification**: called `detectViaBuiltinLlm` directly (real cached model, real node-llama-cpp, real name/id resolution against a fake-but-realistic character list) with the same "text Wren now, text persona tonight" scenario used throughout this task's research. Output: `[{"type":"scheduled-text","targetKind":"persona","charId":null,"targetName":"Jordan","day":2,"timeOfDay":"evening","reason":"I'll send the stuff tonight"},{"type":"text-someone","targetKind":"character","charId":"c2","targetName":"Wren","summary":"texting Wren now"}]` — both actions, correct real character id, correct day/time inference, in 10.7s including a cold model load. Correct.
  
  **Not yet done**: manual testing through the actual live app UI (toggle the Settings dropdown, have a real character turn run with `'llm'` mode on, confirm chips render and act correctly in the browser) — everything above verifies the mechanism works, not the full UI round-trip. Also not done: the `'same'`/`'custom'` remote-source paths were code-reviewed and reuse well-tested primitives (`callOpenRouter`, `extractJsonLenient`) but weren't independently smoke-tested the way the local path was (would need a working OpenRouter-style endpoint to actually call).
- author: claude
  date: 2026-08-07T00:00:00.000Z
  **Three real bugs from a live deployment's logs, fixed and verified against the exact reported scenarios:**
  1. Log visibility — the raw sidecar output was being logged via `logger.debug(msg, extra)`, and `log.js` always gates the `extra` payload behind `FREEROAM_LOG=debug` regardless of the call's own level. Fixed by embedding raw output directly in the message string in both the builtin and remote paths.
  2. `scheduled-text`'s `day`/`timeOfDay` — with no resolution rule, the model just echoed the current world time back verbatim for "later" promises (day 1/morning in, day 1/morning out). Fixed with explicit advancement rules against the app's real time-of-day sequence, plus a guardrail against ever returning the exact current time.
  3. `reason` quality — went through two rounds live: first it was a bare restatement ("Ezra promises to text the persona later"), then after fixing that, a bare pronoun with no context ("what he finds"). Fixed by requiring a self-contained "text about ___" brief, with three real bad examples baked into the prompt (all three actually observed, not hypothetical) — verified good on retest ("findings on mystery daughters born in 2003 and baptized...").
  
  **A fourth issue found during my own verification, not fully resolved:** a reply where the character dismisses the persona ("Go. I work better without someone breathing in my peripheral vision...") while also promising a scheduled text gets misclassified as `demote` (speaker steps back) instead of `scheduled-text` — and the wrong classification crowds out the real one entirely, not just alongside it. Root cause: `demote`'s definition didn't distinguish "the speaker withdraws themselves" from "the speaker dismisses someone else while staying" — surface-similar dismissal language, opposite actor. Tried three rounds of prompt fixes (abstract disambiguation, then a concrete counter-example with two sample phrasings) against this exact case — same misclassification every time, byte-identical raw output on a rerun confirming this isn't sampling noise (session defaults to temperature 0 per node-llama-cpp's docs). This reads like a real capability ceiling for this specific ambiguity at Gemma4-E2B's size, not something further prompt wording is going to fix — logged here rather than continuing to iterate blind. The first reported scenario (no dismissal language) still resolves correctly after these changes — this is scoped to replies that combine a real intent with dismissal-shaped phrasing, not a general regression.
  
  **Options if this needs to actually get fixed** (not evaluated, just named): split classification into multiple independent passes per intent type instead of one combined array (removes the "one wrong guess crowds out a real one" failure mode entirely, at real architecture cost); try stock Qwen3-1.7B specifically for this case (scored better on some multi-intent tests earlier in this research, though also had its own inconsistencies); or accept the gap, since `demote` is already covered independently by `'regex'`/`'ml'` modes elsewhere — the real cost here is narrower than it first looks, specifically "a reply with both a dismissal AND a co-occurring different intent loses that other intent."

- author: claude
  date: 2026-08-09T00:00:00.000Z
  **Research (no build): can all 7 intent types run on local ML models instead of the LLM sidecar? Short answer: mostly yes — and the parts that can't be done the LLM's way can mostly be done a *better* way. The catch is that detection of the 3 new intent types rests on an untested-but-promising reframing of the zero-shot setup, so this needs one spot-check before being trusted.**
  
  Prompted by the verdict that LLM mode is "good in theory, horrible in practice" — which the production record supports: 7s synchronous latency per turn on CPU, three rounds of prompt-fix whack-a-mole on `reason`, a misclassification (`demote` crowding out `scheduled-text`) that three more prompt attempts couldn't fix, and no way to regression-test any of it deterministically.
  
  **The key move is decomposition.** The LLM sidecar does four different jobs in one opaque shot. Split apart, each job has a different — and often easier — ML/rules answer:
  
  | Job | LLM sidecar today | ML/rules equivalent | Verdict |
  |---|---|---|---|
  | 1. Intent detection ("does this reply imply X?") | one JSON array, all-or-nothing | zero-shot classification, `multi_label: true` (verified available in the installed transformers.js — scores each label independently, no softmax competition) | plausible, needs spot-check |
  | 2. Target binding ("who is it aimed at?") | LLM guesses, needed persona-name hiding to stop misbinding | rules + existing alias infra; QA model for hard cases | mostly solved already |
  | 3. Time resolution ("tonight" -> day/timeOfDay) | 3 prompt iterations to stop it echoing current time | a deterministic keyword table over the 7-value `TIMES_OF_DAY` enum | **rules are strictly better** |
  | 4. `reason` content brief | abstractive summary, lossy even after 3 fixes | **extractive**: store the trigger sentence(s) + preceding persona line verbatim | arguably better (see below) |
  
  **Job 3 (time)**: the in-world time model is a 7-value enum, not real datetimes. "tonight" -> evening/night same day, "tomorrow [morning]" -> day+1 [morning], "in an hour / a few hours / later today" -> advance 1-3 steps, wrap past night to day+1. That's a ~10-line lookup, exact and unit-testable. The LLM needed explicit instructions to not echo the current time and still only approximates; this can't-fail.
  
  **Job 4 (reason)**: the whole three-round `reason` saga (restatement -> timing-explanation -> bare pronoun) was fighting a small model's summarization ability. But the eventual consumer of `reason` is the *future firing loop*, which will be a full LLM generation call anyway — it can interpret a verbatim quote at least as well as a lossy summary. Storing the sentence(s) containing the trigger phrase plus the persona's preceding line verbatim is self-contained *by construction* (it's the actual source text — can't hallucinate, can't lose the subject). For the Ezra scenario this captures "Three women, possibly multiple children, father's name Shad Torson..." automatically — better than any of the model's three attempts.
  
  **Job 2 (target binding)**, split by case:
  - "text *you*" with no name -> persona: a pronoun rule. Trivially reliable — note the LLM needed the persona's name *hidden from the prompt* to get this right, and still misbound it in the realistic tests. Rules win here.
  - Named target -> `characterAliases`/`characterMentionedIn`/`firstMentionedCharacter` (lib/textUtils.js) — already battle-tested by the nickname/response-order features and the existing beckon detection.
  - True coreference ("let *her* know", antecedent two sentences back) -> the one genuinely open case. Candidate: an extractive-QA model — `Xenova/distilbert-base-cased-distilled-squad` exists as a transformers.js ONNX port (~65MB at int8), `question-answering` pipeline confirmed in the installed lib; ask it "Who will {speaker} send a text to?" against the reply. **Unknown domain fit** (QA models are trained on factoid/Wikipedia-style text, not roleplay prose with asterisk actions) — needs its own spot-check, and is optional: shipping without it just means pronoun-only-antecedent cases degrade to no suggestion, this app's standard failure mode.
  
  **Job 1 (detection) — the honest open question, and why the earlier negative results don't settle it.** Branch A's spot-check condemned the *current* framing: 2-label "X vs. none of the above" calls at MobileBERT size (near coin-flip). But the same data showed the 3-way destination call going 6/6 on the same model, and the original Check investigation explicitly hypothesized the 2-label-vs-generic-none *framing* was the weak point, not zero-shot itself — and its two cheapest recommendations (per-label-set thresholds, more specific negative labels) were never tried. A 7-intent multi-label setup is a structurally different regime: fuller label space to discriminate against, independent per-label scores, per-label calibrated thresholds. Additional design note: don't ask zero-shot to distinguish `text-someone` from `scheduled-text` (the now-vs-later distinction even Qwen3-1.7B kept failing) — use ONE "texting" label, then split now/later with the Job-3 keyword rules. Let NLI do topic detection, let rules do temporal logic.
  
  **Per-intent feasibility**: `destination` solved (existing, 6/6). `new-character` solved (existing NER, known minor warts documented in the Check findings). `demote` — regex is reliable AND structurally immune to the dismissal trap that beat the LLM (`STEP_BACK_RE` only matches first-person phrasings; "Go." *cannot* fire it). `promote` — existing, noisy at 2-label, should improve under the new framing. `call-to-scene` — same shape as promote but resolved against *non-present* cast (plumbing, not research). `text-someone`/`scheduled-text` — new "texting" label + binding rules + time rules + extractive reason, pending the Job-1 spot-check.
  
  **What ML structurally fixes about "horrible in practice"**: ~100x latency (tens of ms vs. 7s, and the 3.3GB model download goes away — DeBERTa is 242MB, already cached); deterministic and unit-testable (the golden-set regression tests the Check recommended become possible — prompt-fix whack-a-mole becomes threshold/rule tuning with assertions); `multi_label` scoring makes the crowding-out failure (`demote` suppressing `scheduled-text`) structurally impossible — every label scores independently; zero API cost, fully offline.
  
  **What's genuinely lost**: robustness to phrasings outside the label semantics/regex patterns; cross-sentence inference beyond what QA can recover; any use of world/persona context in detection. Also worth naming once: a middle path exists (ML-gated LLM — only fire the sidecar when a cheap zero-shot pass suspects a texting intent, cutting the 7s cost to suspicious turns only), already flagged in the original research as a cost-cutter, but it inherits the LLM's misclassification problems for the turns where it does fire.
  
  **Recommended validation path (in order, reusing this task's existing spot-check methodology and test lines):**
  1. Multi-label zero-shot spot-check: 5-6 intent labels (one "texting" label, no now/later split) + per-label thresholds, on DeBERTa-v3 (cached) and MobileBERT (current), against the existing 16-case set plus the two production scenarios. This is the go/no-go gate for the whole idea.
  2. If (1) passes: QA-model spot-check on the coreference cases only (optional, ships without it).
  3. Build shape: an upgrade inside `'ml'`/`'hybrid'` modes rather than a 4th mode — the ctx plumbing added for LLM mode (`precedingUserText`, world time, background/non-present cast) already carries everything these stages need.

- author: claude
  date: 2026-08-09T00:00:01.000Z
  **Spot-check ran (the go/no-go gate from the previous comment): multi-label zero-shot, 7 label wordings tested simultaneously, 16-case set + both Ezra production scenarios, MobileBERT and DeBERTa-v3-base sequentially. Verdict: GO — but only on DeBERTa, only with the right label wordings, and the single most important finding is *how much* label wording matters.**
  
  Methodology: `multi_label: true` (each label scored independently — since labels don't compete, alternate wordings of the same intent cost one extra forward pass each and can be A/B-tested in the same run), whole-text scoring for all 18 cases plus a per-sentence pass for the two long Ezra replies, then per-label separation analysis (min score across that label's positive cases vs. max score across its negatives — positive separation means a usable threshold exists). Script kept as `backend/scratch-multilabel-spotcheck.mjs` (untracked) for iteration.
  
  **MobileBERT (current prod model): total fail, no-go as backbone.** All 7 labels overlap. Standouts: "He shrugged and said nothing, turning back to his book" scores `stepback=0.97` (both models actually — this line belongs in every future hard-negative set); whole-text on the long Ezra replies just lights everything up (`introduce=0.98`, `stepback=0.99` on text implying neither).
  
  **DeBERTa-v3-base: the two families that matter most both separate cleanly at whole-text — with the right wording:**
  
  | Label (wording) | Separation | Verdict |
  |---|---|---|
  | `'the speaker promises to text someone'` | **+0.561** (thr ~0.71) | **clean separation**, 0.99-1.00 on all 5 texting positives incl. both Ezra whole-texts |
  | `'the speaker says they will send someone a text message'` | −0.717 | collapse — scored 0.00 on Ezra 2 whole-text |
  | `'the speaker announces that they are leaving'` | **+0.151** (thr ~0.92) | separates |
  | `'the speaker excuses themselves or steps back...'` (current prod string) | −0.159 | overlaps |
  | invite / introduce / beckon (various) | −0.045 to −0.33 | overlap at intent level — but see below |
  
  Same intent, near-synonymous phrasings, opposite outcomes (+0.561 vs −0.717). **Any zero-shot label in this app should be treated as a tuned hyperparameter, not prose** — and cheaply ensembled (2-3 wordings per family, take max) since multi-label makes extra hypotheses nearly free.
  
  **Both production regressions pass on DeBERTa** with the two winning labels at their computed thresholds: Ezra 1 — texting 1.00 (fires), leaving-label 0.85 < 0.92 (correctly silent); Ezra 2 — texting 0.99 (fires), stepback 0.24/0.01 (silent). The exact case that beat the LLM four prompt-iterations in a row falls out of threshold arithmetic.
  
  **The invite/introduce/beckon "overlaps" are mostly not real failures.** Worst offenders: "You should come with me to the tavern" scoring `beckon=1.00` (semantically true — an invite IS a beckon; the families genuinely overlap in meaning) and "I'm going to head out now" scoring `invite=1.00`. But the existing ml pipeline already gates these intents on slot resolution — beckon only produces a promote if a *background character's alias* matches, invite only produces a destination if a *place* resolves — and under that gating, every one of these cross-family false-fires is neutralized (no background char named in case 8, no place named in case 14 → no wrong chip either way). Intent labels don't need to be mutually exclusive; slots disambiguate. My separation table over-penalizes by ignoring this.
  
  **Per-sentence: use for localization only, not detection.** It nails the trigger sentence ("I'll text you when I have something" = 1.00 exactly where it should — which *is* the extractive `reason` and the input for the time rules, for free), but short imperatives and narration fragments are poison as standalone premises ("Go." fires invite/stepback at 1.00 — genuinely ambiguous without context; "A pause." fires `stepback=0.97`). Detect on whole text; localize on sentences only for labels that already fired.
  
  **Time-rule demo**: 4/5 exact on first try; the one miss is itself the design lesson — running keyword rules on the *whole reply* let "He doesn't answer **immediately**" (narration) hijack Ezra 2's now/later split. Rules must run on the localized trigger sentence, which the per-sentence pass provides. With that ordering, all 5 resolve correctly.
  
  Practical notes: DeBERTa here loaded fp32 (70s load, ~200ms/short case for 7 labels) because no dtype was passed — Branch A's q8 config (12.8s load, proportionally faster inference) is the production choice and is what the earlier accuracy numbers were measured on. ~35x faster than the 7s LLM sidecar either way; 242MB vs 3.3GB.
- author: claude
  date: 2026-08-09T00:00:02.000Z
  **Research: fine-tuning a small local model for these intents (requested alongside the spot-check — no build). The zero-shot result above is good enough to ship a v1 for texting+demote; fine-tuning is how the *whole* label set gets robust and the wording-fragility risk dies. Four approaches, ordered by effort:**
  
  **1. Embedding + tiny head ("frozen SetFit") — the natural first step for THIS codebase.** [SetFit](https://github.com/huggingface/setfit) fine-tunes a sentence-transformer contrastively then trains a small classification head, needing only ~8-32 examples per class. The degenerate version needs no new runtime at all: this app *already ships* local sentence-embedding inference (`lib/embeddings.js`, bge-small-en-v1.5) — embed N examples per intent family offline, train a multi-label logistic head (scikit-learn, minutes on CPU), ship the head as a JSON of weights + ~20 lines of JS matrix math. Zero new dependencies, instant inference (one embedding + one matmul), trivially re-trainable as bad cases accumulate. The full SetFit variant (contrastively tuned body) needs an optimum ONNX re-export of the tuned embedding model — also well-trodden. ONNX export is [supported by the library](https://pypi.org/project/setfit/); multi-label via one-vs-rest strategies.
  
  **2. Multi-label classifier head on a small encoder — the "proper" build.** DeBERTa-v3-small/xsmall or DistilBERT + linear head, `problem_type="multi_label_classification"` (BCEWithLogits, sigmoid outputs, per-class thresholds calibrated on a val split — [standard recipe](https://www.philschmid.de/fine-tune-modern-bert-in-2025)). Scale reference from that recipe: ~15k synthetic examples, 5 epochs, **321 seconds** of training, F1 0.993 — this is small-model territory, minutes on the local GPU. Deployment: optimum ONNX export → quantize → load via transformers.js `text-classification` pipeline from a local model dir, same `.cache` pattern as every other model here. **Avoid ModernBERT as the base despite its benchmarks** — fine-tuned-ModernBERT→ONNX export has a [known optimum bug](https://huggingface.co/answerdotai/ModernBERT-base/discussions/77); DeBERTa-v3/DistilBERT export cleanly today.
  
  **3. Zero-shot/LLM distillation for the training data — the reframe that makes "horrible in practice" useful.** The per-call LLM was unreliable *and slow synchronously*, but as an offline batch teacher it's fine: generate a few thousand roleplay reply lines via OpenRouter (varied register — quoted dialogue, asterisk actions, narration mix), have the big model label them once, human-spot-check a sample, train approach 1 or 2 on the result. The unreliability that killed per-turn use averages out in bulk and every label is inspectable before training.
  
  **Training data strategy (the actual bottleneck, whatever the model):** ~100-300 synthetic positives per family + equal *hard negatives mined from this session's real failures* — the entire catalog is already documented on this task: dismissals-that-aren't-demotes ("Go.", "give me some space to work"), narration with intent-adjacent verbs ("He shrugged and said nothing, turning back to his book" — 0.97+ stepback on BOTH zero-shot models), bare imperatives, "come with me" invite/beckon boundary lines, texting-mentioned-but-not-promised. Real lines from the server deployment's logs as they accumulate (LLM-assisted labeling). **Golden set: the 18 spot-check cases + both Ezra scenarios, never trained on** — they become the regression test the original Check investigation asked for.
  
  **4. Slot side (only if alias/pronoun rules prove insufficient):** [GLiNER](https://github.com/urchade/GLiNER) does runtime-specified entity types ("person being texted", "promised time") with [ONNX ports available](https://huggingface.co/onnx-community/gliner_large-v2.1), but it doesn't run in the plain transformers.js pipeline — needs GLiNER.js or a custom ORT wrapper (new dependency). Fine-tuning a token-classification model for role slots is the heavyweight endgame and needs span-annotated data; not a v1 move. The spot-check suggests rules + existing alias infra cover the current cases without either.
  
  **Recommended sequence:** ship tuned zero-shot (DeBERTa q8, winning label wordings, per-label thresholds, slot gating) as the ml-mode upgrade now → collect real lines from the deployment → train the embedding-head model (approach 1, near-zero deployment cost) → only escalate to approach 2 if per-family precision still disappoints. Each step reuses the golden set for regression.

- author: claude
  date: 2026-08-09T00:00:03.000Z
  **Built: the tuned zero-shot config is now the ml/hybrid-mode upgrade path (uncommitted, on `feature/llm-suggested-actions`). The regex layer and mode surface are untouched — `'ml'`/`'hybrid'` just got materially better, and learned texting detection.**
  
  What changed:
  - `lib/nlp.js` — zero-shot backbone swapped `Xenova/mobilebert-uncased-mnli` -> `Xenova/nli-deberta-v3-base` at q8 (~242MB, downloads on first ml-mode use for fresh installs); `classifyIntent` (competitive softmax) replaced by `classifyIntents` (multi-label, independent per-label scores — the framing the whole spot-check validated).
  - `lib/suggestedActions.js` — one shared multi-label call + one NER call per message, consumed by every gate: known-destination on the invite family (thr 0.9), promote on beckon (thr 0.9) with the existing alias gating, and two new outputs — `text-someone`/`scheduled-text` — matching `llmSuggestedActions.js`'s shapes exactly so the frontend renders both modes identically. Texting pipeline per the validated design: whole-text gate (thr 0.85) -> per-sentence localization of the trigger -> deterministic target binding (known-alias -> "you"/no-target -> persona -> NER-PER free-text fallback) -> `resolveWhen` keyword rules on the trigger sentence for the now/later split -> the trigger sentence verbatim as the extractive `reason`. Label wordings + thresholds live in one `INTENT_FAMILIES` table documented as tuned values.
  - **Calibration lesson (cost one debugging round): thresholds and dtype are a matched set.** The first calibration ran fp32; production runs q8, and the quantization score-shift both broke demote (spurious fire on Ezra 1, missed fire on a genuine leaving line) in the first real-model smoke. Recalibrated everything on q8 (`scratch-multilabel-spotcheck.mjs` now pins q8 for exactly this reason).
  - **Demote redesigned around what q8 can actually do**: whole-text separation for the leaving label doesn't exist at q8 (true positive 0.86 vs. Ezra-1 dismissal negative 0.98). The per-sentence data showed the split that works — every false-firing sentence is imperative/second-person ("Go." = 1.00, "Door sticks on the way out." = 1.00) while genuine step-backs are first-person by nature. Shipped: whole-text pre-gate (0.5) -> score only sentences containing first-person "I" -> sentence threshold 0.8. A listener-directed dismissal is now *structurally* unable to demote (no first-person sentence -> no candidates), not just unlikely — the same property the regex layer always had, now with ml recall.
  - Bonus real bug fixed en route: known-character exclusion for new-character suggestions matched exact full names only, so "Ezra Vane" referred to as "Ezra" in prose got re-suggested as a new character. Now goes through `characterAliases` (full name, first name, nicknames), and the persona's first name is excluded too.
  - `SuggestedActionsCard.vue` hint copy updated (ML mode now covers texting/scheduling; first-use download note).
  
  **Verification**: 820/820 backend tests (suggestedActions suite rewritten for the multi-label contract: 50 tests incl. new coverage for per-label thresholds, sentence localization — asserting narration can't hijack the time rules or leak into `reason` — first-person demote gating, NER-fallback target binding, and exported `resolveWhen` unit tests); frontend builds clean; real-model smoke (`scratch-ml-smoke.mjs`, untracked) all-green: Ezra 1 production regression -> exactly one suggestion, `scheduled-text` to persona day 1 afternoon with `reason: "I'll text you when I have something."`, no demote, no spurious new-character; regex-missed beckon -> promote; first-person leaving -> demote; the neutral line that scored 0.97 stepback on the old model -> silent. Latency: 75-102ms per short reply, ~3s for the 5-paragraph production reply (vs. ~7s+ for the local LLM sidecar on the same text).
  
  **Still open, deliberately**: `'llm'` mode untouched (user can compare all four modes live); call-to-scene has no ml path (needs non-present-cast plumbing); the golden set lives in the two untracked scratch scripts and should eventually become a proper opt-in test per the fine-tuning comment's plan; fine-tuning path (embedding + tiny head first) documented in the previous comment, unbuilt.

- author: claude
  date: 2026-08-10T00:00:00.000Z
  **The scheduled-text firing loop — marked "out of scope, unbuilt infrastructure" throughout this task — is now built (uncommitted).** The scheduled-text chip (persona-target) is a real button: clicking stores the promise in a new per-world `scheduledTexts.json` (calls.json pattern; excluded from clone, included in export), and `POST /api/world/time` — the one place world time ever changes, where schedule placements already apply — fires each due entry as a proactive text with the suggestion's `reason` as the generation hint (the wiring from the earlier "spreadsheet of our earnings" fix). Due = tuple-compare `(day, timeOfDay index) <= now`, so jumping time straight past a slot still fires it late rather than stranding it; already-due-at-creation fires immediately; per-tick firing shares `MAX_PROACTIVE_TEXTS_PER_ROUND`'s cap (excess stays pending for the next tick); due-with-no-API-key stays pending instead of being dropped; entries are removed before generation starts (a failed generation loses that one text — logged — rather than risking double-sends from overlapping ticks). `GET/DELETE /api/scheduled-texts` exist for inspection/cancel (no management UI yet — the chip is the only producer). 837/837 backend tests (10 new: due-logic unit tests + route tests covering pending/fire-on-advance/fire-if-overdue/cancel, incl. asserting the reason reaches the final prompt turn), frontend builds clean.

## History

- type: created
  date: 2026-08-05T13:50:24.633Z
  column: Todo
- type: moved
  date: 2026-08-05T14:30:00.000Z
  fromColumn: Todo
  toColumn: In Progress
- type: moved
  date: 2026-08-05T15:15:00.000Z
  fromColumn: In Progress
  toColumn: Needs Human Testing
- type: moved
  date: 2026-08-05T00:00:00.000Z
  fromColumn: Needs Human Testing
  toColumn: Todo
- type: moved
  date: 2026-08-06T00:00:02.000Z
  fromColumn: Todo
  toColumn: In Progress
