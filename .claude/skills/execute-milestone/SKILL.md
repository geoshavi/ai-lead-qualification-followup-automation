---
name: execute-milestone
description: Execute one PROJECT_SPEC.md milestone (M0-M9) end to end under the spec's working rules. Use when asked to "proceed with M<n>", "implement the next milestone", "do M3 only", or to run a spec-compliance correction. Enforces spec authority, bounded context reading, the stop-and-ask gates for scope/install decisions, required tests, commit-only-if-green, and stopping at the milestone boundary.
compatibility: Requires git and Node >= 20. Adds no project dependencies.
metadata:
  project: lead-engine
  scope: developer-tooling
---

# Execute a milestone

Agent-side developer tooling. Nothing here is part of the product: it must never
be imported by `src/core/`, appear in `dist/nodes/`, enter n8n Code-node business
logic, or join the lead automation's runtime dependency graph
(PROJECT_SPEC.md section 13.1). It also must not weaken the rule that
`src/core/` is dependency-free, and must not change the human-built n8n canvas
model.

## Why this exists

M0, M1, M2 and one spec-compliance correction all ran the same procedure, and
the same two mistakes were available at every step: quietly widening scope, and
reinterpreting a spec sentence into something that sounds better than what it
says. This encodes the procedure so neither depends on remembering.

## The authority rule

**`PROJECT_SPEC.md` is authoritative. Do not reinterpret spec-defined
behaviour.**

When the spec states a behaviour, implement that behaviour — not a nicer,
safer, or more conventional version of it. If your implementation would differ
from a literal reading, that is not a judgement call to make silently: stop and
say so.

A worked example from this repo. Section 6.2 says a send time outside
09:00-18:00 moves to "09:00 on the next business day". M1 shipped a `same-day`
default that sent 07:00 Tuesday at 09:00 that same Tuesday — a defensible rule,
and not the one the spec states. It cost a correction commit. The literal
reading was right and was always available.

Where the spec is genuinely silent, choose the option that is cheapest to
reverse later, and record the choice in the milestone report.

## Bounded context

**Read only the milestone-relevant spec sections and their direct
dependencies.** `references/spec-map.md` lists which sections each milestone
needs. Load the full spec only when a section is ambiguous, appears to conflict
with another, or the milestone map does not cover what you hit.

The same bound applies to the repository. Read the modules the milestone
actually touches and the contracts they depend on. Do not re-read unchanged
architecture you already covered this session, and do not re-derive facts
already established in the conversation.

## The two stop gates

These are hard stops. Announce and wait — do not proceed on your own judgement,
and do not treat your own earlier message as approval.

**Gate 1 — scope and design.** Stop before:
- touching more than three files
- any change to the data model (`db/**`, the canonical field list, adapter contracts)
- any architecture decision the spec does not already settle

Explain what you intend, why, and the alternative you rejected. Then wait.

**Gate 2 — the environment.** Stop before any download, install, login,
permission grant, service restart, or external configuration — including
pulling a container image, creating a hosted account, or asking for credentials.

Say what you need, why the milestone needs it, what it costs, and whether a
$0/offline path exists instead. Then wait. Prefer the offline path: the spec's
default runtime is local and free (section 1.1), and a milestone that cannot be
verified without a paid account is a finding to report, not a reason to buy one.

## Procedure

1. **Scope.** Read the milestone entry in section 9 and its mapped sections.
   Write down the "Done when" clause verbatim — that is the acceptance test.
2. **Survey, read-only.** Find every file the milestone touches and everything
   that references them. Reading is not touching. Count the files.
3. **Gate 1** if the count exceeds three, the data model moves, or a design
   decision is open. Explain and wait.
4. **Tests first.** Write the failing test before the implementation. If a suite
   passes on first implementation, that is not evidence — mutate the
   implementation and confirm the specific test fails, then restore. Watch it
   fail for the right reason, or you have not tested it.
5. **Implement** the minimum that satisfies the spec sentence.
6. **Gate 2** the moment the environment is involved. Explain and wait.
7. **Run the required tests** — the full suite at milestone completion, not a
   filtered subset. Some milestones forbid network calls (M3) or require a
   second configuration (M2 parity); check the "Done when" clause.
8. **Commit only if green.** Every required check passes, or you do not commit.
   Never report a milestone complete on a partial pass — say which check failed
   and stop. One commit per milestone, message naming the milestone, the
   decisions taken, and the verification evidence.
9. **Report and stop at the boundary.** Do not begin the next milestone. The
   spec requires a stop after each one (section 0, rule 1).

## The report

Cover, briefly: what shipped; verification with real numbers; decisions taken
and which are worth revisiting; anything deliberately left to a later milestone;
and anything you did that touched a stop gate. Then stop.

State outcomes plainly. A test that fails gets said out loud with its output. A
step that was skipped gets named. Never describe work as verified when it was
only written.

## Red flags

| Thought | Reality |
|---|---|
| "This adjacent thing is basically part of the milestone" | It is the next milestone. Leave it. |
| "The spec probably means X" | It says what it says. Gate 1. |
| "Just one more file" | Four is more than three. Gate 1. |
| "I'll pull the image, it's only dev tooling" | Gate 2. Ask. |
| "The suite passed, so the code is right" | A suite that never failed proves nothing. Mutate it. |
| "Tests mostly pass" | Then it is not green and does not commit. |
| "I'll start the next milestone while I'm here" | Stop at the boundary. |
