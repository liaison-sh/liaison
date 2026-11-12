// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.kernel.caller / roles / findUsersByEmail: the directory reads an app needs
// to decide access rules of its own, through the real bridge and database.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

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
  for (const [org, slug] of [
    [ORG, "dir-org"],
    [OTHER_ORG, "dir-other-org"],
  ] as const) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, ${slug}, ${slug}) ON CONFLICT (id) DO NOTHING`
  }
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, totp_secret)
    VALUES (${USER}, ${ORG}, 'Dir.Person@test.com', 'Dir', 'hash-value', 'totp-value'),
           (${OTHER_USER}, ${OTHER_ORG}, 'other@test.com', 'Other', 'hash', null)
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES
    (${ROLE}, ${ORG}, 'dir-analysts'), (${OTHER_ROLE}, ${OTHER_ORG}, 'dir-elsewhere')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'dirprobe:reports:read')
    ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER}, ${ROLE}, ${ORG})
    ON CONFLICT DO NOTHING`
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
