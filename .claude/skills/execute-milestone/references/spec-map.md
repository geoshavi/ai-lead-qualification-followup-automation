# Milestone → spec section map

Progressive disclosure for `PROJECT_SPEC.md`. Read the sections listed for the
milestone in hand plus the always-on rules. Load the whole spec only when a
section is ambiguous, two sections appear to conflict, or the work lands
somewhere this map does not cover.

## Always on

| Section | Why it always applies |
|---|---|
| 0 | Working rules: one milestone at a time, `mock` must say mock, no secrets in code, `src/core/` dependency-free, stop before >3 files or a data-model change, commit per milestone, $0 default path |
| 9 | The milestone list and, for the one in hand, its verbatim "Done when" |
| 13.1 | Developer tooling stays out of `src/core/`, `dist/nodes/`, Code-node logic, and the runtime dependency graph |

## Per milestone

| Milestone | Sections | Notes |
|---|---|---|
| M0 Foundation | 2, 3, 12, 13.2 | Folder layout, data model, env vars |
| M1 Core logic | 3, 4.2, 6.2, 6.3, 7 | Cadence table, stop conditions, dedupe precedence, sanitisation |
| M2 Persistence | 3, 7, 8 | Adapter contract, conflict merge rules, audit log |
| M3 AI layer | 4.2, 4.3, 5 (all), 10 items 9/12/14/16/17 | Provider abstraction, scoring contract, parse/retry, injection |
| M4 Vertical slice | 1, 4.1, 11 | Human builds the canvas; agent supplies snippets and the build guide |
| M5 Remaining sources | 3, 7 | Three payload shapes, one canonical output |
| M6 Scheduler | 3.3, 6 (all) | Due query, idempotent send, step advance, stop conditions |
| M7 Booking + reporting | 3.3, 6.3, 12 | Booking cancels follow-ups; `DRY_RUN` respected |
| M8 Resilience | 4, 5.0, 5.3, 10 (all) | Retries, timeouts, every scenario as a runnable assertion |
| M9 Presentation | 1.1, 11, 12, 13.2 | $0 default path vs optional hosted, provider switch is config-only |

## Invariants worth re-checking before any commit

These are cheap to verify and expensive to discover late.

- `src/core/` has **zero imports** and never reads the ambient clock
  (`Date.now`, `new Date()`, `Math.random`). Enforced by
  `tests/core-contract.test.js`.
- `package.json` declares **no dependencies** and there is **no lockfile**.
  Also enforced there. Adding an npm package is a Gate 1 decision, not a
  convenience.
- `.env.example` declares exactly the section 12 variables — no more, no fewer.
  Enforced by `tests/env.test.js`. A new env var is a spec change.
- Nothing mocked reads as real: filename, function name and log output all say
  `mock` (section 0, rule 2).
- Adding or removing a `src/core/` module means updating the module list in
  `tests/core-contract.test.js`. That test pins the count on purpose.
- `db/**` changes are a data-model change. Gate 1, always.

## Verification tools already in the repo

- `.claude/skills/verify-postgres-schema/` — proves the migrations apply to a
  real Postgres and that each constraint rejects by name. Run when `db/`
  changes or before a milestone that depends on the schema.
- `src/adapters/crmInterface.md` — documents how to run the CRM parity suite
  against a local PostgREST with no hosted account.
