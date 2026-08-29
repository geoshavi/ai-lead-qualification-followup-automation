# M7 build guide — booking + reporting

**You build this canvas by hand in n8n. Nothing here builds it for you.**
This document is the node-by-node instructions and the paste-ready code; the
agent that wrote it cannot click an n8n canvas (PROJECT_SPEC.md section 0).

Scope, verbatim from PROJECT_SPEC.md section 9 (M7): *booking webhook,
follow-up cancellation, Slack confirmation using a free Slack workspace, and
Google Sheets sync using a normal Google account. All outbound paths remain
dry-run capable.* This is the **third** workflow in the project — separate
from the M4 website-intake canvas and the M6 scheduler, on the same reasoning
both of those already established (section 6.1): one workflow per trigger
type, so no execution mixes an inbound webhook's request/response lifecycle
with a cron tick's batch lifecycle.

**Done when** (section 9, verbatim): *"a booking event cancels pending
follow-ups and the Sheet row updates."*

---

## 0. Prerequisites

| Needed | Why | $0 option |
|---|---|---|
| The M4 canvas already built, with at least one scored lead in Postgres | this workflow only ever acts on a lead that already exists | `docs/workflow.md` |
| A reachable Postgres with `db/001_schema.sql` + `002_indexes.sql` applied | lead lookup, booking patch, audit log, notification claim | the same container M4/M6 use — see `src/adapters/crmInterface.md` |
| A Slack incoming webhook URL | booking confirmation message | free Slack workspace, same `SLACK_WEBHOOK_URL` M4's HOT alert already uses — no second secret |
| A Google Sheet, and a Google Sheets credential configured **in n8n itself** | reporting sync | a normal Google account — n8n's built-in Google Sheets node holds its own OAuth2 credential; nothing here is your responsibility to create (section 0) |
| `GOOGLE_SHEET_ID` set to that Sheet's ID | the canvas references the Sheet by ID, not by name | already declared in `.env.example` (section 12) — no new variable |
| `Find Lead by ID`'s node **Settings → Always Output Data** enabled (2.4) | n8n's default is to emit **no output item at all** when the query matches zero rows — the `IF: lead found?` node (2.5) then never executes, and the request silently falls through to an empty `200` instead of the documented `404` | flip the one setting when building this node — confirmed live (see [Live verification](#live-verification-2026-08-29)) |

M6 is not a hard prerequisite — this canvas cancels a sequence directly (2.6
below), independent of whether the scheduler ever runs again for this lead.
Building M6 first only makes the "cancels a *running* sequence" demo more
visible, since there is an actual `next_followup_at` in the future to point at.

---

## 1. Canvas shape

```
[Webhook: POST /booking]
        |
[Code: Auth Check]  <-- dist/nodes/webhookAuth.js
        |
  [IF: authorized?]
   /          \
 FALSE        TRUE
   |            |
[Respond    [Postgres: Find Lead by ID]
 401]              |
             [IF: lead found?]
              /          \
           FALSE        TRUE
             |             |
      [Postgres: log  [Code: Build Booking Patch]  <-- dist/nodes/followup.js
       WORKFLOW_        |
       ERROR]      [Postgres: Apply Booking]  (booking_status, crm_status,
             |            |                     and — only if the sequence was
      [Respond          IN_PROGRESS — the stop fields too)
       404]              |
                   [Postgres: log BOOKING_RECEIVED]
                          |
              [IF: patch included stop fields?]
               /                          \
             TRUE                       FALSE
               |                           |
      [Postgres: log                       |
       FOLLOWUP_STOPPED]                   |
               \                          /
                \________________________/
                          |
             [Postgres: Claim Notification]   (BOOKING_CONFIRM, step 0 —
                          |                     spec 3.3's idempotency guard)
                  [IF: claimed?]
                   /          \
                 FALSE        TRUE
                   |             |
             (skip Slack,  [IF: {{$env.DRY_RUN}} == 'true']
              already        /                  \
              confirmed)   TRUE                FALSE
                   |          |                    |
                   |    [Postgres: log      [Slack: booking
                   |     SLACK_ALERT_        confirmation]
                   |     SENT, SKIPPED]     [Postgres: log
                   |          |              SLACK_ALERT_SENT,
                   |          |              SUCCESS]
                    \         |                    |
                     \________|____________________/
                               |
                   [IF: {{$env.DRY_RUN}} == 'true']
                     /                     \
                   TRUE                   FALSE
                     |                       |
              [Postgres: log        [Google Sheets: Append
               SHEET_SYNCED,         or Update Row, keyed
               SKIPPED]              on lead_id]
                     |               [Postgres: log
                     |                SHEET_SYNCED, SUCCESS]
                      \                     /
                       \___________________/
                                 |
                          [Respond 200]
```

Every `[Code: ...]` node's body is one or more files from `dist/nodes/`.
Every `[Postgres: ...]` node is n8n's built-in Postgres node running raw SQL
— nothing here calls `src/adapters/*.js`, for the same reason M4/M6 do not
(a Code node cannot `require()` a file with imports). `[Google Sheets: ...]`
and `[Slack: ...]` are n8n's built-in nodes, using credentials the human
configures in n8n's own UI — never a key in `process.env`.

---

## 2. Node-by-node

### 2.1 Webhook

- **Node:** Webhook
- **Method:** POST
- **Path:** `booking` (or your choice)
- **Respond:** "Using Respond to Webhook Node" — same convention as M4/M6,
  so every branch ends in a real status code.

### 2.2 Code: Auth Check

Paste **`dist/nodes/webhookAuth.js`** verbatim, then the identical glue
`docs/workflow.md` §2.2 already uses:

```js
const receivedToken = $input.first().json.headers['x-lead-token'] ?? null;
const expectedSecret = $env.WEBHOOK_SECRET;

const result = verifyWebhookToken({ receivedToken, expectedSecret });

return [{ json: { ...$input.first().json, authorized: result.authorized, authReason: result.reason } }];
```

Section 4.1 says "every inbound webhook requires a shared secret" — not one
secret per webhook. Reusing `WEBHOOK_SECRET`/`X-Lead-Token` here means this
canvas needs no new credential.

### 2.3 IF: authorized?

Condition: `{{$json.authorized}}` is `true`.

**FALSE branch:** **Respond to Webhook** — status `401`, body
`{"error": "unauthorized"}`. Identical to `docs/workflow.md` §2.3.

**TRUE branch:** continue to 2.4.

### 2.4 Postgres: Find Lead by ID

```sql
SELECT * FROM leads WHERE lead_id = $1;
```

Bind `$1` from the inbound payload's `lead_id`.

**This node's Settings → Always Output Data must be enabled.** n8n's
default behaviour for a Postgres node is to emit zero output items when the
query matches zero rows — not one empty item, none at all. With the default
left off, a `lead_id` that matches nothing produces no item for 2.5's `IF`
node to evaluate, so that node never runs and the request falls straight
through to an empty `200` instead of ever reaching the `404` branch below.
This is not a hypothetical: it is exactly what happened on the first live
run of this canvas, before the setting was turned on (see
[Live verification](#live-verification-2026-08-29)).

PROJECT_SPEC.md names no specific booking/scheduling tool, so there is no
documented third-party payload shape to match. This guide takes the
cheapest-to-reverse reading: the booking trigger already knows which lead
it is for — for example, a "Book a call" link generated per-lead (in the
Slack HOT alert, or in a follow-up message) that carries `lead_id` as a
query parameter — rather than inventing a specific vendor's webhook contract
the spec never names (section 0, rule 2: never invent an integration). The
rejected alternative was resolving by `email` the way a real third-party
scheduler's webhook typically would; that is a config-only change to this
one query if a specific tool is chosen later — nothing downstream of this
node would need to change.

### 2.5 IF: lead found?

Condition: the Postgres node above returned a row. **This only evaluates
at all if 2.4's Always Output Data setting is on** — otherwise a zero-row
match gives this node nothing to run against, and the whole request falls
through silently instead of reaching either branch below.

**FALSE branch:** **Postgres node** — `INSERT INTO lead_events (event_type,
status, details) VALUES ('WORKFLOW_ERROR', 'FAILURE', $1::jsonb)`, `details`
carrying the `lead_id` that did not resolve. **Respond to Webhook** — status
`404`.

**TRUE branch:** continue to 2.6.

### 2.6 Code: Build Booking Patch

Paste **`dist/nodes/followup.js`**, then:

```js
const lead = $('Find Lead by ID').first().json;

const stop = evaluateStopConditions({ ...lead, booking_status: 'BOOKED' });
const wasInProgress = lead.followup_status === 'IN_PROGRESS';

const patch = {
  booking_status: 'BOOKED',
  crm_status: 'BOOKED',
  followup_status: wasInProgress ? stop.followup_status : lead.followup_status,
  next_followup_at: wasInProgress ? null : lead.next_followup_at,
  stop_reason: wasInProgress ? stop.reason : null,
};

return [{ json: { lead, patch } }];
```

No new `src/core/` function was needed for this: `evaluateStopConditions`
already covers `booking_status = 'BOOKED'` (spec 6.3) and has since M1 —
`tests/core-followup.test.js` already asserts `{ stop: true, reason:
'booking_confirmed', followup_status: 'STOPPED' }` for exactly this input.
This node's only new logic is `wasInProgress`: a lead whose sequence never
started (`PENDING`, e.g. a lead still flagged for human review after a
scoring failure) or already finished (`STOPPED`/`COMPLETED`) has nothing
running to cancel. Reporting a `FOLLOWUP_STOPPED` for a sequence that was
never `IN_PROGRESS` would misrepresent what happened, even though the
due-query (`booking_status <> 'BOOKED'`) would have excluded the row either
way — this guard is about audit-log accuracy, not the cancellation
guarantee itself, which the patch's `booking_status` alone already secures.

### 2.7 Postgres: Apply Booking

```sql
UPDATE leads SET
  booking_status = $1, crm_status = $2,
  followup_status = $3, next_followup_at = $4
WHERE lead_id = $5
RETURNING *;
```

Bind `$1..$4` from `{{$json.patch}}`, `$5` from the lead's `lead_id`. Runs
unconditionally — 2.6 already resolved whether there was a running sequence
to stop, so `followup_status`/`next_followup_at` are either the new stop
values or simply the lead's own current values written back (a no-op for
those two columns when there was nothing to cancel).

### 2.8 Postgres: log BOOKING_RECEIVED

```sql
INSERT INTO lead_events (lead_id, event_type, status, details)
VALUES ($1, 'BOOKING_RECEIVED', 'SUCCESS', $2::jsonb);
```

Bind `$1` from the lead's `lead_id`, `$2` from whatever the inbound booking
payload carried beyond `lead_id` (meeting time, source, etc.) — captured for
audit the same way `raw_payload` captures the original intake submission,
without adding a new column for it (section 0: stop before a data-model
change; nothing here needs one).

### 2.9 IF: patch included stop fields?

Condition: `{{$json.patch.stop_reason}}` is not empty — the same shape
`docs/scheduler.md` §2.14 already checks.

**TRUE branch:** **Postgres node** — `INSERT INTO lead_events (lead_id,
event_type, status, details) VALUES ($1, 'FOLLOWUP_STOPPED', 'SUCCESS',
$2::jsonb)`, `details` from `{{$json.patch.stop_reason}}` (`"reason":
"booking_confirmed"`). Identical idiom to `docs/scheduler.md` §2.14's own
`TRUE` branch.

**FALSE branch:** nothing further — there was no running sequence to
report stopping.

Both branches continue to 2.10.

### 2.10 Postgres: Claim Notification

```sql
INSERT INTO notifications (lead_id, kind, step)
VALUES ($1, 'BOOKING_CONFIRM', 0)
ON CONFLICT (lead_id, kind, step) DO NOTHING
RETURNING id, sent_at;
```

Bind `$1` from the lead's `lead_id`; `step` is always `0` — a booking is
confirmed once, not stepped like a follow-up cadence. Identical idiom to
`docs/scheduler.md` §2.6, spec 3.3's idempotency guard applied to the
`BOOKING_CONFIRM` kind the `notifications` table already enumerates.

### 2.11 IF: claimed?

Condition: the Postgres node above returned a row.

**FALSE branch:** skip straight to 2.13 — this booking was already
confirmed (by this request or an earlier retry of it); sending a second
Slack message would be exactly the double-send spec 3.3 exists to prevent.

**TRUE branch:** continue to 2.12.

### 2.12 IF: DRY_RUN — Slack confirmation

Condition: `{{$env.DRY_RUN}}` equals `'true'`. Same structure as
`docs/workflow.md` §2.17's HOT-alert branch:

- **TRUE (default):** **Postgres node** logging `SLACK_ALERT_SENT` with
  `status = 'SKIPPED'` and the message text in `details` — nothing is
  actually sent.
- **FALSE:** **Slack node** (Incoming Webhook, `{{$env.SLACK_WEBHOOK_URL}}`)
  posts a booking-confirmation message (e.g. *"📅 {{first_name}}
  {{last_name}} just booked a call — {{company}}"*), then a Postgres node
  logs `SLACK_ALERT_SENT` with `status = 'SUCCESS'`. Live-named **Send
  Booking Confirmation**; Retry On Fail is verified ON (Max Tries `3`, Wait
  `1000ms`, On Error: Stop Workflow) — same n8n node-level mechanism
  `docs/workflow.md` §2.11 documents, distinct from `src/core/retry.js`'s
  code-level policy (spec 9, M8), which no canvas node here calls.

Both branches continue to 2.13.

### 2.13 IF: DRY_RUN — Google Sheets sync

Condition: `{{$env.DRY_RUN}}` equals `'true'`.

- **TRUE (default):** **Postgres node** logging `SHEET_SYNCED` with
  `status = 'SKIPPED'`.
- **FALSE:** **Google Sheets node** (built-in, the human's own OAuth2
  credential), operation **Append or update row**, spreadsheet
  `{{$env.GOOGLE_SHEET_ID}}`, matching column `lead_id`. "Append or update"
  is what makes this idempotent by construction: a repeat sync for the same
  `lead_id` overwrites the same row rather than appending a duplicate — a
  different guarantee than 2.10/2.11's claim-based suppression, and it does
  not need one, since re-writing identical values is harmless. Then a
  Postgres node logs `SHEET_SYNCED` with `status = 'SUCCESS'`. Live-named
  **Sync Booking to Sheet**; Retry On Fail is verified ON here too (Max
  Tries `3`, Wait `1000ms`, On Error: Stop Workflow) — same n8n node-level
  mechanism as 2.12's Slack node, distinct from `src/core/retry.js`'s
  code-level policy (spec 9, M8), which no canvas node here calls.

Both branches continue to 2.14.

### 2.14 Respond to Webhook

Status `200`.

---

## 3. Environment variables this canvas reads

All already declared in `.env.example` (section 12); no new variable was
added for this milestone:

`WEBHOOK_SECRET`, `SLACK_WEBHOOK_URL`, `GOOGLE_SHEET_ID`, `DRY_RUN`.

---

## Running the acceptance test

No new `src/core/` logic exists for this milestone — 2.6's `wasInProgress`
guard is the only new decision, and it is a single boolean gate around
`evaluateStopConditions`, which `tests/core-followup.test.js` already
covers in full (spec 6.3's `booking_confirmed` branch). What only a human
can still do is build the canvas above and confirm it reproduces the
following against a real Postgres:

1. Seed a lead mid-sequence directly in Postgres — `followup_status =
   'IN_PROGRESS'`, `followup_step = 1`, `next_followup_at` a real future
   timestamp — and note its `lead_id`.
2. POST a booking event for that `lead_id` with a valid `X-Lead-Token`.
   Confirm: `booking_status = 'BOOKED'`, `crm_status = 'BOOKED'`,
   `followup_status = 'STOPPED'`, `next_followup_at IS NULL`, and exactly
   one `BOOKING_RECEIVED` row plus one `FOLLOWUP_STOPPED` row (`details`
   `reason: "booking_confirmed"`) in `lead_events`. With `DRY_RUN=true`
   (default): a `SLACK_ALERT_SENT`/`SKIPPED` row and a `SHEET_SYNCED`/
   `SKIPPED` row, no outbound Slack message, no Sheet write.
3. POST the identical booking event again. Confirm: the `leads` row is
   unchanged (still `BOOKED`/`STOPPED` — the UPDATE just reasserts the same
   values), and `lead_events` gained **one** more `BOOKING_RECEIVED` row
   (2.8 always runs) but **no** second `FOLLOWUP_STOPPED` (2.9's `FALSE`
   branch, since the sequence is `STOPPED` already, not `IN_PROGRESS`) and
   **no** second `SLACK_ALERT_SENT` (2.11's claim fails the second time).
   Flip `DRY_RUN=false` and fire once more with a *different* `lead_id` to
   see a real Slack message and a real Sheet row before returning it to
   `true`.
4. Seed a second lead with `followup_status = 'PENDING'` (never started —
   e.g. a lead still in `HUMAN_REVIEW` after a scoring failure) and POST a
   booking event for it. Confirm: `booking_status = 'BOOKED'`, `crm_status
   = 'BOOKED'`, but `followup_status` stays `PENDING` — nothing was running
   to stop — and exactly one `BOOKING_RECEIVED` row with **no**
   `FOLLOWUP_STOPPED` row at all.
5. POST with a `lead_id` that matches no row. Confirm: `404`, exactly one
   `WORKFLOW_ERROR` row in `lead_events` with `lead_id IS NULL` (section
   3.2's audit table allows this on purpose — a payload can fail before any
   lead is touched), and no `leads` row changed.
6. POST with a missing or wrong `X-Lead-Token`. Confirm: `401`, identical
   to the M4 canvas's own auth-failure behaviour (same snippet, same
   guarantee) — never echo the received token into any log either way.

If any of this diverges, the mismatch is almost always in the wiring, not
the snippets — `webhookAuth.js` and `followup.js` both have unit and
behavioural-fidelity tests (`tests/build-nodes.test.js`) proving they
behave identically to their `src/core/` source, and
`tests/core-followup.test.js` proves `evaluateStopConditions` produces
exactly the `booking_confirmed` result this canvas relies on.

### Live verification (2026-08-29)

All six steps above were run against the real stack — n8n, Postgres, a
real Slack webhook, and a real Google Sheet, not `mockCrm` or a dry run
throughout:

- **Step 1 (mid-sequence booking):** a lead seeded `IN_PROGRESS` at
  `followup_step = 1` with a future `next_followup_at`. Result:
  `booking_status = 'BOOKED'`, `crm_status = 'BOOKED'`, `followup_status =
  'STOPPED'`, `next_followup_at IS NULL`, `followup_step` unchanged at `1`.
  Exactly one `BOOKING_RECEIVED` row and one `FOLLOWUP_STOPPED` row
  (`reason: "booking_confirmed"`). With `DRY_RUN=true`: `SLACK_ALERT_SENT`
  and `SHEET_SYNCED` both logged `SKIPPED`.
- **Step 2 (repeat POST, idempotency):** the identical booking event fired
  again. `leads` row unchanged. A **second** `BOOKING_RECEIVED` row was
  logged (2.8 runs unconditionally), but **no** second `FOLLOWUP_STOPPED`
  (the sequence was already `STOPPED`, not `IN_PROGRESS` — 2.9's `FALSE`
  branch) and **no** second `SLACK_ALERT_SENT` (2.10/2.11's `notifications`
  claim on `BOOKING_CONFIRM`/step `0` was already taken). A second
  `SHEET_SYNCED`/`SKIPPED` row *did* appear — expected, since 2.13 is not
  claim-gated the way Slack is.
- **Step 3 (live outbound, `DRY_RUN=false`):** on a fresh `IN_PROGRESS`
  lead, both `SLACK_ALERT_SENT` and `SHEET_SYNCED` came back `SUCCESS`
  (`details` included the real Sheet name and a real-send confirmation) —
  an actual Slack message posted and an actual row appended/updated in the
  Sheet — while the booking-cancellation state (`BOOKED`/`BOOKED`/
  `STOPPED`) was identical to step 1. `DRY_RUN` was restored to `true` and
  the n8n container recreated afterward.
- **Step 4 (`PENDING` lead):** a lead that had never started a sequence
  (`followup_status = 'PENDING'`, scoring had failed earlier) was booked.
  Result: `booking_status = 'BOOKED'`, `crm_status = 'BOOKED'`,
  `followup_status` stayed `'PENDING'`, and **no** `FOLLOWUP_STOPPED` row
  was logged — matching 2.6's `wasInProgress` guard exactly.
- **Step 5 (unknown `lead_id`):** the **first** live run of this case
  exposed a real gap, not just confirmed the design: `Find Lead by ID`
  (2.4) returned zero rows and, by n8n's default node behaviour, emitted
  **no output item at all** — so `IF: lead found?` (2.5) never executed
  and the request fell through to an empty `200` instead of the documented
  `404`. Fixed live by enabling **Always Output Data** in that node's
  Settings (now called out explicitly in 2.4/2.5 and the prerequisites
  table above). After the fix: `404` with body `{"error":
  "lead_not_found"}`, and exactly one `WORKFLOW_ERROR`/`FAILURE` row
  logged with the unmatched `lead_id` in `details`.
- **Step 6 (wrong token):** `401` with body `{"error": "unauthorized"}` —
  identical to the M4 canvas's own auth-failure behaviour.

No `src/core/`, `dist/nodes/`, or `db/` change came out of this pass — the
one real fix (Always Output Data) is entirely an n8n node setting, which is
why it is documented here rather than in code.
