// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.kernel.caller / roles / findUsersByEmail: the directory reads an app needs
// to decide access rules of its own, through the real bridge and database.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"

const ORG = "00000000-0000-4000-8000-0000000d7001"
const OTHER_ORG = "00000000-0000-4000-8000-0000000d7002"
const USER = "00000000-0000-4000-8000-0000000d7011"
const OTHER_USER = "00000000-0000-4000-8000-0000000d7012"
const ROLE = "00000000-0000-4000-8000-0000000d7021"
const OTHER_ROLE = "00000000-0000-4000-8000-0000000d7022"
const APP = "dirprobe"
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

async function call<T>(
  method: string,
  args: unknown[],
  opts: { userId?: string; callerScopes?: string[] } = {},
): Promise<T> {
  const userId = opts.userId ?? USER
  const out: string = await withRlsContext(
    // The RLS session is a member's; the bridge's own actor is `userId`.
    { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
    (tx) =>
      createRpcBridge(APP, userId, ORG, tx as never, manifest as never, opts.callerScopes ?? [])[
        method
      ](...args),
  )
  return JSON.parse(out) as T
}

beforeAll(async () => {
  const rows: Array<[string, Record<string, RowValue>[]]> = [
    [
      "kernel.organizations",
      [
        { id: ORG, name: "dir-org", slug: "dir-org" },
        { id: OTHER_ORG, name: "dir-other-org", slug: "dir-other-org" },
      ],
    ],
    [
      "kernel.users",
      [
        {
          id: USER,
          org_id: ORG,
          email: "Dir.Person@test.com",
          name: "Dir",
          password_hash: "hash-value",
          totp_secret: "totp-value",
        },
        {
          id: OTHER_USER,
          org_id: OTHER_ORG,
          email: "other@test.com",
          name: "Other",
          password_hash: "hash",
          totp_secret: null,
        },
      ],
    ],
    [
      "kernel.roles",
      [
        { id: ROLE, org_id: ORG, name: "dir-analysts" },
        { id: OTHER_ROLE, org_id: OTHER_ORG, name: "dir-elsewhere" },
      ],
    ],
    ["kernel.role_scope_grants", [{ role_id: ROLE, scope: "dirprobe:reports:read" }]],
    ["kernel.user_roles", [{ user_id: USER, role_id: ROLE, org_id: ORG }]],
  ]
  for (const [table, list] of rows) {
    await sql.unsafe(insertSql(table, list, { onConflictDoNothing: true }))
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_roles WHERE org_id IN (${ORG}, ${OTHER_ORG})`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ROLE}, ${OTHER_ROLE})`
  await sql`DELETE FROM kernel.roles WHERE org_id IN (${ORG}, ${OTHER_ORG})`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG}, ${OTHER_ORG})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
})

describe("ctx.kernel.caller", () => {
  it("names a person's roles and answers only the scopes asked, from their grants and the call's", async () => {
    const caller = await call<Record<string, unknown>>(
      "kernel_caller",
      [JSON.stringify(["dirprobe:reports:read", "kernel:org:admin", "dirprobe:query:read"])],
      { callerScopes: ["dirprobe:query:read"] },
    )
    expect(caller).toEqual({
      kind: "person",
      userId: USER,
      roleIds: [ROLE],
      holds: {
        "dirprobe:reports:read": true,
        "kernel:org:admin": false,
        "dirprobe:query:read": true,
      },
    })
  })

  it("is the system for a job's run, holding every scope asked", async () => {
    const caller = await call("kernel_caller", [["kernel:org:admin"]], { userId: "system:job" })
    expect(caller).toEqual({ kind: "system", holds: { "kernel:org:admin": true } })
  })

  it("refuses more than 20 scopes", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `a:b:${i}`)
    await expect(call("kernel_caller", [many])).rejects.toThrow("at most 20")
  })
})

describe("ctx.kernel.roles and findUsersByEmail", () => {
  it("lists the org's roles only", async () => {
    const roles = await call<Array<{ id: string; name: string }>>("kernel_roles", [])
    expect(roles.some((r) => r.id === ROLE && r.name === "dir-analysts")).toBe(true)
    expect(roles.some((r) => r.id === OTHER_ROLE)).toBe(false)
  })

  it("finds the org's people by email, case-insensitive, directory fields only", async () => {
    const found = await call<Array<Record<string, unknown>>>("kernel_findUsersByEmail", [
      JSON.stringify(["dir.person@TEST.com", "other@test.com"]),
    ])
    expect(found.map((u) => u.id)).toEqual([USER])
    expect(found[0]).not.toHaveProperty("password_hash")
    expect(found[0]).not.toHaveProperty("totp_secret")
  })
})
