---
name: database-adapter-authoring
description: Walk a developer through adapting the `database` connector to their own (possibly non-liaison) database — inventory the target schema, write a read catalog, provision a read-only role, connect, and smoke-test. Use when the user wants to point Liaison's database connector at a new database, write a new adapter/catalog, or extend `liaison-self` with a new read.
---

# Database adapter authoring

You are pairing with a developer to adapt the `database` connector to a
target database — either extending `liaison-self` with a new read, or
authoring a brand-new adapter for a completely different schema. This skill
is written so **neither of you needs to read the connector's implementation
source** — everything you need is here and in `docs/database-connector.md`.

Drive the conversation one step at a time. Each step below ends in a
concrete, checkable artifact or command — don't skip the validation loop.

## Before you start

Open `docs/database-connector.md` once — it's the architecture + safety-stack
reference this skill assumes. If this skill and that doc disagree, the doc
wins.

Reference adapter: `apps/api/src/apps/database/adapters/liaison-self.ts` (the
real, generic liaison-schema adapter). Reference fixture:
`apps/api/src/apps/database/adapters/__fixtures__/toy-shop.ts` (a tiny
3-table adapter authored purely by following this skill — read it if you
want to see the destination, not the process).

## Step 1 — Inventory the target schema

Ask: *"What database are we pointing this at? Is it this liaison instance's
own Postgres, or a different one?"*

For a **non-liaison** target: get (or generate) a schema dump —
`information_schema.tables` / `information_schema.columns`, or an ORM's
schema file, or a migration history. You need every table name, its schema,
and its columns with types, for the domains you're about to pick.

For **extending `liaison-self`**: the frozen baseline is
`apps/api/src/db/migrations/0000_initial.sql` (+ forward migrations under
the same directory) and `apps/api/src/db/schema/kernel/*.ts` /
`db/schema/app_*/*.ts` for Drizzle-typed schema.

## Step 2 — Pick domains

Group the reads you want into domains — `licenses`, `moderation`, `health`
are the conventions `liaison-self` uses, but `domain` is a free string; use
whatever taxonomy fits the target (e.g. a toy shop adapter might use
`catalog`, `orders`, `inventory`). Domains show up in `db_list_reads`'
output and in `agentInstructions`, so the agent can reason about "which read
do I want" without reading SQL.

Keep the read count small and purposeful (`liaison-self` ships ~10). Each
read should answer one recognizable support/troubleshooting question, not be
a generic "dump the table" query.

## Step 3 — The secret-column checklist (do this before writing any SQL)

For every table you're about to touch, check every column name against
this pattern: `*_hash`, `*_encrypted`, `*_secret`, `password*`, `totp*`,
`recovery*`, `*token*`. If your target is liaison's own schema, the
canonical list is `packages/db-core/src/secret-columns.ts`'s
`SECRET_COLUMNS` — do not add anything from that list to a `columns`
allow-list, ever.

If your target is a **different** database: run the same sweep yourself
(`information_schema.columns` filtered by those name patterns is a good
starting query) and simply never reference a matching column in any read's
`columns` or `sql`. There's no shared `SECRET_COLUMNS` constant for a
foreign schema — the discipline is manual, and it's the single most
important step in this whole skill. Get this wrong and a catalog read (or a
`db_query` opt-in) can leak a credential; the DB grant layer (Step 6) is the
backstop, but don't rely on the backstop when you're the one writing the
catalog.

## Step 4 — Write catalog reads

A `ReadCatalog` (`packages/db-core/src/catalog.ts`) is:

```ts
import type { ReadCatalog } from "@liaison/db-core"
import { registerAdapter, validateCatalog } from "@liaison/db-core"

export const myCatalog: ReadCatalog = {
  adapter: "my-adapter",
  reads: {
    widgets_by_status: {
      description: "List widgets in a given status.",
      domain: "inventory",
      sql: "SELECT id, name, status, updated_at FROM shop.widgets WHERE status = :status ORDER BY updated_at DESC",
      params: { status: { type: "string", description: "Widget status" } },
      columns: ["id", "name", "status", "updated_at"],
      tables: ["shop.widgets"],
      maxRows: 100,
    },
  },
}

validateCatalog(myCatalog)   // throws CatalogValidationError with a specific reason on any violation
registerAdapter(myCatalog)
```

Rules (enforced by `validateCatalog`, not just convention):

- `sql` must be a single `SELECT` or `WITH ... SELECT` statement — no writes,
  no multi-statement.
- Named params in `sql` use `:name`; every `:name` must appear in `params`
  and vice versa (unused-param and undeclared-placeholder are both errors).
- Parameters reach Postgres untyped. A param used only where Postgres cannot
  infer a type (`:after IS NULL`, `coalesce(:x, ...)`) needs an explicit cast
  at least once (`:after::timestamptz`); the compiler applies that cast to
  every use of the param, so it may sit at any occurrence.
- `columns` must be non-empty, and none of them may be a `SECRET_COLUMNS`
  entry for any table in `tables` (Step 3's discipline, checked
  automatically for liaison's own schema — for a foreign schema this check
  can only catch what you declared consistently, so get `tables` right).
- `tables` must be non-empty — this is what the readonly-role grant
  renderer (Step 6) and `db_describe` filtering use; every table your `sql`
  actually touches (including joined tables) must be listed.

**Validation loop:** after writing/editing a catalog, actually run
`validateCatalog(myCatalog)` (a one-line `bun -e` script, or a test file) and
fix every thrown error before moving on. Don't hand-wave "looks right" —
the validator's errors are specific (`CatalogValidationError` names the read
and the reason).

If this is a brand-new adapter (not extending `liaison-self`), also write a
catalog-validation test mirroring `packages/db-core/src/catalog.test.ts`'s
shape: accepts the catalog, rejects a mutated copy with a secret column
smuggled in, rejects a param mismatch. Run it as
`.claude/skills/run-tests/SKILL.md` describes.

## Step 5 — Choose a connectivity rung

Read `docs/database-connector.md` §2's decision guide. Short version:

- Same machine/network → direct DSN (rung 0/1).
- Untrusted network / "I don't want to expose Postgres at all" →
  `liaison-db-gate` (rung 2) — put your catalog on the gate's side
  (`catalog.yaml`), mint a token, never hand Liaison your DSN.
- Public endpoint only → direct DSN with TLS (rung 3) — the connector
  refuses plaintext to any DSN whose host resolves to a public IP.

## Step 6 — Provision the read-only role

The grant model is **allow-list**, never `GRANT SELECT ON ALL TABLES`, and
it's generated **from your catalog** — one command renders exactly the
grants your reads need (and nothing else):

```bash
# Regenerate the grants SQL from your catalog (no DB connection needed —
# pure render + write to the single checked-in file):
bun run scripts/db-readonly-role.ts --regenerate

# Verify it's actually in sync with the catalog (no DB connection — fails if
# you changed the catalog but forgot to regenerate; this is what
# `bun run check:grants` / CI runs):
bun run scripts/db-readonly-role.ts --check-sync

# Provision (idempotent — safe to re-run) against the target cluster, using
# a superuser/owner DSN via MIGRATION_DATABASE_URL or DATABASE_URL — this
# step DOES connect to the live target DB and apply the regenerated file:
DB_READONLY_PASSWORD=$(openssl rand -hex 32) \
  MIGRATION_DATABASE_URL=postgres://<owner>:<pw>@<host>/<db> \
  bun run scripts/db-readonly-role.ts --create

# Optional: query a LIVE cluster's actually-applied grants (separate from
# --check-sync's catalog-vs-file diff):
MIGRATION_DATABASE_URL=postgres://<owner>:<pw>@<host>/<db> \
  bun run scripts/db-readonly-role.ts --check
```

If you're extending `liaison-self`, the generated grants file
(`apps/api/src/apps/database/generated/readonly-grants.sql`) is the ONE
checked-in copy — the same file `deploy/postgres-init/20-readonly-role.sh`
executes via a bind mount for fresh clusters, no second hand-maintained
copy — rendered from the catalog by `packages/db-core/src/grants-renderer.ts`.
After any catalog change, run `--regenerate` and commit the diff; `bun run
check:grants` (= `--check-sync`) is what CI enforces (see
`docs/database-connector.md` §9's "add a read" runbook).

If you're authoring a **new, standalone adapter** for a different database,
you'd point the same renderer at your own catalog and land the generated SQL
next to your adapter (mirroring the `liaison-self` structure) — the renderer
itself is generic over any `ReadCatalog`.

**A newly migrated table is invisible to the role until it's in your
catalog and the grants are regenerated.** This is intended fail-closed
behavior, not a bug to work around.

## Step 7 — Connect + probe

Connect the `database` app's connection (direct DSN or gate URL+token per
Step 5) through the normal connections UI/CLI. `db_probe` runs automatically
at connect time; also callable any time. Confirm:

- `ok: true`
- `writeGrantsDetected` absent/false
- `dangerousExecuteGrantsDetected` absent/false
- (gate mode only) `missingReads` empty

If any of those are dirty, `docs/database-connector.md` §8's troubleshooting
table maps the signal to the fix — usually "re-run `--create`" or "your
catalog and the gate's `catalog.yaml` are out of sync."

## Step 8 — Smoke-test every read

For each read in your catalog, call `db_list_reads` (confirm it's listed
with the right params/columns) then `db_read(name, params)` with a
realistic param set and confirm:

- Rows come back and look right.
- Only the declared `columns` are present (no extra/secret columns leaked —
  this is the column-projection defense-in-depth layer working).
- A deliberately-wrong param (wrong type, or a value with no matching rows)
  fails/empties gracefully, not with a raw driver error.

If `db_query` is enabled for this deployment
(`LIAISON_DATABASE_ALLOW_RAW_QUERY=true`), also smoke a hostile shape (e.g.
`SELECT pg_sleep(1)` or an `INSERT`) and confirm it's rejected — both by the
SELECT-only validator (fast, typed error) and, if you bypass that in a test,
by the grant layer itself (`42501`).

## When the SDK doesn't fit

If the target schema needs something this connector's shape genuinely can't
express — a non-Postgres engine, a write capability, streaming results — do
not bypass the sandbox or hand-roll a workaround. File a row in
`docs/sdk-gaps.md` and stop; the transport seam (`DbTransport`) is designed
to admit new engines behind the same interface, but that's a connector-level
change, not something to improvise per-adapter.

## Reference

- `docs/database-connector.md` — architecture, safety stack, catalog format,
  troubleshooting.
- `apps/api/src/apps/database/adapters/liaison-self.ts` — the real, generic
  reference adapter.
- `apps/api/src/apps/database/adapters/__fixtures__/toy-shop.ts` — a tiny
  fixture adapter built purely from this skill; read it to see what "done"
  looks like for a brand-new, non-liaison target.
- `apps/db-gate/catalog.example.yaml` — the YAML mirror of the same catalog
  shape, for gate-mode deployments.
- A change to the connector itself (not to one customer's catalog) updates
  `docs/database-connector.md` and `docs/sales/sales-data.md` in the same PR
  (`.claude/docs-map.ts`, `bun run check:docs`).
