// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000000bc001"
const USER = "00000000-0000-0000-0000-0000000bc002"
const APP = "bulkroute_test"

function uuid(seed: number): string {
  // version nibble must be 1-8; variant nibble must be 8,9,a,or b
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`
}

let token: string

function setupAppRegistry() {
  toolRegistry.set([ORG, APP, "assign"], {
    appName: APP,
    name: "assign",
    description: "assign",
    requiredScopes: [`${APP}:items:write`],
    gated: false,
    handler: async () => ({ ok: true }),
  })
  toolRegistry.set([ORG, APP, "setStatus"], {
    appName: APP,
    name: "setStatus",
    description: "setStatus",
    requiredScopes: [`${APP}:items:write`],
    gated: false,
    handler: async () => ({ ok: true }),
  })
  toolRegistry.set([ORG, APP, "moveTo"], {
    appName: APP,
    name: "moveTo",
    description: "moveTo",
    requiredScopes: [`${APP}:items:write`],
    gated: false,
    handler: async () => ({ ok: true }),
  })

  const bulk = {
    assign: {
      label: "Assign",
      underlyingTool: "assign",
      dispatchMode: "perItem" as const,
      perItemParam: "itemId",
      sharedFields: ["assignedTo"],
      agentTool: "bulkAssign",
    },
    setStatus: {
      label: "Set status",
      underlyingTool: "setStatus",
      dispatchMode: "perItem" as const,
      perItemParam: "itemId",
      sharedFields: ["status"],
      agentTool: "bulkUpdate",
    },
    moveTo: {
      label: "Move",
      underlyingTool: "moveTo",
      dispatchMode: "perItem" as const,
      perItemParam: "itemId",
      sharedFields: ["projectId"],
      agentTool: "bulkUpdate",
    },
  }
  manifestRegistry.set([ORG, APP], {
    name: APP,
    bulk,
    uiBundleUrl: null,
  })
  registerBulkAgentTools({
    orgId: ORG,
    appName: APP,
    bulk,
    tools: {
      assign: {
        requiredScopes: [`${APP}:items:write`],
        params: { properties: { assignedTo: { type: "string" } } },
      },
      setStatus: {
        requiredScopes: [`${APP}:items:write`],
        params: { properties: { status: { type: "string" } } },
      },
      moveTo: {
        requiredScopes: [`${APP}:items:write`],
        params: { properties: { projectId: { type: "string" } } },
      },
    },
  })
}

async function clearRedis() {
  await clearRedisPatterns([`bulk:${ORG}:*`])
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Bulk Route Org', 'bulk-route-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'bulk-route@test.com', 'Bulk Route')`
  token = await signAccessToken(
    {
      userId: USER,
      orgId: ORG,
      name: "Bulk Route",
      authVersion: 1,
      permissionVersion: 1,
      scopes: [`${APP}:items:write`],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
  setupAppRegistry()
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG, APP])
  manifestRegistry.delete([ORG, APP])
  await clearRedis()
  await releaseTestLock()
})

describe("POST /api/apps/:app/bulk/:action", () => {
  it("422 BATCH_TOO_LARGE when ids.length > 100", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => uuid(1000 + i))
    const res = await app.request(`/api/apps/${APP}/bulk/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ids, params: { assignedTo: USER }, idempotencyKey: uuid(900) }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("BATCH_TOO_LARGE")
  })

  it("422 when idempotencyKey is not a UUID", async () => {
    const res = await app.request(`/api/apps/${APP}/bulk/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [uuid(800)],
        params: { assignedTo: USER },
        idempotencyKey: "bad",
      }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INVALID_IDEMPOTENCY_KEY")
  })

  it("non-gated dispatch returns total/succeeded counts", async () => {
    const res = await app.request(`/api/apps/${APP}/bulk/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [uuid(700), uuid(701), uuid(702)],
        params: { assignedTo: USER },
        idempotencyKey: uuid(703),
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { total: number; succeeded: number; failed: number }
    }
    expect(body.data.total).toBe(3)
    expect(body.data.succeeded).toBe(3)
    expect(body.data.failed).toBe(0)
  })

  it("404 UNKNOWN_BULK_ACTION when action not declared", async () => {
    const res = await app.request(`/api/apps/${APP}/bulk/unknownAction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [uuid(600)],
        params: {},
        idempotencyKey: uuid(601),
      }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("UNKNOWN_BULK_ACTION")
  })
})

describe("agent tool registration from manifest.bulk", () => {
  it("registers bulkAssign as agent-visible single-entry tool", () => {
    const tool = toolRegistry.get([ORG, APP, "bulkAssign"])
    expect(tool).toBeTruthy()
    expect(tool!.agentVisible).toBe(true)
    expect(tool!.requiredScopes).toEqual([`${APP}:items:write`])
  })

  it("registers grouped bulkUpdate with operation enum", () => {
    const tool = toolRegistry.get([ORG, APP, "bulkUpdate"])
    expect(tool).toBeTruthy()
    expect(tool!.agentVisible).toBe(true)
    const params = (tool as any).params
    const parsed = params.safeParse({
      ids: [uuid(500)],
      operation: "setStatus",
      params: { status: "done" },
      idempotencyKey: uuid(501),
    })
    expect(parsed.success).toBe(true)
    const bad = params.safeParse({
      ids: [uuid(502)],
      operation: "delete",
      params: {},
      idempotencyKey: uuid(503),
    })
    expect(bad.success).toBe(false)
  })

  it("agent tool invocation fans out to runBulkDispatch", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const res = await executeTool({
      toolName: `${APP}:bulkAssign`,
      orgId: ORG,
      actor: {
        actorType: "user",
        userId: USER,
        orgId: ORG,
        scopes: [`${APP}:items:write`],
        dimensionGrants: {},
      },
      params: {
        ids: [uuid(400), uuid(401)],
        assignedTo: USER,
        idempotencyKey: uuid(402),
      },
    })
    const data = res.data as { bulkRequestId: string; items: unknown[]; total: number }
    expect(data.bulkRequestId).toBe(uuid(402))
    expect(data.items.length).toBe(2)
    expect(data.total).toBe(2)
  })

  it("grouped agent tool dispatches the right action by operation", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const res = await executeTool({
      toolName: `${APP}:bulkUpdate`,
      orgId: ORG,
      actor: {
        actorType: "user",
        userId: USER,
        orgId: ORG,
        scopes: [`${APP}:items:write`],
        dimensionGrants: {},
      },
      params: {
        ids: [uuid(300)],
        operation: "moveTo",
        params: { projectId: uuid(301) },
        idempotencyKey: uuid(302),
      },
    })
    const data = res.data as { bulkRequestId: string; total: number; succeeded: number }
    expect(data.bulkRequestId).toBe(uuid(302))
    expect(data.total).toBe(1)
    expect(data.succeeded).toBe(1)
  })
})
