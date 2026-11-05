// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * CI lint check: ban imports of `~/db/connection` (and relative variants
 * resolving to apps/api/src/db/connection) outside a small allowlist.
 *
 * The handle exported from connection.ts (now `__privileged_db__`) bypasses
 * RLS — every consumer outside the allowlist must use RlsClient via
 * withRequestRls or one of the with{Privileged,System,Schema}Db helpers.
 *
 * Wired into the root `lint` script. Run standalone:
 *   bun run check:db-connection-import
 *
 * To add a new entry to ALLOWLIST: it must use the privileged handle for a
 * documented, security-reviewed reason (e.g., DDL bootstrap, liveness probe).
 */
import { Glob } from "bun"

const ALLOWLIST = new Set<string>([
  "apps/api/src/db/connection.ts",
  "apps/api/src/db/privileged.ts",
  "apps/api/src/db/rls.ts",
  "apps/api/src/db/index.ts",
  "apps/api/src/modules/health/routes.ts",
  "apps/api/src/modules/healthz/index.ts",
  "apps/api/src/infra/events/outbox-worker.ts",
  // Operator bench, never loaded by the server: runs against a private database
  // and reads pg_stat_user_tables deltas, which need the privileged handle.
  "apps/api/src/tests/bench/mail-sync-throughput.ts",
])

const TILDE_IMPORT = /from\s+["']~\/db\/connection["']/
const RELATIVE_IMPORT = /from\s+["']\.{1,2}\/(?:[^"']*\/)?db\/connection["']/

async function lintRoot(root: string): Promise<number> {
  let violations = 0
  for await (const path of new Glob("apps/api/src/**/*.{ts,tsx}").scan(root)) {
    // Test files and test-only infrastructure are exempt — they may legitimately
    // reach into the privileged handle for fixture setup / teardown.
    if (
      path.endsWith(".test.ts") ||
      path.endsWith(".test.tsx") ||
      path.endsWith(".test-fixtures.ts") ||
      path.endsWith("test-helpers.ts") ||
      path.includes("/__tests__/")
    )
      continue
    if (ALLOWLIST.has(path)) continue

    const content = await Bun.file(`${root}/${path}`).text()
    for (const [i, line] of content.split("\n").entries()) {
      if (TILDE_IMPORT.test(line) || RELATIVE_IMPORT.test(line)) {
        console.error(
          `${path}:${i + 1}: forbidden import from ~/db/connection — ` +
            `use RlsClient (withRequestRls) or with{Privileged,System,Schema}Db. ` +
            `Add to ALLOWLIST only after a security review.`,
        )
        violations++
      }
    }
  }
  return violations
}

if (import.meta.main) {
  const violations = await lintRoot(".")
  if (violations > 0) {
    console.error(`\n${violations} forbidden ~/db/connection import(s).`)
    process.exit(1)
  } else {
    console.log("No forbidden ~/db/connection imports.")
  }
}

export { lintRoot }
