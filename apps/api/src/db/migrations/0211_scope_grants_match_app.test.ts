// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0211: every database scope check holds exactly what the app's hasScope holds.
// Each case runs through hasScope and through each SQL check, with the grants
// set as the transaction's scopes, and all must give the expected answer: the
// cases of permissions.test.ts plus the trailing and misplaced wildcards the two
// sides used to disagree on.

import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"

const CHECKS = [
  "app_tickets.app_has_scope",
  "app_projects.app_has_scope",
  "app_mcp_manager.app_has_scope",
  "app_knowledge.app_has_scope",
  "kernel.has_scope",
]

const CASES: Array<[required: string, granted: string[], expected: boolean]> = [
  // permissions.test.ts
  ["test:items:read", ["test:items:read"], true],
  ["test:items:read", ["test:items"], true],
  ["test:items:write", ["test:items"], true],
  ["test:items:read", ["test"], true],
  ["test:items:read", ["test:items:write"], false],
  ["test:items:read", ["other:items:read"], false],
  ["test:items:read", [], false],
  ["test:items:read", ["test:item"], false],
  ["kernel:users:read", ["kernel"], true],
  ["kernel:audit:read", ["kernel"], true],
  ["any:scope:here", ["*"], true],
  ["kernel:threads:read", ["*"], true],
  ["kernel:skills:approve", ["kernel:skills:read", "kernel:skills:write"], false],
  ["kernel:skills:approve", ["kernel:skills"], true],
  ["kernel:threadSettings:write", ["kernel:threads"], false],
  ["kernel:items:read", ["kernel:item"], false],
  ["", ["kernel"], false],
  ["", ["*"], false],
  // Trailing wildcards: one segment or more under the prefix.
  ["a:b:c", ["a:b:*"], true],
  ["a:b:c:d", ["a:b:*"], true],
  ["a:b", ["a:b:*"], false],
  ["a:bc:d", ["a:b:*"], false],
  ["a:x", ["a:*"], true],
  ["a:x:y", ["a:*"], true],
  ["a", ["a:*"], false],
  ["b:x", ["a:*"], false],
  ["knowledge:documents:update", ["knowledge:*"], true],
  ["knowledge:documents:update", ["knowledge:documents:*"], true],
  // A wildcard before the last segment holds nothing, itself included.
  ["a:b:c", ["a:*:c"], false],
  ["a:*:c", ["a:*:c"], false],
  ["a:b:c", ["*:b:c"], false],
  // Several grants: any one holding it is enough.
  ["a:b:c", ["x:y", "a:b:*"], true],
]

/** Each SQL check's answer for `required`, with `granted` as the transaction's scopes. */
async function sqlAnswers(required: string, granted: string[]): Promise<boolean[]> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    await tx`SELECT set_config('app.current_scopes', ${granted.length > 0 ? granted.join(",") : "__none__"}, true)`
    const [row] = await tx.unsafe<Record<string, boolean | null>[]>(
      `SELECT ${CHECKS.map((c, i) => `${c}($1) AS c${i}`).join(", ")}`,
      [required],
    )
    return CHECKS.map((_, i) => row![`c${i}`] as boolean)
  })
}

describe("0211: a scope grant matches in SQL as in hasScope", () => {
  for (const [required, granted, expected] of CASES) {
    it(`${JSON.stringify(granted)} ${expected ? "holds" : "does not hold"} "${required}"`, async () => {
      expect(hasScope(required, granted)).toBe(expected)
      expect(await sqlAnswers(required, granted)).toEqual(CHECKS.map(() => expected))
    })
  }
})
