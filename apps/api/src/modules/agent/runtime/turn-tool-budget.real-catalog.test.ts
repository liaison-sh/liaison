// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tool schema budget over the real catalog, not over fixtures: the schemas
// the turn holds are what `providerInputSchemaOf` returns for a registered
// tool, and the budget has to decide on what those schemas cost on the wire.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { asSchema, jsonSchema, tool } from "ai"
import { z } from "zod"
import { sql } from "~/db"
import {
  estimateToolSchemaTokens,
  TURN_TOOL_SCHEMA_TOKEN_CAP,
} from "~/modules/agent/context/context"
import {
  actsOnEntity,
  entityRank,
  FOCUS_ENTITY_TOOLS_CEILING_FACTOR,
  focusHeadroomFill,
  focusOverflow,
  type TurnFocus,
} from "~/modules/agent/runtime/turn-focus"
import { planTurnToolBudget } from "~/modules/agent/runtime/turn-tool-budget"
import { isDeferredTool, providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"

const ORG_ID = "00000000-0000-0000-0000-000000db0003"
const REPO_ROOT = resolve(import.meta.dir, "../../../../../..")

type ToolDef = { description?: string; inputSchema?: unknown }
type ToolDefs = Record<string, ToolDef>

/** A manifest's agent-visible tools, as the bridge hands them to a provider. */
function manifestTools(manifestPath: string): ToolDefs {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, manifestPath), "utf8")) as {
    name: string
    tools: Record<string, { description: string; params?: unknown; agentVisible?: boolean }>
  }
  const out: ToolDefs = {}
  for (const [name, def] of Object.entries(manifest.tools)) {
    if (def.agentVisible === false) continue
    out[`${manifest.name}__${name}`] = {
      description: def.description,
      inputSchema: providerInputSchemaOf(def.params),
    }
  }
  return out
}

/** What the provider receives for one tool, by the product's characters-over-four estimate. */
function wireTokens(name: string, def: ToolDef): number {
  const schema = JSON.stringify(asSchema(def.inputSchema as never).jsonSchema)
  return Math.ceil(`${name}\n${def.description ?? ""}\n${schema}`.length / 4)
}

const LARGE_APPS = [
  { app: "invoicing", manifest: "bundled-apps/invoicing/app.manifest.json", entity: "document" },
  { app: "shopify", manifest: "bundled-apps/shopify/app.manifest.json", entity: "order" },
  { app: "boxtal", manifest: "bundled-apps/boxtal/app.manifest.json", entity: "shipment" },
  { app: "tickets", manifest: "apps/api/src/apps/tickets/app.manifest.json", entity: "ticket" },
  { app: "projects", manifest: "apps/api/src/apps/projects/app.manifest.json", entity: "task" },
]

const hardFocus = (app: string, entity: string): TurnFocus =>
  new Map([
    [
      app,
      { hard: true, verifiedEntityTypes: new Set([entity]), viewEntityTypes: new Set<string>() },
    ],
  ])

const kernelTools: ToolDefs = {}
const coreTools: string[] = []
/** The load a thread's heaviest kernel tools put on a turn: about one large app's worth. */
const HEAVY_LOAD_TOKENS = 5000
/**
 * The deferred kernel tools a thread loaded, heaviest first, until together
 * they cost more than HEAVY_LOAD_TOKENS on the wire. Picked from the real
 * catalog, not by name, so a tool whose own text shrinks does not take the
 * pressure out of these tests.
 */
const heavyKernelLoad: string[] = []

beforeAll(async () => {
  const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
  await registerKernelAgentTools(ORG_ID)
  for (const [key, def] of toolRegistry.entries()) {
    if (key[0] !== ORG_ID || key[1] !== "kernel") continue
    const name = `${key[1]}__${key[2]}`
    kernelTools[name] = {
      description: def.description,
      inputSchema: providerInputSchemaOf((def as { params?: unknown }).params),
    }
    if (!isDeferredTool(key[1], def as { deferLoading?: boolean })) coreTools.push(name)
  }
  let load = 0
  for (const [name, def] of Object.entries(kernelTools)
    .filter(([name]) => !coreTools.includes(name))
    .sort(([a, x], [b, y]) => wireTokens(b, y) - wireTokens(a, x))) {
    if (load > HEAVY_LOAD_TOKENS) break
    heavyKernelLoad.push(name)
    load += wireTokens(name, def)
  }
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG_ID])
  skillRegistry.deleteByPrefix([ORG_ID])
  agentInstructionsRegistry.deleteByPrefix([ORG_ID])
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
})

describe("the tool schema meter", () => {
  it("reads every real tool at what the provider receives", () => {
    const tools: ToolDefs = { ...kernelTools }
    for (const { manifest } of LARGE_APPS) Object.assign(tools, manifestTools(manifest))
    expect(Object.keys(tools).length).toBeGreaterThan(300)
    const offenders = Object.entries(tools)
      .filter(([name, def]) => estimateToolSchemaTokens(name, def) !== wireTokens(name, def))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it("counts an argument's description and none of Zod's internals", () => {
    const bare = z.object({ note: z.string() })
    const described = z.object({ note: z.string().describe("n".repeat(4000)) })
    const cost = (inputSchema: unknown) => estimateToolSchemaTokens("t", { inputSchema })
    expect(cost(described) - cost(bare)).toBeGreaterThanOrEqual(1000)
    expect(cost(bare)).toBeLessThan(60)
  })

  it("converts a schema once, however many turns read it", () => {
    let conversions = 0
    const lazy = () => {
      conversions++
      return jsonSchema({ type: "object", properties: { a: { type: "string" } } })
    }
    const first = estimateToolSchemaTokens("t", { inputSchema: lazy })
    expect(estimateToolSchemaTokens("t", { inputSchema: lazy })).toBe(first)
    expect(conversions).toBe(1)
  })

  it("counts a schema the SDK cannot project as written, and no schema as nothing", () => {
    const bare = { properties: { a: { type: "string" } } }
    expect(estimateToolSchemaTokens("t", { description: "d", inputSchema: bare })).toBe(
      Math.ceil(`t\nd\n${JSON.stringify(bare)}`.length / 4),
    )
    expect(estimateToolSchemaTokens("t", { description: "d" })).toBe(Math.ceil("t\nd\n".length / 4))
  })
})

describe("a hard focus turn on a large app", () => {
  for (const { app, manifest, entity } of LARGE_APPS) {
    it(`${app}: fits the budget on the wire, sheds only its own tools, keeps the core`, () => {
      const appTools = manifestTools(manifest)
      const names = Object.keys(appTools)
      const tools = { ...kernelTools, ...appTools }
      const plan = planTurnToolBudget({
        visible: [...coreTools, ...names],
        tools,
        droppable: (n) => n in appTools,
        preloaded: new Set(names),
        hardFocusApps: new Set([app]),
        focus: hardFocus(app, entity),
        recency: new Map(),
        cap: TURN_TOOL_SCHEMA_TOKEN_CAP,
      })
      const dropped = new Set(plan.drop)
      const kept = [...coreTools, ...names].filter((n) => !dropped.has(n))
      const wire = kept.reduce((sum, n) => sum + wireTokens(n, tools[n]), 0)
      expect(wire).toBe(plan.toolSchemaTokens)
      expect(wire).toBeLessThanOrEqual(TURN_TOOL_SCHEMA_TOKEN_CAP)
      expect(coreTools).toContain("kernel__tool_search")
      expect(plan.drop.every((n) => n in appTools)).toBe(true)
      expect(kept.filter((n) => n in appTools).length).toBeGreaterThan(names.length / 2)
    })
  }
})

describe("a thread holding kernel tools whose cost the meter used to miss", () => {
  const app = LARGE_APPS.find((a) => a.app === "tickets")
  const plan = (recency: Map<string, number>) => {
    const appTools = manifestTools(app?.manifest ?? "")
    const names = Object.keys(appTools)
    const tools = { ...kernelTools, ...appTools }
    const heavy = heavyKernelLoad
    const out = planTurnToolBudget({
      visible: [...coreTools, ...heavy, ...names],
      tools,
      droppable: (n) => heavy.includes(n) || n in appTools,
      preloaded: new Set(names),
      hardFocusApps: new Set(["tickets"]),
      focus: hardFocus("tickets", "ticket"),
      recency,
      cap: TURN_TOOL_SCHEMA_TOKEN_CAP,
    })
    const cost = heavy.reduce((n, name) => n + wireTokens(name, tools[name]), 0)
    return { ...out, heavy, cost }
  }
  const usedLastTurn = () => new Map(heavyKernelLoad.map((name) => [name, 0]))

  it("is a large load on the wire", () => {
    expect(plan(new Map()).cost).toBeGreaterThan(HEAVY_LOAD_TOKENS)
  })

  it("sheds them first when the last turns did not use them, and the app keeps its room", () => {
    const out = plan(new Map())
    for (const name of out.heavy) expect(out.drop).toContain(name)
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(TURN_TOOL_SCHEMA_TOKEN_CAP)
  })

  it("keeps them when the last turn used them, beside the tools acting on the ticket", () => {
    const out = plan(usedLastTurn())
    for (const name of out.heavy) expect(out.drop).not.toContain(name)
    for (const name of ["reply", "get", "addNote"]) {
      expect(out.drop).not.toContain(`tickets__${name}`)
    }
    expect(out.drop).toContain("tickets__search")
    expect(out.toolSchemaTokens).toBeLessThanOrEqual(
      Math.round(TURN_TOOL_SCHEMA_TOKEN_CAP * FOCUS_ENTITY_TOOLS_CEILING_FACTOR),
    )
  })
})

describe("entity protection reads what the tool bridge hands out", () => {
  const entity = new Set(["ticket"])

  it("reads the schema the bridge hands a model for a manifest's params", () => {
    const reply = manifestTools("apps/api/src/apps/tickets/app.manifest.json").tickets__reply
    expect(actsOnEntity(reply.inputSchema, entity)).toBe(true)
  })

  it("reads a Zod object", () => {
    expect(actsOnEntity(z.object({ ticketId: z.string() }), entity)).toBe(true)
  })

  it("reads the schema a tuple argument is rewritten to", () => {
    const rewritten = providerInputSchemaOf(
      z.object({ ticketId: z.string(), pair: z.tuple([z.string(), z.number()]) }),
    )
    expect(actsOnEntity(rewritten, entity)).toBe(true)
  })

  it("reads the schema a built tool carries, unchanged by the SDK's tool()", () => {
    const inputSchema = providerInputSchemaOf({
      type: "object",
      properties: { ticketId: { type: "string" } },
    })
    const built = tool({ description: "d", inputSchema: inputSchema as never })
    expect(actsOnEntity(built.inputSchema, entity)).toBe(true)
  })

  it("does not count an input naming another entity", () => {
    expect(actsOnEntity(providerInputSchemaOf(z.object({ taskId: z.string() })), entity)).toBe(
      false,
    )
  })
})

describe("the tool order on a real entity page", () => {
  const ticketTools = () => manifestTools("apps/api/src/apps/tickets/app.manifest.json")
  const projectTools = () => manifestTools("apps/api/src/apps/projects/app.manifest.json")

  it("ranks the tools of the entity on a ticket's and a task's thread", () => {
    const tickets = ticketTools()
    const ticket = hardFocus("tickets", "ticket")
    for (const name of ["reply", "get", "addNote", "close", "setStatus"]) {
      expect(entityRank(`tickets__${name}`, tickets, ticket)).toBe(2)
    }
    for (const name of ["search", "backlogHealth", "templates.list"]) {
      expect(entityRank(`tickets__${name}`, tickets, ticket)).toBe(0)
    }
    const projects = projectTools()
    const task = hardFocus("projects", "task")
    for (const name of ["comment", "comments", "get", "update"]) {
      expect(entityRank(`projects__${name}`, projects, task)).toBe(2)
    }
    expect(entityRank("projects__createProject", projects, task)).toBe(0)
  })

  it("does not rank another app's tool because its input names the entity", () => {
    const tools = {
      ...ticketTools(),
      ...manifestTools("apps/api/src/apps/mail/app.manifest.json"),
    }
    expect(entityRank("mail__convertToTicket", tools, hardFocus("tickets", "ticket"))).toBe(0)
  })

  it("sheds every other tool of the app before any tool acting on the entity", () => {
    const tools = ticketTools()
    const names = Object.keys(tools)
    const focus = hardFocus("tickets", "ticket")
    const visibleTokens = names.reduce(
      (n, name) => n + estimateToolSchemaTokens(name, tools[name]),
      0,
    )
    const others = names.filter((n) => entityRank(n, tools, focus) === 0)
    const entityTools = names.filter((n) => entityRank(n, tools, focus) === 2)
    expect(entityTools.length).toBeGreaterThan(5)

    const out = focusOverflow({ candidates: names, tools, focus, visibleTokens, cap: 1000 })
    expect(out.slice(0, others.length).sort()).toEqual([...others].sort())
    expect(out.slice(0, others.length)[0]).toBe("tickets__search")
  })

  it("keeps a task's own tools under pressure from what the thread loaded", () => {
    const appTools = projectTools()
    const names = Object.keys(appTools)
    const tools = { ...kernelTools, ...appTools }
    const heavy = heavyKernelLoad
    const plan = planTurnToolBudget({
      visible: [...coreTools, ...heavy, ...names],
      tools,
      droppable: (n) => heavy.includes(n) || n in appTools,
      preloaded: new Set(names),
      hardFocusApps: new Set(["projects"]),
      focus: hardFocus("projects", "task"),
      recency: new Map(heavy.map((name) => [name, 0])),
      cap: TURN_TOOL_SCHEMA_TOKEN_CAP,
    })
    for (const name of ["comment", "comments", "get", "update"]) {
      expect(plan.drop).not.toContain(`projects__${name}`)
    }
    expect(plan.drop).toContain("projects__createProject")
    for (const name of heavy) expect(plan.drop).not.toContain(name)
  })

  it("loads the tools of the entity in view first when only a little room is left", () => {
    const tools = ticketTools()
    const names = Object.keys(tools)
    const focus: TurnFocus = new Map([
      [
        "tickets",
        {
          hard: false,
          verifiedEntityTypes: new Set<string>(),
          viewEntityTypes: new Set(["ticket"]),
        },
      ],
    ])
    const out = focusHeadroomFill({ candidates: names, tools, focus, visibleTokens: 0, cap: 3000 })
    expect(out.length).toBeGreaterThan(0)
    const firstOther = out.findIndex((n) => entityRank(n, tools, focus) === 0)
    const lastActing = out.findLastIndex((n) => entityRank(n, tools, focus) === 1)
    expect(lastActing).toBeGreaterThanOrEqual(0)
    if (firstOther !== -1) expect(lastActing).toBeLessThan(firstOther)
  })
})

describe("the schema a model is sent, over the real catalog", () => {
  /** Every node of a JSON Schema's schema positions, data under `enum` or `default` aside. */
  function* schemaNodes(node: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(node)) {
      for (const entry of node) yield* schemaNodes(entry)
      return
    }
    if (typeof node !== "object" || node === null) return
    const schema = node as Record<string, unknown>
    yield schema
    for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
      const map = schema[key]
      if (typeof map === "object" && map !== null) yield* schemaNodes(Object.values(map))
    }
    for (const key of ["anyOf", "oneOf", "allOf", "items", "additionalProperties", "not"]) {
      yield* schemaNodes(schema[key])
    }
  }

  const isFormatPattern = (n: Record<string, unknown>) =>
    (n.format === "uuid" || n.format === "email") && "pattern" in n

  it("carries no $schema and no uuid or email pattern on any tool", () => {
    const tools: ToolDefs = { ...kernelTools }
    for (const { manifest } of LARGE_APPS) Object.assign(tools, manifestTools(manifest))
    const offenders: string[] = []
    for (const [name, def] of Object.entries(tools)) {
      const json = asSchema(def.inputSchema as never).jsonSchema
      if (typeof json === "object" && json !== null && "$schema" in json) offenders.push(name)
      if ([...schemaNodes(json)].some(isFormatPattern)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it("removes only the pattern Zod generates for the format, never one a tool wrote", () => {
    const generated = new Set(
      [z.uuid(), z.email()].map((s) => (z.toJSONSchema(s) as { pattern: string }).pattern),
    )
    const removed = new Set<string>()
    for (const [key, def] of toolRegistry.entries()) {
      if (key[0] !== ORG_ID) continue
      const params = (def as { params?: unknown }).params
      if (typeof (params as { safeParse?: unknown } | undefined)?.safeParse !== "function") continue
      for (const node of schemaNodes(asSchema(params as never).jsonSchema)) {
        if (isFormatPattern(node)) removed.add(node.pattern as string)
      }
    }
    expect(removed.size).toBeGreaterThan(0)
    expect([...removed].filter((pattern) => !generated.has(pattern))).toEqual([])
  })

  it("still refuses a bad uuid on a real tool, and passes a valid one", async () => {
    const zodKernelTool = [...toolRegistry.entries()].flatMap(([key, def]) => {
      const params = (def as { params?: z.ZodObject }).params
      if (key[0] !== ORG_ID || typeof params?.safeParse !== "function") return []
      const json = asSchema(params as never).jsonSchema as {
        properties?: Record<string, { format?: string }>
        required?: string[]
      }
      const id = Object.entries(json.properties ?? {}).find(([, p]) => p.format === "uuid")?.[0]
      const required = json.required ?? []
      return id && required.length === 1 && required[0] === id ? [{ key, id }] : []
    })[0]
    expect(zodKernelTool).toBeDefined()
    const { key, id } = zodKernelTool
    const { validate } = asSchema(kernelTools[`${key[1]}__${key[2]}`].inputSchema as never)
    expect((await validate?.({ [id]: "not-a-uuid" }))?.success).toBe(false)
    expect((await validate?.({ [id]: "3f2b8c1e-6a4d-4e9b-8f10-2c7d5e9a1b34" }))?.success).toBe(true)
  })
})
