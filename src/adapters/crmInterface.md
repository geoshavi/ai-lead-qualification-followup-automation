# CRM adapter contract

Every CRM adapter implements exactly this surface. Core logic never imports an
adapter (PROJECT_SPEC.md section 8); a workflow selects one via `CRM_ADAPTER`
and passes it in.

| Adapter | `CRM_ADAPTER` | Storage | Role |
|---|---|---|---|
| `mockCrm.js` | `mock` *(default)* | JSON file on disk | local development, automated tests, offline demo |
| `supabaseCrm.js` | `supabase` | Supabase Free / PostgreSQL via PostgREST | hosted demonstration |

Both are held to the same behaviour by one shared suite,
`tests/helpers/crm-contract-suite.js`. If the two ever disagree, that suite
fails — which is the whole point of writing it once and running it twice.

---

## Construction

```js
createMockCrm({ file, now })
createSupabaseCrm({ url, serviceKey, restPath, fetchImpl, timeoutMs })
```

`now` is an injected clock (`() => Date`) defaulting to `() => new Date()`.
Adapters perform I/O, so unlike `src/core/` they are allowed to read a clock —
the injection point exists so tests can freeze it. It is mock-only: in Postgres
`created_at` and `updated_at` come from `now()` and the `trg_leads_updated_at`
trigger, so there would be nothing for it to control. `fetchImpl` is the same
idea on the HTTP side.

`restPath` defaults to `/rest/v1`, where Supabase mounts PostgREST. A bare
PostgREST container is mounted at the root, so the local parity run passes `''`.

No adapter reads `process.env` itself. Configuration is passed in by the caller,
so a test never depends on the ambient environment.

---

## Methods

All methods are `async`.

### `upsertLead(canonicalLead) -> { leadId, created, duplicate, lead, review }`

The spec fixes `{ leadId, created }`; the other three fields are additive,
because the caller needs the resulting row and needs to know whether a person
has to look at it.

| Field | Meaning |
|---|---|
| `leadId` | primary key of the row that now holds this lead |
| `created` | `true` only when this call inserted the row |
| `duplicate` | `!created` — named positively so call sites read well |
| `lead` | the full row after insert or merge |
| `review` | `{ needsHumanReview, reason, conflictReasons }` |

`dedupe_key` must be a non-empty string. Everything outside
`CANONICAL_FIELDS` is dropped before the write — inbound payloads are
attacker-influenced and an unknown key must never reach an INSERT.

**On conflict** (PROJECT_SPEC.md section 7) the adapter merges rather than
overwrites: empty fields are filled from the newcomer, an existing non-empty
value is never replaced, and a new `message` is appended to `message_history`.
It deliberately does **not** touch `lead_score`, `lead_temperature`,
`crm_status`, `followup_status`, `followup_step` or `next_followup_at`. A
customer who submits the form twice must not be scored twice, alerted twice, or
dropped back to the start of the follow-up sequence.

Merge policy is not reimplemented per adapter. Both call `mergeDuplicate` and
`detectCrossKeyConflict` from `src/core/dedupe.js`, so the rules stay
unit-tested in one place.

A cross-key conflict (same email arriving under a different `source_id`) sets
`needs_human_review = true` with a `cross_key_conflict:` reason instead of
auto-merging two people who might share an inbox.

### `getLeadByDedupeKey(key) -> lead | null`

`null` for an unknown key. Not an error — "no such lead" is an ordinary answer.

### `updateLead(leadId, patch) -> lead`

The patch is allowlisted through `pickCanonical`, so a key that is not a real
column is dropped rather than written. This matters more than it looks:
`startFollowup` and `advanceFollowup` both return a `stop_reason` field that is
control flow for the caller, not a column, and it must not reach the database.

Throws when `leadId` does not exist. Bumps `updated_at`.

### `recordEvent(event) -> event`

Appends to the audit log. `event` is
`{ lead_id?, event_type, status, details?, error_message? }`, validated against
the same enumerations as `lead_events`. `lead_id` is nullable on purpose: a
payload can fail validation before any lead row exists, and that failure still
has to be auditable.

The spec types this `void`; returning the stored row costs nothing and lets a
test assert on what was written.

### `listEvents({ leadId, eventType, limit }) -> event[]`

Not in the spec's five. It exists because M2 requires audit logging on every
write, and a write path you cannot read back is a claim rather than a
guarantee. Newest first.

### `listDueFollowups(now) -> lead[]`

Exactly the scheduler query from PROJECT_SPEC.md section 6.1:

```sql
SELECT * FROM leads
 WHERE next_followup_at <= now()
   AND followup_status = 'IN_PROGRESS'
   AND booking_status <> 'BOOKED'
   AND crm_status NOT IN ('LOST','BOOKED')
```

Ordered by `next_followup_at` ascending — oldest due first, and deterministic,
so the two adapters can be compared row for row.

### `claimNotification({ leadId, kind, step }) -> { claimed: boolean, notification }`

The idempotent-send guard from spec 3.3 (M6). Attempts the insert; if
`UNIQUE (lead_id, kind, step)` refuses it, the message was already sent —
`claimed` is `false` and `notification` is the *original* claim, not a new
one. This is the entire duplicate-prevention mechanism for a send: never a
boolean flag on the lead row, because a flag races (spec 3.3 says so
explicitly, and `tests/adapter-mock.test.js` fires twenty concurrent claims
at one `(lead, kind, step)` to prove exactly one wins).

Deliberately quiet: unlike `upsertLead`, a successful claim does **not**
write its own `lead_events` row. The caller knows what message text actually
went out and logs `FOLLOWUP_SENT` itself — see `recordEvent` below.

---

## Audit logging is automatic

Every write records its own event. The caller cannot forget to:

| Call | Event | Status |
|---|---|---|
| `upsertLead` inserting | `CRM_CREATED` | `SUCCESS` |
| `upsertLead` merging | `DUPLICATE_FOUND` | `SUCCESS` |
| `upsertLead` on a cross-key conflict | `DUPLICATE_FOUND` + `HUMAN_REVIEW_FLAGGED` | `SUCCESS` |
| `updateLead` | `CRM_UPDATED` | `SUCCESS` |
| any of the above failing | `WORKFLOW_ERROR` | `FAILURE` |

`recordEvent` stays public for the events the workflow raises itself
(`LEAD_RECEIVED`, `VALIDATION_FAILED`, `SLACK_ALERT_SENT`, and so on).

---

## Row shape

A returned lead is every field in `CANONICAL_FIELDS` plus `lead_id`,
`created_at` and `updated_at` — the three the database generates and code never
sets. Both adapters return identical types:

| Type | Representation |
|---|---|
| timestamps | ISO-8601 UTC string ending in `Z`, or `null` |
| `budget_amount` | JS number or `null` |
| `lead_score`, `followup_step` | JS number |
| `needs_human_review` | JS boolean |
| `raw_payload`, `message_history` | parsed JSON value |

The column types and the coercion that enforces them live once, in
`leadRow.js`, and both adapters use it. What a column *is* is schema knowledge
with one right answer; PostgREST rendering `timestamptz` as
`2026-03-10T16:00:00.326008+00:00` where a JSON file round-trips
`2026-03-10T16:00:00.326Z` is a representation difference, not a behaviour worth
preserving in two places.

What is deliberately **not** shared is behaviour. Conflict handling, filtering,
ordering and audit writes are implemented independently in each adapter — one
against a JSON array, one against PostgREST filters — and the parity suite is
what proves they agree. That split is load-bearing: it already caught a
supabase-only bug where a query string decoded the `+` in an E.164 phone number
to a space, so the cross-key probe matched nothing.

---

## Deliberate limits

**The mock is single-process.** It serialises its own mutations and writes
atomically (temp file, then rename), so concurrent calls inside one Node process
cannot produce two rows. Two separate processes writing the same file can.
Postgres is where the real guarantee lives: `leads.dedupe_key` is `UNIQUE`, so a
webhook fired twice cannot create two rows even under genuine concurrency
(PROJECT_SPEC.md section 7). The mock imitates that guarantee; it does not
provide it. Do not demo the concurrency claim on the mock.

**Notification idempotency claims are single-process on the mock, exactly
like the leads table above.** `claimNotification` (M6) serialises through the
same in-process queue `upsertLead` does, so it cannot race with itself the
way the real `UNIQUE (lead_id, kind, step)` constraint guarantees under
genuine concurrency. Same caveat, same reason: do not demo the concurrency
claim on the mock.

**No npm dependencies.** `supabaseCrm.js` talks to PostgREST over built-in
`fetch` rather than through `@supabase/supabase-js` or a Postgres driver. The
project ships with zero dependencies and no lockfile
(`tests/core-contract.test.js` enforces it), and `SUPABASE_URL` +
`SUPABASE_SERVICE_KEY` in PROJECT_SPEC.md section 12 are PostgREST credentials,
not a connection string.

---

## Running the parity suite

`npm test` runs the mock half only. It stays offline, free and fast, and needs
no account — that is the $0 development path.

The hosted half runs when `SUPABASE_URL` is set. Point it at a Supabase Free
project, or at a local PostgREST over the real migrations, which needs no
account at all:

```bash
docker network create leadengine-parity
docker run --rm -d --name leadengine-parity-db --network leadengine-parity   -e POSTGRES_PASSWORD=parity -e POSTGRES_DB=leadengine postgres:16-alpine
docker exec -i leadengine-parity-db psql -q -v ON_ERROR_STOP=1 -U postgres -d leadengine < db/001_schema.sql
docker exec -i leadengine-parity-db psql -q -v ON_ERROR_STOP=1 -U postgres -d leadengine < db/002_indexes.sql
docker run --rm -d --name leadengine-parity-rest --network leadengine-parity -p 3001:3000   -e PGRST_DB_URI="postgres://postgres:parity@leadengine-parity-db:5432/leadengine"   -e PGRST_DB_SCHEMA=public -e PGRST_DB_ANON_ROLE=postgres postgrest/postgrest:v12.2.3

SUPABASE_URL=http://127.0.0.1:3001 SUPABASE_REST_PATH= npm test

docker rm -f leadengine-parity-db leadengine-parity-rest
docker network rm leadengine-parity
```

`SUPABASE_REST_PATH` is read only by the test file. It is not product
configuration and is deliberately absent from `.env.example`, because a real
deployment is always Supabase and always `/rest/v1`.

The suite deletes every row between tests, so point it at a scratch database,
never at anything holding real data.
