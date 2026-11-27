// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `revenue-stream@1`, a multi-provider contract with events: registration checks a provider's
// emits and a consumer's contract subscription; the kernel delivers a contract event from every
// app implementing the contract in the org (and only that org), with the source app in the
// envelope; a call names its provider, which the caller's own binding table must hold.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
} from "~/infra/events/event-bus"
import {
  appContractCallsRegistry,
  appContractImplementationsRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertAppRow } from "~/seed/factories/app-tables"
import { insertSql } from "~/seed/factories/org/test-rows"

const KEY = "revenue-stream@1"
const OPS = { sale_get: "rs_sale_get", sales_list: "rs_sales_list" }

function opTool(app: string, name: string, params: string[], fieldMap = false) {
  return {
    description: `op ${name}`,
    requiredScopes: [`${app}:internal`],
    handler: name,
    trustBoundary: "internal",
    agentVisible: false,
    contractOnly: true,
    // A manifest declares JSON Schema params; a registered descriptor a field map.
    params: fieldMap
      ? Object.fromEntries(params.map((p) => [p, "string?"]))
      : { type: "object", properties: Object.fromEntries(params.map((p) => [p, {}])) },
  }
}

function provider(name: string, emits: string[] = ["sale:paid", "sale:refunded"]) {
  return {
    name,
    version: "1.0.0",
    scopes: [`${name}:internal`],
    tools: {
      rs_sale_get: opTool(name, "rs_sale_get", ["external_id"]),
      rs_sales_list: opTool(name, "rs_sales_list", ["paid_from", "paid_to", "cursor"]),
    },
    implements: [{ contract: "revenue-stream", version: 1, tools: OPS }],
    events: { emits },
  }
}

function consumer(over: Record<string, unknown> = {}) {
  return {
    name: "rscons",
    version: "1.0.0",
    scopes: ["rscons:write"],
    schema: { streams: { fields: { provider_app: "text" } } },
    contract_calls: [{ contract: KEY, bindingSetting: "streams.provider_app" }],
    events: { subscribes: { "contract:revenue-stream@1/sale:paid": "onSale" } },
    ...over,
  }
}

const errorOf = (m: unknown) => validateAppManifest(m).error ?? ""

describe("revenue-stream@1 registration", () => {
  it("accepts a provider emitting the required events and a consumer subscribing", () => {
    expect(validateAppManifest(provider("shopx")).error ?? null).toBeNull()
    expect(validateAppManifest(consumer()).error ?? null).toBeNull()
  })
  it("refuses a provider that does not emit sale:paid", () => {
    expect(errorOf(provider("shopx", ["sale:refunded"]))).toContain(
      'requires events.emits "sale:paid"',
    )
  })
  it("refuses a provider missing sales_list", () => {
    const p = provider("shopx")
    p.implements = [
      { contract: "revenue-stream", version: 1, tools: { sale_get: "rs_sale_get" } as never },
    ]
    expect(errorOf(p)).toContain('requires op "sales_list"')
  })
  it("refuses a subscription to an event the contract does not declare", () => {
    expect(
      errorOf(
        consumer({ events: { subscribes: { "contract:revenue-stream@1/sale:shipped": "x" } } }),
      ),
    ).toContain('has no event "sale:shipped"')
  })
  it("refuses a subscription to an unknown contract, and a malformed one", () => {
    expect(
      errorOf(consumer({ events: { subscribes: { "contract:nope@1/sale:paid": "x" } } })),
    ).toContain('unknown contract "nope@1"')
    expect(
      errorOf(consumer({ events: { subscribes: { "contract:revenue-stream/sale:paid": "x" } } })),
    ).toContain("a contract subscription reads")
  })
  it("refuses a contract subscription without contract_calls for the contract", () => {
    expect(errorOf(consumer({ contract_calls: undefined }))).toContain(
      'subscribing to "revenue-stream@1" needs contract_calls for it',
    )
  })
})

// ---------------------------------------------------------------------------------------------
const ORG = randomUUID()
const OTHER_ORG = randomUUID()
const received: Array<{ org: string; app: string; data: unknown }> = []

/** A provider as the registries hold it once registered (as provider-contracts.test.ts does). */
function registerProvider(org: string, name: string) {
  appContractImplementationsRegistry.set([org, name], { [KEY]: { ops: OPS } })
  for (const t of Object.values(OPS)) {
    toolRegistry.set([org, name, t], {
      appName: name,
      name: t,
      description: t,
      requiredScopes: [`${name}:internal`],
      trustBoundary: "internal",
      agentVisible: false,
      contractOnly: true,
      handler: async (params: { external_id?: string }) =>
        t === "rs_sale_get"
          ? { found: true, sale: { external_id: params.external_id, from: name } }
          : { sales: [], next: null },
    } as never)
  }
}

function deliveryConsumer(org: string) {
  return {
    name: "rscons",
    version: "1.0.0",
    scopes: ["rscons:internal"],
    schema: { streams: { rlsScope: "internal", fields: { provider_app: "text" } } },
    contract_calls: [{ contract: KEY, bindingSetting: "streams.provider_app" }],
    events: {
      subscribes: {
        "contract:revenue-stream@1/sale:paid": async (e: {
          orgId: string
          app: string
          data: unknown
        }) => {
          received.push({ org, app: e.app, data: e.data })
        },
      },
    },
  }
}

async function publish(org: string, app: string, entity: string, action: string, id: string) {
  await publishEvent({
    app,
    entity,
    action,
    entityId: id,
    data: { external_id: id, occurred_at: "2026-11-20T10:00:00.000Z" },
    actorId: `system:${app}`,
    actorType: "system",
    orgId: org,
    timestamp: new Date().toISOString(),
  })
  await flushEventHandlers()
}

describe("revenue-stream@1 delivery and calls", () => {
  beforeAll(async () => {
    for (const [id, slug] of [
      [ORG, `rs-${ORG.slice(0, 8)}`],
      [OTHER_ORG, `rs-${OTHER_ORG.slice(0, 8)}`],
    ]) {
      await sql.unsafe(
        insertSql("kernel.organizations", { id: id!, name: "Revenue Org", slug: slug! }),
      )
    }
    initEventBus()
    const r1 = await registerApps([deliveryConsumer(ORG)] as never, ORG)
    expect(r1.failedApps).toEqual([])
    registerProvider(ORG, "rsshop")
    registerProvider(ORG, "rspay")
    // The other org has the consumer and only one of the providers.
    const r2 = await registerApps([deliveryConsumer(OTHER_ORG)] as never, OTHER_ORG)
    expect(r2.failedApps).toEqual([])
    registerProvider(OTHER_ORG, "rsshop")
  })

  afterAll(async () => {
    for (const org of [ORG, OTHER_ORG]) {
      await teardownAppRegistrations(org, "rscons").catch(() => {})
      for (const app of ["rsshop", "rspay"])
        for (const t of Object.values(OPS)) toolRegistry.delete([org, app, t])
      appContractCallsRegistry.deleteByPrefix([org])
      appContractImplementationsRegistry.deleteByPrefix([org])
    }
    await sql`DELETE FROM app_rscons.streams WHERE org_id IN (${ORG}, ${OTHER_ORG})`.catch(() => {})
    await sql`DELETE FROM kernel.apps WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
  })

  it("delivers sale:paid from each provider of the org, naming the source app", async () => {
    received.length = 0
    await publish(ORG, "rsshop", "sale", "paid", "o-1")
    await publish(ORG, "rspay", "sale", "paid", "pi_1")
    expect(received).toEqual([
      {
        org: ORG,
        app: "rsshop",
        data: { external_id: "o-1", occurred_at: "2026-11-20T10:00:00.000Z" },
      },
      {
        org: ORG,
        app: "rspay",
        data: { external_id: "pi_1", occurred_at: "2026-11-20T10:00:00.000Z" },
      },
    ])
  })

  it("never delivers to another org, nor an event outside the contract, nor from a non-provider", async () => {
    // rsshop's order:created is not a contract event; rscons implements nothing.
    received.length = 0
    await publish(ORG, "rsshop", "order", "created", "o-2")
    await publish(ORG, "rscons", "sale", "paid", "self")
    await publish(OTHER_ORG, "rspay", "sale", "paid", "pi_2")
    expect(received).toEqual([])
    await publish(OTHER_ORG, "rsshop", "sale", "paid", "o-3")
    expect(received.map((r) => [r.org, r.app])).toEqual([[OTHER_ORG, "rsshop"]])
  })

  const call = (provider: string | null) =>
    withRlsContext(
      { actorType: "system", orgId: ORG, purpose: "job", scopes: ["rscons:*"] },
      async (tx) =>
        JSON.parse(
          await createRpcBridge(
            "rscons",
            "system",
            ORG,
            tx as never,
            { name: "rscons" } as never,
            ["rscons:*"],
            "system",
          ).contracts_call(
            KEY,
            "sale_get",
            JSON.stringify({ external_id: "x-1" }),
            JSON.stringify(provider ? { provider } : {}),
          ),
        ),
    )

  it("a call names its provider, and only one the caller's binding table holds", async () => {
    expect(toolRegistry.get([ORG, "rspay", "rs_sale_get"])).toBeDefined()
    expect(await call(null)).toMatchObject({
      status: "error",
      error: { code: "contract_provider_required" },
    })
    expect(await call("rspay")).toMatchObject({
      status: "error",
      error: { code: "contract_provider_not_configured" },
    })
    expect(await call("nosuchapp")).toMatchObject({
      status: "error",
      error: { code: "contract_provider_unavailable" },
    })
    await withPrivilegedDb(ORG, "test", (tx) =>
      insertAppRow(tx as never, "rscons", "streams", { org_id: ORG, provider_app: "rspay" }),
    )
    expect(await call("rspay")).toMatchObject({
      status: "completed",
      provider: "rspay",
      result: { found: true, sale: { external_id: "x-1", from: "rspay" } },
    })
    // Bound to one provider does not open the other.
    expect(await call("rsshop")).toMatchObject({
      status: "error",
      error: { code: "contract_provider_not_configured" },
    })
  })
})
