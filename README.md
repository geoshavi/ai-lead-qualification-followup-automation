# lead-engine

AI lead qualification and follow-up automation, built on n8n.

Leads arrive from three sources, get scored by an LLM, land in a CRM, and enter a
deterministic follow-up sequence that stops when it should. Duplicate submissions
cannot create duplicate rows or duplicate messages — that guarantee is enforced by
the database, not by workflow logic.

> **Status: M8 (resilience pass) complete.** `src/core/retry.js` (new — the
> twelfth core module) is a deterministic, bounded retry-with-backoff policy:
> `shouldRetry`, `backoffDelayMs`, and `isRetryableFailure`, which classifies
> a normalised `{kind, status}` failure as transient (`timeout`,
> `unreachable`, `http_error` at `429`/`5xx`) or fixed (any other
> `http_error`, `empty_response`) — no jitter, no clock, so a schedule is
> exact and reproducible. `src/adapters/llm/scoreLead.js`'s
> `callProviderWithRetry` applies it to the one real transport call this
> project's code makes: up to 3 attempts, 200ms/400ms backoff, before a
> transient failure reaches the existing persist-and-flag path — a *malformed
> answer* still gets its own, separate section 5.3 retry one layer up. A
> fixed failure (bad auth, bad request) is never retried — resending an
> identical request would just resend the identical mistake. Section 10's
> scenario 13 (a failing external call retried, then resolved) has no Slack
> adapter to call — Slack is n8n's built-in node on the canvas, like every
> other outbound send in this project — so its automated assertion is the
> generic mechanism itself, composed and proven in
> `tests/core-retry.test.js` without inventing a fake integration; wiring an
> n8n node's own retry-on-fail setting for the live Slack/Sheets sends is a
> canvas change for a human to make, left for later rather than done
> unilaterally here. Every other scenario in section 10 (temperature bands,
> dedupe precedence, validation, low confidence, booking/reply stops,
> invalid-JSON-twice, provider unavailable/timeout, prompt injection,
> concurrent duplicate webhooks, cross-provider parity) already had an
> automated assertion before this pass — M8 closes the one gap the codebase's
> own comments had flagged since M3: `scoreLead.js`'s catch block used to say
> outright that a transport failure "does not earn... retry... that is the
> M8 pass." Semgrep was not installed or run — not present in this
> environment, and per this session's own instruction not installed
> unilaterally; running it is a still-open manual step. 668 tests, 667
> passing, 1 skipped (the M2 hosted-parity marker), up from 640 — the new
> module and its regenerated `dist/nodes/retry.js`, one existing test that
> asserted the old no-retry behaviour rewritten to assert the new one, and no
> other `src/core/`, `dist/nodes/`, or `db/` file touched. See
> `PROJECT_SPEC.md` §9 for the full milestone plan. This README is expanded
> into full documentation at M9.

---

## The $0 default stack

Everything below runs locally with no paid API and no hosted service.

| Concern | Default | Cost |
|---|---|---|
| Workflow runtime | n8n, local or self-hosted | free |
| LLM | Ollama + `qwen2.5:7b-instruct` | free |
| Persistence | `mockCrm.js` — JSON file on disk | free |
| Outbound sends | `DRY_RUN=true` — logged, never sent | free |

Optional upgrades, each configuration-only: Supabase Free for hosted Postgres, a
free Slack workspace for alerts, Google Sheets on a normal account for reporting,
and Anthropic or OpenAI in place of Ollama.

Switching LLM provider requires setting `LLM_PROVIDER` and that provider's key.
It requires no change to `src/core/`, prompts, generated Code-node snippets,
workflow topology, or the database schema.

## Requirements

- Node.js ≥ 20 (uses the built-in `node --test` runner — the project has **zero
  npm dependencies**, production or dev)
- PostgreSQL 13+ *or* a Supabase Free project — only when running the hosted path
- Docker — optional, only to run the hosted-parity half of the test suite locally
  without an account (see `src/adapters/crmInterface.md`)
- Ollama — only to run a live scoring call; the test suite scores against
  recorded fixtures and needs no LLM running at all (see `src/adapters/llm/llmInterface.md`)

## Setup

```bash
cp .env.example .env        # defaults already describe the $0 path
npm test                    # no install step; there are no dependencies
```

`npm test` is offline and free: it runs against `mockCrm.js`, which keeps state in
a JSON file under `.data/`. Setting `SUPABASE_URL` additionally runs the identical
contract suite against `supabaseCrm.js` — that parity run is what stops the free
local path from drifting away from hosted Postgres.

To apply the schema to a Postgres instance:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/001_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/002_indexes.sql
```

Both files are re-runnable — every object is created `IF NOT EXISTS`, so
re-applying them to an existing database is a no-op that preserves data.

## Architecture in one paragraph

Business logic lives **inside n8n Code nodes**, not in an external service. This is
a portfolio piece for n8n work, so the canvas has to be doing real work rather than
proxying to an API. Because Code nodes cannot `require()` local files, every module
in `src/core/` is written as a plain function with **zero imports**, and a build step
(`npm run build:nodes`, arriving at M4 with the first n8n canvas) concatenates each
one into a self-contained snippet in `dist/nodes/` ready to paste into a node. Tests
import from `src/core/` directly and run in Node. `src/core/` is the source of truth — `dist/` is generated and must
never be hand-edited.

## Two design decisions worth pointing at

**Temperature is derived, not returned by the model.** The LLM returns a score; the
mapping to HOT/WARM/COLD happens in `src/core/temperature.js`. Letting the model
return both produces contradictions like `score: 30, temperature: HOT`. Deriving it
removes the entire class of bug.

**No `Wait` node in the follow-up engine.** A Wait node holds an execution open,
does not survive an n8n restart, and is invisible to the database. Instead the
intake workflow writes `next_followup_at` and exits, and a separate cron workflow
polls for due leads every 15 minutes. State lives in the database, executions stay
short, and everything is queryable.

## Layout

```
src/core/       pure, dependency-free, unit-tested business logic
src/adapters/   CRM and LLM adapters (the only place I/O is allowed)
db/             schema and index migrations
tests/          node --test suites
fixtures/       raw source payloads and scenario leads
n8n/workflows/  exported workflow JSON
dist/nodes/     generated Code-node snippets — never edit by hand
docs/           architecture, workflow, testing, security, handover
```

## Security posture

- Every inbound webhook requires a shared secret compared in **constant time**.
- `lead.message` is attacker-controlled text going into a prompt. It is stripped of
  control characters, truncated, and wrapped in explicit delimiters that tell the
  model the contents are data to evaluate, never instructions to follow.
- Injection heuristics **flag** for human review rather than blocking — a real
  customer might simply write something odd.
- The LLM never writes to the database, never chooses timing, and never sets
  status. It returns JSON that deterministic code parses, validates, clamps, and
  applies.
- Ollama being local does not make it a security boundary. Model output is
  untrusted regardless of provider.

Full reasoning lands in `docs/security.md` at M9.
