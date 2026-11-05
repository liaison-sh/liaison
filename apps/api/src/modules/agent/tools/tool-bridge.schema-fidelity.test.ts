// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A manifest tool's parameter schema must reach the model WHOLE: descriptions,
// enums, nested object shapes and array items. The live Oracle walk found every
// manifest tool projected to bare types, in-app and over MCP: `db_query`'s
// `connection` lost its ["default","warehouse"] enum and `kpi_run`'s `period`
// arrived as `{}`, and Gemini's first warehouse call hit the wrong connection.
//
// Checked at the three places the schema travels: the in-app tool set, the MCP
// tools/list projection, and the actual Gemini request body the AI SDK builds.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createGoogle } from "@ai-sdk/google"
import { asSchema, generateText } from "ai"
import type { UserContext } from "~/db/rls"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { toJsonSchema } from "~/modules/mcp/tool-projection"

const ORG = "00000000-0000-0000-0000-0000009e0001"

const actor: UserContext = {
  actorType: "user",
  userId: "00000000-0000-0000-0000-0000009e0002",
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

// Real shapes, copied from the database and kpi manifests.
const DB_QUERY_PARAMS = {
  type: "object",
  properties: {
    sql: { type: "string", description: "A single SELECT (or WITH ... SELECT) statement" },
    connection: {
      type: "string",
      enum: ["default", "warehouse"],
      description: 'Which connection to use: "default" or "warehouse"',
    },
  },
  required: ["sql"],
}

const KPI_RUN_PARAMS = {
  type: "object",
  properties: {
    hubId: { type: "string", description: "Hub UUID" },
    period: {
      type: "object",
      description: "Inclusive calendar period {start, end}, both YYYY-MM-DD",
      properties: { start: { type: "string" }, end: { type: "string" } },
      required: ["start", "end"],
    },
    population: {
      type: "string",
      enum: ["members", "active_members", "panel"],
      description: "Population the metrics are computed over",
    },
    metricIds: {
      type: "array",
      items: { type: "string" },
      description: "Subset of registry metric ids",
    },
    limit: { type: ["integer", "null"], description: "Optional cap" },
  },
  required: ["hubId", "period", "population"],
}

type Json = Record<string, any>

function projected(tools: Record<string, any>, name: string): Json {
  return asSchema(tools[name].inputSchema).jsonSchema as Json
}

describe("manifest tool schemas keep what the model needs", () => {
  beforeAll(() => {
    toolRegistry.set([ORG, "database", "db_query"], {
      appName: "database",
      name: "db_query",
      description: "Run a read query.",
      requiredScopes: ["database:queries:read"],
      params: DB_QUERY_PARAMS,
      handler: async (p: unknown) => ({ received: p }),
    } as never)
    toolRegistry.set([ORG, "kpi", "kpi_run"], {
      appName: "kpi",
      name: "kpi_run",
      description: "Compute KPIs.",
      requiredScopes: ["kpi:metrics:read"],
      params: KPI_RUN_PARAMS,
      handler: async (p: unknown) => ({ received: p }),
    } as never)
  })

  afterAll(() => {
    toolRegistry.deleteByPrefix([ORG])
  })

  it("the in-app tool set keeps enums, descriptions, nested properties and items", () => {
    const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const db = projected(tools, "database__db_query")
    expect(db.properties.connection.enum).toEqual(["default", "warehouse"])
    expect(db.properties.connection.description).toContain("warehouse")
    expect(db.properties.sql.description).toContain("SELECT")
    expect(db.required).toEqual(["sql"])

    const kpi = projected(tools, "kpi__kpi_run")
    expect(kpi.properties.period.type).toBe("object")
    expect(Object.keys(kpi.properties.period.properties).sort()).toEqual(["end", "start"])
    expect(kpi.properties.period.required).toEqual(["start", "end"])
    expect(kpi.properties.population.enum).toEqual(["members", "active_members", "panel"])
    expect(kpi.properties.metricIds.items.type).toBe("string")
    expect(kpi.properties.metricIds.description).toContain("metric ids")
    expect(JSON.stringify(kpi.properties.limit)).toContain("null")
  })

  it("still validates what the tool accepts: a wrong enum value is refused, a nested extra key kept", async () => {
    const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const schema = asSchema(tools.database__db_query.inputSchema)
    const bad = await schema.validate?.({ sql: "select 1", connection: "prod" })
    expect(bad?.success).toBe(false)
    const kpi = asSchema(tools.kpi__kpi_run.inputSchema)
    const ok = await kpi.validate?.({
      hubId: "h",
      period: { start: "2026-08-01", end: "2026-08-31", note: "kept" },
      population: "members",
    })
    expect(ok?.success).toBe(true)
    expect((ok as { value: Json }).value.period.note).toBe("kept")
  })

  it("the MCP tools/list projection carries the same schema", () => {
    const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "gateway")
    const db = toJsonSchema(tools.database__db_query.inputSchema) as Json
    expect(db.properties.connection.enum).toEqual(["default", "warehouse"])
    const kpi = toJsonSchema(tools.kpi__kpi_run.inputSchema) as Json
    expect(Object.keys(kpi.properties.period.properties).sort()).toEqual(["end", "start"])
  })

  it("the Gemini request body carries the enum, the descriptions and the nested shape", async () => {
    let body: Json | null = null
    const google = createGoogle({
      apiKey: "test-key",
      fetch: (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body)
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as never,
    })
    const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    await generateText({
      model: google("gemini-2.5-flash"),
      prompt: "hi",
      tools: { database__db_query: tools.database__db_query, kpi__kpi_run: tools.kpi__kpi_run },
    })
    const decls = (body as unknown as Json).tools[0].functionDeclarations as Json[]
    // @ai-sdk/google 4 sends the JSON Schema as-is (`parametersJsonSchema`);
    // 3 converted it to Gemini's OpenAPI subset (`parameters`).
    const schemaOf = (name: string) => {
      const d = decls.find((x) => x.name === name) as Json
      return { parameters: d.parametersJsonSchema ?? d.parameters } as Json
    }
    const db = schemaOf("database__db_query")
    expect(db.parameters.properties.connection.enum).toEqual(["default", "warehouse"])
    expect(db.parameters.properties.connection.description).toContain("warehouse")
    const kpi = schemaOf("kpi__kpi_run")
    expect(Object.keys(kpi.parameters.properties.period.properties).sort()).toEqual([
      "end",
      "start",
    ])
    expect(kpi.parameters.properties.metricIds.items.type).toBe("string")
    expect(kpi.parameters.properties.population.enum).toEqual([
      "members",
      "active_members",
      "panel",
    ])
  })
})
