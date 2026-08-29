# M6 build guide — the follow-up scheduler

**You build this canvas by hand in n8n. Nothing here builds it for you.**
This document is the node-by-node instructions and the paste-ready code; the
agent that wrote it cannot click an n8n canvas (PROJECT_SPEC.md section 0).

Scope, verbatim from PROJECT_SPEC.md section 9 (M6): *cron workflow,
due-lead query, idempotent send, step advancement, stop conditions.* This is
the **second** workflow in the project — separate from the M4 website-intake
canvas, on purpose (section 6.1): a `Wait` node would hold an execution open
across the hours or days between follow-ups, would not survive an n8n
restart, and could not be inspected or cancelled. Instead, intake writes
`next_followup_at` and exits; this workflow polls for due rows on a timer.
State lives in the database, not in a suspended execution.

**Done when** (section 9, verbatim): *"a seeded lead with a past
`next_followup_at` advances exactly one step per run and stops correctly at
every stop condition."* Unlike M4, section 9 assigns this milestone no
curl/live-canvas deliverable — "seeded" is a database precondition, not a
webhook call, and `tests/scheduler.test.js` already proves the underlying
logic against `mockCrm`. What only a human can still do is build the canvas
below and confirm it reproduces that same result against a real Postgres —
see [Running the acceptance test](#running-the-acceptance-test).

---

## 0. Prerequisites

| Needed | Why | $0 option |
|---|---|---|
| The M4 canvas already built and reachable | this workflow only ever sees a lead that M4's intake already scored | `docs/workflow.md` |
| A reachable Postgres with `db/001_schema.sql` + `002_indexes.sql` applied | due-query, notification claim, lead update | the same container M4 uses — see `src/adapters/crmInterface.md` |
| Ollama, with a model pulled | writes the follow-up wording | already running per M4's setup |
| `npm run build:nodes` run since this milestone | `dist/nodes/followupPrompt.js` exists | `cd` to the repo root, run it once |
| A **second** n8n workflow, not a branch on the first | section 6.1 requires a *separate* scheduler workflow | create a new workflow in the same n8n instance |

`DRY_RUN` does not gate anything in this workflow. Unlike the M4 canvas's
Slack alert, there is no external channel here for a follow-up message to
go out on — this project integrates no email/SMS provider (`PROJECT_SPEC.md`
section 12 declares none), so "send" **is** the audit-log write: generating
the wording and recording it in `lead_events.details` (section 6.4: *"every
generated message is stored in `lead_events.details` so the demo can show
exactly what went out"*). Section 12's `DRY_RUN` contract — logging instead
of calling an external API — has nothing further to gate here; the LLM call
that writes the wording is not itself an outbound message, exactly as
scoring's LLM call in M4 is never `DRY_RUN`-gated either. Spec-silent, and
the cheapest choice to revise later if a real outbound channel is ever
added: nothing above would need to change, only a new step appended after
the `FOLLOWUP_SENT` log.

---

## 1. Canvas shape

```
[Schedule Trigger: every 15 minutes]                          (spec 6.1)
        |
[Postgres: Due-Lead Query]                                    (spec 6.1, verbatim)
        |
[Loop Over Items]  <-- one due lead per iteration
        |
[Code: Evaluate Stop Conditions]  <-- dist/nodes/followup.js
        |
   [IF: stop?]
    /        \
  TRUE       FALSE
    |            |
[Postgres:   [Postgres: Claim Notification]        (INSERT ... ON CONFLICT
 apply stop        |                                 DO NOTHING RETURNING —
 patch]      [IF: claimed? (a row came back)]        spec 3.3)
    |          /              \
[Postgres:  FALSE             TRUE
 log            |               |
 FOLLOWUP_   (loop         [Code: Build Follow-up Prompt]  <-- sanitize.js,
 STOPPED)     continues:         |                            followup.js
    |         already sent  [HTTP Request: Ollama /api/chat]  (totalSteps),
(loop          this step,         |                            followupPrompt.js
 continues)    nothing to do  [Code: Extract Message Text]
                                   |
                             [Postgres: log FOLLOWUP_SENT, message in details]
                                   |
                             [Code: Compute Advance Patch]  <-- dist/nodes/followup.js
                                   |
                             [Postgres: UPDATE lead with patch]
                                   |
                             [IF: patch.stop_reason present?]
                              /                        \
                           TRUE                       FALSE
                             |                            |
                       [Postgres: log                (loop continues)
                        FOLLOWUP_STOPPED]
                             |
                       (loop continues)
```

Every `[Code: ...]` node's body is one or more files from `dist/nodes/`,
pasted in sequence (section 3 of `docs/workflow.md` explains why
concatenation is safe: zero cross-core imports, proven by
`tests/core-contract.test.js` and `tests/build-nodes.test.js`). Every
`[Postgres: ...]` node is n8n's built-in Postgres node — nothing here calls
`src/adapters/*.js` either, for the same reason M4 does not (section 1: a
Code node cannot `require()` a file with imports).

---

## 2. Node-by-node

### 2.1 Schedule Trigger

Interval: every 15 minutes (spec 6.1, literal). Any n8n Cron/Schedule
Trigger node satisfies this; the number is what matters, not the node name.

### 2.2 Postgres: Due-Lead Query

```sql
SELECT * FROM leads
 WHERE next_followup_at <= now()
   AND followup_status = 'IN_PROGRESS'
   AND booking_status <> 'BOOKED'
   AND crm_status NOT IN ('LOST','BOOKED')
 ORDER BY next_followup_at ASC;
```

Verbatim from spec 6.1, with the ordering `listDueFollowups` already
documents (`src/adapters/crmInterface.md`) — oldest due first, deterministic.
This single query is the entire "which leads need attention" decision; no
Code node re-derives it.

### 2.3 Loop Over Items

n8n's batching/loop node (named "Loop Over Items" in current versions,
"Split In Batches" in older ones), batch size 1. One lead at a time, so one
failing row cannot take the rest of a due batch down with it, and so the
notification claim below is meaningfully scoped to a single lead per
iteration rather than an array.

### 2.4 Code: Evaluate Stop Conditions

Paste **`dist/nodes/followup.js`**, then:

```js
const lead = $input.first().json;
const stop = evaluateStopConditions(lead);

return [{ json: { lead, stop } }];
```

This runs **before** the notification claim, not after — a reply or a
booking that arrived since this lead's `next_followup_at` was last computed
must pre-empt the send entirely (spec 6.3), not just pre-empt scheduling the
*next* one. `listDueFollowups`'s own `WHERE` clause already excludes
`booking_status = BOOKED` and `crm_status IN (LOST, BOOKED)` at the query
level; this check is what also catches `replied_at` and "final step already
sent", neither of which the due-query filters on.

### 2.5 IF: stop?

Condition: `{{$json.stop.stop}}` is `true`.

**TRUE branch:**

- **Postgres node** — `UPDATE leads SET followup_status = $1, next_followup_at = NULL WHERE lead_id = $2 RETURNING *`, bound from `{{$json.stop.followup_status}}` and the lead's `lead_id`.
- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details) VALUES ('FOLLOWUP_STOPPED', 'SUCCESS', $1, $2)`, `details` = `{ "reason": "{{$json.stop.reason}}" }`.
- Loop continues to the next due lead. **No notification is claimed, no message is generated, nothing sends.**

**FALSE branch:** continue to 2.6.

### 2.6 Postgres: Claim Notification

```sql
INSERT INTO notifications (lead_id, kind, step)
VALUES ($1, 'FOLLOWUP', $2)
ON CONFLICT (lead_id, kind, step) DO NOTHING
RETURNING id, sent_at;
```

Bind `$1` from the lead's `lead_id`, `$2` from `{{$json.lead.followup_step}}`
— the step that is due **right now** is whatever `followup_step` already
holds; nothing has advanced yet. Zero rows back means the `UNIQUE (lead_id,
kind, step)` constraint already holds one for this exact step: it was
already sent, by this run or an earlier one, and this is where spec 3.3's
guarantee becomes visible on the canvas — "before sending anything, attempt
the insert; if it violates the constraint, the message was already sent —
skip." `src/adapters/mockCrm.js`'s `claimNotification` and
`src/adapters/supabaseCrm.js`'s implement the identical rule for the
automated suite; this query is what they both model.

### 2.7 IF: claimed?

Condition: the Postgres node above returned a row (n8n surfaces this as a
non-empty output; equivalently, `{{$json.id}}` is not empty).

**FALSE branch:** loop continues to the next due lead. This step was already
sent — correctly doing nothing is the entire point.

**TRUE branch:** continue to 2.8.

### 2.8 Code: Build Follow-up Prompt

Paste **`dist/nodes/sanitize.js`**, then **`dist/nodes/followup.js`**, then
**`dist/nodes/followupPrompt.js`**, then:

```js
const lead = $('Evaluate Stop Conditions').first().json.lead;
const sanitized = prepareUntrustedText(lead.message);
const total = totalSteps(lead.lead_temperature);
const built = buildFollowupPrompt({ lead: { ...lead, message: sanitized.value }, step: lead.followup_step, totalSteps: total });

return [{ json: { lead, systemPrompt: built.systemPrompt, userPrompt: built.userPrompt } }];
```

`lead.message` is stored **raw** — M4 never persists the sanitized form (see
`docs/workflow.md` step 2.10) — so spec 4.2 applies here exactly as it does
at scoring time: sanitize fresh, at the point the text reaches a prompt,
rather than trusting a column that was only ever cleaned for a different
prompt on a different day.

### 2.9 HTTP Request: Ollama

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
    "stream": false
  }
  ```
  No `"format": "json"` here, unlike the scoring call in `docs/workflow.md`
  2.11 — this prompt asks for prose, and constraining it to JSON would ask
  Ollama for the wrong shape of output entirely.
- **Timeout:** `{{$env.LLM_TIMEOUT_MS}}`, same reasoning as the scoring call.
- **Optional: pointing this node at a hosted provider instead.** Same
  config-only swap `docs/workflow.md` 2.11 documents for the scoring call —
  Anthropic's `/v1/messages` endpoint, `x-api-key` + `anthropic-version`
  headers, system prompt as a top-level field, no `temperature`/`top_p`. See
  `src/adapters/llm/llmInterface.md`'s per-provider table. Ollama remains the
  $0 default this guide documents in full.
- **Retry On Fail verified live** (live-named **Claude Follow-up**): Settings
  → Retry On Fail is ON, Max Tries `3`, Wait `1000ms`, On Error: Stop
  Workflow — same n8n node-level mechanism `docs/workflow.md` §2.11
  documents, distinct from `src/core/retry.js`'s code-level policy (spec 9,
  M8, commit `5cb3a10`), which no canvas node here calls either.

### 2.10 Code: Extract Message Text

```js
const raw = $input.first().json.message.content; // Ollama's response body
const text = typeof raw === 'string' ? raw.trim() : '';

if (text === '') {
  throw new Error('follow-up message generation returned no text');
}

return [{ json: { ...$('Build Follow-up Prompt').first().json, message: text } }];
```

An empty completion fails the node loudly rather than logging a blank
`FOLLOWUP_SENT` — the same "fail loudly, do not half-populate" instinct
`normalize.js` documents for an unmapped source. Retry-on-fail belongs on
**Claude Follow-up** (2.9), not here — confirmed live (see 2.9's own note) —
because that is where the actual external call is; nothing here needs to
duplicate scoring's two-attempt retry, because there is no structured
output to have failed parsing — "the model returned words" is the entire
correctness bar for free text.

### 2.11 Postgres: log FOLLOWUP_SENT

```sql
INSERT INTO lead_events (event_type, status, lead_id, details)
VALUES ('FOLLOWUP_SENT', 'SUCCESS', $1, $2);
```

`$2` (`details`) = `{ "step": <followup_step>, "message": "<the text from 2.10>" }`.
This row is section 6.4's guarantee: *"every generated message is stored in
`lead_events.details` so the demo can show exactly what went out."*

### 2.12 Code: Compute Advance Patch

Paste **`dist/nodes/followup.js`**, then:

```js
const lead = $('Build Follow-up Prompt').first().json.lead;

const patch = advanceFollowup(lead, {
  now: new Date(),
  // Anchored to when the lead was CREATED, not to "now" — followup.js
  // measures every step from one fixed point (spec 6.2): if this workflow
  // is down for six hours, an anchored schedule catches up on the next due
  // step immediately rather than pushing it a further full cadence-interval
  // out from whenever this late send happened to run. `created_at` is the
  // same instant the M4 canvas implicitly used as step 0's anchor (a lead is
  // scored synchronously right after intake), so reusing it needs no new
  // column — see tests/scheduler.test.js for the same reasoning verified
  // against a frozen clock.
  anchor: new Date(lead.created_at),
  timeZone: $env.BUSINESS_TZ,
});

return [{ json: { lead, patch } }];
```

### 2.13 Postgres: UPDATE lead with patch

```sql
UPDATE leads SET
  followup_step = $1, followup_status = $2, next_followup_at = $3, last_contacted_at = $4
WHERE lead_id = $5
RETURNING *;
```

Bind `$1..$4` from `{{$json.patch}}`, `$5` from the lead's `lead_id`. This is
the one and only place `followup_step` moves forward — exactly once per due
lead per run, which is the literal acceptance test.

### 2.14 IF: patch.stop_reason present?

Condition: `{{$json.patch.stop_reason}}` is not empty.

**TRUE branch** — the cadence table ran out (`stop_reason: 'sequence_complete'`,
section 6.3's *"the final step has been sent"*):

- **Postgres node** — `INSERT INTO lead_events (event_type, status, lead_id, details) VALUES ('FOLLOWUP_STOPPED', 'SUCCESS', $1, $2)`, `details` from `{{$json.patch.stop_reason}}`.

**FALSE branch:** nothing further — `next_followup_at` already holds the
next due time; the next scheduler tick that reaches it picks the lead back
up.

Either way, loop continues to the next due lead in this run's batch.

---

## 3. Environment variables the canvas reads

Already declared in `.env.example` (section 12); no new variable was added
for this milestone:

`OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `LLM_TIMEOUT_MS`, `BUSINESS_TZ`.

`DRY_RUN` is read by the M4 canvas, not this one — see
[Prerequisites](#0-prerequisites) for why a follow-up "send" has nothing
further for it to gate.

---

## Running the acceptance test

`tests/scheduler.test.js` already proves the logic — due-query, stop-check
ordering, the idempotency claim, step advancement, every stop condition —
against `mockCrm` with a frozen clock. What that suite cannot reach is the
canvas itself. To confirm this build reproduces the same result against a
real Postgres:

1. Seed a lead already mid-sequence and past due, directly in Postgres:
   ```sql
   UPDATE leads
      SET lead_temperature = 'HOT', followup_status = 'IN_PROGRESS',
          followup_step = 0, next_followup_at = now() - interval '1 hour'
    WHERE lead_id = '<a lead_id from a prior M4 acceptance run>'
   RETURNING lead_id, followup_step, next_followup_at;
   ```
2. Execute this workflow once (manually trigger it rather than waiting on
   the schedule). Confirm: `followup_step` is now `1` (not `0`, not `2`),
   `next_followup_at` moved to roughly 24 hours out from `created_at`
   (business-hours clamped), and `lead_events` gained exactly one
   `FOLLOWUP_SENT` row for step `0` with real generated text in `details`.
3. Execute the workflow again immediately, without changing anything.
   Confirm: **zero** new rows in `lead_events` for this lead, and
   `followup_step` unchanged — the due-query no longer returns this lead at
   all, because its `next_followup_at` is now in the future. To exercise the
   *idempotency claim itself* (rather than the due-query's own filter),
   re-run only the "Claim Notification" query by hand for the same
   `(lead_id, 'FOLLOWUP', 0)` and confirm it returns zero rows.
4. Set `next_followup_at` back into the past and set `booking_status =
   'BOOKED'` (or `crm_status = 'LOST'`, or `replied_at = now()`). Execute the
   workflow once more. Confirm: `followup_status` becomes `STOPPED`,
   `next_followup_at` becomes `NULL`, exactly one `FOLLOWUP_STOPPED` row is
   logged with the matching reason, and **no** `FOLLOWUP_SENT` row is
   written — the stop pre-empts the send.
5. Seed a lead on its **last** cadence step (e.g. COLD at step 1) past due.
   Execute the workflow. Confirm: `followup_status` becomes `COMPLETED`,
   `next_followup_at` becomes `NULL`, and **both** a `FOLLOWUP_SENT` row
   (step 1 still gets its message) **and** a `FOLLOWUP_STOPPED` row with
   reason `sequence_complete` are logged — the final step is sent, then the
   sequence stops.

If any of this diverges, the mismatch is almost always in the wiring, not
the snippets — `followup.js`, `followupPrompt.js` and `sanitize.js` all have
unit and behavioural-fidelity tests (`tests/build-nodes.test.js`) proving
each behaves identically to its `src/core/` source, and
`tests/scheduler.test.js` proves the sequence they're wired into here
produces exactly the "done when" result against `mockCrm`.

### Live verification (2026-08-28)

Steps 1–4 above were run against the real stack (n8n + Postgres via
`compose.yaml`, not `mockCrm`), using the HOT lead from `docs/workflow.md`'s
M4 acceptance walkthrough (`vakosh1+schedulertz@gmail.com`):

- **Step 1 (seed):** `followup_step = 0`, `next_followup_at` set 1 hour
  into the past.
- **Step 2 (send):** the due-query picked the lead up. Result:
  `followup_step` advanced `0 → 1`, `last_contacted_at` was set, exactly
  one `FOLLOWUP_SENT` row was logged (`step: 0`, real generated message
  text), and `next_followup_at` advanced to `2026-08-31 16:00:00+00` —
  `09:00 America/Los_Angeles` on the next business day, confirming the
  `BUSINESS_TZ` fix (`docs/workflow.md` §2.14; commits 1478738/93a2370)
  holds through this canvas's `advanceFollowup` path, not just the M4
  intake canvas's `startFollowup`.
- **Step 3 (no double-send):** an immediate second run left `followup_step`
  at `1` and the `FOLLOWUP_SENT` count at exactly `1` — the due-query
  correctly excluded the lead once `next_followup_at` moved into the
  future. (This exercised the due-query's own exclusion; the idempotency
  claim's separate re-check — re-running "Claim Notification" by hand for
  the same `(lead_id, 'FOLLOWUP', 0)` — was not run this pass.)
- **Step 4 (stop on reply):** with `replied_at` set and `next_followup_at`
  forced past-due again, the next run set `followup_status = STOPPED`,
  `next_followup_at = NULL`, logged exactly one `FOLLOWUP_STOPPED` row
  with `reason: "lead_replied"`, and produced **no** second
  `FOLLOWUP_SENT` row — the stop pre-empted the send, matching spec 6.3.

Step 5 (`COMPLETED` on the last cadence step) was **not** exercised this
pass — still covered only by `tests/scheduler.test.js`'s frozen-clock
suite, not live.
