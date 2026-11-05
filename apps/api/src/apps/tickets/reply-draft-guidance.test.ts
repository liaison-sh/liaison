// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One pending reply draft per ticket: the agent must UPDATE the waiting draft, a colleague's
// included, rather than stage a second one or stop at "a draft is already waiting". The guide
// section loads with tickets__reply and tickets__get, and the reply tool says it too.
import { describe, expect, it } from "bun:test"
import ticketsManifest from "./app.manifest.json"

type Section = { tools: string[]; text: string }
const sections = (ticketsManifest.agentInstructions as { sections: Section[] }).sections
const tools = ticketsManifest.tools as unknown as Record<string, { description: string }>

describe("tickets reply draft guidance", () => {
  it("a guide section on reply and get tells the agent to update the waiting draft", () => {
    const section = sections.find((s) => s.text.startsWith("ONE REPLY DRAFT PER TICKET"))
    expect(section?.tools).toEqual(expect.arrayContaining(["reply", "get"]))
    expect(section?.text).toContain("pendingReplyDrafts")
    expect(section?.text).toContain("kernel__approval_update_payload (requestId = its approvalId")
    expect(section?.text).toContain("Rewriting a colleague's draft is normal")
    expect(section?.text).toContain("approval_already_pending")
  })

  it("tickets__reply itself says to update the waiting draft, even a colleague's", () => {
    expect(tools.reply!.description).toContain("ONE pending reply draft per ticket")
    expect(tools.reply!.description).toContain("even when a colleague drafted it")
  })
})
