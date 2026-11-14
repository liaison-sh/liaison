// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reserving a reconciliation's sources at Create, on the real database: the live-claim index is
// what keeps one task off two invoices, a retry reuses its own claims, an hour-old reservation with
// no document goes, and a line left at zero is recorded as left off.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { reserveClaims } from "./claims"
import {
  asPerson,
  type ClaimsWorld,
  claimState,
  claimsOf,
  claimsWorld,
  forgetClaimsWorld,
  heldClaim,
  storedReconciliation,
} from "./claims.test-helpers"
import { sweepClaims } from "./reconcile-sweep"
import { ProjectsServiceError } from "./statuses"

let w: ClaimsWorld

beforeAll(async () => {
  await acquireTestLock()
  w = await claimsWorld("CLAIM", 8)
}, 120_000)

afterAll(async () => {
  forgetClaimsWorld(w)
  await releaseTestLock()
})

const reserve = (id: string, userId?: string) =>
  asPerson(
    w,
    (tx) =>
      reserveClaims(tx, { orgId: w.orgId, reconciliationId: id, documentRef: `reconcile:${id}:1` }),
    userId ? { userId } : {},
  )

describe("billing claims at Create", () => {
  it("two proposals for overlapping periods cannot both reserve one task, the second is told which document holds it", async () => {
    const first = await storedReconciliation(w, {
      month: "2026-09",
      lines: [{ tasks: ["CLAIM-1", "CLAIM-2"], bill: 480 }],
    })
    // One proposed card per person and period: the second proposal is a colleague's.
    const colleague = await minimal.session(w.orgId)
    const second = await storedReconciliation(w, {
      month: "2026-09",
      createdBy: colleague.userId,
      lines: [{ tasks: ["CLAIM-2"], bill: 240 }],
    })
    // Two transactions at once: the index lets one through and the other waits, then does nothing.
    const outcomes = await Promise.allSettled([
      reserve(first.id),
      reserve(second.id, colleague.userId),
    ])
    const ok = outcomes.filter((o) => o.status === "fulfilled")
    const refused = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    const err = refused[0]!.reason as ProjectsServiceError
    expect(err).toBeInstanceOf(ProjectsServiceError)
    expect(err.code).toBe("already_on")
    expect(err.status).toBe(409)
    expect(err.message).toContain("Work item 2")
    expect(err.message).toContain("draft invoice for Maison Delorme claim")
    // The refused reservation wrote nothing: its own task stays free.
    const firstWon = ok[0] === outcomes[0]
    const loser = firstWon ? second.id : first.id
    const loserBy = firstWon ? colleague.userId : undefined
    expect(await claimsOf(loser)).toEqual([])
    // Once the winner's invoice has a number, the refusal names it.
    const winner = loser === first.id ? second.id : first.id
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET state = 'billed', document_number = 'F-2026-0101'
       WHERE reconciliation_id = ${winner}::uuid`)
    const again = await reserve(loser, loserBy).catch((e) => e as ProjectsServiceError)
    expect((again as ProjectsServiceError).code).toBe("already_on")
    expect((again as ProjectsServiceError).message).toContain("invoice F-2026-0101")
    expect((again as ProjectsServiceError).details).toEqual(
      expect.objectContaining({ documentNumber: "F-2026-0101" }),
    )
  })

  it("a retry with the same proposal reuses its own claims", async () => {
    const r = await storedReconciliation(w, {
      month: "2026-08",
      lines: [
        {
          tasks: ["CLAIM-3"],
          bill: 300,
          proofs: [{ kind: "commit", ref: "abc1234", label: "Search fix" }],
        },
      ],
    })
    const one = await reserve(r.id)
    expect(one).toEqual(expect.objectContaining({ reserved: 2, reused: false }))
    const two = await reserve(r.id)
    expect(two).toEqual(expect.objectContaining({ reserved: 2, reused: true }))
    const claims = await claimsOf(r.id)
    expect(claims.filter((c) => c.state === "reserved")).toHaveLength(2)
    const stored = extractRows<{ document_ref: string }>(
      await db.execute(drizzleSql`
        SELECT document_ref FROM app_projects.reconciliations WHERE id = ${r.id}::uuid`),
    )[0]
    expect(stored?.document_ref).toBe(`reconcile:${r.id}:1`)
  })

  it("a reservation with no document is kept at 59 minutes and released at 61", async () => {
    const early = await storedReconciliation(w, { month: "2026-07", lines: [] })
    const late = await storedReconciliation(w, { month: "2026-04", lines: [] })
    const kept = await heldClaim(w, "CLAIM-4", early.id, 59)
    const gone = await heldClaim(w, "CLAIM-5", late.id, 61)
    await sweepClaims()
    expect(await claimState(kept)).toBe("reserved")
    expect(await claimState(gone)).toBe("released")
  })

  it("a line left at zero is recorded as left off and is not offered again as new", async () => {
    const r = await storedReconciliation(w, {
      month: "2026-06",
      lines: [
        { tasks: ["CLAIM-6"], bill: 0 },
        { tasks: ["CLAIM-7"], bill: 0 },
      ],
    })
    const out = await reserve(r.id)
    expect(out).toEqual(expect.objectContaining({ reserved: 0, leftOff: 2 }))
    const claims = await claimsOf(r.id)
    expect(claims.map((c) => c.state)).toEqual(["left_off", "left_off"])
    // Left off takes no part in the live index: the same task can still be billed by asking.
    const later = await storedReconciliation(w, {
      month: "2026-05",
      lines: [{ tasks: ["CLAIM-6"], bill: 120 }],
    })
    expect(await reserve(later.id)).toEqual(expect.objectContaining({ reserved: 1 }))
  })
})
