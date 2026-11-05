// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { setUserScopes, UserNotInOrgError } from "~/modules/permissions/app-grants"
import { everyMemberScopeGrants } from "~/modules/permissions/permissions"

const rlsDb = db as unknown as RlsClient

// `__privileged_db__` is a raw pool handle: it carries no `queueEvent`, while
// every production caller of setUserScopes hands it a real transaction that
// does. These tests assert grant and audit semantics rather than the queued
// event, so the outbox is stubbed here (same shape as email-from.test.ts) and
// the events are kept for inspection. The real outbox row is asserted in
// services/security/grant-invalidation.test.ts, which runs in a real tx.
const queuedEvents: unknown[] = []
function patchQueueEvent(client: unknown): void {
  const d = client as { queueEvent?: unknown; transaction: (fn: unknown) => Promise<unknown> }
  d.queueEvent = async (e: unknown) => {
    queuedEvents.push(e)
  }
  const orig = d.transaction.bind(d)
  d.transaction = async (fn: unknown) =>
    orig(async (tx: { queueEvent?: unknown }) => {
      tx.queueEvent = async (e: unknown) => {
        queuedEvents.push(e)
      }
      return (fn as (t: unknown) => unknown)(tx)
    })
}
patchQueueEvent(rlsDb)

const ORG = "00000000-0000-0000-0000-0000000000a1"
const USER = "00000000-0000-0000-0000-0000000000a2"
// A second org + a user belonging to it, plus a deactivated user in ORG, for
// the membership-validation tests.
const OTHER_ORG = "00000000-0000-0000-0000-0000000000b1"
const OTHER_ORG_USER = "00000000-0000-0000-0000-0000000000b2"
const DEACTIVATED_USER = "00000000-0000-0000-0000-0000000000a3"
const NON_MEMBER_UUID = "00000000-0000-0000-0000-0000000000ff"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'AppGrantOrg', 'app-grant-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'app-grant-user@t.com', 'Grant User') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG}, 'OtherOrg', 'app-grant-other-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_ORG_USER}, ${OTHER_ORG}, 'other-org-user@t.com', 'Other Org User') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${DEACTIVATED_USER}, ${ORG}, 'deactivated-user@t.com', 'Deactivated User', 'deactivated') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  // Clean any pre-existing in-namespace grants + the audit log for the fixture user.
  await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${USER} AND org_id = ${ORG}`
  await sql`DELETE FROM kernel.app_scope_grant_audit WHERE target_user_id = ${USER} AND org_id = ${ORG}`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${USER} AND org_id = ${ORG}`
  await sql`DELETE FROM kernel.app_scope_grant_audit WHERE target_user_id = ${USER} AND org_id = ${ORG}`
})

describe("permissions.setUserScopes — namespace ceiling", () => {
  it("grants in-namespace scopes and writes a single audit row", async () => {
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read", "shopify:refunds:create"],
    })
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
      ORDER BY scope
    `
    expect(rows.map((r: any) => r.scope)).toEqual(["shopify:orders:read", "shopify:refunds:create"])
    const audit = await sql`
      SELECT app_name, scopes_set, scopes_added, scopes_removed
      FROM kernel.app_scope_grant_audit
      WHERE target_user_id = ${USER} AND org_id = ${ORG}
    `
    expect(audit.length).toBe(1)
    expect(audit[0].app_name).toBe("shopify")
    expect([...audit[0].scopes_added].sort()).toEqual([
      "shopify:orders:read",
      "shopify:refunds:create",
    ])
    expect(audit[0].scopes_removed).toEqual([])
  })

  it("rejects out-of-namespace grant attempts (other-app)", async () => {
    await expect(
      setUserScopes(rlsDb, {
        orgId: ORG,
        callingApp: "shopify",
        userId: USER,
        scopes: ["mail:conversations:read"],
      }),
    ).rejects.toThrow(/namespace/i)
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
    `
    expect(rows.length).toBe(0)
  })

  it("rejects kernel-scope grant attempts", async () => {
    await expect(
      setUserScopes(rlsDb, {
        orgId: ORG,
        callingApp: "shopify",
        userId: USER,
        scopes: ["kernel:users:write"],
      }),
    ).rejects.toThrow(/namespace/i)
  })

  // I9 — declared-scopes intersection
  it("rejects in-namespace scopes that are not declared in the app manifest", async () => {
    await expect(
      setUserScopes(rlsDb, {
        orgId: ORG,
        callingApp: "shopify",
        userId: USER,
        scopes: ["shopify:orders:read", "shopify:made-up-typo:write"],
        declaredScopes: ["shopify:orders:read", "shopify:orders:write"],
      }),
    ).rejects.toThrow(/not declared/i)
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
    `
    // Tx rolled back — no scopes persisted.
    expect(rows.length).toBe(0)
  })

  it("accepts in-namespace scopes that ARE all declared", async () => {
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read"],
      declaredScopes: ["shopify:orders:read", "shopify:orders:write"],
    })
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
    `
    expect(rows.length).toBe(1)
  })

  it("is idempotent — repeat call with same scopes adds no new grants and logs an empty diff", async () => {
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read"],
    })
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read"],
    })
    const audit = await sql`
      SELECT scopes_added, scopes_removed FROM kernel.app_scope_grant_audit
      WHERE target_user_id = ${USER} AND org_id = ${ORG}
      ORDER BY created_at
    `
    expect(audit.length).toBe(2)
    expect(audit[0].scopes_added).toEqual(["shopify:orders:read"])
    expect(audit[1].scopes_added).toEqual([])
    expect(audit[1].scopes_removed).toEqual([])
  })

  it("computes diff: setUserScopes replaces previous app-namespaced grants", async () => {
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read", "shopify:refunds:create"],
    })
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read", "shopify:products:write"],
    })
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
      ORDER BY scope
    `
    expect(rows.map((r: any) => r.scope)).toEqual(["shopify:orders:read", "shopify:products:write"])
    const lastAudit = await sql`
      SELECT scopes_added, scopes_removed FROM kernel.app_scope_grant_audit
      WHERE target_user_id = ${USER} AND org_id = ${ORG}
      ORDER BY created_at DESC LIMIT 1
    `
    expect(lastAudit[0].scopes_added).toEqual(["shopify:products:write"])
    expect(lastAudit[0].scopes_removed).toEqual(["shopify:refunds:create"])
  })

  it("only touches in-namespace scopes — pre-existing kernel/other-app grants are untouched", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, 'mail:conversations:read')`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, 'kernel:threads:read')`
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: [],
    })
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
      ORDER BY scope
    `
    expect(rows.map((r: any) => r.scope)).toEqual([
      "kernel:threads:read",
      "mail:conversations:read",
    ])
  })

  it("empty-scope-list call clears in-namespace grants but leaves an audit row", async () => {
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read", "shopify:refunds:create"],
    })
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: [],
    })
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG} AND scope LIKE 'shopify:%'
    `
    expect(rows.length).toBe(0)
    const audit = await sql`
      SELECT scopes_added, scopes_removed FROM kernel.app_scope_grant_audit
      WHERE target_user_id = ${USER} AND org_id = ${ORG}
      ORDER BY created_at DESC LIMIT 1
    `
    expect(audit[0].scopes_added).toEqual([])
    expect([...audit[0].scopes_removed].sort()).toEqual([
      "shopify:orders:read",
      "shopify:refunds:create",
    ])
  })
})

describe("permissions.setUserScopes — org-membership validation", () => {
  it("rejects a userId that is not any user (foreign UUID) and writes no rows", async () => {
    await expect(
      setUserScopes(rlsDb, {
        orgId: ORG,
        callingApp: "shopify",
        userId: NON_MEMBER_UUID,
        scopes: ["shopify:orders:read"],
      }),
    ).rejects.toThrow(UserNotInOrgError)
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants WHERE user_id = ${NON_MEMBER_UUID}
    `
    expect(rows.length).toBe(0)
    // No audit row either — the tx rolls back before the audit insert.
    const audit = await sql`
      SELECT 1 FROM kernel.app_scope_grant_audit WHERE target_user_id = ${NON_MEMBER_UUID}
    `
    expect(audit.length).toBe(0)
  })

  it("rejects a userId that belongs to a DIFFERENT org (cross-org dangling grant)", async () => {
    await expect(
      setUserScopes(rlsDb, {
        orgId: ORG,
        callingApp: "shopify",
        userId: OTHER_ORG_USER,
        scopes: ["shopify:orders:read"],
      }),
    ).rejects.toThrow(UserNotInOrgError)
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants WHERE user_id = ${OTHER_ORG_USER} AND org_id = ${ORG}
    `
    expect(rows.length).toBe(0)
  })

  it("rejects a deactivated user (no longer a member)", async () => {
    await expect(
      setUserScopes(rlsDb, {
        orgId: ORG,
        callingApp: "shopify",
        userId: DEACTIVATED_USER,
        scopes: ["shopify:orders:read"],
      }),
    ).rejects.toThrow(UserNotInOrgError)
  })

  it("accepts an active member of the org", async () => {
    await setUserScopes(rlsDb, {
      orgId: ORG,
      callingApp: "shopify",
      userId: USER,
      scopes: ["shopify:orders:read"],
    })
    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants WHERE user_id = ${USER} AND org_id = ${ORG}
    `
    expect(rows.length).toBe(1)
  })
})

// RLS boundary: setUserScopes must work correctly when called from within the
// real liaison_rls role context (not just via the BYPASSRLS privileged
// connection). The production call path runs under withRlsContext; this test
// exercises that exact boundary so an RLS policy gap is caught before shipping.
describe("permissions.setUserScopes — real RLS boundary (liaison_rls role)", () => {
  it("grants scopes successfully when run through the real RLS context as the target user", async () => {
    // Run setUserScopes from inside a withRlsContext (liaison_rls role) transaction.
    // The user context here is for USER themselves — matching the real call path
    // where the acting user is the one whose scopes are being managed.
    await withRlsContext(
      {
        actorType: "user",
        userId: USER,
        orgId: ORG,
        scopes: ["kernel:grants:write"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        await setUserScopes(rlsTx, {
          orgId: ORG,
          callingApp: "shopify",
          userId: USER,
          scopes: ["shopify:orders:read"],
        })
      },
    )

    const rows = await sql`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${USER} AND org_id = ${ORG}
    `
    expect(rows.map((r: any) => r.scope)).toContain("shopify:orders:read")
  })
})

describe("everyMemberScopeGrants: the bug report scope belongs to active members only", () => {
  const grantsOf = async (userId: string, orgId: string) =>
    (
      await withPrivilegedDb(orgId, "test-every-member", (tx) =>
        everyMemberScopeGrants(tx, userId, orgId),
      )
    ).map((g) => g.scope)

  it("an active member holds kernel:bug_reports:file", async () => {
    expect(await grantsOf(USER, ORG)).toContain("kernel:bug_reports:file")
  })

  it("a deactivated member holds nothing", async () => {
    expect(await grantsOf(DEACTIVATED_USER, ORG)).toEqual([])
  })

  it("a person of another org holds nothing here", async () => {
    expect(await grantsOf(OTHER_ORG_USER, ORG)).toEqual([])
  })
})
