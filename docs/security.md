# Security posture

The reasoning behind this project's security decisions, consolidated in one
place as PROJECT_SPEC.md section 4.2 asks: *"Document this reasoning in
`docs/security.md`."* Nothing below is new behavior — every mechanism here
already shipped in M0–M8; this document explains **why** each one is shaped
the way it is, for a reader deciding whether the shape is right.

---

## 1. Webhook authentication (spec 4.1)

Every inbound webhook — the M4 intake canvas (`docs/workflow.md`) and the M7
booking canvas (`docs/booking.md`) — requires a shared secret in the
`X-Lead-Token` header, compared against `WEBHOOK_SECRET` with a
**constant-time** comparison (`src/core/webhookAuth.js`'s `verifyWebhookToken`).

**Why constant-time.** A naive `===` comparison on strings returns as soon as
the first differing character is found, so response time leaks how many
leading characters an attacker guessed correctly — a timing side-channel that
turns "guess the whole secret" into "guess it one character at a time."
Constant-time comparison takes the same time regardless of where (or whether)
the strings differ.

**Why one secret, not one per webhook.** Section 4.1 says "a shared secret,"
not "a shared secret per endpoint." `docs/booking.md`'s auth check reuses
`WEBHOOK_SECRET` rather than introducing a second one — one secret to
provision and rotate, not two to keep in sync.

**On mismatch:** respond `401`, log `WORKFLOW_ERROR`, and — the part easy to
get wrong — **never echo the received token into any log or error body**.
`webhookAuth.js`'s own tests assert the token never appears in its return
value, and every canvas guide repeats this instruction at the auth-check node
specifically, because a wrong-token audit log is exactly the kind of place a
credential accidentally leaks.

---

## 2. Untrusted input reaching the LLM (spec 4.2)

`lead.message` is free text from a public web form — attacker-controlled,
by definition. `src/core/sanitize.js`'s `prepareUntrustedText` does four
things before that text goes anywhere near a model:

1. **Strip control characters and zero-width characters.** These render
   invisibly but can alter how a downstream system parses text, or hide
   content from a human reviewer reading the same field.
2. **Truncate to 2,000 characters.** Bounds both prompt cost and how much
   attacker-controlled text a single field can inject.
3. **Wrap the content in explicit delimiters**, with the system prompt
   instructing the model that everything between them is **data to
   evaluate, never instructions to follow**. This is prompt-injection
   defense in depth: the delimiter alone does not stop a determined model
   from being confused, so it is backed by —
4. **A heuristic scan for injection markers** — phrases attempting to
   override instructions, references to system prompts, requests for a
   specific score.

### Why the heuristic flags rather than filters

This is the reasoning spec 4.2 specifically asks to be written down.

**A false positive costs a customer their lead being scored correctly. A
false negative costs one score being reviewed by a human anyway** — every
lead persists either way (spec 5.3's core guarantee), and every lead
eventually reaches a human's eyes if it is flagged. Blocking on a heuristic
match would mean a real customer who happens to write "please prioritize
this, it's urgent — ignore my last email, that one was a mistake" gets
rejected or mangled for using ordinary language that happens to pattern-match
an override phrase. A heuristic is a **pattern match, not an intent
detector** — it cannot distinguish "attempting to manipulate the model" from
"writing normally in a way that resembles an attempt" — so treating a match
as a block converts every false positive into a lost, legitimate lead.

Flagging instead — `needs_human_review = true`, `review_reason =
'possible_prompt_injection'` — costs nothing when the heuristic is wrong (a
person looks, sees an ordinary message, moves on) and catches the case when
it is right (a person looks, sees an actual attempt, can act on it with full
context the automated pipeline does not have). The asymmetry of the two
failure modes — silently blocking a real customer versus asking a human to
glance at a flagged row — is why this is a flag, not a filter, and why that
choice is spec-mandated rather than a judgement call made per deployment.

**The flag survives even a clean-looking result.** `tests/llm-score-lead.test.js`
proves this explicitly: an injection attempt that the model handles well —
returning a normal, unremarkable score — is *still* flagged, because the
model behaving correctly this time is not evidence the attempt was benign,
and is not something the pipeline can verify on its own.

---

## 3. Output constraints (spec 4.3)

**The model never writes to the database, never chooses timing, and never
sets status.** It returns a JSON object — score, reasoning, recommended
action, a confidence level, a human-review flag — that deterministic code
then parses, validates, clamps, and applies (`src/core/scoreParse.js`,
`src/core/temperature.js`). Concretely:

- **Temperature is derived, never returned by the model** (`temperature.js`).
  Letting the model return both score and temperature invites contradictions
  like `score: 30, temperature: HOT` that only a person would notice, usually
  too late.
- **A score is clamped, not trusted**, to the `0–100` range the database
  itself also enforces (`leads_score_range_check`) — defense at two layers,
  not one.
- **Malformed, fenced, truncated, or missing-field output all route through
  the same parser** (`scoreParse.js`), which either produces a valid patch or
  a clear failure — never a half-applied one.
- **A second consecutive failure still persists the lead**, flagged for
  human review (`AI_SCORE_INVALID`, `crm_status = HUMAN_REVIEW`) rather than
  dropped. A lead is never lost because a model misbehaved.

### Ollama is not a security boundary

Running the model locally does not change any of the above. Local output is
**exactly as untrusted** as a hosted provider's — same parsing, same
validation, same clamping, same retry, same human-review path
(`src/adapters/llm/llmInterface.md`). Concretely, this project:

- Never exposes Ollama beyond the local/trusted network.
- Never puts user-controlled text into model or endpoint *configuration*
  (only into the prompt body, inside the delimiters above).
- Never logs a secret or a full authentication header — `src/adapters/llm/llmError.js`'s
  failure mapping copies a provider's own error message through but not its
  request headers, so a credential cannot reach a log line via an exception.
- Keeps optional hosted-provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
  unset unless that provider is explicitly selected — `.env.example` ships
  placeholders only, never a real credential.

---

## 4. Duplicate- and abuse-resistance (spec 3.3, 7)

Two `UNIQUE` constraints, not application-level checks, are the entire
duplicate-prevention design:

- `leads.dedupe_key UNIQUE` — the same webhook fired twice, even
  concurrently, cannot create two rows. A duplicate submission merges into
  the existing row (`src/core/dedupe.js`'s precedence rules) rather than
  re-scoring, re-alerting, or restarting the follow-up sequence.
- `notifications (lead_id, kind, step) UNIQUE` — a message (a `SLACK_HOT`
  alert, a `FOLLOWUP` step, a `BOOKING_CONFIRM`) cannot be sent twice, even
  under a race. Before sending anything, the code attempts the insert; a
  unique-constraint violation means it already went out, so it skips. A
  boolean flag on the lead row would race here; the constraint does not
  (`tests/adapter-mock.test.js` fires twenty concurrent claims at one
  `(lead, kind, step)` and asserts exactly one wins).

Both guarantees live in the database, not in workflow logic, which is what
makes them hold under genuine concurrency rather than merely "usually."

---

## 5. Bounded retry, not indefinite retry (spec 9, M8)

`src/core/retry.js`'s policy is deliberately bounded — 3 total attempts by
default — for a security reason as much as a reliability one: an unbounded
retry loop against an external call is a resource-exhaustion risk (an
attacker-triggerable or fault-triggered hang), not just a slow one. The same
reasoning applies to the live canvases' own n8n-level `Retry On Fail`
settings (verified live, `docs/workflow.md`/`docs/scheduler.md`/`docs/booking.md`):
`Max Tries 3`, `On Error: Stop Workflow` — a failure that exhausts its
retries stops that execution rather than hanging or looping.

---

## 6. Secrets, end to end

- Every credential is read from `process.env`, documented in
  `.env.example` as a placeholder only (spec 0, rule 3). `tests/env.test.js`
  pins the exact variable list — no more, no fewer — so a new one cannot be
  added silently.
- No adapter reads `process.env` itself; construction takes explicit
  configuration, so a test never depends on the ambient environment and
  never risks a real key leaking into a fixture.
- No npm dependency, and therefore no supply-chain surface from a
  transitive package — `tests/core-contract.test.js` enforces zero
  dependencies and no lockfile.
