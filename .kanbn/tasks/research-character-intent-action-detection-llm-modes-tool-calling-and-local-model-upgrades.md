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

- [ ] Branch A: spot-check BART-large-MNLI / DeBERTa-MNLI zero-shot and a
      stronger NER model against the Check investigation's realistic-line
      methodology; measure accuracy AND CPU latency; decide go/no-go on
      swapping `'ml'`/`'hybrid'`'s underlying models independent of Branch B
- [ ] Branch B: add `'llm'` to `suggestedActionsMode`'s accepted values
      (`backend/server.js` DEFAULT_CONFIG, `publicConfig`, `POST
      /api/settings` validation) + a Settings UI option in
      `SuggestedActionsCard.vue` with the 3 model-source sub-options
      (same backend/model, different backend/model, tiny local LLM),
      default unchanged (`'regex'`)
- [ ] Tiny-local-LLM sub-option: accuracy spot-check a CPU-runnable small
      instruct model (Qwen2.5-0.5B/1.5B-Instruct or similar) on the same
      JSON-emission task before trusting it as a shipped option
- [ ] New sidecar-call module (extends `lib/suggestedActions.js` or a new
      `lib/llmSuggestedActions.js`) — native tool-calling preferred,
      prompt-based JSON fallback, dispatching to whichever of the 3 model
      sources is configured
- [ ] Read-tool implementations: character info (name/nicknames/definition,
      relationships, schedule, matching memories) and world info (location/
      area name, current day/time-of-day, list of locations, weather),
      exposed as callable tools and also usable to build the prompt-based
      fallback's context block
- [ ] Action-tool schema covering all 9 types (`destination`, `new-character`,
      `promote`, `demote`, `text-someone`, `call-to-scene`, `scheduled-text`,
      plus `move-to-location`/`invite-character-over` — resolve overlap
      with `destination`/`promote` during implementation), with a
      per-action `try`/`catch` validator so one malformed action doesn't
      drop the whole batch
- [ ] Server-side name -> id resolution + revalidation for every resolved
      `charId`/`targetId`/`placeId` before it reaches the frontend
- [ ] Wire the sidecar call fire-and-forget after the reply stream
      completes, gated strictly on `suggestedActionsMode === 'llm'`
- [ ] Frontend: extend whatever renders today's 4 suggestion chip types to
      handle the 5 new action types (decide during implementation which,
      if any, merge into existing chip types vs. stay distinct)
- [ ] Backend tests: mock sequential OpenRouter fetches (reply, then
      sidecar) via the existing `mockOpenRouterFetch` pattern — cover a
      clean multi-action tool-calling response, a prompt-based-JSON
      fallback path, a malformed/partial response degrading to zero
      suggestions, an unresolvable name staying as a free-text
      `new-character` candidate, and an attacker-shaped id being rejected
      by the revalidation step
- [ ] `npm test` and `npm run build` both clean
- [ ] Manual: turn `suggestedActionsMode` to `llm` in Settings (try all 3
      model-source sub-options), exercise lines that should trigger each
      of the 9 action types, confirm chips appear correctly, and confirm
      switching back to `regex` fully reverts to today's behavior

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
