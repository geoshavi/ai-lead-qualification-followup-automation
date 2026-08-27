# PROJECT SPEC — AI Lead Qualification & Follow-Up Automation

**Type:** Portfolio project, built to production standards
**Primary goal:** Demonstrable proof of n8n + LLM + CRM automation skill for Upwork clients
**Secondary goal:** A codebase that could be handed to a real client with minimal rework
**Default runtime goal:** A complete $0 development and portfolio-demo stack using local/self-hosted n8n, Ollama, a local open-source model, and mock/local services wherever possible

---

## 0. READ THIS FIRST (instructions for the coding agent)

You are working on a project where **n8n is a GUI tool that you cannot click**. The human builds the n8n canvas. You write everything else.

**Your responsibilities:**
- All business logic as pure, testable JavaScript functions
- Database schema and migrations
- CRM adapter layer
- LLM provider adapter layer
- Prompt construction and LLM response validation
- Unit and integration tests
- Test fixtures
- Documentation

**Not your responsibilities:**
- Building or wiring n8n workflows
- Creating credentials
- Anything requiring a browser

**Working rules:**
1. Work **one milestone at a time**. Do not jump ahead. Stop at the end of each milestone and report.
2. Never invent an integration. If something is mocked, the filename, the function name, and the log output must all say `mock`.
3. No secrets in code. Everything through `process.env`, documented in `.env.example`.
4. Every core module must be **dependency-free** (no npm imports). See §2 for why.
5. Before any change that affects more than three files or alters the data model, stop and explain the decision first.
6. Commit after each milestone with a clear message.
7. The default development/runtime path must not require a paid API. Ollama and mock/local adapters are the defaults; hosted or paid providers are opt-in configuration only.
8. Development tools described in §13 are agent-side capabilities only. They must never become imports, runtime dependencies, generated Code-node content, or architectural requirements of the product.

---

## 1. ARCHITECTURE DECISION: WHERE LOGIC LIVES

The logic lives **inside n8n Code nodes**, not in an external API service.

**Why:** This is a portfolio piece for n8n work. A client scanning the demo needs to see a real n8n canvas doing real work. If n8n is a thin proxy to a FastAPI service, the n8n skill demonstration disappears — and that is the thing being sold.

**The consequence you must design around:** n8n Code nodes cannot `require()` local project files. So:

- Every module in `src/core/` is written as a plain function with **zero imports**.
- A build step (`npm run build:nodes`) concatenates each module into a single self-contained snippet in `dist/nodes/`, ready to paste into a Code node.
- Tests import from `src/core/` directly and run in Node.
- **`src/core/` is the source of truth.** Never edit `dist/`. Never edit a Code node by hand and expect it to survive.

This gives real unit-tested logic while keeping the demo visually honest.

### 1.1 Default $0 runtime stack

- **Workflow runtime:** n8n running locally or self-hosted by the developer.
- **LLM runtime:** Ollama on the local machine, using `qwen2.5:7b-instruct` by default. The model name is configurable for machines that need a smaller or larger local model.
- **Development persistence:** `mockCrm.js` and local fixtures by default, with no hosted service required for core development or tests.
- **Hosted database option:** Supabase Free when a real hosted Postgres demonstration is useful.
- **Notifications/reporting:** Slack free workspace and Google Sheets using a normal Google account.
- **Safety:** `DRY_RUN=true` by default. No outbound message is sent during routine development unless the developer deliberately disables dry-run mode.

This is a cost choice, not an architecture shortcut. All production-standard rules in this specification still apply. Local model output is treated as untrusted and receives the same parsing, validation, retry, audit, and human-review handling as any hosted model output.

---

## 2. FOLDER STRUCTURE

```
lead-engine/
├── PROJECT_SPEC.md
├── README.md
├── .env.example
├── .gitignore
├── package.json
├── src/
│   ├── core/                 # pure, dependency-free, unit tested
│   │   ├── schema.js         # canonical field list + defaults
│   │   ├── sanitize.js       # untrusted-input handling
│   │   ├── normalize.js      # source payload -> canonical lead
│   │   ├── validate.js       # required field checks
│   │   ├── dedupe.js         # dedupe_key generation + match rules
│   │   ├── prompt.js         # builds the scoring prompt
│   │   ├── scoreParse.js     # validates + repairs LLM JSON output
│   │   ├── temperature.js    # score -> temperature (deterministic)
│   │   └── followup.js       # deterministic scheduling rules
│   ├── adapters/
│   │   ├── crmInterface.md   # the contract every adapter implements
│   │   ├── supabaseCrm.js
│   │   ├── mockCrm.js
│   │   └── llm/
│   │       ├── llmInterface.md
│   │       ├── ollamaLlm.js  # default local provider
│   │       ├── anthropicLlm.js
│   │       └── openaiLlm.js
├── dist/nodes/               # generated, pasteable Code node snippets
├── db/
│   ├── 001_schema.sql
│   ├── 002_indexes.sql
│   └── 003_seed.sql
├── tests/
├── fixtures/
│   ├── sources/              # raw payloads per source
│   └── leads/                # the 12 scenario leads
├── n8n/workflows/            # exported JSON (human exports these)
├── scripts/build-nodes.js
└── docs/
    ├── architecture.md
    ├── workflow.md
    ├── testing.md
    ├── security.md
    └── handover.md
```

---

## 3. DATA MODEL

### 3.1 `leads` table

| Column | Type | Notes |
|---|---|---|
| lead_id | uuid PK | generated by DB |
| source | text | `website` \| `meta` \| `email` |
| source_id | text | external id, nullable |
| first_name | text | |
| last_name | text | |
| email | text | lowercased, trimmed |
| phone | text | E.164 where derivable |
| company | text | |
| service_interest | text | |
| message | text | raw user text |
| budget_raw | text | as submitted |
| budget_amount | numeric | parsed, nullable |
| budget_currency | text | default `USD` |
| timeline | text | |
| lead_score | int | 0–100 |
| lead_temperature | text | HOT \| WARM \| COLD |
| ai_reasoning | text | |
| recommended_action | text | |
| crm_status | text | see enum below |
| followup_status | text | PENDING \| IN_PROGRESS \| STOPPED \| COMPLETED |
| followup_step | int | 0-based counter |
| next_followup_at | timestamptz | **nullable — null means no scheduled follow-up** |
| last_contacted_at | timestamptz | |
| assigned_to | text | |
| booking_status | text | NONE \| BOOKED \| CANCELLED |
| needs_human_review | boolean | default false |
| review_reason | text | nullable |
| dedupe_key | text | **UNIQUE NOT NULL** |
| raw_payload | jsonb | original inbound payload, unmodified |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | trigger-updated |

`crm_status`: `NEW`, `QUALIFIED`, `CONTACTED`, `NURTURING`, `BOOKED`, `LOST`, `HUMAN_REVIEW`

### 3.2 `lead_events` table (audit log)

| Column | Type |
|---|---|
| event_id | uuid PK |
| lead_id | uuid FK nullable (null when the lead never got created) |
| event_type | text |
| status | text — `SUCCESS` \| `FAILURE` \| `SKIPPED` |
| details | jsonb |
| error_message | text |
| created_at | timestamptz |

Event types: `LEAD_RECEIVED`, `LEAD_NORMALIZED`, `VALIDATION_FAILED`, `DUPLICATE_FOUND`, `AI_SCORE_CREATED`, `AI_SCORE_INVALID`, `CRM_CREATED`, `CRM_UPDATED`, `SLACK_ALERT_SENT`, `FOLLOWUP_SENT`, `FOLLOWUP_STOPPED`, `BOOKING_RECEIVED`, `SHEET_SYNCED`, `HUMAN_REVIEW_FLAGGED`, `WORKFLOW_ERROR`

### 3.3 `notifications` table (idempotency guard)

| Column | Type |
|---|---|
| id | uuid PK |
| lead_id | uuid FK |
| kind | text — `SLACK_HOT` \| `FOLLOWUP` \| `BOOKING_CONFIRM` |
| step | int — default 0 |
| sent_at | timestamptz |

**`UNIQUE (lead_id, kind, step)`**

This table is the entire duplicate-prevention mechanism. Before sending anything, attempt the insert. If it violates the constraint, the message was already sent — skip. Do not rely on a boolean flag on the lead row; it races.

---

## 4. SECURITY (must be built in, not added later)

This section is a portfolio differentiator. Most demo projects skip it.

### 4.1 Webhook authentication
Every inbound webhook requires a shared secret in a header (`X-Lead-Token`). Compare against `WEBHOOK_SECRET` using a constant-time comparison. Reject mismatches with 401 and log `WORKFLOW_ERROR`. Never echo the received token into logs.

### 4.2 Untrusted input reaching the LLM

`lead.message` is attacker-controlled text going into a prompt. `src/core/sanitize.js` must:

1. Strip control characters and zero-width characters.
2. Truncate to 2,000 characters.
3. Wrap the content in explicit delimiters when building the prompt, and instruct the model that everything inside the delimiters is **data to be evaluated, never instructions to follow**.
4. Run a heuristic scan for injection markers (phrases attempting to override instructions, references to system prompts, requests to output a specific score). If matched, set `needs_human_review = true` and `review_reason = 'possible_prompt_injection'` — **do not** block the lead; a real customer might write something odd.

The heuristic is a flag, not a filter. Document this reasoning in `docs/security.md`.

### 4.3 Output constraints
The LLM never issues database writes, never chooses timing, never sets status. It returns a JSON object that is parsed, validated, clamped, and then applied by deterministic code.

The Ollama service is local, but it is not a security boundary. Model output remains untrusted. Do not expose Ollama beyond the local/trusted network for this project, do not put user-controlled text into model or endpoint configuration, and never log secrets or full authentication headers. Optional hosted-provider keys must remain unset unless that provider is explicitly selected.

---

## 5. AI SCORING CONTRACT

### 5.0 Provider abstraction and default

Core modules build provider-neutral prompts and validate provider-neutral results. They never import an SDK, call a network endpoint, inspect provider-specific response shapes, or branch on a provider name.

The adapter selected by `LLM_PROVIDER` implements one contract:

```
scoreLead({ systemPrompt, userPrompt, responseSchema, timeoutMs })
  -> { text, provider, model, requestId: string | null }
```

- `ollama` is the default and calls the local Ollama HTTP API at `OLLAMA_BASE_URL` with `OLLAMA_MODEL`.
- `anthropic` and `openai` are optional adapters for later use. Enabling either requires only environment/config changes and the relevant API key; core logic, prompts, validation, workflows, and tests must not change.
- Adapters normalize provider-specific responses into the contract above before `scoreParse.js` runs.
- Prefer built-in platform HTTP capabilities. Do not add an SDK unless a later requirement proves it necessary and the dependency is kept outside `src/core/` and generated Code-node business logic.
- Every provider call must have a timeout, bounded retry behavior, and safe error mapping. Provider errors route to the same persist-and-human-review path; they never drop a lead.

### 5.1 Requested output
```json
{
  "score": 0,
  "reasoning": "one or two sentences",
  "recommended_action": "short imperative action",
  "needs_human_review": false,
  "confidence": "HIGH | MEDIUM | LOW"
}
```

**The model does not return temperature.** Temperature is derived in `src/core/temperature.js`:

- `score >= 75` → `HOT`
- `40 <= score < 75` → `WARM`
- `score < 40` → `COLD`

Letting the model return both produces contradictions like `score: 30, temperature: HOT`. Deriving it removes an entire class of bug and is worth mentioning in the demo.

### 5.2 Scoring criteria (goes in the prompt)
Urgency, stated budget, purchase intent, service fit, timeline specificity, clarity of the request, and business fit. Include a short rubric with anchor examples so scores are stable across runs.

### 5.3 Validation and failure path
`scoreParse.js` must:
- Strip markdown fences before parsing
- Reject non-objects, missing keys, wrong types
- Clamp `score` into 0–100 and round to integer
- Truncate `reasoning` and `recommended_action` to sane lengths
- Return a discriminated result: `{ ok: true, value }` or `{ ok: false, error }`

On failure: retry once with a stricter reminder appended. On second failure: write `AI_SCORE_INVALID`, set `crm_status = HUMAN_REVIEW`, `needs_human_review = true`, and **still persist the lead**. A lead is never lost because the model misbehaved.

If `confidence === 'LOW'`, flag for human review but keep the score.

Provider-specific formatting features may be used as defense in depth, but tests must prove that the common parser still handles plain text, fenced JSON, malformed JSON, missing fields, and out-of-range values. Recorded fixtures must include Ollama as the default provider and may include optional Anthropic/OpenAI response envelopes. Unit and integration tests must never require Ollama to be running and must never call a paid API.

---

## 6. FOLLOW-UP ENGINE

### 6.1 Do not use the n8n Wait node

A Wait node holds an execution open. It does not survive an n8n restart, it is invisible in the database, it cannot be inspected or cancelled, and it does not scale. Anyone reviewing the project who has run n8n in production will notice.

**Correct design:**

- The intake workflow writes `next_followup_at` to the leads table and exits.
- A **separate scheduler workflow** runs on cron every 15 minutes:
  `SELECT * FROM leads WHERE next_followup_at <= now() AND followup_status = 'IN_PROGRESS' AND booking_status <> 'BOOKED' AND crm_status NOT IN ('LOST','BOOKED')`
- For each row: check `notifications` for idempotency, send, record, advance `followup_step`, compute the next `next_followup_at`, or set `followup_status = 'COMPLETED'` and `next_followup_at = NULL`.

State lives in the database. Executions are short. Everything is queryable. Say this out loud in the Loom — it is the single strongest engineering signal in the project.

### 6.2 Cadence (deterministic, in `followup.js`)

| Temperature | Step 0 | Step 1 | Step 2 |
|---|---|---|---|
| HOT | immediate | +24h | +72h |
| WARM | immediate | +48h | +120h |
| COLD | immediate | +168h | stop |

Business-hours clamping: if a computed send time falls outside 09:00–18:00 in `BUSINESS_TZ`, move it to 09:00 on the next business day. Weekend sends are pushed to Monday. This is deterministic and easy to unit test with a frozen clock.

### 6.3 Stop conditions
Stop when any of: `booking_status = BOOKED`, `crm_status = LOST`, `crm_status = BOOKED`, a reply is recorded, or the final step has been sent. Stopping sets `followup_status = STOPPED` or `COMPLETED` and `next_followup_at = NULL`, and logs `FOLLOWUP_STOPPED` with the reason.

### 6.4 Message generation
The LLM writes the wording. Deterministic code decides whether to send, when to send, and which step it is. Every generated message is stored in `lead_events.details` so the demo can show exactly what went out.

---

## 7. DEDUPLICATION

`dedupe_key` precedence:
1. `source + ':' + source_id` when `source_id` exists
2. else `email:` + normalized email
3. else `phone:` + E.164 phone
4. else `fallback:` + hash of (normalized name + company + day bucket), and set `needs_human_review = true`

Persist via `INSERT ... ON CONFLICT (dedupe_key) DO UPDATE`. This makes intake idempotent at the database level — a webhook fired twice cannot create two rows even under concurrency.

On conflict: merge new non-empty fields into the existing record, append the new message to a `message_history` jsonb array, log `DUPLICATE_FOUND`, and **do not** re-trigger the HOT alert or restart the follow-up sequence.

Cross-key conflicts (same email, different `source_id`) go to human review rather than being auto-merged.

---

## 8. CRM ADAPTER CONTRACT

Every adapter implements exactly this surface:

```
upsertLead(canonicalLead) -> { leadId, created: boolean }
getLeadByDedupeKey(key)   -> lead | null
updateLead(leadId, patch) -> lead
recordEvent(event)        -> void
listDueFollowups(now)     -> lead[]
```

`supabaseCrm.js` talks to Postgres. `mockCrm.js` holds state in a JSON file on disk so the whole system is demoable with no external services. Selection via `CRM_ADAPTER=supabase|mock`. Core logic never imports an adapter directly.

`mock` is the default for local development and automated tests. `supabase` is the hosted demonstration option and must work within Supabase Free limits; no core behavior may depend on a paid Supabase feature. Adapter parity tests prevent the free/mock path from drifting from hosted Postgres behavior.

---

## 9. MILESTONES

Complete in order. Each milestone ends with passing tests and a commit.

### M0 — Foundation
Repo init, `package.json`, test runner (`node --test`, no framework dependency), `.gitignore`, `.env.example`, `db/001_schema.sql` + `002_indexes.sql` including the UNIQUE constraints. Document the $0-first defaults: local/self-hosted n8n, `LLM_PROVIDER=ollama`, `CRM_ADAPTER=mock`, and `DRY_RUN=true`. Perform the minimal developer-tooling availability check from §13; configure Agent Skills/progressive disclosure and use Context7 only when a narrow current-doc lookup is actually needed.
**Done when:** schema applies cleanly to a fresh Postgres/Supabase instance.

### M1 — Core logic, no I/O
`schema.js`, `sanitize.js`, `normalize.js`, `validate.js`, `dedupe.js`, `temperature.js`, `followup.js` + full unit test coverage with a frozen clock.
**Done when:** `npm test` passes and covers every branch of the follow-up cadence table and every dedupe precedence rule.

### M2 — Persistence
`mockCrm.js` first, then `supabaseCrm.js` as the Supabase Free hosted option. Audit logging on every write. Integration tests against the mock adapter. After M1/M2 gives the repository meaningful structure, evaluate and enable Graphify locally only if it will reduce repeated repository reading; do not add it ceremonially.
**Done when:** the same test suite passes against both adapters.

### M3 — AI layer
`prompt.js`, `scoreParse.js`, retry logic, injection heuristics, the provider-neutral interface, and the Ollama adapter as the default runtime path. Add optional Anthropic/OpenAI adapters behind environment configuration without changing core logic. Tests use recorded fixture responses including Ollama output, malformed JSON, fenced JSON, out-of-range scores, and an injection attempt.
**Done when:** no test in this milestone makes a network call.

### M4 — Vertical slice in n8n *(human builds, agent supports)*
Website form only: webhook → auth check → normalize → validate → dedupe/upsert → AI score → persist → Slack if HOT.
Agent produces `dist/nodes/` snippets, a node-by-node build guide in `docs/workflow.md`, and a `curl` command that fires a test lead. The human builds the canvas in local/self-hosted n8n. The default vertical slice uses Ollama locally, mock/local services where practical, and `DRY_RUN=true` until the explicit real-send acceptance test.
**Done when:** one real submission produces one row, one score, one Slack message — and a second identical submission produces zero new rows and zero new messages.

### M5 — Remaining sources
Meta lead ads payload and inbound email parsing, both through the same normalization layer. Fixtures for each.
**Done when:** three different payload shapes produce byte-identical canonical output for the same underlying person.

### M6 — Scheduler
Cron workflow, due-lead query, idempotent send, step advancement, stop conditions.
**Done when:** a seeded lead with a past `next_followup_at` advances exactly one step per run and stops correctly at every stop condition.

### M7 — Booking + reporting
Booking webhook, follow-up cancellation, Slack confirmation using a free Slack workspace, and Google Sheets sync using a normal Google account. All outbound paths remain dry-run capable.
**Done when:** a booking event cancels pending follow-ups and the Sheet row updates.

### M8 — Resilience pass
Retries with backoff on every external call, timeouts, error routing to human review, local-Ollama unavailable/timeout coverage, optional-provider failure coverage, and every test scenario from §10 as a runnable fixture. Run bounded/local Semgrep rules before or during this security/resilience pass; findings are review evidence, not automatic product behavior.
**Done when:** every scenario has an automated assertion.

### M9 — Presentation
`README.md`, the four docs files, Mermaid diagram, screenshots, Loom script. The documentation must distinguish the default $0 demo path from optional hosted/paid-provider configuration, include local setup and hardware/model-sizing guidance, and show that switching providers is configuration-only. Use GitHub MCP read-only only when repository/PR/CI context is useful and not already available locally.

---

## 10. TEST SCENARIOS

1. Strong HOT lead — clear budget, urgent timeline
2. High budget, urgent, vague service description
3. Standard WARM lead
4. Low-intent COLD lead
5. Duplicate email, different submission
6. Duplicate phone, different email
7. Malformed email → validation failure → human review
8. Missing phone, valid email → passes
9. Ambiguous request → LOW confidence → human review
10. Booking arrives mid-sequence → follow-ups cancel
11. Reply arrives before step 1 → sequence stops
12. LLM returns invalid JSON twice → lead persists, flagged
13. Slack API returns 500 → retried, logged, lead unaffected
14. Prompt injection in `message` → flagged, score not inflated
15. Same webhook fired twice concurrently → one row
16. Ollama unavailable or times out → lead persists, failure logged, human review flagged
17. The same recorded scoring result through Ollama, Anthropic, and OpenAI adapters → identical validated core result

(Items 13–15 are additions to the original twelve and cover failure/security/concurrency probes. Items 16–17 verify the $0 local-provider path and provider abstraction.)

---

## 11. WHAT THE DEMO MUST SHOW

Screenshots: full canvas, AI scoring node output, database row, Slack HOT alert, scheduler workflow, Google Sheet, audit log query.

The default recording must be reproducible without a paid API: local/self-hosted n8n + Ollama + local open-source model, with Supabase Free/Slack free/Google Sheets only where the demo calls for a real hosted integration. Clearly label any optional hosted-provider screenshot as optional rather than required.

**Loom, 4 minutes:**
1. The problem — leads arrive from three places and go cold (20s)
2. Architecture diagram (30s)
3. Submit a lead live, watch it execute (45s)
4. Show the score and the reasoning (30s)
5. Show the database row and audit trail (30s)
6. Slack alert (15s)
7. **Submit the exact same lead again — nothing duplicates** (30s)
8. Scheduler: state in the database, not a hanging Wait node — explain why (30s)
9. Show a failure path handled cleanly (20s)

Steps 7 and 8 are what separate this from every other n8n demo. Do not cut them for time.

---

## 12. ENVIRONMENT VARIABLES

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b-instruct
LLM_TIMEOUT_MS=30000
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
OPENAI_API_KEY=
OPENAI_MODEL=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
CRM_ADAPTER=mock
WEBHOOK_SECRET=
SLACK_WEBHOOK_URL=
GOOGLE_SHEET_ID=
BUSINESS_TZ=America/Los_Angeles
HOT_SCORE_THRESHOLD=75
DRY_RUN=true
```

`DRY_RUN=true` logs outbound messages instead of sending them. Every send path must respect it — it makes the system safe to run repeatedly during development and safe to demo without spamming anyone.

Only variables for the selected provider are required. With the default `LLM_PROVIDER=ollama`, no LLM API key is needed. Changing to `anthropic` or `openai` must require only `LLM_PROVIDER` plus that provider's key/model variables; it must not require edits to `src/core/`, generated snippets, prompts, workflow topology, or data schema. `.env.example` must contain placeholders only and must never contain real credentials.

---

## 13. DEVELOPER/AGENT TOOLING PLAN — NEVER PRODUCT RUNTIME

`PROJECT_SPEC.md` remains the source of truth. The tools in this section help the coding agent work on the repository; the product must not be redesigned around them.

### 13.1 Hard boundary

Agent Skills, Context7, Graphify, Semgrep, GitHub MCP, Hermes material, and Kimi/Atlas-style ideas must never appear as runtime dependencies or framework code inside:

- `src/core/`
- generated `dist/nodes/`
- n8n Code-node business logic
- the lead automation's runtime dependency graph

They also must not weaken the rule that `src/core/` is dependency-free or change the human-built n8n canvas model.

### 13.2 Minimal, staged use

1. **Agent Skills — early and incremental.** Use the Agent Skills standard for reusable procedures and progressive disclosure: short metadata first, full instructions/references only when needed. Add a project skill only after repeated work justifies it; likely candidates are testing, n8n automation, prompt security, and CRM/integration testing. Do not create a large skill library at bootstrap.
2. **Context7 — early, narrow lookups only.** Use it only when current library/API documentation is needed, such as exact n8n node behavior, Ollama HTTP behavior, Supabase/Postgres APIs, or optional hosted-provider APIs. Ask narrow questions; do not load whole documentation sets or use Context7 as runtime infrastructure.
3. **Graphify — after M1/M2.** Once the repository has meaningful structure, build a local repository graph if it will save context. Update it incrementally and prefer scoped dependency/caller/blast-radius queries. Do not run it on an almost-empty M0 repository, and do not repeatedly read a full generated graph report.
4. **Semgrep — before/around M8 security and resilience.** Use bounded local rules for deterministic static/security analysis. Do not download arbitrary remote rules. Treat findings as evidence requiring review; never let a finding automatically alter runtime behavior.
5. **GitHub MCP — read-only initially.** Use it when repository, commit, issue, PR, or CI context becomes useful and is not already available locally. No automatic push, merge, issue creation, comments, or repository mutation.
6. **Hermes — design reference only.** Its progressive-disclosure/skills documentation may inspire agent procedure design. Do not install or embed the Hermes runtime.
7. **Kimi/Atlas-style systems — design references only.** Borrow useful ideas only when they fit this specification. Do not add another agent framework or orchestration layer.

Before installing or configuring any tool, verify whether it is already available and whether the current milestone needs it. Keep context use bounded: narrow documentation and graph queries, focused tests during development, the full suite at milestone completion, concise milestone reports, and no repeated analysis of unchanged architecture.
