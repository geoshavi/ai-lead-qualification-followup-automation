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
 log WORKFLOW_ERROR]  [Code: Build Dedupe Key + Review Patch]  <-- dedupe.js
                            |
                      [IF: dedupe key derivable?]
                       /                  \
                    FALSE                TRUE
                      |                     |
              [Postgres: log        [Postgres: Upsert Lead]  (raw SQL, section 4;
               VALIDATION_FAILED,          |                  crm_status carries
               lead_id = NULL]       [IF: was this a fresh insert?]   HUMAN_REVIEW
              [Respond 200]           /                  \            when invalid)
                                    FALSE                TRUE
                                      |                     |
                          [Postgres: log       [IF: was THIS submission valid?]
                           DUPLICATE_FOUND]        /                    \
                          [Postgres: log        FALSE                 TRUE
                           VALIDATION_FAILED       |                     |
                           if this submission  [Postgres: log   [Code: Build Scoring Prompt]  <-- prompt.js, sanitize.js
                           was itself invalid]  VALIDATION_             |
                          [Respond 200]         FAILED]        [HTTP Request: Ollama /api/chat]
                                                [Respond 200]          |
                                        (no scoring, no follow-up,  [Code: Parse Score (attempt 1)]  <-- scoreParse.js
                                         no Slack for either branch)         |
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
                                 |             |                 |
                  [Postgres: Apply    [Postgres: Apply Score     |
                   Score Failure]      Retry]                    |
                                 |             |                  |
                  [Postgres: Log AI           |          [Postgres: Apply Score]
                   Score Invalid]             |                  |
                                 |              \                /
                  [Respond 200 -                 \              /
                   Score Invalid]         [Postgres: Log AI Score Created]
                  (PENDING/NULL —          (fed by Apply Score and Apply Score
                   Start Follow-up          Retry; INSERT AI_SCORE_CREATED,
                   never runs here)          then returns the current lead row)
                                                       |
                                              [Code: Start Follow-up]  <-- dist/nodes/followup.js
                                                       |             (spec 6.1: intake starts
                                              [Postgres: Update         the sequence and exits;
                                               Follow-up State]          M6 only ever advances
                                                       |                  one already started)
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

Note what does **not** happen here: there is no longer a gate that stops an
invalid lead. `validateLead` already carries everything needed to route it —
`needsHumanReview` and a `reviewReason` string like
`validation_failed:email,contact` — this step just carries `validation`
forward so the next two steps can use it. An invalid lead is never discarded
(scenario 7, section 10): it is persisted, flagged, and routed away from
scoring — never silently dropped.

### 2.5 Code: Build Dedupe Key + Review Patch

Paste **`dist/nodes/dedupe.js`**, then:

```js
const { lead, validation } = $input.first().json;

let built;
let dedupeKeyDerivable = true;
try {
  built = buildDedupeKey(lead, { now: new Date() });
} catch {
  // buildDedupeKey only throws when source_id, email and phone are ALL
  // absent — no identity of any kind, not even the weak name+company+day
  // fallback has anything to hash. Unreachable in practice on this canvas
  // (a `now` is always supplied, so the fallback strategy always succeeds
  // given at least a clock), but handled per spec rather than assumed away.
  dedupeKeyDerivable = false;
}

if (!dedupeKeyDerivable) {
  return [{ json: { lead, validation, dedupeKeyDerivable: false } }];
}

const reasons = [];
if (!validation.ok) reasons.push(validation.reviewReason);
if (built.needsHumanReview) reasons.push(built.reviewReason);

return [{
  json: {
    ...lead,
    validation,
    dedupeKeyDerivable: true,
    dedupe_key: built.key,
    // A validation failure routes the row to a person from the moment it is
    // created — crm_status starts at HUMAN_REVIEW, not the schema default
    // NEW, so it is never mistaken for a lead simply awaiting triage.
    crm_status: validation.ok ? 'NEW' : 'HUMAN_REVIEW',
    needs_human_review: !validation.ok || built.needsHumanReview,
    review_reason: reasons.length > 0 ? reasons.join(',') : null,
  },
}];
```

### 2.6 IF: dedupe key derivable?

Condition: `{{$json.dedupeKeyDerivable}}` is `true`.

**FALSE branch — no identity at all, so there is nothing to persist a row
against:**
- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details, error_message) VALUES ('VALIDATION_FAILED', 'FAILURE', NULL, $1, $2)`, `details` built from `validation.errors`. This is the audit model already in use for a pre-lead failure (spec 3.2 — `lead_id` is nullable exactly for this case; `webhookAuth.js`'s own `buildAuthFailureEvent` does the same thing on an auth rejection).
- **Respond to Webhook** — status `200`.

**TRUE branch (the ordinary case):** continue to the upsert.

### 2.7 Postgres: Upsert Lead

One parameterized query does the insert-or-merge section 7 describes, and the
`xmax = 0` column is the standard Postgres idiom for "was this row just
inserted" — Postgres tags an updated row's `xmax` with the updating
transaction, while a fresh insert leaves it at `0`. That is what gates
scoring and the Slack alert: a duplicate never reaches either, and — new in
this revision — neither does an invalid submission.

```sql
INSERT INTO leads (
  source, source_id, first_name, last_name, email, phone, company,
  service_interest, message, budget_raw, budget_amount, budget_currency,
  timeline, dedupe_key, crm_status, needs_human_review, review_reason, raw_payload
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
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
  -- crm_status, needs_human_review, review_reason, followup_status,
  -- followup_step, next_followup_at. Section 7: a duplicate must not be
  -- re-scored, re-flagged, or have its follow-up sequence restarted — an
  -- existing lead's crm_status/review state is not overwritten by a later,
  -- possibly-invalid resubmission either. This mirrors mockCrm.js/
  -- supabaseCrm.js exactly — see tests/helpers/crm-contract-suite.js "never
  -- overwrites a field that already had a value" and "does not re-score the
  -- lead".
RETURNING *, (xmax = 0) AS inserted;
```

Bind `$1..$18` from the Code node's output (`first_name`, `last_name`, …,
`dedupe_key`, `crm_status`, `needs_human_review`, `review_reason`, and
`raw_payload` = the original webhook body as JSON). `crm_status` is `'NEW'`
for a valid lead and `'HUMAN_REVIEW'` for an invalid one — computed in step
2.5, never left to the column default here.

### 2.8 IF: was this a fresh insert?

Condition: `{{$json.inserted}}` is `true`.

**FALSE branch (duplicate — same dedupe_key as an existing row):**
- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details) VALUES ('DUPLICATE_FOUND', 'SUCCESS', $1, $2)`.
- **IF:** `{{$json.validation.ok}}` is `false` — **also** insert a
  `VALIDATION_FAILED` / `FAILURE` event against the same `lead_id`, `details`
  from `validation.errors`. The two facts are independent: this submission
  was invalid, *and* it turned out to describe someone already on file. Both
  get recorded; neither is scored and no Slack node runs either way.
- **Respond to Webhook** — status `200`.

**TRUE branch (fresh row):** continue to 2.9.

### 2.9 IF: was this submission valid?

Condition: `{{$json.validation.ok}}` is `true`.

**FALSE branch — the row now exists, flagged, and stops here:**
- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details, error_message) VALUES ('VALIDATION_FAILED', 'FAILURE', $1, $2, $3)`, `lead_id` from the upsert's `RETURNING`, `details` from `validation.errors`.
- **Respond to Webhook** — status `200`. **No scoring node runs. No Slack node runs. No follow-up is started** — `followup_status` stays at its schema default `PENDING` and `next_followup_at` stays `NULL`, so the M6 scheduler's due-query (`followup_status = 'IN_PROGRESS'`) never picks this row up until a person clears the review and starts it deliberately.

**TRUE branch:** continue to scoring.

### 2.10 Code: Build Scoring Prompt

Paste **`dist/nodes/sanitize.js`** then **`dist/nodes/prompt.js`**, then:

```js
const lead = $input.first().json;
const prepared = prepareUntrustedText(lead.message);
const built = buildScoringPrompt({ ...lead, message: prepared.value });

return [{ json: { ...lead, sanitized: prepared, systemPrompt: built.systemPrompt, userPrompt: built.userPrompt } }];
```

### 2.11 HTTP Request: Ollama

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

**Optional: pointing this node at a hosted provider instead.** `LLM_PROVIDER`
adapter selection (section 5.0) is a Node-side concept this canvas never
calls — the canvas always talks to a provider directly over this one HTTP
Request node, wired by hand. Ollama is the $0 default and the only wiring this
guide documents in full. Repointing this same node at Anthropic (`POST
https://api.anthropic.com/v1/messages`, headers `x-api-key` and
`anthropic-version: 2023-06-01`, the system prompt as a top-level `system`
field, no `temperature`/`top_p`) is a config-only swap of this node alone —
see `src/adapters/llm/llmInterface.md`'s per-provider request-shape table for
the exact Anthropic and OpenAI shapes. It changes nothing else on the canvas
and nothing in `src/core/`. Treat a hosted-provider run as the optional,
current-demo path, not the default the acceptance test above assumes.

### 2.12 Code: Parse Score

Paste **`dist/nodes/scoreParse.js`** then **`dist/nodes/temperature.js`**, then:

```js
const raw = $input.first().json.message.content; // Ollama's response body
const parsed = parseScoreResponse(raw);

let output = { ok: parsed.ok };
if (parsed.ok) {
  const temperature = scoreToTemperature(parsed.value.score, thresholdsFromEnv({ HOT_SCORE_THRESHOLD: $env.HOT_SCORE_THRESHOLD }));
  output.patch = buildScorePatch(parsed.value, {
    temperature,
    existingReviewReason: $('Build Dedupe Key + Review Patch').first().json.review_reason,
  });
} else {
  output.error = parsed.error;
}

return [{ json: output }];
```

### 2.13 IF: parsed ok?

Condition: `{{$json.ok}}` is `true`.

**FALSE branch — the one retry section 5.3 allows:**
- **Code node**, pasting `prompt.js` again, calling `buildScoringPrompt(lead, { strict: true })` to get `STRICT_RETRY_REMINDER` appended.
- **HTTP Request** — same Ollama call as 2.11, with the strict prompt.
- **Code node** — same parse as 2.12.
- **IF: parsed ok? (second attempt)**
  - **FALSE:** paste `scoreParse.js`, call `buildScoreFailurePatch({ reason: 'invalid_response' })`, then continue to **Apply Score Failure** (2.14) — `crm_status` becomes `HUMAN_REVIEW` there and **AI_SCORE_INVALID** is logged by **Log AI Score Invalid** right after; the lead still persists (spec 5.3's core guarantee).
  - **TRUE:** continue to **Apply Score Retry** (2.14).

**TRUE branch:** continue to **Apply Score** (2.14).

### 2.14 Postgres: Apply Score

2.13's two `parsed ok?` checks resolve into exactly one of two branches from
here: a successful score (either attempt) applies and logs on the path that
continues to Start Follow-up (2.15); a twice-failed score applies and logs
on its own separate path that responds immediately instead.

**Success — either `parsed ok?` was `TRUE`:**

- **Postgres node — `Apply Score`** (wired from the first attempt's `TRUE`)
  and **`Apply Score Retry`** (wired from the second attempt's `TRUE`) are
  two separate node instances running the identical query below — n8n
  needs one node per incoming branch here, since nothing upstream merges
  them first:

  ```sql
  UPDATE leads SET
    lead_score = $1, lead_temperature = $2, ai_reasoning = $3,
    recommended_action = $4, crm_status = $5,
    needs_human_review = $6, review_reason = $7
  WHERE lead_id = $8
  RETURNING *;
  ```

  Bind from the patch object built in 2.12 (`buildScorePatch`) plus the
  `lead_id` from the upsert step (2.7).

- **Postgres node — `Log AI Score Created`**, fed by both nodes above.
  Logs the event and hands back the row Start Follow-up (2.15) reads, in
  one statement — the `CROSS JOIN` forces the CTE's `INSERT` to run before
  the final `SELECT`, whose row becomes this node's output:

  ```sql
  WITH logged AS (
    INSERT INTO lead_events (
      lead_id,
      event_type,
      status,
      details
    )
    VALUES (
      $1,
      'AI_SCORE_CREATED',
      'SUCCESS',
      $2::jsonb
    )
    RETURNING 1
  )
  SELECT l.*
  FROM leads l
  CROSS JOIN logged
  WHERE l.lead_id = $1;
  ```

  **Query Parameters:**

  ```
  {{ [
    $('Upsert Lead').first().json.lead_id,
    JSON.stringify({
      score: $json.lead_score,
      temperature: $json.lead_temperature,
      reasoning: $json.ai_reasoning
    })
  ] }}
  ```

  `$1` is the lead's `lead_id` from **Upsert Lead** (2.7); `$2` is a JSON
  object built from the current item's `lead_score`/`lead_temperature`/
  `ai_reasoning` — the columns `Apply Score`/`Apply Score Retry` just
  returned. `$('Log AI Score Created').first().json` downstream is this
  query's `SELECT` row: the full current `leads` row, not the insert.

**Failure — the second `parsed ok?` was `FALSE`:**

- **Postgres node — `Apply Score Failure`**: the same `UPDATE leads SET
  ...` shape as above, bound from `buildScoreFailurePatch` instead —
  `lead_score`/`lead_temperature`/`ai_reasoning`/`recommended_action` come
  back `NULL`, `crm_status` is `HUMAN_REVIEW`, `needs_human_review` is
  `true`, `review_reason` records why.
- **Postgres node — `Log AI Score Invalid`**:

  ```sql
  INSERT INTO lead_events (
    lead_id,
    event_type,
    status,
    details,
    error_message
  )
  VALUES (
    $1,
    'AI_SCORE_INVALID',
    'FAILURE',
    $2::jsonb,
    $3
  );
  ```

  **Query Parameters:**

  ```
  {{ [
    $('Upsert Lead').first().json.lead_id,
    JSON.stringify({ reason: 'invalid_response_after_retry' }),
    'LLM returned invalid scoring JSON after retry'
  ] }}
  ```

  `$1` is the lead's `lead_id` from **Upsert Lead** (2.7); `$2` is a fixed
  `{ reason: 'invalid_response_after_retry' }` details object; `$3` is a
  fixed, human-readable `error_message` — a real, populated column here,
  unlike `Log AI Score Created`. This node doesn't need to hand back the
  lead row: nothing downstream of the failure branch reads it.
- **Respond to Webhook — `Respond 200 - Score Invalid`**, status `200`.
  This branch never reaches Start Follow-up: `followup_status` stays at
  its schema default `PENDING` and `next_followup_at` stays `NULL` — the
  same reasoning as the validation-failure branch (2.4) — a person clears
  the review and starts the sequence deliberately (spec 5.3's core
  guarantee: the lead still persists either way).

### 2.15 Code: Start Follow-up

This node sits directly after **Log AI Score Created** on the shared
success path and feeds **Update Follow-up State** (2.16) next —
`Log AI Score Created → Start Follow-up → Update Follow-up State → HOT?`,
with nothing branching in between. AI_SCORE_INVALID leads never reach this
node: they already exited on their own failure branch
(`Apply Score Failure → Log AI Score Invalid → Respond 200 - Score Invalid`),
so every lead here carries a real, non-null `lead_temperature`.

Paste **`dist/nodes/followup.js`**, then:

```js
const lead = $('Log AI Score Created').first().json;

const patch = startFollowup(lead, { now: new Date(), timeZone: $env.BUSINESS_TZ });

return [{ json: { lead, patch: { followup_step: 0, ...patch } } }];
```

Section 6.1 is explicit about the division of labour this step exists for:
*"the intake workflow writes `next_followup_at` to the leads table and
exits"* — starting the sequence is the intake canvas's job, not the M6
scheduler's (`docs/scheduler.md`). The scheduler only ever **advances** a
lead whose `followup_status` is already `IN_PROGRESS`; nothing here sends a
message or logs `FOLLOWUP_SENT` — step 0's `next_followup_at` is computed as
"immediate" (clamped to business hours), so the scheduler's own next tick
picks this lead up and sends step 0 through its normal path within 15
minutes (spec 6.1). Logging that send twice — once here, once from the
scheduler — is exactly the mistake this split avoids.

There is deliberately no new audit event type for "follow-up started": the
section 3.2 enumeration has none, and inventing one would be a data-model
change this milestone does not need — the state change is visible in the
row itself, exactly like `crm_status` moving to `HUMAN_REVIEW` is not its
own logged event either.

### 2.16 Postgres: Update Follow-up State

```sql
UPDATE leads SET
  followup_status = $1, followup_step = $2, next_followup_at = $3
WHERE lead_id = $4
RETURNING *;
```

Bind `$1..$3` from `{{$json.patch}}`, `$4` from the lead's `lead_id`. Runs
unconditionally — every execution reaching this node already carries a real
`startFollowup` patch, since AI_SCORE_INVALID leads exited on their own
failure branch before Start Follow-up ever ran, so there is no `IF` node
here to wire.

### 2.17 IF: HOT?

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
(2.4, 2.10, 2.12) needs its snippets pasted **in sequence, top to bottom**,
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
`HOT_SCORE_THRESHOLD`, `DRY_RUN`, `SLACK_WEBHOOK_URL`, `BUSINESS_TZ` (step
2.15's business-hours clamping).

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

### 5.1 Test curl command — an invalid submission (scenario 7)

```bash
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H "Content-Type: application/json" \
  -H "X-Lead-Token: $WEBHOOK_SECRET" \
  -d '{
    "email": "not-an-email",
    "first_name": "Grace",
    "message": "Interested in your services."
  }'
```

No phone, and an email that fails format validation — `validateLead` rejects
it on both `email` (`INVALID_FORMAT`) and `contact` (`NO_CONTACT_METHOD`, since
an invalid email does not count as a usable one). It is still a non-empty
string though, so `buildDedupeKey` uses it as-is (`email:not-an-email`) —
dedupe key derivation only cares whether a field is *present*, never whether
it is *valid* (spec 7 defines precedence, not format). Confirm: one new row
in `leads` with `crm_status = 'HUMAN_REVIEW'`, `needs_human_review = true`,
`review_reason` containing `validation_failed:email,contact`, and
`lead_score`/`lead_temperature` both `NULL` — no scoring ever ran. `lead_events`
gets one `VALIDATION_FAILED` row against that `lead_id`. No `SLACK_ALERT_SENT`
row is written at all, `DRY_RUN` or not — the HOT-check never runs for a lead
that was never scored.

---

## Running the acceptance test

1. Run the `curl` command above once. Confirm: one new row in `leads` (its
   `dedupe_key` will be `email:ada@example.com`, per section 7's precedence —
   `source_id` was never supplied), `lead_score`/`lead_temperature` populated,
   `followup_status = 'IN_PROGRESS'` with `followup_step = 0` and
   `next_followup_at` set to a near-immediate business-hours timestamp (step
   2.15 — the M6 scheduler's next tick, within 15 minutes, is what actually
   sends step 0; nothing here does), and — with `DRY_RUN=true` — a
   `SLACK_ALERT_SENT` / `SKIPPED` row in `lead_events` rather than an actual
   Slack message. Flip `DRY_RUN=false` and fire once more with a different
   email to see a real Slack message before returning it to `true`.
2. Run the identical `curl` command again. Confirm: `leads` has **no** new
   row, and `lead_events` has exactly one new `DUPLICATE_FOUND` row and
   nothing else — no second `AI_SCORE_CREATED`, no second `SLACK_ALERT_SENT`.
3. Query the audit trail for the lead (`SELECT * FROM lead_events WHERE
   lead_id = '<id>' ORDER BY created_at`) — this is the screenshot section 11
   asks for, and the sequence should read cleanly: `CRM_CREATED` →
   `AI_SCORE_CREATED` → `SLACK_ALERT_SENT` → `DUPLICATE_FOUND`.
4. Run the [invalid-submission `curl` command](#51-test-curl-command--an-invalid-submission-scenario-7)
   once. Confirm: one new row, `crm_status = 'HUMAN_REVIEW'`,
   `lead_score IS NULL`, `followup_status = 'PENDING'` with
   `next_followup_at IS NULL` (never started — step 2.15 is never reached on
   this branch), and exactly one `VALIDATION_FAILED` row in `lead_events` —
   no `AI_SCORE_CREATED`, no `SLACK_ALERT_SENT`, either way. The lead was
   never dropped (scenario 7, section 10).

If any of this diverges, the mismatch is almost always in the wiring, not the
snippets — every `dist/nodes/*.js` file has unit and behavioural-fidelity
tests (`tests/build-nodes.test.js`) proving it behaves identically to its
`src/core/` source.
