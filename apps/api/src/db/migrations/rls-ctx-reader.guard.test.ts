// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A migration never reads the request context variables itself.
//
// Since 0184-0186 every policy and function reads the transaction's org, user,
// scopes, dimensions and roles through the rls_ctx readers, which accept a
// value only with the tag the server computed (db/rls.ts). A policy written
// with `current_setting('app.current_org_id', true)` trusts any SQL that sets
// the variable itself. The database guards (rls-org-context.test.ts,
// rls-user-context.test.ts) find such a policy once it exists in a migrated
// database, but they run only in the unit suite; this source scan runs in the
// PR guards and names the migration that wrote it.
//
// App tables declared in a manifest get their policies from
// modules/permissions/rls-generator.ts, which already emits the readers; this
// scan covers the hand-written SQL.
//
// Four migrations wrote such policies before this guard existed; 0209 rewrites
// them through the readers. They stay listed here, and the list cannot grow.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = import.meta.dir

/** The migrations that introduced the readers (and rewrote everything before them). */
const READERS_LAST = 186

/** Written before this guard, repaired by 0209_rls_ctx_policies. */
const REPAIRED = [
  "0198_mcp_connection_access.sql",
  "0203_import_uploads.sql",
  "0206_secret_requests.sql",
  "0207_import_runs.sql",
]

const RAW_READ =
  /current_setting\(\s*'app\.current_(org_id|user_id|scopes|dimensions|roles)'(::text)?\s*(,\s*true\s*)?\)/

/**
 * The SQL a migration runs: comments dropped, and the bodies of rls_ctx's own
 * functions (the readers themselves read the variables) left out.
 */
function executableSql(text: string): string {
  return text
    .replace(/--[^\n]*/g, "")
    .replace(/FUNCTION\s+rls_ctx\.[\s\S]*?(\$[a-z_]*\$)[\s\S]*?\1/gi, "")
}

function offenders(): string[] {
  return readdirSync(DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > READERS_LAST)
    .filter((f) => RAW_READ.test(executableSql(readFileSync(join(DIR, f), "utf8"))))
    .sort()
}

describe("migrations after the rls_ctx readers", () => {
  it("read the request context only through rls_ctx", () => {
    expect(offenders()).toEqual(REPAIRED)
  })

  it("sees a raw read in a policy, and not in a comment or an rls_ctx reader", () => {
    expect(
      RAW_READ.test(
        executableSql(
          "CREATE POLICY p ON t USING (org_id = current_setting('app.current_org_id', true)::uuid);",
        ),
      ),
    ).toBe(true)
    expect(
      RAW_READ.test(
        executableSql("-- was current_setting('app.current_user_id', true)\nSELECT 1;"),
      ),
    ).toBe(false)
    expect(
      RAW_READ.test(
        executableSql(
          "CREATE OR REPLACE FUNCTION rls_ctx.org_id() RETURNS text LANGUAGE sql AS $fn$ SELECT pg_catalog.current_setting('app.current_org_id', true) $fn$;\nSELECT 1;",
        ),
      ),
    ).toBe(false)
  })
})
