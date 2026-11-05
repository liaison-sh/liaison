// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const TICKETS_MANIFEST_PATH = path.join(
  import.meta.dir,
  "..",
  "apps",
  "tickets",
  "app.manifest.json",
)
const mf = JSON.parse(readFileSync(TICKETS_MANIFEST_PATH, "utf8"))

describe("Tickets manifest mail-tickets conversion delta", () => {
  it("declares mail tool dependencies", () => {
    expect(mf.dependencies?.optional).toEqual(expect.arrayContaining(["mail"]))
    expect(mf.dependencies?.required ?? []).not.toContain("mail")
    expect(mf.dependencies?.tools).toEqual(
      expect.arrayContaining(["mail:createFromTicket", "mail:appendInboundMessage"]),
    )
  })

  it("declares the six new conversion+summary tools", () => {
    expect(mf.tools.convertToMail).toMatchObject({ trustBoundary: "user" })
    expect(mf.tools.createFromMail).toMatchObject({
      trustBoundary: "internal",
      deferLoading: true,
    })
    expect(mf.tools.pullMailReply).toMatchObject({
      trustBoundary: "internal",
      deferLoading: true,
      agentVisible: false,
    })
    expect(mf.tools.pullMailReplyFromBanner).toMatchObject({
      trustBoundary: "user",
      deferLoading: true,
      agentVisible: false,
    })
    expect(mf.tools.deleteIfUnreferenced).toMatchObject({
      trustBoundary: "internal",
      deferLoading: true,
    })
    expect(mf.tools.ensureSummary).toMatchObject({
      trustBoundary: "user",
      agentVisible: false,
    })
    expect(mf.tools.regenerateSummary).toMatchObject({
      trustBoundary: "user",
      agentVisible: false,
    })
  })

  it("convertToMail accountId doc matches the BL-79 handler (org/shared inbox accepted, not personal-only)", () => {
    // Regression guard (BL-82): the convertToMail manifest doc had drifted to a pre-BL-79
    // claim — "the conversation is created on YOUR OWN personal mailbox" + "Passing a
    // shared/org account returns 'account not visible'" — but rpc-bridge `mail_createFromTicket`
    // accepts EITHER the actor's personal mailbox OR an org-owned (shared) account (see the
    // BL-79 test in mail-tickets-conversion.test.ts). The stale doc steered the agent away from
    // the shared inbox that is the correct target for re-routing a mis-filed ticket to a team
    // queue (convert-misrouted-ticket-back-to-mail), so it never accomplished the conversion.
    const accountDesc: string = mf.tools.convertToMail.params.properties.accountId.description
    const toolDesc: string = mf.tools.convertToMail.description
    // Must advertise that an org/shared inbox is a valid host.
    expect(accountDesc).toMatch(/org\/shared|shared\/org|shared inbox|org\b/i)
    // Must NOT carry the false blanket claim that any shared/org account is rejected.
    expect(accountDesc).not.toMatch(/Passing a shared\/org account returns 'account not visible'/)
    expect(toolDesc).not.toMatch(/created on YOUR OWN personal mailbox/)
    // Must still steer the agent to pass a real listAccounts id (the weak-model trap).
    expect(accountDesc).toMatch(/listAccounts/)
  })

  it("declares tickets-summarize on-demand job", () => {
    expect(mf.jobs["tickets-summarize"]).toMatchObject({ onDemand: true })
  })

  it("declares summarizer prompt with non-trivial content", () => {
    expect(mf.prompts.summarizer).toBeDefined()
    expect(mf.prompts.summarizer.content.length).toBeGreaterThan(50)
  })

  it("declares ticket:converted and ticket:summary_updated event emits", () => {
    expect(mf.events.emits).toEqual(
      expect.arrayContaining(["ticket:converted", "ticket:summary_updated"]),
    )
  })

  it("declares explicit frontend websocket handlers", () => {
    expect(mf.views.wsHandlers).toMatchObject({
      connectedAccount: {
        key: "kernel:connected_account",
        handler: "handleConnectedAccountEvent",
      },
      mailConversation: { key: "mail:conversation", handler: "handleMailConversationEvent" },
      sla: { key: "tickets:sla", handler: "handleSlaEvent" },
    })
  })
})
