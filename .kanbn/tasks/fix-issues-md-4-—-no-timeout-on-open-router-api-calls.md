---
tags:
  - 'priority:medium'
  - 'workload:Normal'
created: 2026-08-04T21:08:21.000Z
updated: 2026-08-04T21:08:21.000Z
completed: 2026-08-04T21:08:21.000Z
---

# Fix: ISSUES.md #4 — no timeout on OpenRouter API calls

This same AbortController infrastructure later became the foundation
for the cancel-generation feature.

## Sub-tasks

- [x] Added `timeoutController`/`LLM_TIMEOUT_MS` around `callOpenRouter`/`streamOpenRouter` in `backend/server.js`, surfacing a clear timeout error instead of hanging forever.

## History

- type: created
  date: 2026-08-04T21:08:21.000Z
  column: Done
- type: moved
  date: 2026-08-04T21:08:21.000Z
  fromColumn: Done
  toColumn: Done
