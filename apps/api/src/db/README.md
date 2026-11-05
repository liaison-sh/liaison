# Database

PostgreSQL with Drizzle ORM + postgres.js driver.

## Setup

- `sql` — postgres.js connection (pooled, max 20)
- `db` — Drizzle instance wrapping `sql`; accessed via `withRlsContext` in request handlers
- `MIGRATION_DATABASE_URL` — DDL-privileged connection used exclusively by `db:migrate` (superuser or migration role); never use `DATABASE_URL` for migrations
- All queries go through `db` (query builder) or `sql` (raw, rare)

## Schema organization

One `pgSchema("kernel")` for all kernel tables. Future apps get `pgSchema("app_<name>")`.

```typescript
import { kernel } from "./index"

export const things = kernel.table("things", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
```

## Key conventions

- **Drizzle for all CRUD** — raw SQL only for `SET LOCAL`, complex CTEs, window functions, DDL in migrations
- **Type derivation:** `typeof table.$inferInsert`, `typeof table.$inferSelect`
- **Transactions:** `db.transaction(async (tx) => { ... })` — never `sql.begin()`
- **Foreign keys:** always `onDelete: "cascade"` or explicit policy
- **JSON columns:** `jsonb("col").$type<Interface>()` for typed JSON

## Row-Level Security (RLS)

`withRlsContext(ctx, fn)` wraps queries in a transaction that:
1. Sets `app.current_user_id`, `app.current_org_id`, `app.current_scopes`, `app.current_dimensions`, `app.current_roles` via `SET LOCAL`, each with a `<name>_tag` (`app.current_org_tag`, ...): an HMAC of the value (prefixed `user:`, `scopes:`, `dimensions:`, `roles:` for all but the org) under a per-database key the request login cannot read (`rls_ctx.tag_key`, migrations 0184 to 0186). It then calls `rls_ctx.enter()`, which verifies every variable once and keeps the verified values for the rest of the transaction where SQL inside it cannot overwrite them (0186)
2. Switches role to `liaison_rls` (NOBYPASSRLS)
3. Runs the query function with the transaction handle

Policies and functions read the org through `rls_ctx.org_id()`, never `current_setting('app.current_org_id')` directly (`rls-org-context.test.ts` checks the live database). On the request login it returns the org only when the tag matches, so SQL run inside a request transaction cannot switch itself to another org. On a login that can reach `liaison_admin` (the privileged login, migrations) it returns the variable as is. New policies call `rls_ctx.org_id()` directly, or `(SELECT rls_ctx.org_id())` (an InitPlan, once per statement) when the policy already holds a sub-select; giving a policy its first sub-select can trip Postgres's recursion check on a table whose policies read the same table.

The user works the same way: policies and functions read it through `rls_ctx.user_id()`, never `current_setting('app.current_user_id')` (`rls-user-context.test.ts`). Without a matching tag it returns the max uuid, which is no user's id and not the nil uuid a system context carries, so SQL that forges or clears the variable is nobody, never the system.

Scopes, dimension grants and roles work the same way through `rls_ctx.scopes()`, `rls_ctx.dimensions()` and `rls_ctx.roles()` (`rls-grants-context.test.ts`): a forged value reads as no scope (`__none__`), no grant (`{}`), no role (`__none__`). Inside a transaction that entered, the readers cost one settings lookup per call; elsewhere (the privileged login, a parallel worker) they fall back to the per-call tag check.

## Migrations

The codebase uses a **living baseline** strategy: `migrations/0000_initial.sql` is the single source of truth for the database schema. It is maintained in-place (no production data, no cumulative delta files) and rebuilt from a clean database on every migration run.

To apply migrations locally:

```bash
MIGRATION_DATABASE_URL=postgres://superuser:password@localhost:5432/liaison_dev bun run db:migrate
```

`migrate.ts` exits non-zero if `MIGRATION_DATABASE_URL` is unset — a superuser or DDL-capable role is required. `DATABASE_URL` (the runtime `liaison_app` role) lacks `CREATE SCHEMA` / `ALTER TABLE` / `GRANT` permissions and must never be used here.

To regenerate after schema changes: `bunx drizzle-kit generate` produces a diff; review and merge it into `0000_initial.sql` by hand if iterating on the baseline, or keep it as an incremental file if deploying to an existing database.
