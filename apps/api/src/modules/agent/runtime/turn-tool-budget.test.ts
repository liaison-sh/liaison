// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tool schema budget sheds the least recently useful tools first: never
// the core set (tool_search among it), never what the last turns used before
// what they did not, and a focus app's preload never fills the whole budget.
import { describe, expect, it } from "bun:test"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import { recentTools, toolRecency } from "~/modules/agent/context/discovery-window"
import type { TurnFocus } from "~/modules/agent/runtime/turn-focus"
import {
  evictByRecency,
  FOCUS_PRELOAD_TOKEN_SHARE,
  planTurnToolBudget,
} from "~/modules/agent/runtime/turn-tool-budget"

const tool = (chars: number) => ({ description: "d".repeat(chars) })
type Defs = Record<string, { description?: string }>
const tokensOf = (tools: Defs, names: readonly string[]) =>
  names.reduce((n, name) => n + estimateToolSchemaTokens(name, tools[name]), 0)

/** `count` tools of `app`, each about `chars / 4` tokens. */
function appTools(app: string, count: number, chars = 1100): Defs {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${app}__t${i}`, tool(chars)]))
}

const CORE = ["kernel__tool_search", "kernel__memory_search", "kernel__skill_read"]

describe("the tool budget sheds least recently useful first", () => {
  // The live shape: 105 tools over budget. The person's last turn loaded the
  // shipping app's tools; the tickets app was last used many turns ago.
  const tools: Defs = {
    ...Object.fromEntries(CORE.map((n) => [n, tool(1200)])),
    ...appTools("tickets", 40),
    ...appTools("projects", 30),
    ...appTools("websearch", 12),
    ...appTools("invoicing", 15),
    ...appTools("boxtal", 5),
  }
  const names = Object.keys(tools)
  const recency = new Map<string, number>()
  for (const n of names) {
    if (n.startsWith("boxtal__")) recency.set(n, 0)
    else if (n.startsWith("tickets__")) recency.set(n, 9)
    else if (!n.startsWith("kernel__")) recency.set(n, 4)
  }
  const cap = Math.round(tokensOf(tools, names) * 0.7)

  it("evicts the oldest-used app, keeps the app the current request loaded, and keeps tool_search", () => {
    expect(names).toHaveLength(105)
    const out = planTurnToolBudget({
      visible: names,
      tools,
      droppable: (n) => !n.startsWith("kernel__"),
      preloaded: new Set(),
      hardFocusApps: new Set(),
      focus: new Map(),
      recency,
      cap,
    })
    const dropped = new Set(out.drop)
    for (const n of names.filter((n) => n.startsWith("tickets__")))
      expect(dropped.has(n)).toBe(true)
    for (const n of names.filter((n) => n.startsWith("boxtal__")))
      expect(dropped.has(n)).toBe(false)
    expect(dropped.has("kernel__tool_search")).toBe(false)
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(cap)
  })

  it("sheds a recently used tool only once every older one is gone", () => {
    const out = planTurnToolBudget({
      visible: names,
      tools,
      droppable: (n) => !n.startsWith("kernel__"),
      preloaded: new Set(),
      hardFocusApps: new Set(),
      focus: new Map(),
      recency,
      cap: tokensOf(tools, [...CORE, "boxtal__t0", "boxtal__t1"]),
    })
    const dropped = new Set(out.drop)
    for (const n of names.filter((n) => !n.startsWith("kernel__") && !n.startsWith("boxtal__")))
      expect(dropped.has(n)).toBe(true)
    for (const n of CORE) expect(dropped.has(n)).toBe(false)
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(
      tokensOf(tools, [...CORE, "boxtal__t0", "boxtal__t1"]),
    )
  })

  it("within an app, the tools used longer ago go first", () => {
    const defs = { ...appTools("shop", 4) }
    const out = evictByRecency({
      names: Object.keys(defs),
      tools: defs,
      recency: new Map([
        ["shop__t0", 0],
        ["shop__t1", 2],
        ["shop__t2", 5],
      ]),
      total: tokensOf(defs, Object.keys(defs)),
      cap: tokensOf(defs, ["shop__t0", "shop__t1"]),
    })
    // Never used, then used five turns ago; the two latest stay.
    expect(out.dropped).toEqual(["shop__t3", "shop__t2"])
  })
})

describe("a turn just over the budget", () => {
  // Logged on a live turn: 20,433 tokens over a 20,000 cap dropped 50 of 70 tools.
  it("sheds the smallest equally old app that covers the excess, not the largest", () => {
    const tools: Defs = { ...appTools("big", 50), ...appTools("small", 3) }
    const names = Object.keys(tools)
    const total = tokensOf(tools, names)
    const out = evictByRecency({
      names,
      tools,
      recency: new Map(),
      total,
      cap: total - 100,
    })
    expect(out.dropped.sort()).toEqual(names.filter((n) => n.startsWith("small__")).sort())
  })

  it("when no one app covers it, the largest still goes first, whole", () => {
    const tools: Defs = { ...appTools("big", 50), ...appTools("small", 3) }
    const names = Object.keys(tools)
    const total = tokensOf(tools, names)
    const bigTokens = tokensOf(
      tools,
      names.filter((n) => n.startsWith("big__")),
    )
    const out = evictByRecency({ names, tools, recency: new Map(), total, cap: total - bigTokens })
    expect(out.dropped.sort()).toEqual(names.filter((n) => n.startsWith("big__")).sort())
    expect(
      evictByRecency({ names, tools, recency: new Map(), total, cap: 0 }).dropped.length,
    ).toBe(53)
  })

  it("age still comes first: an older app goes before a newer small one", () => {
    const tools: Defs = { ...appTools("old", 30), ...appTools("newer", 2) }
    const names = Object.keys(tools)
    const recency = new Map(names.map((n) => [n, n.startsWith("old__") ? 9 : 2]))
    const total = tokensOf(tools, names)
    const out = evictByRecency({ names, tools, recency, total, cap: total - 10 })
    expect(out.dropped.every((n) => n.startsWith("old__"))).toBe(true)
  })
})

describe("recent turns, then a vague message, under a large focus preload", () => {
  // The live demo case: the last turns booked a shipment (boxtal), the
  // visitor's open tab is the shop app (a hard focus app on a visitor turn)
  // and its 68 tools were preloaded. The person wrote "HELLO ?".
  const tools: Defs = {
    ...Object.fromEntries(CORE.map((n) => [n, tool(1200)])),
    ...appTools("shopify", 68),
    ...appTools("boxtal", 5),
  }
  const names = Object.keys(tools)
  const shopify = names.filter((n) => n.startsWith("shopify__"))
  const boxtal = names.filter((n) => n.startsWith("boxtal__"))
  const focus: TurnFocus = new Map([
    ["shopify", { hard: true, verifiedEntityTypes: new Set(), viewEntityTypes: new Set() }],
  ])
  // What the discovery window reads back from the last agent rows.
  const rows = [
    { metadata: { toolCalls: [{ toolName: "tickets__list" }] } },
    { metadata: { discoveredTools: boxtal } },
    { metadata: { toolCalls: [{ toolName: "boxtal__t0" }, { toolName: "boxtal__t3" }] } },
    { metadata: { toolCalls: [{ toolName: "boxtal__t1" }] } },
  ]
  const recency = toolRecency(rows)

  it("the window keeps the last turns' tools whatever the thread column says", () => {
    expect([...recentTools(recency)].sort()).toEqual(boxtal)
    expect(recency.get("tickets__list")).toBe(3)
    expect(recency.get("boxtal__t1")).toBe(0)
  })

  it("the boxtal tools stay loaded and the preload keeps within its share", () => {
    const cap = 20_000
    const out = planTurnToolBudget({
      visible: names,
      tools,
      droppable: (n) => !n.startsWith("kernel__"),
      preloaded: new Set(shopify),
      hardFocusApps: new Set(["shopify"]),
      focus,
      recency,
      cap,
    })
    const dropped = new Set(out.drop)
    for (const n of boxtal) expect(dropped.has(n)).toBe(false)
    for (const n of CORE) expect(dropped.has(n)).toBe(false)
    const keptShopify = shopify.filter((n) => !dropped.has(n))
    expect(keptShopify.length).toBeGreaterThan(0)
    expect(tokensOf(tools, keptShopify)).toBeLessThanOrEqual(cap * FOCUS_PRELOAD_TOKEN_SHARE)
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(cap)
  })
})

describe("the tools acting on the entity and what the last turn used", () => {
  const schema = (input: string) => ({ jsonSchema: { properties: { [input]: {} } } })
  const sized = (chars: number, input: string) => ({
    description: "d".repeat(chars),
    inputSchema: schema(input),
  })
  const focus: TurnFocus = new Map([
    [
      "tickets",
      { hard: true, verifiedEntityTypes: new Set(["ticket"]), viewEntityTypes: new Set<string>() },
    ],
  ])
  const run = (tools: Record<string, { description: string; inputSchema: unknown }>, cap: number) =>
    planTurnToolBudget({
      visible: Object.keys(tools),
      tools,
      droppable: () => true,
      preloaded: new Set(Object.keys(tools).filter((n) => n.startsWith("tickets__"))),
      hardFocusApps: new Set(["tickets"]),
      focus,
      recency: new Map(
        Object.keys(tools)
          .filter((n) => n.startsWith("boxtal__"))
          .map((n, i) => [n, i]),
      ),
      cap,
    })

  it("does not shed a tool the last turn used for what the entity's tools cost past the cap", () => {
    const tools = {
      tickets__reply: sized(4000, "ticketId"),
      boxtal__book: sized(4000, "orderKey"),
    }
    const out = run(tools, 1500)
    expect(out.drop).toEqual([])
    expect(out.toolSchemaTokens).toBeGreaterThan(1500)
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(2250)
  })

  it("still sheds the recent tools past what the entity's tools hold", () => {
    const tools = {
      tickets__reply: sized(800, "ticketId"),
      boxtal__book: sized(2000, "orderKey"),
      boxtal__quote: sized(3000, "orderKey"),
    }
    const out = run(tools, 1000)
    expect(out.drop).toEqual(["boxtal__quote"])
  })

  it("past the ceiling the entity's tools go, and the turn is back under the cap", () => {
    const tools = {
      tickets__reply: sized(6000, "ticketId"),
      boxtal__book: sized(4000, "orderKey"),
    }
    const out = run(tools, 1500)
    expect(out.drop).toEqual(["tickets__reply"])
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(1500)
  })
})
