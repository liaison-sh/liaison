// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tighten-only enforcement for `kernel.scope_disclosure_policy` (S7, D4).
//
// Every write and every read below goes through `withRlsContext`, i.e. the
// app's `liaison_rls` role with the real GUCs, so the admin gate under test is
// the real INSERT/UPDATE policy from 0068 and not a privileged shortcut. The
// privileged connection appears only to seed fixtures and to prove, from
// outside the policy, what did or did not land.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  assertDisclosurePolicyTightenOnly,
  isScopeDisclosable,
  listNonDisclosableScopes,
  ScopeDisclosurePolicyError,
  updateScopeDisclosurePolicy,
} from "~/modules/permissions/scope-disclosure-policy"

describe("scope disclosure policy: tighten only", () => {
  const ORG_A = crypto.randomUUID()
  const ORG_B = crypto.randomUUID()
  const A_ADMIN = crypto.randomUUID()
  const A_MEMBER = crypto.randomUUID()
  const B_ADMIN = crypto.randomUUID()
  const tag = ORG_A.slice(0, 8)

  const ADMIN_SCOPE = "kernel:agents:admin"
  /** Seeded non-disclosable in ORG_A only, so the isolation case has a control. */
  const SHARED_SCOPE = `tighten:shared:${tag}`
  const OPEN_SCOPE = `tighten:open:${tag}`

  const ctx = (userId: string, orgId: string, scopes: string[]): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: {},
  })

  const asAdminA = ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE])
  const asMemberA = ctx(A_MEMBER, ORG_A, ["finance:invoices:read"])
  const asAdminB = ctx(B_ADMIN, ORG_B, [ADMIN_SCOPE])

  const storedValue = async (orgId: string, scope: string): Promise<boolean | undefined> =>
    extractRows<{ disclosable: boolean }>(
      await db.execute(
        drizzleSql`SELECT disclosable FROM kernel.scope_disclosure_policy
          WHERE org_id = ${orgId} AND scope = ${scope}`,
      ),
    )[0]?.disclosable

  beforeAll(async () => {
    for (const [id, name, slug] of [
      [ORG_A, "TightenOrgA", `tighten-a-${tag}`],
      [ORG_B, "TightenOrgB", `tighten-b-${tag}`],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, ${name}, ${slug})`
    }
    for (const [id, orgId, name] of [
      [A_ADMIN, ORG_A, "a-admin"],
      [A_MEMBER, ORG_A, "a-member"],
      [B_ADMIN, ORG_B, "b-admin"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${orgId}, ${`tighten-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${ORG_A}, ${SHARED_SCOPE}, false)`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.scope_disclosure_policy WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("the guard refuses only the loosening transition", () => {
    expect(() => assertDisclosurePolicyTightenOnly(true, false)).not.toThrow()
    expect(() => assertDisclosurePolicyTightenOnly(true, true)).not.toThrow()
    expect(() => assertDisclosurePolicyTightenOnly(false, false)).not.toThrow()

    let thrown: unknown
    try {
      assertDisclosurePolicyTightenOnly(false, true)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ScopeDisclosurePolicyError)
    expect((thrown as ScopeDisclosurePolicyError).code).toBe("E_DISCLOSURE_POLICY_LOOSENING")
  })

  it("an admin can mark a scope non-disclosable", async () => {
    const scope = `tighten:admin:${tag}`
    expect(await withRlsContext(asAdminA, (tx) => isScopeDisclosable(tx, ORG_A, scope))).toBe(true)

    const result = await withRlsContext(asAdminA, (tx) =>
      updateScopeDisclosurePolicy(tx, { orgId: ORG_A, scope, disclosable: false }),
    )
    expect(result).toEqual({ scope, disclosable: false })

    expect(await storedValue(ORG_A, scope)).toBe(false)
    expect(await withRlsContext(asAdminA, (tx) => isScopeDisclosable(tx, ORG_A, scope))).toBe(false)
  })

  it("a member without kernel:agents:admin cannot mark a scope non-disclosable", async () => {
    const scope = `tighten:denied:${tag}`
    // The query builder is lazy: await it inside the promise the matcher sees.
    await expect(
      (async () =>
        await withRlsContext(asMemberA, (tx) =>
          updateScopeDisclosurePolicy(tx, { orgId: ORG_A, scope, disclosable: false }),
        ))(),
    ).rejects.toThrow()

    // Nothing landed, seen from outside the policy.
    expect(await storedValue(ORG_A, scope)).toBeUndefined()
  })

  it("a member without kernel:agents:admin cannot tighten an existing row", async () => {
    const scope = `tighten:denied-existing:${tag}`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope) VALUES (${ORG_A}, ${scope})`

    await expect(
      (async () =>
        await withRlsContext(asMemberA, (tx) =>
          updateScopeDisclosurePolicy(tx, { orgId: ORG_A, scope, disclosable: false }),
        ))(),
    ).rejects.toThrow()

    expect(await storedValue(ORG_A, scope)).toBe(true)
  })

  it("marking a non-disclosable scope disclosable again is refused, even for an admin", async () => {
    let thrown: unknown
    try {
      await withRlsContext(asAdminA, (tx) =>
        updateScopeDisclosurePolicy(tx, { orgId: ORG_A, scope: SHARED_SCOPE, disclosable: true }),
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ScopeDisclosurePolicyError)
    expect((thrown as ScopeDisclosurePolicyError).code).toBe("E_DISCLOSURE_POLICY_LOOSENING")

    // The stored value never moved, and the read still reports it withheld.
    expect(await storedValue(ORG_A, SHARED_SCOPE)).toBe(false)
    expect(
      await withRlsContext(asAdminA, (tx) => isScopeDisclosable(tx, ORG_A, SHARED_SCOPE)),
    ).toBe(false)
  })

  it("tightening an already non-disclosable scope stays non-disclosable", async () => {
    const result = await withRlsContext(asAdminA, (tx) =>
      updateScopeDisclosurePolicy(tx, { orgId: ORG_A, scope: SHARED_SCOPE, disclosable: false }),
    )
    expect(result).toEqual({ scope: SHARED_SCOPE, disclosable: false })
    expect(await storedValue(ORG_A, SHARED_SCOPE)).toBe(false)
  })

  it("a scope with no row reads as disclosable", async () => {
    expect(await storedValue(ORG_A, OPEN_SCOPE)).toBeUndefined()
    expect(await withRlsContext(asMemberA, (tx) => isScopeDisclosable(tx, ORG_A, OPEN_SCOPE))).toBe(
      true,
    )
    expect(
      await withRlsContext(asMemberA, (tx) =>
        listNonDisclosableScopes(tx, ORG_A, [OPEN_SCOPE, `tighten:absent:${tag}`]),
      ),
    ).toEqual([])
  })

  it("asking for disclosable on an already disclosable scope writes nothing", async () => {
    const result = await withRlsContext(asAdminA, (tx) =>
      updateScopeDisclosurePolicy(tx, { orgId: ORG_A, scope: OPEN_SCOPE, disclosable: true }),
    )
    expect(result).toEqual({ scope: OPEN_SCOPE, disclosable: true })
    expect(await storedValue(ORG_A, OPEN_SCOPE)).toBeUndefined()
  })

  it("the read names exactly the non-disclosable scopes of the set", async () => {
    expect(
      await withRlsContext(asMemberA, (tx) =>
        listNonDisclosableScopes(tx, ORG_A, [OPEN_SCOPE, SHARED_SCOPE]),
      ),
    ).toEqual([SHARED_SCOPE])
    expect(
      await withRlsContext(asMemberA, (tx) => listNonDisclosableScopes(tx, ORG_A, [])),
    ).toEqual([])
  })

  it("one org's policy never affects another org's scope", async () => {
    // ORG_A withheld SHARED_SCOPE. ORG_B never did, so it stays disclosable there.
    expect(
      await withRlsContext(asAdminB, (tx) => isScopeDisclosable(tx, ORG_B, SHARED_SCOPE)),
    ).toBe(true)
    expect(
      await withRlsContext(asAdminB, (tx) => listNonDisclosableScopes(tx, ORG_B, [SHARED_SCOPE])),
    ).toEqual([])

    // And tightening it in ORG_B leaves ORG_A's row exactly where it was.
    await withRlsContext(asAdminB, (tx) =>
      updateScopeDisclosurePolicy(tx, { orgId: ORG_B, scope: SHARED_SCOPE, disclosable: false }),
    )
    expect(await storedValue(ORG_B, SHARED_SCOPE)).toBe(false)
    expect(await storedValue(ORG_A, SHARED_SCOPE)).toBe(false)

    // An admin of one org cannot reach into the other org's row through this path.
    await expect(
      (async () =>
        await withRlsContext(asAdminA, (tx) =>
          updateScopeDisclosurePolicy(tx, {
            orgId: ORG_B,
            scope: `tighten:cross:${tag}`,
            disclosable: false,
          }),
        ))(),
    ).rejects.toThrow()
    expect(await storedValue(ORG_B, `tighten:cross:${tag}`)).toBeUndefined()
  })

  it("a tightened row cannot be deleted and re-inserted to fall back to the default", async () => {
    const deleted = await withRlsContext(asAdminA, async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`DELETE FROM kernel.scope_disclosure_policy
            WHERE org_id = ${ORG_A} AND scope = ${SHARED_SCOPE} RETURNING id`,
        ),
      ),
    )
    expect(deleted).toEqual([])
    expect(await storedValue(ORG_A, SHARED_SCOPE)).toBe(false)

    // A re-insert collides with the surviving row rather than resetting it.
    await expect(
      (async () =>
        await withRlsContext(asAdminA, (tx) =>
          tx.execute(
            drizzleSql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope)
              VALUES (${ORG_A}, ${SHARED_SCOPE})`,
          ),
        ))(),
    ).rejects.toThrow()
    expect(await storedValue(ORG_A, SHARED_SCOPE)).toBe(false)

    // And the read still refuses to call it disclosable.
    expect(
      await withRlsContext(asAdminA, (tx) => isScopeDisclosable(tx, ORG_A, SHARED_SCOPE)),
    ).toBe(false)
  })

  it("an unreadable policy row never reads as disclosable", async () => {
    const broken = {
      select: () => {
        throw new Error("policy read failed")
      },
    } as unknown as RlsClient

    expect(await isScopeDisclosable(broken, ORG_A, OPEN_SCOPE)).toBe(false)
    expect(await listNonDisclosableScopes(broken, ORG_A, [OPEN_SCOPE, SHARED_SCOPE])).toEqual([
      OPEN_SCOPE,
      SHARED_SCOPE,
    ])
  })
})
