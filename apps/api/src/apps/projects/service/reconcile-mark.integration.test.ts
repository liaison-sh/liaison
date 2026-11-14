// SPDX-License-Identifier: FSL-1.1-ALv2
//
// reconcile_mark on the real database: every move is checked against the invoicing documents
// carrying the reconciliation's key first, so a call on a draft flips nothing, a release waits for
// the last document to go, and a partial credit only writes the billed-after-credit figure.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import {
  asPerson,
  type ClaimsWorld,
  claimsOf,
  claimsWorld,
  forgetClaimsWorld,
  heldClaim,
  invoiceCarrying,
  reconciliationRow,
  storedReconciliation,
} from "~/tests/helpers/projects-claims"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { reconcileMark } from "./claims"

let w: ClaimsWorld

beforeAll(async () => {
  await acquireTestLock()
  w = await claimsWorld("MARK", 8)
}, 120_000)

afterAll(async () => {
  forgetClaimsWorld(w)
  await releaseTestLock()
})

const mark = (input: Parameters<typeof reconcileMark>[0]["input"]) =>
  asPerson(w, (tx) => reconcileMark({ tx, orgId: w.orgId, input }))

async function drafted(month: string, taskKey: string, lines = [{ tasks: [taskKey], bill: 480 }]) {
  const ref = `reconcile:${crypto.randomUUID()}:1`
  const r = await storedReconciliation(w, { month, state: "drafted", documentRef: ref, lines })
  await heldClaim(w, taskKey, r.id, 5)
  return { ...r, ref }
}

describe("reconcile_mark", () => {
  it("marking billed on a draft changes nothing", async () => {
    const r = await drafted("2026-09", "MARK-1")
    await invoiceCarrying(w, { externalRef: r.ref, status: "draft" })
    const out = await mark({ reconciliationId: r.id, to: "billed" })
    expect(out.changed).toBe(false)
    expect(out.message).toContain("A draft never moves its claims")
    expect((await claimsOf(r.id)).map((c) => c.state)).toEqual(["reserved"])
    expect((await reconciliationRow(r.id))?.state).toBe("drafted")
    // A release is refused too while the draft still carries the key.
    const release = await mark({ reconciliationId: r.id, to: "released" })
    expect(release.changed).toBe(false)
    expect(release.message).toContain("still carries")
    expect((await claimsOf(r.id)).map((c) => c.state)).toEqual(["reserved"])
  })

  it("marking billed once the invoice carrying the key is issued bills the claims, and a repeat changes nothing", async () => {
    const r = await drafted("2026-08", "MARK-2")
    const inv = await invoiceCarrying(w, { externalRef: r.ref, status: "issued" })
    const out = await mark({ reconciliationId: r.id, to: "billed", documentId: inv.id })
    expect(out).toEqual(
      expect.objectContaining({
        changed: true,
        state: "invoiced",
        claims: 1,
        documentNumber: inv.number,
      }),
    )
    expect(await claimsOf(r.id)).toEqual([
      expect.objectContaining({ state: "billed", document_number: inv.number }),
    ])
    const again = await mark({ reconciliationId: r.id, to: "billed" })
    expect(again.changed).toBe(false)
  })

  it("a partial credit keeps the claims billed and writes the billed-after-credit figure", async () => {
    const r = await drafted("2026-07", "MARK-3", [
      { tasks: ["MARK-3"], bill: 480 },
      { tasks: ["MARK-4"], bill: 240 },
    ])
    const inv = await invoiceCarrying(w, {
      externalRef: r.ref,
      status: "issued",
      creditMinor: 20_000,
    })
    await mark({ reconciliationId: r.id, to: "billed" })
    const out = await mark({
      reconciliationId: r.id,
      to: "partly_credited",
      creditedMinutesByLine: { [r.lineIds[0]!]: 120 },
    })
    expect(out.changed).toBe(true)
    expect(out.message).toContain(`invoice ${inv.number}`)
    const lines = extractRows<{ bill_minutes: number; billed_after_credit_minutes: number | null }>(
      await db.execute(drizzleSql`
        SELECT bill_minutes, billed_after_credit_minutes FROM app_projects.reconciliation_lines
         WHERE reconciliation_id = ${r.id}::uuid ORDER BY position`),
    )
    expect(lines).toEqual([
      { bill_minutes: 480, billed_after_credit_minutes: 360 },
      { bill_minutes: 240, billed_after_credit_minutes: null },
    ])
    expect((await claimsOf(r.id)).map((c) => c.state)).toEqual(["billed"])
    expect((await reconciliationRow(r.id))?.state).toBe("invoiced")
    // The same figure again is a repeat, and a full credit is not claimed from a partial one.
    const repeat = await mark({
      reconciliationId: r.id,
      to: "partly_credited",
      creditedMinutesByLine: { [r.lineIds[0]!]: 120 },
    })
    expect(repeat.changed).toBe(false)
    const notWhole = await mark({ reconciliationId: r.id, to: "credited" })
    expect(notWhole.changed).toBe(false)
    expect((await claimsOf(r.id)).map((c) => c.state)).toEqual(["billed"])
  })

  it("a release once no document carries the key frees the claims and the month is proposed again", async () => {
    const r = await storedReconciliation(w, {
      month: "2026-06",
      state: "drafted",
      documentRef: `reconcile:${crypto.randomUUID()}:1`,
      lines: [
        { tasks: ["MARK-5"], bill: 480 },
        { tasks: ["MARK-6"], bill: 0 },
      ],
      idleDays: 40,
    })
    await heldClaim(w, "MARK-5", r.id, 5)
    await heldClaim(w, "MARK-6", r.id, 5, "all", "left_off")
    const out = await mark({ reconciliationId: r.id, to: "released" })
    expect(out).toEqual(expect.objectContaining({ changed: true, state: "proposed", claims: 2 }))
    expect((await claimsOf(r.id)).map((c) => c.state)).toEqual(["released", "released"])
    expect(await reconciliationRow(r.id)).toEqual({
      state: "proposed",
      fresh: true,
      document_ref: null,
    })
  })
})
