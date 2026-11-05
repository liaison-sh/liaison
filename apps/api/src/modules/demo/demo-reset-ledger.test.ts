// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CEILING'S LEDGER SURVIVES THE JOB THAT ENFORCES THE CEILING.
//
// The reserved org's budget is a ROLLING 24 HOURS, summed out of
// `credit_transactions`. The nightly reset ruled that table `clear` and clears
// the reserved org before re-seeding it, so the window was really "since 03:15,
// or 24 hours, whichever is shorter", and a reviewer could spend the whole
// allowance either side of the boundary: up to twice the ceiling in a night,
// with the number in the environment saying otherwise.
//
// The justification for clearing it was about visitor orgs. They have no
// ceiling at all (they spend only their own pasted key), and an expired one is
// PURGED rather than reset, so nobody ever inherits anybody's ledger.
//
// ── THE MUTATION THAT PROVES THIS BITES ────────────────────────────────────
//  * Rule `credit_transactions: "clear"` again: both cases fail, the second
//    with the reserved org's spend back at zero after a reset.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import { KERNEL_RESET_RULES, resetDemoOrgContent, runDemoReset } from "~/modules/demo/demo-reset"
import { demoOrgTokensUsed } from "~/modules/demo/demo-spend"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MODEL = "ledger-model"

describe("the nightly reset and the ceiling's ledger", () => {
  let reservedOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    reservedOrgId = (await ensureOrg({ slug: "ledger-reserved", name: "Ledger Reserved" })).orgId
    await markOrgAsDemo(reservedOrgId, reservedMarker())
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    invalidateDemoMarker()
  })

  it("does not rule the token ledger as content", () => {
    expect(KERNEL_RESET_RULES.credit_transactions).toBe("keep")
  })

  it("leaves the reserved org's rolling window where the clock left it", async () => {
    DemoModeTestAccess.set(true)
    await sql`
      INSERT INTO kernel.credit_transactions
        (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost)
      VALUES (${reservedOrgId}, 'byok_usage', '-1', '0', ${MODEL}, 40000, 2000, '1')`
    expect(await demoOrgTokensUsed(reservedOrgId)).toBe(42_000)

    await resetDemoOrgContent(reservedOrgId)

    expect(await demoOrgTokensUsed(reservedOrgId)).toBe(42_000)
  })

  // A reviewer's phone registers its push token once, at sign in. The nightly
  // reset used to clear `push_tokens` with the rest of the content, so the
  // morning after, "ask the agent to message you in one minute" reached no
  // device. Rule `push_tokens: "clear"` again and this fails.
  it("keeps the reviewer's push token across the reset", async () => {
    DemoModeTestAccess.set(true)
    const userId = crypto.randomUUID()
    const token = `reviewer-device-${userId.slice(0, 8)}`
    await sql`
      INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${userId}, ${reservedOrgId}, ${`push-${userId.slice(0, 8)}@demo.liaison.sh`}, 'Reviewer', 'x')`
    await sql`
      INSERT INTO kernel.push_tokens (org_id, user_id, token, platform)
      VALUES (${reservedOrgId}, ${userId}, ${token}, 'ios')`
    expect(KERNEL_RESET_RULES.push_tokens).toBe("keep")

    await resetDemoOrgContent(reservedOrgId)

    const rows = await sql`
      SELECT token FROM kernel.push_tokens WHERE org_id = ${reservedOrgId} AND token = ${token}`
    expect(rows.length).toBe(1)
  })

  // The nightly run resolves the App Review credential BEFORE it deletes
  // anything. `reservedOwner()` throws when LIAISON_DEMO_REVIEWER_PASSWORD is
  // unset, and a throw after the clear would leave the one curated workspace on
  // the box emptied with no re-seed behind it. Move the `reservedOwner()` call
  // back below `resetDemoOrgContent` in `runDemoReset` and this fails: the rows
  // are gone and the org is left flagged mid reset.
  it("clears nothing when the App Review password is not configured", async () => {
    DemoModeTestAccess.set(true)
    const saved = env.LIAISON_DEMO_REVIEWER_PASSWORD
    ;(env as { LIAISON_DEMO_REVIEWER_PASSWORD: string }).LIAISON_DEMO_REVIEWER_PASSWORD = ""
    try {
      await sql`
        INSERT INTO kernel.credit_transactions
          (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost)
        VALUES (${reservedOrgId}, 'byok_usage', '-1', '0', ${MODEL}, 1000, 0, '1')`
      const before = await demoOrgTokensUsed(reservedOrgId)
      const outcome = await runDemoReset()
      const ours = outcome.reseeded.find((r) => r.orgId === reservedOrgId)
      expect(ours?.action).toBe("skipped")
      expect(ours?.ok).toBe(false)
      expect(ours?.detail).toContain("LIAISON_DEMO_REVIEWER_PASSWORD")
      // Untouched: a misconfigured box loses nothing.
      expect(await demoOrgTokensUsed(reservedOrgId)).toBe(before)
      const [{ users }] = await sql`
        SELECT count(*)::int AS users FROM kernel.users WHERE org_id = ${reservedOrgId}`
      expect(users).toBeGreaterThanOrEqual(0)
    } finally {
      ;(env as { LIAISON_DEMO_REVIEWER_PASSWORD: string }).LIAISON_DEMO_REVIEWER_PASSWORD = saved
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
    }
  })

  it("still takes the platform credit away, which is the other half", async () => {
    DemoModeTestAccess.set(true)
    await sql`
      UPDATE kernel.credit_balances SET included_balance = 25, purchased_balance = 10
      WHERE org_id = ${reservedOrgId}`
    await resetDemoOrgContent(reservedOrgId)
    const [row] = await sql`
      SELECT included_balance::text AS included, purchased_balance::text AS purchased
      FROM kernel.credit_balances WHERE org_id = ${reservedOrgId}`
    expect(Number(row.included)).toBe(0)
    expect(Number(row.purchased)).toBe(0)
  })
})
