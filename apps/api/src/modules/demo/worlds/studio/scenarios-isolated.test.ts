// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVICES WORLD'S SCENARIOS DO NOT STEP ON EACH OTHER.
//
// The client scenario's one card is a change request whose reply mails a
// client contact; its send check stops the reply once anyone at that client's
// company writes in after it was drafted (send-guard.ts, colleagues count).
// The support scenario's live ticket came from a colleague at that same
// company, so a visitor who played Support first (the "Everything" order does)
// found the card stale, with no Approve, and Client work died at its approval.
// The scripted tour runs play each tour alone and never saw it.
import { describe, expect, it } from "bun:test"
import { STUDIO_CHANGE_REQUEST_CONTACT } from "~/seed/worlds/studio/agreements"
import { STUDIO_CLIENTS, STUDIO_CONTACTS } from "~/seed/worlds/studio/fiction"
import { STUDIO_SUPPORT_CLIENT } from "./support-ticket"

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? ""

describe("the services world's scenarios", () => {
  it("the support ticket's sender is not at the company the change request mails", () => {
    const cardContact = STUDIO_CONTACTS.find((c) => c.key === STUDIO_CHANGE_REQUEST_CONTACT)
    expect(cardContact).toBeDefined()
    const cardCompany = STUDIO_CLIENTS.find((c) => c.domain === domainOf(cardContact?.email ?? ""))
    expect(cardCompany).toBeDefined()
    const sender = STUDIO_CONTACTS.find(
      (c) => c.email.toLowerCase() === STUDIO_SUPPORT_CLIENT.email.toLowerCase(),
    )
    // A contact of the world, so the routine finds their history and company.
    expect(sender).toBeDefined()
    expect(cardCompany?.contactKeys).not.toContain(sender?.key)
    expect(domainOf(STUDIO_SUPPORT_CLIENT.email)).not.toBe(cardCompany?.domain)
  })
})
