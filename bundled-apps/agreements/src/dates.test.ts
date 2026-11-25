// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily dates job: a signed agreement inside its notice period raises the expiring
// event once; a send whose every link expired with nobody signed becomes expired; one
// where somebody signed stays partly signed. Dates are date-only strings and the day is
// the org's today, both sides of each threshold.

import { describe, expect, it } from "bun:test"
import type { AgreementsCtx } from "./ctx"
import { datesDaily } from "./dates"
import { memoryDb } from "./memory-db.testutil"

function ctxFor(db: ReturnType<typeof memoryDb>, today: string, links: unknown[] = []) {
  const emitted: Array<{ action: string; data?: unknown }> = []
  const ctx = {
    orgId: "org",
    userId: "00000000-0000-0000-0000-000000000000",
    db,
    today,
    client_actions_record: async () => ({ status: "ok", links }),
    emit: async (e: { action: string; data?: unknown }) => {
      emitted.push(e)
      return null
    },
  } as unknown as AgreementsCtx
  return { ctx, emitted }
}

async function agreement(db: ReturnType<typeof memoryDb>, row: Record<string, unknown>) {
  const { id } = await db.insert("agreements", { number: "AG-2026-001", title: "MSA", ...row })
  await db.insert("agreement_versions", { agreement_id: id, number: 1, status: "frozen" })
  return id
}

describe("the daily dates job", () => {
  it("raises the expiring event once a signed agreement is inside its notice, and only once", async () => {
    const db = memoryDb()
    const id = await agreement(db, { status: "signed", renews_on: "2026-12-31", notice_days: 30 })
    const before = ctxFor(db, "2026-11-30")
    await datesDaily(before.ctx)
    expect(before.emitted).toEqual([])
    const on = ctxFor(db, "2026-12-01")
    await datesDaily(on.ctx)
    expect(on.emitted.map((e) => e.action)).toEqual(["expiring"])
    expect(on.emitted[0]?.data).toMatchObject({ number: "AG-2026-001", date: "2026-12-31" })
    const next = ctxFor(db, "2026-12-02")
    await datesDaily(next.ctx)
    expect(next.emitted).toEqual([])
    expect((db.tables.get("agreements") ?? []).find((r) => r.id === id)?.expiring_notified_on).toBe(
      "2026-12-31",
    )
  })

  it("a send whose every link expired with nobody signed becomes expired", async () => {
    const db = memoryDb()
    const id = await agreement(db, { status: "sent" })
    const { ctx, emitted } = ctxFor(db, "2026-11-30", [
      { id: "a", state: "expired" },
      { id: "b", state: "expired" },
    ])
    await datesDaily(ctx)
    expect((db.tables.get("agreements") ?? []).find((r) => r.id === id)?.status).toBe("expired")
    expect(emitted.map((e) => e.action)).toEqual(["expired"])
  })

  it("a send with one signature and one expired link stays partly signed", async () => {
    const db = memoryDb()
    const id = await agreement(db, { status: "partly_signed" })
    const { ctx, emitted } = ctxFor(db, "2026-11-30", [
      { id: "a", state: "decided" },
      { id: "b", state: "expired" },
    ])
    await datesDaily(ctx)
    expect((db.tables.get("agreements") ?? []).find((r) => r.id === id)?.status).toBe(
      "partly_signed",
    )
    expect(emitted).toEqual([])
  })
})
