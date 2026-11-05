// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A query of filler words only ("what can you do") names no capability: it lists
// matches but loads none. Scored as typed, every one of its words is a substring
// of some long description, and the tool whose description held them all loaded.
// Real asks still load their tools.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-00000000f111"
const USER = "00000000-0000-0000-0000-00000000f112"
const SCOPES = ["invoicing:documents:write", "boxtal:shipments:write", "mail:conversations:read"]

const TOOLS = [
  {
    app: "invoicing",
    name: "drafts_create",
    description: "Create an invoice draft (or a quote draft) for a customer.",
    scope: "invoicing:documents:write",
  },
  {
    app: "boxtal",
    name: "parcel_ship",
    description: "Ship a parcel: book a carrier for an order's parcels and print the label.",
    scope: "boxtal:shipments:write",
  },
  {
    app: "mail",
    name: "search",
    description: "Search my mail: the synced conversations matching words or filters.",
    scope: "mail:conversations:read",
  },
  {
    // A long description that holds every word of "what can you do".
    app: "widgets",
    name: "overview",
    description:
      "Explains what this app does for you: what you can see, how to do a task, and what can be changed.",
    scope: "invoicing:documents:write",
  },
]

async function search(query: string) {
  const frame = {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
  const res = await runContextStore.run(frame as never, () =>
    handleToolSearch({ query }, { orgId: ORG, userId: USER, scopes: SCOPES }),
  )
  return { res, loaded: [...frame.discoveredTools] }
}

beforeAll(() => {
  for (const t of TOOLS) {
    toolRegistry.set([ORG, t.app, t.name], {
      appName: t.app,
      name: t.name,
      description: t.description,
      requiredScopes: [t.scope],
      handler: async () => ({ ok: true }),
      deferLoading: true,
    } as never)
  }
})

afterAll(() => {
  toolRegistry.deleteByPrefix([ORG])
})

describe("tool_search: filler words load nothing, real asks still load tools", () => {
  it("'what can you do' lists matches but loads none", async () => {
    const { res, loaded } = await search("what can you do")
    expect(res.matches.length).toBeGreaterThan(0)
    expect(loaded).toEqual([])
  })

  it("'create an invoice draft' loads the invoice draft tool", async () => {
    const { loaded } = await search("create an invoice draft")
    expect(loaded).toContain("invoicing__drafts_create")
  })

  it("'ship a parcel' loads the parcel tool", async () => {
    const { loaded } = await search("ship a parcel")
    expect(loaded).toContain("boxtal__parcel_ship")
  })

  it("'search my mail' loads the mail search tool", async () => {
    const { loaded } = await search("search my mail")
    expect(loaded).toContain("mail__search")
  })
})
