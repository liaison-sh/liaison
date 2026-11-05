// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * DB-evaluated parity: the SQL clause from `generateRequiredScopesVisibilityClause`
 * must return exactly what the app-level `isMessageVisible` returns, including
 * every `hasScope` wildcard and parent rule. Each row sets the RLS GUCs the way
 * `withRlsContext` does (comma-joined scopes, `__none__` when empty, nil uuid for
 * a non-uuid user id) and evaluates the generated clause over literal arrays.
 */
import { describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { generateRequiredScopesVisibilityClause } from "~/modules/permissions/rls-generator"
import { isMessageVisible } from "~/services/security/visibility"

const VIEWER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

interface Row {
  name: string
  required: (string | null)[] | null
  disclosure: string[] | null
  grants: string[]
  userId: string
  expected: boolean
}

const ROWS: Row[] = [
  {
    name: "bare * covers a:b:read",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["*"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "a:* covers a:b:read",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a:*"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "a:b:* covers a:b:read",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a:b:*"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "parent a:b covers a:b:read",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a:b"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "parent a covers a:b:read",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "exact match",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a:b:read"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "non-match",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["x:y"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "sibling a:c does not cover a:b:read",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a:c"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "longer grant does not cover shorter scope",
    required: ["a:b"],
    disclosure: null,
    grants: ["a:b:read"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "a:* does not cover bare a",
    required: ["a"],
    disclosure: null,
    grants: ["a:*"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "mid-segment wildcard is ignored",
    required: ["a:b:read"],
    disclosure: null,
    grants: ["a:*:read"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "leading wildcard with more segments is ignored",
    required: ["a:b"],
    disclosure: null,
    grants: ["*:b"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "every required scope must be covered",
    required: ["a:b:read", "c:d"],
    disclosure: null,
    grants: ["a:b"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "two scopes covered by two grants",
    required: ["a:b:read", "c:d"],
    disclosure: null,
    grants: ["a:b", "c:*"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "empty requiredScopes, no grants",
    required: [],
    disclosure: null,
    grants: [],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "on disclosure list with no grants",
    required: ["a:b:read"],
    disclosure: [VIEWER],
    grants: [],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "someone else on disclosure list, no grants",
    required: ["a:b:read"],
    disclosure: [OTHER],
    grants: [],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "disclosure list among others, wrong grant",
    required: ["a:b:read"],
    disclosure: [OTHER, VIEWER],
    grants: ["a:c"],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "empty-string required scope fails closed even for *",
    required: [""],
    disclosure: null,
    grants: ["*"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "empty-string required scope among valid ones fails closed",
    required: ["a:b", ""],
    disclosure: null,
    grants: ["*"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "empty-string grant covers nothing",
    required: ["a:b"],
    disclosure: null,
    grants: ["", "x"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "null required element fails closed",
    required: [null],
    disclosure: null,
    grants: ["*"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "null requiredScopes fails closed on the scope branch",
    required: null,
    disclosure: null,
    grants: ["*"],
    userId: VIEWER,
    expected: false,
  },
  {
    name: "null requiredScopes, on disclosure list",
    required: null,
    disclosure: [VIEWER],
    grants: [],
    userId: VIEWER,
    expected: true,
  },
  {
    name: "empty viewer id never matches disclosure",
    required: ["a:b"],
    disclosure: [VIEWER],
    grants: [],
    userId: "",
    expected: false,
  },
  {
    name: "empty requiredScopes, empty viewer id",
    required: [],
    disclosure: null,
    grants: [],
    userId: "",
    expected: true,
  },
]

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function textArray(values: (string | null)[] | null, type: "text" | "uuid"): string {
  if (values === null) return `NULL::${type}[]`
  if (values.length === 0) return `'{}'::${type}[]`
  return `ARRAY[${values.map((v) => (v === null ? "NULL" : sqlText(v))).join(", ")}]::${type}[]`
}

const clause = generateRequiredScopesVisibilityClause({
  requiredScopesColumn: "required_scopes",
  disclosureListColumn: "disclosure_list",
})

async function evaluateInDb(row: Row): Promise<boolean> {
  // Same GUC encoding as withRlsContext (db/rls.ts).
  const scopes = row.grants.length > 0 ? row.grants.join(",") : "__none__"
  const userId = UUID_RE.test(row.userId) ? row.userId : NIL_UUID
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT
      set_config('app.current_scopes', ${scopes}, true),
      set_config('app.current_user_id', ${userId}, true)`)
    const rows = extractRows<{ visible: boolean | null }>(
      await tx.execute(
        sql.raw(`SELECT (${clause}) AS visible FROM (SELECT
          ${textArray(row.required, "text")} AS required_scopes,
          ${textArray(row.disclosure, "uuid")} AS disclosure_list) AS t`),
      ),
    )
    const visible = rows[0]?.visible
    if (typeof visible !== "boolean") throw new Error(`clause returned ${String(visible)}`)
    return visible
  })
}

describe("requiredScopesVisibility clause parity with isMessageVisible", () => {
  it("the parity table matches its hand-written expectations under isMessageVisible", () => {
    for (const row of ROWS) {
      const got = isMessageVisible(
        { requiredScopes: row.required as string[], disclosureList: row.disclosure },
        { userId: row.userId, grants: row.grants },
      )
      expect({ name: row.name, visible: got }).toEqual({ name: row.name, visible: row.expected })
    }
  })

  it("the DB-evaluated clause agrees with isMessageVisible on every row", async () => {
    const mismatches: string[] = []
    for (const row of ROWS) {
      const app = isMessageVisible(
        { requiredScopes: row.required as string[], disclosureList: row.disclosure },
        { userId: row.userId, grants: row.grants },
      )
      const dbResult = await evaluateInDb(row)
      if (dbResult !== app) mismatches.push(`${row.name}: db=${dbResult} app=${app}`)
    }
    expect(mismatches).toEqual([])
  })
})
