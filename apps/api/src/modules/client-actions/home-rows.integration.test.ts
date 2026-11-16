// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a client action puts on Home: its sender hears that the person outside
// decided, opened it, asked something or was locked out, and a failed send; a
// member who is a signer is told it is their turn. Nobody else gets a row.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { processTranslationEvent } from "~/modules/attention/translator"
import { k, useClientActionWorld } from "../../../test-support/client-actions-kit"
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
    SELECT user_id, kind, summary FROM ${k("attention_events")}
     WHERE org_id = ${kit.w.orgId} AND entity_id = ${e.entityId ?? ""}`) as unknown as Array<{
    user_id: string
    kind: string
    summary: string
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
      }),
    )
    expect(rows.map((r) => r.user_id)).toEqual([kit.w.member.userId])
    expect(rows[0]?.summary).toBe("Contrat Alpha: open it in Liaison to read and sign")
    expect(rows[0]?.summary).not.toContain("#t=")
  })

  it("an event that names no sender reaches nobody", async () => {
    expect(await rowsFor(event("opened", { invitedName: "Anne", senderUserIds: [] }))).toEqual([])
  })
})
