// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card a person approves for a change of an agreement draft says what changes (its text,
// who can see it, its dates) and names the agreement by its number and title, never by its id.

import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"
import { summarizeAgreementUpdate } from "./summarizers"

const ID = "225e87ea-6bca-4c6b-8e2f-1a2b3c4d5e6f"
const meta = {
  connectionIdentifier: null,
  context: { agreement: { id: ID, number: "PR-2026-022", title: "Website redesign" } },
}

describe("the card of a change to an agreement draft", () => {
  it("an agent's text names the agreement and says it is its text, not who can see it", async () => {
    const card = await summarizeAgreementUpdate(
      {
        id: ID,
        source: {
          body: {
            blocks: [
              { type: "heading", text: "Scope" },
              { type: "paragraph", text: "Design and build." },
            ],
          },
        },
      },
      undefined,
      meta,
    )
    expect(card.title).toBe('Change the text of PR-2026-022 "Website redesign"')
    expect(card.title).not.toContain(ID)
    expect(card.title).not.toContain("who can see")
    expect(card.lines).toContain('Text: 2 blocks, starting with "Scope"')
  })

  it("a change of who can see it says so", async () => {
    const card = await summarizeAgreementUpdate({ id: ID, org_access: "none" }, undefined, meta)
    expect(card.title).toBe('Change who can see PR-2026-022 "Website redesign"')
    expect(card.lines).toContain("Organization access: none")
  })

  it("several changes are listed, and an agreement the card cannot read is named without its id", async () => {
    const card = await summarizeAgreementUpdate(
      { id: ID, starts_on: "2026-12-01", source: { body: { blocks: [] } } },
      undefined,
      { connectionIdentifier: null, context: null },
    )
    expect(card.title).toBe("Change an agreement draft: its text and dates")
    expect(card.title).not.toContain(ID)
    expect(card.lines).toContain("Starts on: 2026-12-01")
  })

  it("the tool's card is built by this summarizer, from the agreement it names", () => {
    const tool = manifest.tools.agreement_update as {
      summarizer?: string
      summarizerContext?: { tool: string; params: Record<string, string> }
      approvalCard?: { summary?: string }
    }
    expect(tool.summarizer).toBe("summarizeAgreementUpdate")
    expect(tool.summarizerContext).toEqual({ tool: "agreement_get", params: { id: "id" } })
    expect(tool.approvalCard?.summary ?? "").not.toContain("{{params.id}}")
  })
})
