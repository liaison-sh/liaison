// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The live walk's two dead ends, as tool chains a weak model can follow.
//
// A scripted model drives the real tool set. It sees what a turn sees: the
// hot tools plus what this run discovered, and it calls ONLY a tool in that
// set, with a name and params it read in a tool result or a description. Two
// chains, each from a person's words:
//
//   "import our Jira from https://northwind.atlassian.net"
//     tool_search -> import_reference -> import_transform_save (refused: the
//     site) -> import_transform_save with the site (saved, needsConnection,
//     the adapter save loaded) -> connector_adapter_save (approval card,
//     approved) -> request_secret (pending card) -> credentials saved ->
//     connector_adapter_test answers.
//
//   "connect our HubSpot, we have a private app token"
//     tool_search -> connector_adapter_reference -> connector_adapter_save
//     (approved) -> request_secret (pending card) -> credentials saved ->
//     connector_adapter_test answers.
//
// Every gate stays: the adapter save parks for a person's approval, and the
// credentials go through the secret card (the route its Save posts to).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import * as dnsPromises from "node:dns/promises"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { messages, secretRequests } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { errorHandler } from "~/middleware/error-handler"
import { systemEventLine } from "~/modules/agent/context/system-event-replay"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { buildToolSet, isDeferredTool } from "~/modules/agent/tools/tool-bridge"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { registerApiConnectorApp } from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createScope } from "~/modules/permissions/types"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import * as minimal from "~/seed/tiers/minimal"
import { waitFor } from "~/tests/helpers/wait-for"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

let ORG = ""
let ADMIN = ""
let scopes: string[] = []
let lookupSpy: ReturnType<typeof spyOn>
const upstream: string[] = []

/** The fake upstream APIs: Jira Cloud and HubSpot, behind the outbound fetch seam. */
function fakeUpstream(url: URL, init?: RequestInit): Response {
  upstream.push(`${url.host}${url.pathname}`)
  const auth = new Headers(init?.headers).get("authorization") ?? ""
  if (url.host === "northwind.atlassian.net") {
    if (!auth.startsWith("Basic ")) return new Response("{}", { status: 401 })
    if (url.pathname === "/rest/api/3/project/search") {
      return Response.json({ values: [{ key: "NWA", name: "Northwind App", id: "10001" }] })
    }
    return Response.json({ values: [] })
  }
  if (url.host === "api.hubapi.com") {
    if (auth !== "Bearer pat-na1-fake-token") return new Response("{}", { status: 401 })
    return Response.json({
      results: [{ id: "501", properties: { email: "ana@acme.example", firstname: "Ana" } }],
    })
  }
  return new Response("unexpected host", { status: 599 })
}

/** One turn's model: it sees the hot tools and its discoveries, and calls only those. */
class ScriptedModel {
  readonly frame: RunContext & { discoveredTools: Set<string> }
  readonly calls: string[] = []

  constructor(
    readonly threadId: string,
    readonly actor: ActorContext,
  ) {
    this.frame = {
      runId: `run-${crypto.randomUUID()}`,
      parentRunId: null,
      rootRunId: `root-${crypto.randomUUID()}`,
      nestingDepth: 0,
      effectiveScope: actor.scopes ?? [],
      turnScopeAccumulator: createTurnScopeAccumulator(),
      discoveredTools: new Set<string>(),
    }
  }

  /** The step's tool set: built as the loop builds it, from this run's discoveries so far. */
  private tools(): Record<string, { execute: (p: unknown, o: unknown) => Promise<unknown> }> {
    return buildToolSet(
      ORG,
      this.actor,
      this.threadId,
      this.frame.discoveredTools,
      "agent",
      this.frame,
    )
  }

  /** What the provider is shown: hot tools, plus the deferred ones this run discovered. */
  visible(): Set<string> {
    const tools = this.tools()
    const out = new Set<string>()
    for (const [key, def] of toolRegistry.entries()) {
      if (key[0] !== ORG) continue
      const name = `${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`
      if (!(name in tools)) continue
      if (!isDeferredTool(key[1], def) || this.frame.discoveredTools.has(name)) out.add(name)
    }
    return out
  }

  async call(name: string, params: Record<string, unknown>): Promise<unknown> {
    expect(this.visible().has(name)).toBe(true)
    this.calls.push(name)
    const tool = this.tools()[name]
    if (!tool) throw new Error(`${name} is not in the turn's tool set`)
    return tool.execute(params, { toolCallId: `call-${this.calls.length}`, messages: [] })
  }
}

/** A tool answer as the model reads it. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** The approved call's output, read as the agent's next turn reads it (the replayed line). */
async function approvedResult(
  threadId: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  let line = ""
  await waitFor(
    async () => {
      const rows = await withPrivilegedDb(ORG, "chain-read-result", (tx) =>
        tx
          .select({ content: messages.content, metadata: messages.metadata })
          .from(messages)
          .where(and(eq(messages.orgId, ORG), eq(messages.threadId, threadId))),
      )
      for (const r of rows) {
        const meta = asRecord(r.metadata)
        if (meta.type === "approval-result" && meta.requestId === requestId) {
          line = systemEventLine({ content: r.content ?? "", metadata: r.metadata }) ?? ""
        }
      }
      return line !== ""
    },
    { timeoutMs: 20_000, label: "the approved call's result line" },
  )
  // The line fences the tool's output; the model reads the JSON inside the fence. A
  // <platform-step> line after the fence can carry JSON of its own (the next call's params),
  // so the output is read from the fence alone.
  const fenced = line.match(/<external-content[^>]*>\n([\s\S]*?)\n<\/external-content>/)?.[1]
  expect(fenced).toBeDefined()
  return JSON.parse(fenced ?? "") as Record<string, unknown>
}

async function approve(requestId: string): Promise<void> {
  await decideApproval({
    orgId: ORG,
    requestId,
    actor: { actorType: "user", userId: ADMIN, orgId: ORG, scopes, dimensionGrants: {} },
    decision: "approve",
  })
}

/** What the secret card's Save posts, as the person (never through the agent). */
async function personSavesCredentials(identifier: string, credentials: Record<string, string>) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", ORG)
    c.set("userId", ADMIN)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/connections", connectionRoutes)
  const res = await app.request("/api/connections/api-connector/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "org", credentials: { identifier, ...credentials } }),
  })
  expect(res.status).toBeLessThan(300)
}

async function pendingSecretRequest(identifier: string): Promise<boolean> {
  const rows = await withPrivilegedDb(ORG, "chain-read-secret-request", (tx) =>
    tx
      .select({ status: secretRequests.status, target: secretRequests.target })
      .from(secretRequests)
      .where(eq(secretRequests.orgId, ORG)),
  )
  return rows.some((r) => r.status === "pending" && asRecord(r.target).identifier === identifier)
}

/** The tool a search result says it loaded, by a word of its name. */
function loadedBy(result: unknown, part: string): string | undefined {
  const note = String(asRecord(result).note ?? "")
  const loaded = note.match(/LOADED: ([^.]+)\./)?.[1]?.split(", ") ?? []
  return loaded.find((n) => n.includes(part))
}

/** A fresh workspace with its admin, as /register leaves it: no connection yet. */
async function freshWorkspace(label: string): Promise<void> {
  ORG = (await ensureOrg({ slug: `connect-${label}-${Date.now()}`, name: "Northwind" })).orgId
  ADMIN = (
    await ensureUser({
      orgId: ORG,
      email: `nadia-${Date.now()}@northwind.test`,
      name: "Nadia Owner",
      password: "Passw0rd!",
      role: "admin",
    })
  ).userId
  await ensureAppsForOrg(ORG)
  await registerApiConnectorApp(ORG)
  await registerKernelAgentTools(ORG)
  scopes = (
    await withPrivilegedDb(ORG, "chain-scopes", (tx) => loadEffectivePermissions(tx, ADMIN, ORG))
  ).scopes
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
}, 180_000)

afterAll(async () => {
  broadcastSpy.mockRestore()
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(() => {
  upstream.length = 0
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) =>
    fakeUpstream(new URL(String(input instanceof Request ? input.url : input)), init)) as never)
})

afterEach(async () => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
  await invalidateConnectionCaches(ORG, "jira")
  await invalidateConnectionCaches(ORG, "hubspot")
})

function actor(): ActorContext {
  return { actorType: "user", userId: ADMIN, orgId: ORG, scopes, dimensionGrants: {} }
}

describe("from a person's words to a working API connection", () => {
  it("Jira: from the reference to a saved connection, a credentials card and a test call", async () => {
    await freshWorkspace("jira")
    const threadId = await minimal.thread(ORG, ADMIN)
    const model = new ScriptedModel(threadId, actor())

    // "Import our Jira": the import tools are found by the request's words.
    const search = await model.call("kernel__tool_search", { query: "import jira" })
    const reference = loadedBy(search, "import_reference")
    expect(reference).toBe("kernel__import_reference")

    const list = asRecord(await model.call("kernel__import_reference", {}))
    const jira = (list.references as Array<Record<string, unknown>>).find(
      (r) => r.source === "jira-software",
    )
    expect(jira?.connection).toBe("jira")
    // The step one hint already says an API reference needs its site and a connection.
    expect(String(list.next)).toContain("SITE")
    expect(String(list.next)).toContain("needsConnection")
    const saveTool = String(list.next).match(/kernel__import_transform_save/)?.[0] ?? ""
    expect(model.visible().has(saveTool)).toBe(true)

    // Saved without the site: refused, retryable, naming the parameter and the question to ask.
    const noSite = await model.call(saveTool, { name: "jira", fromReference: "jira-software" })
    expect(textOf(noSite)).toContain("call again with params: { SITE:")
    expect(textOf(noSite)).toContain("never guess it")
    expect(textOf(noSite)).not.toContain("NOT retryable")

    // The person gave the site in their message: the save goes through and hands the next step.
    const saved = asRecord(
      await model.call(saveTool, {
        name: "jira",
        fromReference: "jira-software",
        params: { SITE: "https://northwind.atlassian.net" },
      }),
    )
    expect(saved.version).toBe(1)
    const needs = asRecord(saved.needsConnection)
    const createWith = asRecord(needs.createWith)
    expect(createWith.tool).toBe("api-connector__connector_adapter_save")
    expect(String(saved.next)).toContain("LOADED: api-connector__connector_adapter_save")
    expect(asRecord(asRecord(createWith.params).adapter).baseUrl).toBe(
      "https://northwind.atlassian.net",
    )

    // The adapter save, exactly as handed: it parks for a person's approval.
    const staged = asRecord(await model.call(String(createWith.tool), asRecord(createWith.params)))
    const requestId = String(staged.approvalRequestId ?? "")
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    await approve(requestId)
    const result = await approvedResult(threadId, requestId)
    expect(result.saved).toBe(true)
    const askWith = asRecord(result.askWith)
    expect(askWith).toEqual(asRecord(needs.thenCredentials))

    // The credentials card, from the call the results named.
    const card = asRecord(await model.call(String(askWith.tool), asRecord(askWith.params)))
    expect(card.error).toBeUndefined()
    expect(await pendingSecretRequest("jira")).toBe(true)

    // The person enters them on the card; the agent then tests a read, found by name.
    await personSavesCredentials("jira", { username: "nadia@northwind.test", password: "tok" })
    const select = await model.call("kernel__tool_search", {
      query: "select:api-connector__connector_adapter_test",
    })
    expect(loadedBy(select, "connector_adapter_test")).toBeDefined()
    const test = asRecord(
      await model.call("api-connector__connector_adapter_test", {
        identifier: "jira",
        operation: "list_projects",
      }),
    )
    expect(test.ok).toBe(true)
    expect(String(test.items)).toContain("NWA")
    expect(upstream).toContain("northwind.atlassian.net/rest/api/3/project/search")
  }, 120_000)

  it("HubSpot: from 'connect our HubSpot' to the adapter save, the card and a test call", async () => {
    await freshWorkspace("hubspot")
    const threadId = await minimal.thread(ORG, ADMIN)
    const model = new ScriptedModel(threadId, actor())

    // An empty connector list says how a system is connected.
    const ops = await model.call("kernel__tool_search", {
      query: "select:api-connector__connector_list_operations",
    })
    expect(loadedBy(ops, "connector_list_operations")).toBeDefined()
    const empty = asRecord(await model.call("api-connector__connector_list_operations", {}))
    expect(String(empty.next)).toContain("api-connector__connector_adapter_save")

    // The person's own words find the adapter save, ahead of the MCP manager.
    for (const query of ["connect hubspot crm", "hubspot integration", "connect our CRM"]) {
      const found = asRecord(
        await new ScriptedModel(threadId, actor()).call("kernel__tool_search", { query }),
      )
      const names = (found.matches as Array<{ name: string }>).map((m) => m.name)
      expect(names[0]).toBe("api-connector__connector_adapter_save")
    }
    const search = await model.call("kernel__tool_search", { query: "connect our CRM" })
    const save = loadedBy(search, "connector_adapter_save")
    expect(save).toBe("api-connector__connector_adapter_save")

    // Its description sends it to the guide first; one select loads it.
    const guideSearch = await model.call("kernel__tool_search", {
      query: "select:api-connector__connector_adapter_reference",
    })
    expect(loadedBy(guideSearch, "connector_adapter_reference")).toBeDefined()
    const guide = asRecord(await model.call("api-connector__connector_adapter_reference", {}))
    expect(String(guide.text)).toContain("request_secret")

    // The model's own adapter, from the guide and HubSpot's docs.
    const staged = asRecord(
      await model.call(save ?? "", {
        identifier: "hubspot",
        adapter: {
          id: "hubspot",
          name: "HubSpot",
          version: "1",
          baseUrl: "https://api.hubapi.com",
          auth: { type: "bearer" },
          operations: [
            {
              name: "list_contacts",
              description: "Contacts with their email and first name.",
              kind: "read",
              method: "GET",
              path: "/crm/v3/objects/contacts",
              params: { type: "object", properties: {} },
              items: "/results",
              fields: ["id", "properties.email", "properties.firstname"],
            },
          ],
        },
      }),
    )
    const requestId = String(staged.approvalRequestId ?? "")
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    await approve(requestId)
    const result = await approvedResult(threadId, requestId)
    expect(result.saved).toBe(true)
    const askWith = asRecord(result.askWith)
    expect(askWith.tool).toBe("kernel__request_secret")

    // request_secret is deferred: the result named it, one select loads it.
    if (!model.visible().has(String(askWith.tool))) {
      const sel = await model.call("kernel__tool_search", { query: `select:${askWith.tool}` })
      expect(loadedBy(sel, "request_secret")).toBeDefined()
    }
    const card = asRecord(await model.call(String(askWith.tool), asRecord(askWith.params)))
    expect(card.error).toBeUndefined()
    expect(await pendingSecretRequest("hubspot")).toBe(true)

    await personSavesCredentials("hubspot", { token: "pat-na1-fake-token" })
    const testSearch = await model.call("kernel__tool_search", {
      query: "select:api-connector__connector_adapter_test",
    })
    expect(loadedBy(testSearch, "connector_adapter_test")).toBeDefined()
    const test = asRecord(
      await model.call("api-connector__connector_adapter_test", {
        identifier: "hubspot",
        operation: "list_contacts",
      }),
    )
    expect(test.ok).toBe(true)
    expect(String(test.items)).toContain("ana@acme.example")
  }, 120_000)
})

describe("tool_search drops words only when what is left names a tool", () => {
  async function loads(query: string): Promise<string[]> {
    const result = await new ScriptedModel(await minimal.thread(ORG, ADMIN), actor()).call(
      "kernel__tool_search",
      { query },
    )
    const note = String(asRecord(result).note ?? "")
    return note.match(/LOADED: ([^.]+)\./)?.[1]?.split(", ") ?? []
  }

  it("loads the tool a person's words name, filler and a vendor's name aside", async () => {
    await freshWorkspace("search")
    for (const query of ["connect our crm", "connect hubspot", "integration with our erp"]) {
      expect(await loads(query)).toEqual(["api-connector__connector_adapter_save"])
    }
    // A dropped word that is a person's name, not a system, still lets the tool
    // the kept words name win over the connector it credits.
    expect(await loads("send maria a connect link")).toContain("kernel__connect_link_send")
    // An installed app's name is the argument of the kernel tool, never a word to drop.
    expect(await loads("turn the projects app off")).toContain("kernel__apps_set_enabled")
  })

  it("loads nothing for words that only brush descriptions", async () => {
    await freshWorkspace("search-noise")
    rememberOrgAppStates(ORG, [{ app: "social", status: "disabled" }])
    try {
      expect(await loads("post to facebook")).toEqual([])
      expect(await loads("what can you do")).toEqual([])
    } finally {
      forgetOrgApps(ORG)
    }
  })
})
