// SPDX-License-Identifier: FSL-1.1-ALv2
// A client action's link mail in a demo workspace. Its clients are fictional, on
// reserved domains: a link whose every recipient (the sender's reply-to too) is
// on one is recorded as sent, with no provider and no network, so the sender is
// told nothing failed. A link to a real address keeps the demo box's refusal:
// the link is rotated dead and the sender told. Outside demo mode nothing
// changes: the link leaves through the system channel, also for a workspace
// marked as a demo (a self-hosted box may seed one) whose client is on a
// reserved domain. That rule is a demo box's only. The code mail is never
// recorded sent: a demo box refuses it, as it refuses a code request.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { demoProvider } from "~/infra/email"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { k, useClientActionWorld, waitForMail } from "../../../test-support/client-actions-kit"
import { newActionMailId, sendCodeMail } from "./mail"
import { mintClientAction } from "./mint"

const kit = useClientActionWorld("demolinkmail", "contract")

async function mintTo(email: string): Promise<string> {
  const r = await mintClientAction({
    orgId: kit.w.orgId,
    kind: "accept",
    targetApp: kit.targetApp,
    targetType: kit.targetType,
    targetId: crypto.randomUUID(),
    invitedEmail: email,
    invitedName: "Client",
    expiresInDays: 7,
    createdByUserId: kit.w.admin.userId,
  })
  return r.id
}

async function stateOf(id: string) {
  const [row] = await sql`SELECT sent_at, token_hash, prior_token_hashes
    FROM ${k("client_actions")} WHERE id = ${id}`
  const events = await sql`SELECT event, meta FROM ${k("client_action_events")}
    WHERE action_id = ${id} ORDER BY at`
  const failed = await sql`SELECT 1 FROM kernel.pending_events
    WHERE payload->>'entity' = 'client_action' AND payload->>'action' = 'send_failed'
      AND payload->>'entityId' = ${id}`
  return {
    sent: row?.sent_at !== null,
    rotated: events.some((e) => e.event === "rotated" && e.meta?.reason === "send_failed"),
    toldSender: failed.length > 0,
  }
}

/** The mail is sent without being awaited by the mint: wait for its outcome. */
async function settled(id: string, want: (s: Awaited<ReturnType<typeof stateOf>>) => boolean) {
  for (let i = 0; i < 100; i++) {
    const s = await stateOf(id)
    if (want(s)) return s
    await new Promise((r) => setTimeout(r, 30))
  }
  return stateOf(id)
}

let demoOrgMarked = false

beforeAll(async () => {
  // The admin sends: the link's reply-to is their address, on the door world's reserved domain.
  expect(kit.w.admin.email).toMatch(/\.example\.com$/)
})

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("a client action's link mail in a demo workspace", () => {
  it("outside demo mode the link mail path is unchanged", async () => {
    DemoModeTestAccess.set(false)
    const before = kit.capture.sent.length
    const id = await mintTo(kit.w.clientA.email)
    const mail = await waitForMail(
      kit,
      (m) =>
        kit.capture.sent.indexOf(m) >= before &&
        m.template === "client-action.link" &&
        m.to === kit.w.clientA.email,
    )
    expect(mail.replyTo).toBe(kit.w.admin.email)
    expect(await settled(id, (s) => s.sent)).toEqual({
      sent: true,
      rotated: false,
      toldSender: false,
    })
  })

  it("in a demo workspace a change request's link to a client on a reserved domain is recorded sent and the sender is told nothing failed", async () => {
    await markOrgAsDemo(kit.w.orgId, visitorMarker(24))
    demoOrgMarked = true
    DemoModeTestAccess.set(true)
    const refusedBefore = demoProvider().refused.length
    const capturedBefore = kit.capture.sent.length
    const id = await mintTo("pauline@client.example")
    // Give the unawaited send its time, then read: still sent, never rotated.
    await new Promise((r) => setTimeout(r, 300))
    expect(await stateOf(id)).toEqual({ sent: true, rotated: false, toldSender: false })
    // No provider was asked: neither the demo box's refusing one nor any other.
    expect(demoProvider().refused.length).toBe(refusedBefore)
    expect(kit.capture.sent.length).toBe(capturedBefore)
    const [event] = await sql`SELECT mail_id FROM ${k("client_action_events")}
      WHERE action_id = ${id} AND event = 'sent'`
    expect(event?.mail_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it("a demo workspace on a box with demo mode off sends the link to a reserved-domain client for real; with demo mode on it is only recorded sent", async () => {
    expect(demoOrgMarked).toBe(true)
    // Demo mode off: the system channel sends it, as for any workspace.
    DemoModeTestAccess.set(false)
    const before = kit.capture.sent.length
    const offId = await mintTo("thomas@publisher.example")
    const mail = await waitForMail(
      kit,
      (m) =>
        kit.capture.sent.indexOf(m) >= before &&
        m.template === "client-action.link" &&
        m.to === "thomas@publisher.example",
    )
    expect(mail.replyTo).toBe(kit.w.admin.email)
    expect(await settled(offId, (s) => s.sent)).toEqual({
      sent: true,
      rotated: false,
      toldSender: false,
    })

    // Demo mode on, same workspace and the same kind of recipient: recorded sent, nothing captured.
    DemoModeTestAccess.set(true)
    const capturedBefore = kit.capture.sent.length
    const onId = await mintTo("thomas@publisher.example")
    await new Promise((r) => setTimeout(r, 300))
    expect(await stateOf(onId)).toEqual({ sent: true, rotated: false, toldSender: false })
    expect(
      kit.capture.sent.slice(capturedBefore).filter((m) => m.template === "client-action.link"),
    ).toEqual([])
  })

  it("in a demo workspace a link to a real address still fails, rotates and tells the sender", async () => {
    expect(demoOrgMarked).toBe(true)
    DemoModeTestAccess.set(true)
    const refusedBefore = demoProvider().refused.length
    const id = await mintTo("someone@client-real-domain.fr")
    const s = await settled(id, (x) => x.rotated && x.toldSender)
    expect(s).toEqual({ sent: false, rotated: true, toldSender: true })
    expect(demoProvider().refused.length).toBe(refusedBefore + 1)
  })

  it("in a demo workspace the code mail is never recorded sent to a reserved address: a demo box refuses it, and elsewhere it leaves as before", async () => {
    expect(demoOrgMarked).toBe(true)
    const code = {
      orgId: kit.w.orgId,
      to: "pauline@client.example",
      title: "Change request",
      kind: "accept" as const,
      name: "Pauline Client",
      code: "123456",
      orgName: "Demo",
    }
    // On a demo box: refused in words, never swallowed as delivered.
    DemoModeTestAccess.set(true)
    const refusedBefore = demoProvider().refused.length
    await expect(sendCodeMail({ ...code, mailId: newActionMailId() })).rejects.toThrow()
    expect(demoProvider().refused.length).toBe(refusedBefore + 1)
    // Off a demo box (a year box seeds demo workspaces too): the system channel sends it.
    DemoModeTestAccess.set(false)
    const capturedBefore = kit.capture.sent.length
    await sendCodeMail({ ...code, mailId: newActionMailId() })
    const sent = kit.capture.sent.slice(capturedBefore)
    expect(sent.map((m) => [m.template, m.to])).toEqual([["client-action.code", code.to]])
  })
})
