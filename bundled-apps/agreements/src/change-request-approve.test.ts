// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A change request's decision, over the in-memory db and the seal doubles: approved on its
// link with the code, it is a recorded approval (never a signature), sealed and stamped by the
// signature's pipeline; the change request is accepted and its parent's amended total rises by
// its price, once; declined, nothing changes but its own status.

import { describe, expect, it } from "bun:test"
import { changeRequestPrice, decisionFits } from "./change-requests"
import type { AgreementsCtx } from "./ctx"
import type { Row } from "./memory-db.testutil"
import { FROZEN, signedWorld } from "./seal.testutil"
import { onClientActionDecided } from "./send"

const ACTION = "cccccccc-0000-4000-8000-00000000000c"

async function changeRequestWorld(opts: { kind?: string } = {}) {
  const world = await signedWorld()
  const { db } = world
  const parent = await db.insert("agreements", {
    number: "AG-2026-014",
    kind: "sow",
    title: "Website",
    status: "signed",
    price_minor: "4200000",
  })
  await db.update("agreements", world.agreementId, {
    kind: opts.kind ?? "change_request",
    number: "CR-1",
    status: "sent",
    parent_agreement_id: parent.id,
    hours_minutes: 3600,
    rate_minor: "10000",
    price_minor: "600000",
    currency: "EUR",
  })
  await db.update("agreement_versions", world.versionId, { status: "frozen" })
  world.db.tables.set("signature_events", [])
  const record = (decision: string) => ({
    id: ACTION,
    decision,
    decided_at: "2026-11-12 10:00:00+00",
    invited_email: "pauline@maison-marlin.example",
    invited_name: "Pauline Marlin",
    invited_by: "lea@studio.example",
    sign_order: null,
    contact_id: null,
    signer_user_id: null,
    typed_name: "Pauline Marlin",
    capacity: "",
    words_shown: 'By entering my name and the code, I approve "CR-1".',
    words_lang: "en",
    required_phrase: null,
    typed_phrase: null,
    code_verified_at: "2026-11-12 09:59:00+00",
    document_shown_at: "2026-11-12 09:58:00+00",
    reached_end_at: null,
    ip: "198.51.100.7",
    user_agent: "UA",
    target_sha256: FROZEN,
    group: [{ id: ACTION, sign_order: null, decision, open: false }],
  })
  let current = record("approved")
  const ctx = {
    ...world.ctx,
    client_actions_record: async () => ({ status: "ok", record: current }),
  } as unknown as AgreementsCtx
  const decide = (decision: string) => {
    current = record(decision)
    return onClientActionDecided(ctx, {
      data: {
        id: ACTION,
        decision,
        target: { app: "agreements", type: "agreement_version", id: world.versionId },
      },
    }) as Promise<{ status: string; seal?: string }>
  }
  const row = (table: string, id: string) =>
    world.db.tables.get(table)?.find((r) => r.id === id) as Row
  return { world, parentId: parent.id, decide, row }
}

describe("a change request's approval", () => {
  it("is a recorded approval, not a signature: no event at the signature's level, and sealed at the recorded level", async () => {
    const { world, decide } = await changeRequestWorld()
    const out = await decide("approved")
    expect(out.status).toBe("accepted")
    expect(out.seal).toBe("sealed")
    const events = world.db.tables.get("signature_events") ?? []
    expect(events).toHaveLength(1)
    expect(events[0]?.level).toBe("recorded_approval")
    expect(events.some((e) => e.level === "ses")).toBe(false)
    const [pkg] = world.db.tables.get("evidence_packages") ?? []
    expect(pkg?.level).toBe("recorded_approval")
    // The client gets the sealed copy, as a signer does.
    expect(world.ctx.calls.mails.map((m) => m.to)).toContain("pauline@maison-marlin.example")
  })

  it("accepts the change request and raises its parent's amended total by its price, once", async () => {
    const { world, decide, row, parentId } = await changeRequestWorld()
    await decide("approved")
    expect(row("agreements", world.agreementId).status).toBe("accepted")
    expect(String(row("agreements", parentId).amended_total_minor)).toBe("4800000")
    const accepted = world.ctx.calls.emitted.filter(
      (e) => e.entity === "change_request" && e.action === "accepted",
    )
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.data).toMatchObject({
      number: "CR-1",
      parent_number: "AG-2026-014",
      price_minor: "600000",
      amended_total_minor: "4800000",
      hours_minutes: 3600,
    })
    // The same decision delivered again moves nothing.
    expect((await decide("approved")).status).toBe("ignored")
    expect(String(row("agreements", parentId).amended_total_minor)).toBe("4800000")
    expect(
      world.ctx.calls.emitted.filter(
        (e) => e.entity === "change_request" && e.action === "accepted",
      ),
    ).toHaveLength(1)
  })

  it("two deliveries of the approval at once raise the parent's total once", async () => {
    const { decide, row, parentId, world } = await changeRequestWorld()
    const outs = await Promise.all([decide("approved"), decide("approved")])
    expect(outs.map((o) => o.status).sort()).toEqual(["accepted", "ignored"])
    expect(String(row("agreements", parentId).amended_total_minor)).toBe("4800000")
    expect(
      world.ctx.calls.emitted.filter(
        (e) => e.entity === "change_request" && e.action === "accepted",
      ),
    ).toHaveLength(1)
  })

  it("a declined change request is declined and nothing else changes", async () => {
    const { world, decide, row, parentId } = await changeRequestWorld()
    expect((await decide("declined")).status).toBe("declined")
    expect(row("agreements", world.agreementId).status).toBe("declined")
    expect(row("agreements", parentId).amended_total_minor ?? null).toBeNull()
    expect(world.db.tables.get("signature_events") ?? []).toHaveLength(0)
    expect(world.db.tables.get("evidence_packages") ?? []).toHaveLength(0)
    const actions = world.ctx.calls.emitted.map((e) => `${e.entity}:${e.action}`)
    expect(actions).toContain("change_request:declined")
    expect(actions).not.toContain("change_request:accepted")
  })

  it("a signature on a change request, or an approval on any other agreement, records nothing", async () => {
    const cr = await changeRequestWorld()
    expect((await cr.decide("signed")).status).toBe("ignored")
    expect(cr.world.db.tables.get("signature_events") ?? []).toHaveLength(0)
    const sow = await changeRequestWorld({ kind: "sow" })
    expect((await sow.decide("approved")).status).toBe("ignored")
    expect(sow.world.db.tables.get("signature_events") ?? []).toHaveLength(0)
    expect(sow.row("agreements", sow.parentId).amended_total_minor ?? null).toBeNull()
  })
})

describe("a change request's price", () => {
  it("is its own price, else its hours at its rate in minor units", () => {
    expect(
      changeRequestPrice({
        id: "x",
        number: "CR-1",
        kind: "change_request",
        status: "sent",
        price_minor: "600000",
      }),
    ).toBe(600000n)
    expect(
      changeRequestPrice({
        id: "x",
        number: "CR-1",
        kind: "change_request",
        status: "sent",
        hours_minutes: 90,
        rate_minor: "10000",
      }),
    ).toBe(15000n)
  })

  it("only an approval decides a change request; only a signature or an acceptance decides the rest", () => {
    expect(decisionFits("change_request", "approved")).toBe(true)
    expect(decisionFits("change_request", "signed")).toBe(false)
    expect(decisionFits("sow", "approved")).toBe(false)
    expect(decisionFits("sow", "accepted")).toBe(true)
  })
})
