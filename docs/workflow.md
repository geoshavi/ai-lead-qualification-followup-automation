# M4 build guide — website intake vertical slice

**You build this canvas by hand in n8n. Nothing here builds it for you.**
This document is the node-by-node instructions and the paste-ready code; the
agent that wrote it cannot click an n8n canvas (PROJECT_SPEC.md section 0).

Scope, verbatim from PROJECT_SPEC.md section 9 (M4): *website form only —
webhook → auth check → normalize → validate → dedupe/upsert → AI score →
persist → Slack if HOT.* Meta and email intake are M5. The cron scheduler is
M6. Booking and Sheets sync are M7.

**Done when** (section 9, verbatim): *"one real submission produces one row,
one score, one Slack message — and a second identical submission produces
zero new rows and zero new messages."* That is a test only you can run, once
the canvas exists — see [Running the acceptance test](#running-the-acceptance-test).

---

## 0. Prerequisites

| Needed | Why | $0 option |
|---|---|---|
| n8n running locally or self-hosted | the canvas lives here | already running per your setup |
| Ollama, with a model pulled | AI scoring | `ollama pull qwen2.5:7b-instruct` |
| A reachable Postgres | `dedupe/upsert` and `persist` | a local `postgres:16-alpine` container — see `src/adapters/crmInterface.md` for the exact `docker run` + migration commands, no account needed |
| `db/001_schema.sql` and `002_indexes.sql` applied | the `leads` and `lead_events` tables | `psql ... -f db/001_schema.sql -f db/002_indexes.sql`, or the M2 parity stack |
| A Slack **Incoming Webhook** URL | the HOT alert | free Slack workspace; can be added later — `DRY_RUN=true` means nothing sends until you deliberately flip it |
| `WEBHOOK_SECRET` generated | inbound auth (section 4.1) | `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` |
| `npm run build:nodes` has been run | the snippets below exist on disk | `cd` to the repo root, run it once |

`mockCrm.js` is the default for **development and automated tests**
(PROJECT_SPEC.md section 8), but it holds state in a JSON file with no HTTP
surface — n8n cannot call it directly. The canvas therefore talks to Postgres
over n8n's native Postgres node, which is also the $0-compatible path: a local
container needs no account, matching section 1.1's default stack.

---

## 1. Canvas shape

```
[Webhook: POST /lead-intake]
        |
[Code: Auth Check]  <-- dist/nodes/webhookAuth.js
        |
     [IF: authorized?]
      /            \
   FALSE          TRUE
     |               |
[Respond 401]  [Code: Normalize + Validate]  <-- normalize.js, validate.js
[Postgres:                |
 log WORKFLOW_ERROR]  [IF: valid?]
                       /       \
                    FALSE     TRUE
                      |          |
              [Postgres:   [Code: Build Dedupe Key]   <-- dedupe.js
               log               |
               VALIDATION_    [Postgres: Upsert Lead]  (raw SQL, section 4)
               FAILED]              |
              [Respond 200,   [IF: was this a fresh insert?]
               needs_review]    /                  \
                              FALSE                TRUE
                                |                     |
                        [Postgres: log      [Code: Build Scoring Prompt]  <-- prompt.js, sanitize.js
                         DUPLICATE_FOUND]         |
                        [Respond 200,       [HTTP Request: Ollama /api/chat]
                         duplicate]               |
                                            [Code: Parse Score (attempt 1)]  <-- scoreParse.js
                                                   |
                                             [IF: parsed ok?]
                                              /            \
                                           FALSE           TRUE
                                             |                |
                                [Code: Build Scoring Prompt,   |
                                 strict retry]                 |
                                       |                       |
                                [HTTP Request: Ollama, again]  |
                                       |                       |
                                [Code: Parse Score (attempt 2)]|
                                       |                       |
                                 [IF: parsed ok?]               |
                                  /          \                 |
                               FALSE         TRUE               |
                                 |             \                |
                    [Code: Score Failure   [Code: Apply Score]  |
                     Patch]  <-- scoreParse.js         (both join here)
                                 |             /
                          [Postgres: UPDATE lead with score/temperature]
                          [Postgres: log AI_SCORE_CREATED or AI_SCORE_INVALID]
                                 |
                          [IF: lead_temperature == 'HOT']
                           /                        \
                        FALSE                      TRUE
                          |                           |
                    [Respond 200]          [IF: {{$env.DRY_RUN}} == 'true']
                                             /                    \
                                          TRUE                   FALSE
                                            |                       |
                                    [Postgres: log          [Slack: send HOT alert]
                                     SLACK_ALERT_SENT,       [Postgres: log
                                     status SKIPPED]          SLACK_ALERT_SENT,
                                            |                 status SUCCESS]
                                      [Respond 200]                |
                                                              [Respond 200]
```

Every `[Code: ...]` node's body is one file from `dist/nodes/` (or two,
concatenated — see step 3). Every `[Postgres: ...]` node is n8n's built-in
Postgres node running the query given in the matching section below. Nothing
in this canvas calls `src/adapters/*.js` — those files have imports, so a Code
node cannot run them; `dist/nodes/` exists precisely because the adapters
can't be pasted.

---

## 2. Node-by-node

### 2.1 Webhook

- **Node:** Webhook
- **Method:** POST
- **Path:** `lead-intake` (or your choice — matches the `curl` example below)
- **Respond:** "Using Respond to Webhook Node" — every branch below ends in an
  explicit `Respond to Webhook` node, so the caller always gets a real status
  code rather than n8n's default 200.

### 2.2 Code: Auth Check

Paste **`dist/nodes/webhookAuth.js`** verbatim, then append:

```js
const receivedToken = $input.first().json.headers['x-lead-token'] ?? null;
const expectedSecret = $env.WEBHOOK_SECRET;

const result = verifyWebhookToken({ receivedToken, expectedSecret });

return [{ json: { ...$input.first().json, authorized: result.authorized, authReason: result.reason } }];
```

**Never** log `receivedToken` or `expectedSecret` anywhere in this node or any
node downstream of it — section 4.1 is explicit about this, and
`webhookAuth.js`'s own tests assert the token never appears in its return
value.

### 2.3 IF: authorized?

Condition: `{{$json.authorized}}` is `true`.

**FALSE branch:**
- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details, error_message) VALUES ('WORKFLOW_ERROR', 'FAILURE', NULL, $1, $2)`, parameters built from `buildAuthFailureEvent($json.authReason)` (call it in a small preceding Code node, or inline the four `REASON_MESSAGES` strings — either way, never pass the raw header through).
- **Respond to Webhook** — status `401`, body `{"error": "unauthorized"}`.

### 2.4 Code: Normalize + Validate

Paste **`dist/nodes/normalize.js`** then **`dist/nodes/validate.js`**
(concatenation is safe — confirmed zero cross-core imports, see
`src/adapters/crmInterface.md`'s discussion of independent pasteability), then:

```js
const payload = $input.first().json.body;

const { fields, rawMessage } = normalizeLead('website', payload, {});
const lead = { ...fields, message: rawMessage };
const validation = validateLead(lead);

return [{ json: { lead, validation } }];
```

### 2.5 IF: valid?

Condition: `{{$json.validation.ok}}` is `true`.

**FALSE branch:**
- **Postgres node** — `INSERT INTO lead_events (event_type, status, details, error_message) VALUES ('VALIDATION_FAILED', 'FAILURE', $1, $2)`, `details` = `{{JSON.stringify($json.validation.errors)}}`.
- **Respond to Webhook** — status `200`, body noting the lead needs human review (spec 5.3's rule — a validation failure never drops the lead outright at this layer either, but section 9's minimum slice does not require inserting an unvalidated row; document this as a known M4 boundary, tightened if a later milestone needs it).

### 2.6 Code: Build Dedupe Key

Paste **`dist/nodes/dedupe.js`**, then:

```js
const lead = $input.first().json.lead;
const built = buildDedupeKey(lead, { now: new Date() });

return [{ json: { ...lead, dedupe_key: built.key, needs_human_review: built.needsHumanReview, review_reason: built.reviewReason } }];
```

### 2.7 Postgres: Upsert Lead

One parameterized query does the insert-or-merge section 7 describes, and the
`xmax = 0` column is the standard Postgres idiom for "was this row just
inserted" — Postgres tags an updated row's `xmax` with the updating
transaction, while a fresh insert leaves it at `0`. That is what gates
scoring and the Slack alert: a duplicate never reaches either.

```sql
INSERT INTO leads (
  source, source_id, first_name, last_name, email, phone, company,
  service_interest, message, budget_raw, budget_amount, budget_currency,
  timeline, dedupe_key, needs_human_review, review_reason, raw_payload
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
)
ON CONFLICT (dedupe_key) DO UPDATE SET
  first_name       = COALESCE(leads.first_name, EXCLUDED.first_name),
  last_name        = COALESCE(leads.last_name, EXCLUDED.last_name),
  email            = COALESCE(leads.email, EXCLUDED.email),
  phone            = COALESCE(leads.phone, EXCLUDED.phone),
  company          = COALESCE(leads.company, EXCLUDED.company),
  service_interest = COALESCE(leads.service_interest, EXCLUDED.service_interest),
  budget_raw       = COALESCE(leads.budget_raw, EXCLUDED.budget_raw),
  budget_amount    = COALESCE(leads.budget_amount, EXCLUDED.budget_amount),
  timeline         = COALESCE(leads.timeline, EXCLUDED.timeline),
  message_history  = CASE
                        WHEN EXCLUDED.message IS NOT NULL AND EXCLUDED.message <> leads.message
                        THEN leads.message_history || jsonb_build_array(EXCLUDED.message)
                        ELSE leads.message_history
                      END
  -- Deliberately absent from this SET list: lead_score, lead_temperature,
  -- crm_status, followup_status, followup_step, next_followup_at. Section 7:
  -- a duplicate must not be re-scored or have its follow-up sequence
  -- restarted. This mirrors mockCrm.js/supabaseCrm.js exactly — see
  -- tests/helpers/crm-contract-suite.js "never overwrites a field that
  -- already had a value" and "does not re-score the lead".
RETURNING *, (xmax = 0) AS inserted;
```

Bind `$1..$17` from the Code node's output (`first_name`, `last_name`, …,
`dedupe_key`, `needs_human_review`, `review_reason`, and `raw_payload` = the
original webhook body as JSON).

### 2.8 IF: was this a fresh insert?

Condition: `{{$json.inserted}}` is `true`.

**FALSE branch (duplicate):**
- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details) VALUES ('DUPLICATE_FOUND', 'SUCCESS', $1, $2)`.
- **Respond to Webhook** — status `200`, body noting the duplicate. **No scoring node runs. No Slack node runs.** This is the second half of the M4 acceptance test.

**TRUE branch:** continue to scoring.

### 2.9 Code: Build Scoring Prompt

Paste **`dist/nodes/sanitize.js`** then **`dist/nodes/prompt.js`**, then:

```js
const lead = $input.first().json;
const prepared = prepareUntrustedText(lead.message);
const built = buildScoringPrompt({ ...lead, message: prepared.value });

return [{ json: { ...lead, sanitized: prepared, systemPrompt: built.systemPrompt, userPrompt: built.userPrompt } }];
```

### 2.10 HTTP Request: Ollama

- **Method:** POST
- **URL:** `{{$env.OLLAMA_BASE_URL}}/api/chat`
- **Body (JSON):**
  ```json
  {
    "model": "{{$env.OLLAMA_MODEL}}",
    "messages": [
      { "role": "system", "content": "{{$json.systemPrompt}}" },
      { "role": "user", "content": "{{$json.userPrompt}}" }
    ],
    "stream": false,
    "format": "json",
    "options": { "temperature": 0 }
  }
  ```
- **Timeout:** `{{$env.LLM_TIMEOUT_MS}}` — a hung Ollama call must not hold the
  execution open indefinitely (mirrors `src/adapters/llm/ollamaLlm.js`).

### 2.11 Code: Parse Score

Paste **`dist/nodes/scoreParse.js`** then **`dist/nodes/temperature.js`**, then:

```js
const raw = $input.first().json.message.content; // Ollama's response body
const parsed = parseScoreResponse(raw);

let output = { ok: parsed.ok };
if (parsed.ok) {
  const temperature = scoreToTemperature(parsed.value.score, thresholdsFromEnv({ HOT_SCORE_THRESHOLD: $env.HOT_SCORE_THRESHOLD }));
  output.patch = buildScorePatch(parsed.value, {
    temperature,
    existingReviewReason: $('Build Dedupe Key').first().json.review_reason,
  });
} else {
  output.error = parsed.error;
}

return [{ json: output }];
```

### 2.12 IF: parsed ok?

Condition: `{{$json.ok}}` is `true`.

**FALSE branch — the one retry section 5.3 allows:**
- **Code node**, pasting `prompt.js` again, calling `buildScoringPrompt(lead, { strict: true })` to get `STRICT_RETRY_REMINDER` appended.
- **HTTP Request** — same Ollama call as 2.10, with the strict prompt.
- **Code node** — same parse as 2.11.
- **IF: parsed ok? (second attempt)**
  - **FALSE:** paste `scoreParse.js`, call `buildScoreFailurePatch({ reason: 'invalid_response' })`. This is where **AI_SCORE_INVALID** gets logged and `crm_status` becomes `HUMAN_REVIEW` — the lead still persists (spec 5.3's core guarantee).
  - **TRUE:** join the success path below.

**TRUE branch:** continue directly.

### 2.13 Postgres: Apply Score

```sql
UPDATE leads SET
  lead_score = $1, lead_temperature = $2, ai_reasoning = $3,
  recommended_action = $4, crm_status = $5,
  needs_human_review = $6, review_reason = $7
WHERE lead_id = $8
RETURNING *;
```

Bind from the patch object built in 2.11/2.12 (`buildScorePatch` or
`buildScoreFailurePatch`) plus the `lead_id` from the upsert step (2.7).

Follow with a Postgres insert logging **AI_SCORE_CREATED** (success path) or
**AI_SCORE_INVALID** (failure path), `status` `SUCCESS`/`FAILURE` to match.

### 2.14 IF: HOT?

Condition: `{{$json.lead_temperature}}` equals `HOT`.

**FALSE branch:** **Respond to Webhook**, status `200`. Done — no alert for a
WARM or COLD lead, and none at all for a lead that failed scoring twice
(`lead_temperature` is `null` in that case, so this condition is already
false without an extra check).

**TRUE branch — the HOT alert, respecting `DRY_RUN`:**

- **IF:** `{{$env.DRY_RUN}}` equals `'true'`.
  - **TRUE (default):** **Postgres node** logging `SLACK_ALERT_SENT` with
    `status = 'SKIPPED'` and the message text in `details` — *nothing is
    actually sent*. This is section 12's `DRY_RUN` contract: outbound
    messages are logged, never sent, until a developer deliberately disables
    it.
  - **FALSE:** **Slack node** (Incoming Webhook, `{{$env.SLACK_WEBHOOK_URL}}`)
    actually posts, then a Postgres node logs `SLACK_ALERT_SENT` with
    `status = 'SUCCESS'`.
- **Respond to Webhook**, status `200`.

---

## 3. Concatenating snippets in one Code node

n8n's Code node runs one JS file, so a step needing more than one core module
(2.4, 2.9, 2.11) needs its snippets pasted **in sequence, top to bottom**,
before the node-specific logic at the end. This is safe only because every
`dist/nodes/*.js` file is independently self-contained with zero cross-core
imports (`tests/build-nodes.test.js` proves every module transforms with no
`import`/`export` surviving, and `tests/core-contract.test.js` proves the
source files never import each other to begin with) — pasting two of them
back to back cannot collide.

---

## 4. Environment variables the canvas reads

All already declared in `.env.example` (section 12) — set real values in
n8n's own environment/credentials, never in the canvas itself:

`WEBHOOK_SECRET`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `LLM_TIMEOUT_MS`,
`HOT_SCORE_THRESHOLD`, `DRY_RUN`, `SLACK_WEBHOOK_URL`.

---

## 5. Test curl command

```bash
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H "Content-Type: application/json" \
  -H "X-Lead-Token: $WEBHOOK_SECRET" \
  -d '{
    "email": "ada@example.com",
    "first_name": "Ada",
    "last_name": "Lovelace",
    "company": "Analytical Engines",
    "service_interest": "workflow automation",
    "message": "We need lead routing automated before our launch on the 14th. Budget is $15,000.",
    "budget": "$15,000",
    "timeline": "before the 14th"
  }'
```

Replace `http://localhost:5678` with your n8n instance's URL and
`/webhook/lead-intake` with whatever path you gave the Webhook node in step
2.1. `$WEBHOOK_SECRET` must match what n8n has configured — never commit a
real value; `.env.example` carries only a placeholder.

This payload is deliberately scored HOT by the rubric in `prompt.js` (named
service, stated budget, a concrete near-term deadline) — firing it once
should produce the row/score/Slack-log the acceptance test checks for; firing
the exact same `curl` command again should produce a `DUPLICATE_FOUND` log
entry and nothing else.

---

## Running the acceptance test

1. Run the `curl` command above once. Confirm: one new row in `leads` (its
   `dedupe_key` will be `email:ada@example.com`, per section 7's precedence —
   `source_id` was never supplied), `lead_score`/`lead_temperature` populated,
   and — with `DRY_RUN=true` — a `SLACK_ALERT_SENT` / `SKIPPED` row in
   `lead_events` rather than an actual Slack message. Flip `DRY_RUN=false` and
   fire once more with a different email to see a real Slack message before
   returning it to `true`.
2. Run the identical `curl` command again. Confirm: `leads` has **no** new
   row, and `lead_events` has exactly one new `DUPLICATE_FOUND` row and
   nothing else — no second `AI_SCORE_CREATED`, no second `SLACK_ALERT_SENT`.
3. Query the audit trail for the lead (`SELECT * FROM lead_events WHERE
   lead_id = '<id>' ORDER BY created_at`) — this is the screenshot section 11
   asks for, and the sequence should read cleanly: `CRM_CREATED` →
   `AI_SCORE_CREATED` → `SLACK_ALERT_SENT` → `DUPLICATE_FOUND`.

If any of this diverges, the mismatch is almost always in the wiring, not the
snippets — every `dist/nodes/*.js` file has unit and behavioural-fidelity
tests (`tests/build-nodes.test.js`) proving it behaves identically to its
`src/core/` source.
