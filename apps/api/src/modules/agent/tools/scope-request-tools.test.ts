// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleListLockedCapabilities } from "~/modules/agent/tools/scope-request-tools"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-0000007c1001"

const ctxWith = (scopes: string[]) => ({
  userId: "00000000-0000-0000-0000-0000007c1002",
  orgId: ORG,
  scopes,
  db: undefined as never,
})

describe("list_locked_capabilities on multi-scope tools", () => {
  beforeAll(() => {
    toolRegistry.set([ORG, "fc", "sync"], {
      appName: "fc",
      name: "sync",
      description: "Sync the widgets",
      requiredScopes: ["a:b:read", "a:c:write"],
      handler: async () => ({ ok: true }),
    })
    // Registration refuses a tool with no requiredScopes, so the fixture strips
    // the list after the fact to model a definition that slipped through.
    toolRegistry.set([ORG, "fc", "noscope"], {
      appName: "fc",
      name: "noscope",
      description: "Declares no scope",
      requiredScopes: ["fc:placeholder"],
      handler: async () => ({ ok: true }),
    })
    delete (toolRegistry.get([ORG, "fc", "noscope"]) as { requiredScopes?: string[] })
      .requiredScopes
  })

  afterAll(() => {
    toolRegistry.deleteByPrefix([ORG])
  })

  it("filters by query without throwing and shows every missing scope", async () => {
    const all = await handleListLockedCapabilities({ query: "a:c:write" }, ctxWith([]))
    expect(all.locked.find((t) => t.name === "fc__sync")?.scope).toBe("a:b:read, a:c:write")

    const partial = await handleListLockedCapabilities({ query: "sync" }, ctxWith(["a:b:read"]))
    expect(partial.locked.find((t) => t.name === "fc__sync")?.scope).toBe("a:c:write")

    const held = await handleListLockedCapabilities(
      { query: "sync" },
      ctxWith(["a:b:read", "a:c:write"]),
    )
    expect(held.locked.find((t) => t.name === "fc__sync")).toBeUndefined()
  })

  it("never lists a tool that declares no scope, with or without a query", async () => {
    for (const query of [undefined, "noscope"]) {
      const res = await handleListLockedCapabilities({ query }, ctxWith([]))
      expect(res.locked.map((t) => t.name)).not.toContain("fc__noscope")
    }
  })

  it("lists a tool the acting agent's ceiling lacks even when the user holds its scopes", async () => {
    // The live QA: an agent refused a tool by its ceiling asked
    // list_locked_capabilities what it lacked and got [], because the list was
    // computed from the user's grants alone.
    const frame = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      effectiveScope: ["a:b:read"],
    }
    const res = await runContextStore.run(frame, () =>
      handleListLockedCapabilities({ query: "sync" }, ctxWith(["a:b:read", "a:c:write"])),
    )
    expect(res.locked.find((t) => t.name === "fc__sync")?.scope).toBe("a:c:write")
  })
})

describe("list_locked_capabilities answers with a digest the agent can read", () => {
  const BIG_ORG = "00000000-0000-0000-0000-0000007c1101"
  const bigCtx = {
    userId: "00000000-0000-0000-0000-0000007c1102",
    orgId: BIG_ORG,
    scopes: [] as string[],
    db: undefined as never,
  }

  beforeAll(() => {
    // The live walk: 219 locked tools with full multi-KB descriptions, ~131 KB,
    // cut by the tool-result cap. And "tickets" returned the mail tools because
    // their descriptions mention tickets.
    for (let i = 0; i < 200; i++) {
      toolRegistry.set([BIG_ORG, "widgets", `op_${i}`], {
        appName: "widgets",
        name: `op_${i}`,
        description: `Widget operation ${i}. ${"Long parameter documentation. ".repeat(120)}`,
        requiredScopes: ["widgets:items:write"],
        handler: async () => ({ ok: true }),
      } as any)
    }
    toolRegistry.set([BIG_ORG, "mail", "listAccounts"], {
      appName: "mail",
      name: "listAccounts",
      description: "List mail accounts; a conversation can become a ticket in the tickets app.",
      requiredScopes: ["mail:accounts:read"],
      handler: async () => ({ ok: true }),
    } as any)
    toolRegistry.set([BIG_ORG, "tickets", "close"], {
      appName: "tickets",
      name: "close",
      description: "Close a ticket.",
      requiredScopes: ["tickets:tickets:write"],
      handler: async () => ({ ok: true }),
    } as any)
  })

  afterAll(() => {
    toolRegistry.deleteByPrefix([BIG_ORG])
  })

  it("stays small: capped entries of name, app, scope and a one-line summary", async () => {
    const res = await handleListLockedCapabilities({}, bigCtx)
    expect(res.total).toBe(202)
    expect(res.locked.length).toBeLessThanOrEqual(40)
    expect(res.note).toContain("more locked tools")
    expect(JSON.stringify(res).length).toBeLessThan(12_000)
    const first = res.locked[0] as unknown as Record<string, unknown>
    expect(Object.keys(first).sort()).toEqual(["app", "name", "scope", "summary"])
  })

  it("the query narrows on the tool, app and scope, not on words inside descriptions", async () => {
    const res = await handleListLockedCapabilities({ query: "tickets" }, bigCtx)
    expect(res.locked.map((t) => t.name)).toEqual(["tickets__close"])
    expect(res.total).toBe(1)
  })
})
