// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { AgreementsCtx } from "./ctx"
import { memoryDb } from "./memory-db.testutil"
import { onPortalAccessEnded } from "./portal-ended"

type Link = {
  id: string
  invited_name: string
  state: string
  replaced?: boolean
  revoke_reason?: string | null
}

function world(links: Record<string, Link[]>) {
  const db = memoryDb()
  const emitted: unknown[] = []
  const ctx = {
    orgId: "o",
    userId: "",
    db,
    client_actions_record: async (p: { target_id?: string }) =>
      JSON.stringify({ status: "ok", links: links[p.target_id ?? ""] ?? [] }),
    emit: async (e: unknown) => {
      emitted.push(e)
      return { ok: true }
    },
  } as unknown as AgreementsCtx
  return { db, ctx, emitted }
}

describe("a company's portal access ends", () => {
  it("an agreement waiting on a withdrawn link keeps its status and its activity names the signer and why", async () => {
    const links: Record<string, Link[]> = {}
    const { db, ctx, emitted } = world(links)
    const a = await db.insert("agreements", { number: "AG-7", status: "sent", company_id: "c1" })
    const other = await db.insert("agreements", {
      number: "AG-8",
      status: "sent",
      company_id: "c2",
    })
    const v = await db.insert("agreement_versions", {
      agreement_id: a.id,
      number: 2,
      status: "frozen",
    })
    const o = await db.insert("agreement_versions", {
      agreement_id: other.id,
      number: 1,
      status: "frozen",
    })
    links[v.id] = [
      { id: "l1", invited_name: "Claire Martin", state: "revoked", revoke_reason: "access_ended" },
      { id: "l2", invited_name: "Paul Roux", state: "revoked", revoke_reason: "withdrawn" },
      {
        id: "l3",
        invited_name: "Old Link",
        state: "revoked",
        revoke_reason: "access_ended",
        replaced: true,
      },
    ]
    // Another company's agreement is never touched.
    links[o.id] = [
      { id: "l4", invited_name: "Autre", state: "revoked", revoke_reason: "access_ended" },
    ]
    const out = await onPortalAccessEnded(ctx, { data: { companyId: "c1" } })
    expect(out).toEqual({ status: "withdrawn", links: 1 })
    expect(emitted).toEqual([
      {
        entity: "agreement",
        action: "links_withdrawn",
        entityId: a.id,
        data: { number: "AG-7", version: 2, signers: ["Claire Martin"], reason: "access_ended" },
      },
    ])
    expect((await db.findOne("agreements", a.id)) as { status?: string } | null).toMatchObject({
      status: "sent",
    })
  })

  it("a signed agreement and an event with no company change nothing", async () => {
    const { db, ctx, emitted } = world({})
    await db.insert("agreements", { number: "AG-9", status: "signed", company_id: "c1" })
    expect(await onPortalAccessEnded(ctx, { data: { companyId: "c1" } })).toEqual({
      status: "none",
      links: 0,
    })
    expect(await onPortalAccessEnded(ctx, {})).toEqual({ status: "ignored" })
    expect(emitted).toEqual([])
  })
})
