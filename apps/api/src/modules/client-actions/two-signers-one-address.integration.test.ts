// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two signers who share one address keep their own request, link and code: the
// dedupe key is target, contact and address together (without a contact, the
// address and the name), and one code never opens the other row.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { insertSql } from "~/seed/factories/org/test-rows"
import type { DoorPerson } from "~/tests/security/portal-doors/fixture"
import {
  actionRow,
  call,
  codeFor,
  k,
  mintTo,
  nextIp,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"
import { mintClientAction } from "./mint"

const kit = useClientActionWorld("pairdocs")

/**
 * A second contact of company A who reads mail at client A's address (a shared
 * mailbox): a contact's own address is unique in the org, so the request names it.
 */
async function sharedAddressContact(): Promise<DoorPerson> {
  const p: DoorPerson = {
    userId: crypto.randomUUID(),
    contactId: crypto.randomUUID(),
    email: kit.w.clientA.email,
    name: "Partner Shared",
  }
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id: p.contactId,
      org_id: kit.w.orgId,
      handle: `contact-${p.contactId.slice(0, 8)}`,
      name: p.name,
      email: null,
      company_id: kit.w.companyA,
    }),
  )
  return p
}

describe("two signers, one address", () => {
  it("one code never opens the other row", async () => {
    const partner = await sharedAddressContact()
    const targetId = crypto.randomUUID()
    const first = await mintTo(kit, kit.w.clientA, { targetId })
    const second = await mintTo(kit, partner, { targetId, companyId: kit.w.companyA })
    expect(second.id).not.toBe(first.id)
    expect(second.token).not.toBe(first.token)
    const ip = nextIp()
    const codeA = await codeFor(kit, first.token, ip, kit.w.clientA.email)
    await codeFor(kit, second.token, ip, partner.email)
    const onB = await call(
      "verify",
      { t: second.token, code: codeA, name: partner.name },
      { "x-bun-socket-ip": ip },
    )
    // Two six-digit codes match by chance once in a million; any other answer is a refusal.
    expect(onB.status).toBe(401)
    expect((await actionRow(second.id)).decided_at).toBeNull()
    const onA = await call(
      "verify",
      { t: first.token, code: codeA, name: kit.w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    expect(onA.status).toBe(200)
  })

  it("the same target, contact and address while open is one request; another contact at that address is its own", async () => {
    const partner = await sharedAddressContact()
    const targetId = crypto.randomUUID()
    const first = await mintTo(kit, kit.w.clientA, { targetId })
    const again = await mintClientAction({
      orgId: kit.w.orgId,
      kind: "sign",
      targetApp: kit.targetApp,
      targetType: kit.targetType,
      targetId,
      contactId: kit.w.clientA.contactId,
      invitedEmail: kit.w.clientA.email,
      expiresInDays: 7,
      createdByUserId: kit.w.admin.userId,
    })
    expect(again).toMatchObject({ id: first.id, deduped: true, mailQueued: false })
    const other = await mintTo(kit, partner, { targetId })
    expect(other.result.deduped).toBe(false)
    const rows = await sql`
      SELECT contact_id FROM ${k("client_actions")} WHERE target_id = ${targetId} ORDER BY created_at`
    expect(rows.map((r) => r.contact_id)).toEqual([kit.w.clientA.contactId, partner.contactId])
  })

  it("two people named without a contact at one address each have their own link, and the mail says whose it is", async () => {
    const targetId = crypto.randomUUID()
    const email = `couple-${targetId.slice(0, 8)}@signers.example`
    const of = (name: string) => ({ ...kit.w.clientA, email, name })
    const opts = (invitedName: string) => ({ targetId, contactId: null, invitedName })
    const anne = await mintTo(kit, of("Anne Couple"), opts("Anne Couple"))
    const jean = await mintTo(kit, of("Jean Couple"), opts("Jean Couple"))
    expect(jean.id).not.toBe(anne.id)
    expect(jean.result.deduped).toBe(false)
    expect(anne.mail.text).toContain(`This link is for Anne Couple (${email}) only.`)
    expect(jean.mail.text).toContain(`This link is for Jean Couple (${email}) only.`)
    const same = await mintClientAction({
      orgId: kit.w.orgId,
      kind: "sign",
      targetApp: kit.targetApp,
      targetType: kit.targetType,
      targetId,
      invitedEmail: email,
      invitedName: "jean couple",
      expiresInDays: 7,
      createdByUserId: kit.w.admin.userId,
    })
    expect(same).toMatchObject({ id: jean.id, deduped: true, mailQueued: false })
    const ip = nextIp()
    const codeA = await codeFor(kit, anne.token, ip, email)
    await codeFor(kit, jean.token, ip, email)
    const onJean = await call(
      "verify",
      { t: jean.token, code: codeA, name: "Jean Couple" },
      { "x-bun-socket-ip": ip },
    )
    expect(onJean.status).toBe(401)
    const onAnne = await call(
      "verify",
      { t: anne.token, code: codeA, name: "Anne Couple" },
      { "x-bun-socket-ip": ip },
    )
    expect(onAnne.status).toBe(200)
    expect((await actionRow(jean.id)).code_verified_at).toBeNull()
  })
})
