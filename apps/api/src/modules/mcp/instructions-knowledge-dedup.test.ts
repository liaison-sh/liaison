// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEARCH BEFORE YOU CREATE. The MCP `instructions` block is the ONLY channel
// that reaches an external agent before its first tool call, and it carried no
// directive to look for an existing Knowledge document. An agent therefore
// authored a fresh org doc on a subject the knowledge base already covered, and
// the duplicate reached a human approver. The knowledge base is curated and
// org-wide: two documents on one subject split the truth in two.
import { describe, expect, it } from "bun:test"
import { createMcpServer } from "~/modules/mcp/server-factory"

function instructionsFor(): string {
  const server = createMcpServer({
    orgId: "00000000-0000-0000-0000-00000000c0de",
    userId: "00000000-0000-0000-0000-00000000beef",
    scopes: [],
    dimensionGrants: {},
    skills: [],
  } as never)
  // The SDK Server keeps the options it was constructed with; read the
  // instructions off it however it exposes them.
  const opts = (server as unknown as { _options?: { instructions?: string } })._options
  return opts?.instructions ?? ""
}

describe("MCP instructions: knowledge duplication", () => {
  it("tells the agent to look for an existing document before creating one", () => {
    const text = instructionsFor().toLowerCase()
    expect(text).toContain("knowledge__search")
    expect(text).toContain("before you create a knowledge document")
  })

  it("names the exact-title lookup and points at update as the alternative", () => {
    const text = instructionsFor()
    expect(text).toContain("knowledge__find_by_title")
    expect(text).toContain("knowledge__update")
  })
})
