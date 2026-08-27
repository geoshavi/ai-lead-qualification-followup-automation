---
name: verify-postgres-schema
description: Verify that the db/*.sql migrations apply cleanly to a real PostgreSQL instance and that their constraints actually behave. Use when changing anything under db/, before completing a milestone that touches the schema, when adding a column or constraint, or when confirming that UNIQUE, CHECK, trigger and index behaviour still matches PROJECT_SPEC.md. Spins up a throwaway postgres:16-alpine container, applies the migrations under ON_ERROR_STOP, asserts every constraint rejects bad values by name, proves re-runnability, then tears the container down.
compatibility: Requires Docker (Desktop running) and a POSIX shell. Adds no project dependencies.
metadata:
  project: lead-engine
  scope: developer-tooling
---

# Verify the Postgres schema

Agent-side developer tooling. Nothing here is part of the product: it must never
be imported by `src/core/`, appear in `dist/nodes/`, or become an n8n runtime
dependency (PROJECT_SPEC.md section 13.1).

## Why this exists

`db/001_schema.sql` carries the guarantees the whole design rests on — a webhook
fired twice cannot create two rows, and a message cannot be sent twice. DDL
executing successfully is **not** evidence those guarantees hold. This procedure
proves them by feeding deliberately invalid values and asserting which named
constraint rejected each one.

Asserting the constraint **name** matters. A value being rejected is not proof
the rule you intended caught it — a NOT NULL or a type error can reject a row
you meant a CHECK to catch, and the test would still pass.

## Preconditions

Docker Desktop must be running. Check first:

```bash
docker info >/dev/null 2>&1 && echo "daemon OK" || echo "daemon DOWN"
```

If it is down, launch it and poll until ready — do not assume a fixed wait:

```powershell
$exe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (Test-Path $exe) { Start-Process -FilePath $exe }
$e = 0; while ($e -lt 150) { docker info 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 5; $e += 5 }
```

## Procedure

**1. Start a genuinely fresh container.** A reused database proves nothing about
a first-time apply.

```bash
docker rm -f leadengine-schema-check >/dev/null 2>&1
docker run --rm -d --name leadengine-schema-check \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=leadengine postgres:16-alpine
```

**2. Wait for readiness** with `pg_isready`, not a sleep:

```powershell
$e = 0; while ($e -lt 60) {
  docker exec leadengine-schema-check pg_isready -U postgres -d leadengine 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 2; $e += 2
}
```

**3. Apply both migrations.** `ON_ERROR_STOP=1` is required — without it psql
reports success even after a failed statement.

```bash
docker exec -i leadengine-schema-check psql -q -v ON_ERROR_STOP=1 -U postgres -d leadengine < db/001_schema.sql
docker exec -i leadengine-schema-check psql -q -v ON_ERROR_STOP=1 -U postgres -d leadengine < db/002_indexes.sql
```

**4. Run the behavioural verification:**

```bash
docker exec -i leadengine-schema-check psql -v ON_ERROR_STOP=1 -U postgres -d leadengine < .claude/skills/verify-postgres-schema/assets/verify-schema.sql
```

**5. Prove re-runnability** by applying both files a second time. They must
succeed with no error and preserve existing rows.

**6. Tear down:** `docker rm -f leadengine-schema-check`

## What a pass looks like

Every numbered `PASS` notice appears, and the exit code is 0:

```
PASS  1. insert + every default correct
PASS  2. leads_dedupe_key_unique rejected duplicate (webhook twice -> one row)
PASS  3. ON CONFLICT merges into one row and appends message_history
PASS  4. updated_at trigger fires on UPDATE
PASS  5. notifications_unique_send rejected duplicate (no double-send)
PASS  6. all 12 CHECK constraints fired by name across 13 negative cases
PASS  7. lead_events accepts NULL lead_id (pre-lead failures auditable)
```

Plus the scheduler query planning as `Index Scan using idx_leads_due_followups`.

A missing PASS line is a failure even when psql exits 0 — the `DO` blocks raise
on a wrong constraint name, so read the notices, not just the exit code.

## When the schema changes

`assets/verify-schema.sql` names all 12 CHECK constraints in its `expected`
array. Adding a constraint means adding it there **and** adding a negative case
that trips it, otherwise the new rule ships unverified. The paired static test
in `tests/schema.test.js` names the same constraints, so both must be updated
together — that pairing is deliberate.

## Gotchas

- In Git Bash, avoid double backslashes in heredocs; they collapse. Write SQL
  and JS fixtures with a file tool rather than a heredoc when they contain
  escapes.
- `git show :file | grep -c $'\r'` is unreliable here for the same reason. Use
  `git ls-files --eol`, which reports index and worktree endings authoritatively.
- Do not add a `db/verify.sql` to the product tree. This verification is
  developer tooling and lives in this skill.
