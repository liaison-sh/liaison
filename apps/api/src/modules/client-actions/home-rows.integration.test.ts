// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a client action puts on Home: its sender hears that the person outside
// decided, opened it, asked something or was locked out, and a failed send; a
// member who is a signer is told it is their turn. Nobody else gets a row. A sender who left is
// not the only one told: the person who approved the send hears it, else the document's readers
// or the admins.
import { afterEach, describe, expect, it } from "bun:test"
import { NOW_URGENCY } from "@liaison/shared"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { processTranslationEvent } from "~/modules/attention/translator"
import {
  call,
  k,
  mintTo,
  nextIp,
  proofFor,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"
import { SYSTEM_ACTOR_ID } from "./mint"

const kit = useClientActionWorld("homedocs")

function event(action: string, data: Record<string, unknown>): AppEvent {
  return {
    app: "kernel",
    entity: "client_action",
    action,
    orgId: kit.w.orgId,
    actorId: SYSTEM_ACTOR_ID,
    actorType: "system",
    entityId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    data,
  }
}

async function rowsFor(e: AppEvent) {
  await processTranslationEvent(e)
  return (await sql`
    SELECT user_id, kind, summary, urgency, metadata FROM ${k("attention_events")}
     WHERE org_id = ${kit.w.orgId} AND entity_id = ${e.entityId ?? ""}`) as unknown as Array<{
    user_id: string
    kind: string
    summary: string
    urgency: number
    metadata: Record<string, unknown> | null
  }>
}

describe("client action rows on Home", () => {
  it("the sender alone hears each thing the person outside did", async () => {
    const sender = kit.w.admin.userId
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["decided", { title: "Contrat Alpha", decision: "signed" }, /Contrat Alpha: signed by Anne/],
      ["opened", {}, /Anne opened your request/],
      ["requested", { what: "question" }, /Anne asked something about your request/],
      ["code_locked", { locked: true }, /locked after too many wrong codes/],
      ["code_locked", { locked: false }, /wrong code on your request three times/],
      ["send_failed", { title: "Contrat Alpha" }, /Contrat Alpha: the link to Anne did not send/],
    ]
    for (const [action, data, words] of cases) {
      const rows = await rowsFor(
        event(action, { invitedName: "Anne", senderUserIds: [sender], ...data }),
      )
      expect({ action, users: rows.map((r) => r.user_id) }).toEqual({ action, users: [sender] })
      expect(rows[0]?.kind).toBe("client_action")
      expect(rows[0]?.summary).toMatch(words)
    }
  })

  it("a staff signer is told it is their turn, with no link in the row", async () => {
    const rows = await rowsFor(
      event("staff_turn", {
        title: "Contrat Alpha",
        kind: "sign",
        signerUserIds: [kit.w.member.userId],
        staffTurn: true,
      }),
    )
    expect(rows.map((r) => r.user_id)).toEqual([kit.w.member.userId])
    expect(rows[0]?.summary).toBe("Contrat Alpha: open it in Liaison to read and sign")
    expect(rows[0]?.summary).not.toContain("#t=")
    // Their own turn is a decision of theirs: it needs them now, and the row says so.
    expect(rows[0]?.urgency).toBeGreaterThanOrEqual(NOW_URGENCY)
    expect(rows[0]?.metadata?.staffTurn).toBe(true)
  })

  it("an event that names no sender reaches nobody", async () => {
    expect(await rowsFor(event("opened", { invitedName: "Anne", senderUserIds: [] }))).toEqual([])
  })
})

describe("a sender who left the organization", () => {
  const setStatus = async (userId: string, status: string) => {
    await sql`UPDATE ${k("users")} SET status = ${status} WHERE id = ${userId}`
  }
  afterEach(async () => {
    for (const id of kit.w.staffIds) await setStatus(id, "active")
  })

  /** Who the app's `decided` event names after the client signs. */
  async function toldOfASignature(over: Record<string, unknown>): Promise<string[]> {
    const { id, token } = await mintTo(kit, kit.w.clientA, {
      createdByUserId: kit.w.member.userId,
      ...over,
    })
    const ip = nextIp()
    const proof = await proofFor(kit, token, ip)
    await setStatus(kit.w.member.userId, "deactivated")
    const signed = await call(
      "decide",
      { t: token, proof, decision: "sign", typed_name: kit.w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    expect(signed.status).toBe(200)
    const [e] = (await sql`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${kit.w.orgId} AND payload->>'entityId' = ${id}
         AND payload->>'action' = 'decided'`) as unknown as Array<{
      payload: { data: { senderUserIds: string[] } }
    }>
    await setStatus(kit.w.member.userId, "active")
    return e?.payload.data.senderUserIds ?? []
  }

  it("is replaced by the person who approved the send, else by an admin", async () => {
    expect(await toldOfASignature({ approvedByUserId: kit.w.admin.userId })).toEqual([
      kit.w.admin.userId,
    ])
    expect(await toldOfASignature({ approvedByUserId: kit.w.member.userId })).toEqual([
      kit.w.admin.userId,
    ])
  })

  it("on a restricted document, only by someone on its list", async () => {
    const list = [kit.w.member.userId, kit.w.admin.userId]
    expect(await toldOfASignature({ visibleTo: list })).toEqual([kit.w.admin.userId])
    expect(
      await toldOfASignature({
        visibleTo: [kit.w.member.userId],
        approvedByUserId: kit.w.admin.userId,
      }),
    ).toEqual([])
  })

  it("while they are here they alone hear it, and a question reaches the same people", async () => {
    const { id, token } = await mintTo(kit, kit.w.clientA, {
      createdByUserId: kit.w.member.userId,
      approvedByUserId: kit.w.admin.userId,
    })
    const told = async (nth: number) => {
      const asked = await call(
        "request",
        { t: token, type: "question", text: `Question ${nth}` },
        { "x-bun-socket-ip": nextIp() },
      )
      expect(asked.status).toBe(202)
      const rows = (await sql`
        SELECT payload FROM kernel.pending_events
         WHERE org_id = ${kit.w.orgId} AND payload->>'entityId' = ${id}
           AND payload->>'action' = 'requested' ORDER BY created_at`) as unknown as Array<{
        payload: { data: { senderUserIds: string[] } }
      }>
      expect(rows).toHaveLength(nth)
      return rows[nth - 1]?.payload.data.senderUserIds
    }
    expect(await told(1)).toEqual([kit.w.member.userId])
    await setStatus(kit.w.member.userId, "deactivated")
    expect(await told(2)).toEqual([kit.w.admin.userId])
  })
})
