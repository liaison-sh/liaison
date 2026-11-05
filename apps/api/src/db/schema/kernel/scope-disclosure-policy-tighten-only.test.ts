// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-FX10b defect 3: the tighten-only invariant, enforced by the DATABASE.
//
// 0068 deliberately left the transition rule to T09's code guard, on the
// grounds that a CHECK constraint cannot see the old row. Skeptic pass 4 then
// showed the invariant was unenforced in practice: an org admin's own
// `UPDATE ... SET disclosable = true` on a tightened row SUCCEEDED (1 row), and
// `updateScopeDisclosurePolicy` has no production caller yet, so the first
// caller that writes its own UPDATE would lose the rule silently. `liaison_app`
// is BYPASSRLS, so a privileged handle could also DELETE a tightened row.
//
// 0069 adds the guard as a trigger, which every role runs: BYPASSRLS skips row
// security but never skips triggers.
//
// TWO AUTHORITIES, KEPT UNAMBIGUOUS. T09 is the only authority a caller is
// meant to meet: it refuses the loosening in code, before any SQL, with the
// friendly typed `E_DISCLOSURE_POLICY_LOOSENING`, and it never writes `true` at
// all. The trigger sits underneath it as a backstop no correct path can reach,
// and when it does fire it raises its own SQLSTATE `LI001` — a different shape
// from T09's error, so "the app guard refused" and "something bypassed the app
// guard" can never be confused for one another.
//
// DELETE is refused the way the table already refuses it under RLS: 0068 gives
// `liaison_rls` no DELETE policy, so a delete there affects 0 rows without
// raising. The trigger extends exactly that shape to the privileged handles —
// the row simply survives and the command reports 0 rows (plus a server
// WARNING) — rather than inventing a second, fatal failure mode for a
// statement that is already a no-op for every non-privileged caller. An org
// cascade is the one delete that proceeds: once the organization is gone the
// row governs nothing, and suppressing it there would strand a row whose FK
// parent no longer exists.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

/** The SQLSTATE 0069 raises, distinct from anything T09 throws. */
const TIGHTEN_ONLY_SQLSTATE = "LI001"

describe("kernel.scope_disclosure_policy tighten-only trigger (FX10b)", () => {
  const ORG_A = crypto.randomUUID()
  const ORG_B = crypto.randomUUID()
  const A_ADMIN = crypto.randomUUID()
  const tag = ORG_A.slice(0, 8)

  const ADMIN_SCOPE = "kernel:agents:admin"
  /** Seeded non-disclosable: the row every refusal below is aimed at. */
  const TIGHT = `tightonly:tight:${tag}`
  /** Seeded disclosable: the control that proves the guard is scoped. */
  const OPEN = `tightonly:open:${tag}`

  const ctx = (userId: string, orgId: string, scopes: string[]): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: {},
  })

  /** The value as it really stands, read from outside every policy. */
  const stored = async (orgId: string, scope: string): Promise<boolean | undefined> =>
    (
      await sql<{ disclosable: boolean }[]>`
        SELECT disclosable FROM kernel.scope_disclosure_policy
        WHERE org_id = ${orgId} AND scope = ${scope}`
    )[0]?.disclosable

  /**
   * Assert the statement was refused by 0069's trigger specifically. The error
   * is awaited INSIDE this helper: a postgres.js query builder is lazy, so an
   * un-awaited `expect(...).rejects` would never run the query at all.
   * Drizzle may wrap the driver error, so the code is read through `cause` too.
   */
  async function expectTriggerRefusal(run: () => Promise<unknown>): Promise<void> {
    let thrown: unknown
    try {
      await run()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    const err = thrown as { code?: string; cause?: { code?: string } }
    expect(err.code ?? err.cause?.code).toBe(TIGHTEN_ONLY_SQLSTATE)
  }

  beforeAll(async () => {
    for (const [id, name, slug] of [
      [ORG_A, "TightenTriggerA", `tighten-trigger-a-${tag}`],
      [ORG_B, "TightenTriggerB", `tighten-trigger-b-${tag}`],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, ${name}, ${slug})`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${A_ADMIN}, ${ORG_A}, ${`tighten-trigger-admin-${tag}@test.com`}, 'a-admin', 'x')`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${ORG_A}, ${TIGHT}, false)`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${ORG_A}, ${OPEN}, true)`
  })

  afterAll(async () => {
    // Deleting the organization is the supported way to remove a tightened
    // row: the FK cascade is the one delete path 0069 lets through.
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("an org admin cannot flip a tightened row back to disclosable", async () => {
    // Pass 4 ran exactly this and it returned 1 row.
    await expectTriggerRefusal(() =>
      withRlsContext(ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE]), (tx) =>
        tx.execute(
          drizzleSql`UPDATE kernel.scope_disclosure_policy SET disclosable = true
            WHERE org_id = ${ORG_A} AND scope = ${TIGHT}`,
        ),
      ),
    )
    expect(await stored(ORG_A, TIGHT)).toBe(false)
  })

  it("a BYPASSRLS handle cannot flip a tightened row back to disclosable", async () => {
    await expectTriggerRefusal(
      () => sql`UPDATE kernel.scope_disclosure_policy SET disclosable = true
        WHERE org_id = ${ORG_A} AND scope = ${TIGHT}`,
    )
    expect(await stored(ORG_A, TIGHT)).toBe(false)
  })

  it("a BYPASSRLS DELETE of a tightened row removes nothing and the row survives", async () => {
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM kernel.scope_disclosure_policy
      WHERE org_id = ${ORG_A} AND scope = ${TIGHT} RETURNING id`
    // Spread: postgres.js hands back a RowList, not a plain array.
    expect([...deleted]).toEqual([])
    expect(await stored(ORG_A, TIGHT)).toBe(false)
  })

  it("a disclosable row can still be deleted by a privileged handle", async () => {
    const scope = `tightonly:removable:${tag}`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${ORG_A}, ${scope}, true)`
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM kernel.scope_disclosure_policy
      WHERE org_id = ${ORG_A} AND scope = ${scope} RETURNING id`
    expect(deleted).toHaveLength(1)
    expect(await stored(ORG_A, scope)).toBeUndefined()
  })

  it("tightening is still allowed, and re-tightening an already tightened row is a no-op", async () => {
    // true -> false, the move S7 exists to allow.
    const tightened = await sql<{ disclosable: boolean }[]>`
      UPDATE kernel.scope_disclosure_policy SET disclosable = false
      WHERE org_id = ${ORG_A} AND scope = ${OPEN} RETURNING disclosable`
    expect(tightened[0]?.disclosable).toBe(false)

    // false -> false, the shape T09's onConflictDoUpdate writes.
    const again = await sql<{ disclosable: boolean }[]>`
      UPDATE kernel.scope_disclosure_policy SET disclosable = false, updated_at = now()
      WHERE org_id = ${ORG_A} AND scope = ${OPEN} RETURNING disclosable`
    expect(again[0]?.disclosable).toBe(false)
  })

  it("a tightened row cannot be renamed to another scope or moved to another org", async () => {
    // Either move would leave the ORIGINAL scope with no row, i.e. back to the
    // disclosable default: the same loosening by a different spelling.
    await expectTriggerRefusal(
      () => sql`UPDATE kernel.scope_disclosure_policy SET scope = ${`${TIGHT}:renamed`}
        WHERE org_id = ${ORG_A} AND scope = ${TIGHT}`,
    )
    await expectTriggerRefusal(
      () => sql`UPDATE kernel.scope_disclosure_policy SET org_id = ${ORG_B}
        WHERE org_id = ${ORG_A} AND scope = ${TIGHT}`,
    )
    expect(await stored(ORG_A, TIGHT)).toBe(false)
  })

  it("deleting the organization still removes its tightened rows", async () => {
    // Erasure and test teardown must not be blocked, and a suppressed cascade
    // would strand a row pointing at an organization that no longer exists.
    const orgC = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgC}, 'TightenTriggerC', ${`tighten-trigger-c-${tag}`})`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${orgC}, ${`tightonly:cascade:${tag}`}, false)`

    await sql`DELETE FROM kernel.organizations WHERE id = ${orgC}`

    const left = await sql<{ id: string }[]>`
      SELECT id FROM kernel.scope_disclosure_policy WHERE org_id = ${orgC}`
    expect([...left]).toEqual([])
  })

  it("the trigger is armed on the table for both UPDATE and DELETE", async () => {
    const triggers = extractRows<{ tgname: string }>(
      await sql`
        SELECT t.tgname FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kernel'
          AND c.relname = 'scope_disclosure_policy'
          AND NOT t.tgisinternal`,
    )
    expect(triggers.map((t) => t.tgname).sort()).toEqual([
      "scope_disclosure_policy_no_delete_tightened",
      "scope_disclosure_policy_tighten_only",
    ])
  })
})
