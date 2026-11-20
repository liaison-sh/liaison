// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { activityRead } from "./activity"
import type { AgreementsCtx } from "./ctx"
import { memoryDb } from "./memory-db.testutil"

const COMPANY = "c0000000-0000-4000-8000-00000000000c"
const OTHER = "d0000000-0000-4000-8000-00000000000d"
const PERSON = "e0000000-0000-4000-8000-00000000000e"

async function world() {
  const db = memoryDb()
  const add = (row: Record<string, unknown>) => db.insert("agreements", row)
  const signed = await add({
    number: "AG-2026-014",
    kind: "sow",
    status: "signed",
    company_id: COMPANY,
    price_minor: 4_200_000,
    signed_at: "2026-11-02 10:00:00+00",
    updated_at: "2026-11-05 10:00:00+00",
  })
  const cr = await add({
    number: "AG-2026-015",
    kind: "change_request",
    status: "sent",
    contact_id: PERSON,
    updated_at: "2026-11-04 10:00:00+00",
  })
  await add({
    number: "AG-2026-016",
    status: "draft",
    company_id: COMPANY,
    updated_at: "2026-11-06 10:00:00+00",
  })
  await add({
    number: "AG-2026-017",
    status: "signed",
    company_id: OTHER,
    signed_at: "2026-11-03 10:00:00+00",
  })
  const ctx = { orgId: "o", userId: "u", db } as unknown as AgreementsCtx
  return { ctx, signedId: signed.id, crId: cr.id }
}

describe("agreements on the company timeline", () => {
  it("returns one row per agreement of the company or its people, never a draft, newest first", async () => {
    const w = await world()
    const out = await activityRead(w.ctx, {
      companyId: COMPANY,
      contactIds: [PERSON],
      prefix: "agreements:",
    })
    expect(out.rows.map((r) => r.title)).toEqual(["AG-2026-015 sent", "AG-2026-014 signed"])
    // Signed: dated when it was signed, not when the row last moved.
    expect(out.rows[1]?.at).toBe(new Date(Date.UTC(2026, 10, 2, 10)).toISOString())
    expect(out.rows[1]?.href).toEqual({
      app: "agreements",
      entityType: "agreement",
      entityId: w.signedId,
    })
  })

  it("a row names number and status only: no price, no signer", async () => {
    const w = await world()
    const out = await activityRead(w.ctx, { companyId: COMPANY, contactIds: [PERSON] })
    // The row's own id and its link's id are random and may hold any digits; the rest is what a
    // reader sees.
    const text = JSON.stringify(
      out.rows.map(({ id: _id, href, ...rest }) => ({
        ...rest,
        href: { ...href, entityId: undefined },
      })),
    )
    expect(text).not.toContain("4200000")
    expect(text).not.toContain("42")
    expect(out.rows.every((r) => r.who === null)).toBe(true)
  })

  it("pages strictly older than the cursor", async () => {
    const w = await world()
    const first = await activityRead(w.ctx, {
      companyId: COMPANY,
      contactIds: [PERSON],
      limit: 1,
      prefix: "agreements:",
    })
    const row = first.rows[0] as { at: string; id: string }
    const next = await activityRead(w.ctx, {
      companyId: COMPANY,
      contactIds: [PERSON],
      before: { at: row.at, id: `agreements:${row.id}` },
      prefix: "agreements:",
    })
    expect(next.rows.map((r) => r.title)).toEqual(["AG-2026-014 signed"])
  })

  it("never reads signature events, and is declared as the Agreements source under the read scope", async () => {
    expect(readFileSync(join(import.meta.dir, "activity.ts"), "utf8")).not.toContain(
      "signature_events",
    )
    const m = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
    expect(m.activitySources).toEqual([
      {
        tool: "activity_read",
        scope: "agreements:agreements:read",
        label: "Agreements",
        filterKey: "agreements",
      },
    ])
    expect(m.tools.activity_read).toMatchObject({
      readOnly: true,
      agentVisible: false,
      timeoutMs: 2000,
      requiredScopes: ["agreements:agreements:read"],
    })
  })
})
