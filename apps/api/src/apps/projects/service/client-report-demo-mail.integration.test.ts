// SPDX-License-Identifier: FSL-1.1-ALv2
// A client report's mail in a demo workspace. Its clients are fictional, on
// reserved domains: a report whose every recipient (the approver's reply-to too)
// is on one is recorded as delivered, with no provider and no network. A report
// to a real address keeps the demo box's refusal, and outside a demo workspace
// nothing changes.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { demoProvider } from "~/infra/email"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { visitorMarker } from "~/modules/demo/demo-org"
import { markDemoOrgForTest } from "~/tests/helpers/demo-org"
import { createTestOrg } from "~/tests/helpers/org"
import { sendClientReportMail } from "./client-report-mail"

let demoOrg: string
let plainOrg: string

const report = (orgId: string, to: string) => ({
  orgId,
  replyTo: "lead@studio.example",
  to,
  subject: "Reader site: week ending Friday",
  text: "This week the catalogue import was finished.",
  reportId: crypto.randomUUID(),
})

beforeAll(async () => {
  demoOrg = (await createTestOrg()).id
  await markDemoOrgForTest(demoOrg, visitorMarker(24))
  plainOrg = (await createTestOrg()).id
  DemoModeTestAccess.set(true)
})

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("a client report's mail in a demo workspace", () => {
  it("to a client on a reserved domain is recorded delivered, with no provider asked", async () => {
    const refusedBefore = demoProvider().refused.length
    const mailId = await sendClientReportMail(report(demoOrg, "thomas@publisher.example"))
    expect(mailId).toMatch(/^[0-9a-f]{32}$/)
    expect(demoProvider().refused.length).toBe(refusedBefore)
  })

  it("to a real address still goes to the demo box's refusal", async () => {
    const refusedBefore = demoProvider().refused.length
    await expect(
      sendClientReportMail(report(demoOrg, "someone@client-real-domain.fr")),
    ).rejects.toThrow()
    expect(demoProvider().refused.length).toBe(refusedBefore + 1)
  })

  it("outside a demo workspace a reserved address is not recorded delivered", async () => {
    const refusedBefore = demoProvider().refused.length
    await expect(
      sendClientReportMail(report(plainOrg, "thomas@publisher.example")),
    ).rejects.toThrow()
    expect(demoProvider().refused.length).toBe(refusedBefore + 1)
  })
})
