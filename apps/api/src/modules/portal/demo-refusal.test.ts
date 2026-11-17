// SPDX-License-Identifier: FSL-1.1-ALv2
//
// On a demo box no mail leaves, so nobody can be invited to a client portal: they
// could never sign in. The refusal comes before anything is read or written.
// Sending a change request still works there: its approval link is made, the link
// mail is refused by the box so it reaches nobody, and the link is not withdrawn.

import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { demoProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { mintClientAction } from "~/modules/client-actions/mint"
import { ClientActionTargetsTestAccess } from "~/modules/client-actions/targets"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invitePortalPerson, PortalAccessError } from "~/modules/portal/access"
import {
  actionRow,
  baseView,
  eventsOf,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"

const was = env.LIAISON_DEMO_MODE
const setDemo = (on: boolean) => {
  ;(env as { LIAISON_DEMO_MODE: boolean }).LIAISON_DEMO_MODE = on
}

afterEach(() => setDemo(was))

/** A transaction that fails the test if anything runs on it. */
const untouched = {
  execute: () => {
    throw new Error("the demo refusal ran a statement")
  },
} as Partial<RlsClient> as RlsClient

describe("a portal invitation on a demo box", () => {
  it("is refused with NO_MAIL_ON_DEMO before anything is read or written", async () => {
    setDemo(true)
    const err = await invitePortalPerson({
      orgId: crypto.randomUUID(),
      actorId: crypto.randomUUID(),
      db: untouched,
      companyId: crypto.randomUUID(),
      email: "someone@example.com",
      name: "Someone",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PortalAccessError)
    expect((err as PortalAccessError).code).toBe("NO_MAIL_ON_DEMO")
    expect((err as PortalAccessError).status).toBe(403)
  })
})

const kit = useClientActionWorld("agreements", "agreement_version")

beforeAll(() => {
  // A change request is approved on its link, as the agreements app declares it.
  ClientActionTargetsTestAccess.set("agreements", "agreement_version", ["approve"], async () =>
    baseView(),
  )
})

describe("a change request sent on a demo box", () => {
  it("makes its approval link, whose mail reaches nobody, and does not withdraw it", async () => {
    DemoModeTestAccess.set(true)
    try {
      const refusedBefore = demoProvider().refused.length
      const sentBefore = kit.capture.sent.length
      const made = await mintClientAction({
        orgId: kit.w.orgId,
        kind: "approve",
        targetApp: "agreements",
        targetType: "agreement_version",
        targetId: crypto.randomUUID(),
        contactId: kit.w.clientA.contactId,
        companyId: kit.w.companyA,
        invitedEmail: kit.w.clientA.email,
        expiresInDays: 7,
        createdByUserId: kit.w.admin.userId,
      })
      expect(made.id).toBeDefined()
      // The link mail is handed to the box's refusing channel, and its token rotated out.
      let events: string[] = []
      for (let i = 0; i < 150 && !events.includes("rotated"); i++) {
        await new Promise((r) => setTimeout(r, 20))
        events = (await eventsOf(made.id)).map((e) => e.event)
      }
      expect(events).toContain("rotated")
      const refused = demoProvider().refused.slice(refusedBefore)
      expect(
        refused.some((m) => m.to === kit.w.clientA.email && m.template === "client-action.link"),
      ).toBe(true)
      expect(kit.capture.sent.slice(sentBefore)).toEqual([])
      // Still open: neither withdrawn nor decided.
      const row = await actionRow(made.id)
      expect(row.revoked_at).toBeNull()
      expect(row.decided_at).toBeNull()
    } finally {
      DemoModeTestAccess.set(null)
    }
  }, 60_000)
})
