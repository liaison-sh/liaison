// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8: A SECRET TYPED INTO A CARD REACHES ITS STORE AND NOWHERE ELSE.
//
// For every kind, the whole flow runs on the real seams: an agent turn (the
// model stubbed at the provider boundary, nothing else) calls request_secret;
// the person reads the card, posts a sentinel secret to the target's own
// route, completes the card; the agent's follow-up turn runs off the saved
// line. Then every place a secret could leak is searched for the sentinel:
// the conversation's messages (content and metadata, the agent message's
// tool-call metadata included), approval rows, the audit log, the outbox and
// every event published (what becomes a websocket frame), every log line, and
// everything the model was shown.
//
// The discriminator: an agent that passes a secret as a tool parameter (here,
// a key label) must be FOUND by the same search. A checker that cannot see a
// planted copy proves nothing.
//
// A connect card (`oauth_connect`) types no secret: the person signs in at the
// provider, here a local fake one. Its authorization code and the tokens it
// hands out are searched for the same way.
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (_app: string, jobName: string, payload: Record<string, unknown>) => {
    enqueued.push({ jobName, payload })
    return "job-id"
  },
}))
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const crypto = await import("node:crypto")
const { and, eq } = await import("drizzle-orm")
const pino = (await import("pino")).default
const { app } = await import("~/app")
const { sql } = await import("~/db")
const { withPrivilegedDb } = await import("~/db/privileged")
const { agents, threadParticipants, threads } = await import("~/db/schema/kernel")
const eventBus = await import("~/infra/events/event-bus")
const { registerEventSubscribers } = await import("~/infra/events/event-subscribers")
const { processOutboxBatch } = await import("~/infra/events/outbox-worker")
const { rootLogger } = await import("~/lib/logger")
const { AgentServiceTestAccess, runAgentChat } = await import(
  "~/modules/agent/runtime/agent-service"
)
const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
const { ensureAppsForOrg } = await import("~/modules/apps/init")
const { registerApiConnectorApp, saveAdapterForTest } = await import(
  "~/modules/apps/connections/api/app.test-helpers"
)
const { redis } = await import("~/lib/redis")
const { setMailProviderEnabled } = await import("~/modules/mail/provider-settings")
const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
const { runSecretRequestTurn } = await import("~/modules/secret-requests/announce")
const minimal = await import("~/seed/tiers/minimal")
const { createTestOrg } = await import("~/tests/helpers/org")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

type Json = Record<string, any>

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-secret-leak"
const realFetch = globalThis.fetch

/** One sentinel per kind: unmistakable, and each a valid value for its route. */
const S = {
  byok: `sk-or-LEAKSENTINEL-byok-${crypto.randomUUID()}`,
  gitlab: `glpat-LEAKSENTINEL-${crypto.randomUUID()}`,
  oauth: `LEAKSENTINEL-oauth-${crypto.randomUUID()}`,
  google: `LEAKSENTINEL-google-${crypto.randomUUID()}`,
  connector: `LEAKSENTINEL-crm-${crypto.randomUUID()}`,
  /** The provider's authorization code and the tokens it exchanges it for. */
  code: `LEAKSENTINEL-code-${crypto.randomUUID()}`,
  access: `LEAKSENTINEL-access-${crypto.randomUUID()}`,
  refresh: `LEAKSENTINEL-refresh-${crypto.randomUUID()}`,
}
const PLANTED = `LEAKSENTINEL-planted-${crypto.randomUUID()}`

let orgId: string
let adminId: string
let adminToken: string
let threadId: string
let agentId: string

/** Everything the model was shown, every turn. */
const modelInputs: string[] = []
/** Every log line written. */
const logLines: string[] = []
/** Spies on every event published on the bus (the source of every websocket frame). */
const publishSpies: Array<{ mock: { calls: unknown[][] } }> = []

/** A model that calls the given tools in order, then says "ok"; it records what it was shown. */
function model(calls: Array<{ toolName: string; input: unknown }>) {
  return (opts: { system?: unknown; messages?: unknown; tools?: Record<string, Json> }) => {
    modelInputs.push(JSON.stringify({ system: opts.system, messages: opts.messages }))
    return {
      fullStream: (async function* () {
        for (const [i, call] of calls.entries()) {
          const execute = opts.tools?.[call.toolName]?.execute
          if (typeof execute !== "function") throw new Error(`${call.toolName} is not offered`)
          const toolCallId = `call-leak-${crypto.randomUUID()}-${i}`
          yield { type: "tool-call", toolCallId, toolName: call.toolName, input: call.input }
          const output = await execute(call.input, { toolCallId, messages: [] })
          yield {
            type: "tool-result",
            toolCallId,
            toolName: call.toolName,
            input: call.input,
            output,
          }
        }
        yield { type: "text-delta", text: "ok" }
        yield {
          type: "finish-step",
          usage: { inputTokens: 10, outputTokens: 1 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
    }
  }
}

function providerAnswers(status: number): typeof fetch {
  return Object.assign(async () => new Response("{}", { status }), {
    preconnect: realFetch.preconnect,
  })
}

async function actor() {
  const perms = await withPrivilegedDb(orgId, "test-leak-perms", (tx) =>
    loadEffectivePermissions(tx, adminId, orgId),
  )
  return {
    actorType: "user" as const,
    userId: adminId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

/** One agent turn calling request_secret; returns the request id. */
async function agentAsks(kind: string, target: Json): Promise<string> {
  AgentServiceTestAccess.setStreamText(
    model([{ toolName: "kernel__request_secret", input: { kind, target } }]) as never,
  )
  const result = await runAgentChat({
    threadId,
    content: `please set up ${kind}`,
    actor: await actor(),
    orgId,
    seedDiscoveredTools: new Set(["kernel__request_secret"]),
  })
  const toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = []
  const toolResults: Array<{ toolCallId: string; result: unknown }> = []
  for await (const chunk of result.fullStream as AsyncIterable<Json>) {
    if (chunk.type === "tool-call") {
      toolCalls.push({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, args: chunk.input })
    }
    if (chunk.type === "tool-result") {
      toolResults.push({ toolCallId: chunk.toolCallId, result: chunk.output })
    }
  }
  await result.finalize({
    usage: { promptTokens: 10, completionTokens: 1 },
    finishReason: "stop",
    text: "ok",
    steps: [{ toolCalls, toolResults }],
  })
  const out = toolResults[0]?.result as Json | undefined
  if (typeof out?.requestId !== "string") throw new Error(`no request: ${JSON.stringify(out)}`)
  return out.requestId
}

async function call(path: string, method = "GET", body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Json,
    text,
    /** A connect's browser binding, which the callback must present. */
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  }
}

/** The person's side: read the card, store the secret, complete; then the agent's turn. */
async function personSaves(
  requestId: string,
  store: () => Promise<{ status: number }>,
): Promise<string> {
  const card = await call(`/api/secret-requests/${requestId}`)
  expect(card.status).toBe(200)
  expect(card.body.data.canSubmit).toBe(true)
  const stored = await store()
  expect(stored.status).toBeLessThan(300)
  const done = await call(`/api/secret-requests/${requestId}/complete`, "POST")
  expect(done.status).toBe(200)
  expect(done.body.data.status).toBe("saved")
  const job = enqueued.find((j) => j.payload.secretRequestId === requestId)
  if (!job) throw new Error("no follow-up turn was enqueued")
  AgentServiceTestAccess.setStreamText(model([]) as never)
  const before = modelInputs.length
  const payload = job.payload
  const ran = await runSecretRequestTurn({
    orgId: String(payload.orgId),
    threadId: String(payload.threadId),
    messageId: String(payload.messageId),
    requesterId: String(payload.requesterId),
    agentId: String(payload.agentId),
    secretRequestId: String(payload.secretRequestId),
  })
  expect(ran).toBe(true)
  // The follow-up turn saw the saved line.
  const seen = modelInputs.slice(before).join("\n")
  expect(seen).toMatch(/(saved|connected) by/)
  return card.text + done.text
}

/** Every place a secret could have leaked, as text, by source. */
async function leakSurfaces(): Promise<Record<string, string>> {
  for (let i = 0; i < 6; i++) await processOutboxBatch()
  const rows = async (q: Promise<Json[]>) => JSON.stringify(await q)
  return {
    messages: await rows(
      sql`SELECT content, metadata FROM kernel.messages WHERE org_id = ${orgId}`,
    ),
    approvals: await rows(
      sql`SELECT row_to_json(a) AS r FROM kernel.approval_requests a WHERE org_id = ${orgId}`,
    ),
    audit: await rows(
      sql`SELECT row_to_json(a) AS r FROM kernel.audit_log a WHERE org_id = ${orgId}`,
    ),
    outbox: await rows(
      sql`SELECT row_to_json(p) AS r FROM kernel.pending_events p WHERE org_id = ${orgId}`,
    ),
    secretRequests: await rows(
      sql`SELECT row_to_json(s) AS r FROM kernel.secret_requests s WHERE org_id = ${orgId}`,
    ),
    published: publishSpies.map((spy) => JSON.stringify(spy.mock.calls)).join("\n"),
    logs: logLines.join("\n"),
    model: modelInputs.join("\n"),
  }
}

function whereFound(surfaces: Record<string, string>, needle: string): string[] {
  return Object.entries(surfaces)
    .filter(([, text]) => text.includes(needle))
    .map(([name]) => name)
}

describe("S8: a secret typed into the card is stored and found nowhere else", () => {
  let restoreLog: () => void = () => undefined
  const responses: string[] = []

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    adminId = (await minimal.person(orgId, { role: "admin" })).id
    adminToken = await minimal.token(adminId)
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Secret Leak', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    const seeded = await withPrivilegedDb(orgId, "test-leak-seed", async (tx) => {
      // The admin's own personal agent (registration made it), uncapped.
      const [agent] = await tx
        .update(agents)
        .set({ scopeCeiling: ["*"] })
        .where(and(eq(agents.ownerUserId, adminId), eq(agents.kind, "personal")))
        .returning({ id: agents.id })
      if (!agent) throw new Error("the admin has no personal agent")
      const [thread] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `leak-${crypto.randomUUID().slice(0, 8)}`,
          type: "agent_chat",
          createdBy: adminId,
        })
        .returning({ id: threads.id })
      await tx.insert(threadParticipants).values({ threadId: thread.id, userId: adminId, orgId })
      return { agentId: agent.id, threadId: thread.id }
    })
    agentId = seeded.agentId
    threadId = seeded.threadId
    await ensureAppsForOrg(orgId)
    await registerApiConnectorApp(orgId)
    await registerKernelAgentTools(orgId)

    eventBus.resetEventBus()
    eventBus.initEventBus()
    registerEventSubscribers()
    // Called through: the audit subscriber still writes what it writes.
    publishSpies.push(spyOn(eventBus, "_publishEventInternal"))
    publishSpies.push(spyOn(eventBus, "broadcastEphemeral"))

    const stream: unknown = Reflect.get(rootLogger, pino.symbols.streamSym)
    if (!stream || typeof stream !== "object" || !("write" in stream)) {
      throw new Error("the root logger has no stream to capture")
    }
    const original = stream.write
    if (typeof original !== "function") throw new Error("the root logger stream cannot write")
    Reflect.set(stream, "write", (chunk: unknown) => {
      logLines.push(String(chunk))
      return Reflect.apply(original, stream, [chunk])
    })
    restoreLog = () => Reflect.set(stream, "write", original)

    // The connector the agent asks credentials for.
    const adapter = await saveAdapterForTest(orgId, "crm", {
      id: "crm",
      name: "Example CRM",
      version: "1.0.0",
      baseUrl: "https://crm.example.com/api",
      auth: { type: "bearer" },
      operations: [
        {
          name: "find_customer",
          description: "Find companies by contact email.",
          kind: "read",
          method: "GET",
          path: "/companies",
          params: { type: "object", properties: { email: { type: "string" } } },
          query: { email: "{email}" },
          items: "/data",
          fields: ["id", "name"],
          role: "customer.lookup",
        },
      ],
    })
    expect(adapter.status).toBe(200)

    // The whole flow, once per kind.
    globalThis.fetch = providerAnswers(200)
    try {
      const byok = await agentAsks("byok", { provider: "openrouter" })
      responses.push(
        await personSaves(byok, () =>
          call("/api/settings/ai/keys", "POST", { provider: "openrouter", apiKey: S.byok }),
        ),
      )
    } finally {
      globalThis.fetch = realFetch
    }
    const gitlab = await agentAsks("connection_credentials", {
      app: "gitlab",
      connection: "gitlab",
    })
    responses.push(
      await personSaves(gitlab, () =>
        call("/api/connections/gitlab/gitlab/credentials", "POST", {
          mode: "org",
          credentials: { token: S.gitlab, group: "acme" },
        }),
      ),
    )
    const oauth = await agentAsks("oauth_client", { app: "google-drive", connection: "drive" })
    responses.push(
      await personSaves(oauth, () =>
        call("/api/connections/google-drive/drive/oauth-client", "PUT", {
          clientId: "client-1234567.example",
          clientSecret: S.oauth,
        }),
      ),
    )
    const google = await agentAsks("google_integration_client", {})
    responses.push(
      await personSaves(google, () =>
        call("/api/settings/integrations/google", "PATCH", {
          clientId: "998877-abcdefg.apps.googleusercontent.com",
          clientSecret: S.google,
        }),
      ),
    )
    // A connect card: the person's own Gmail, through a local fake provider.
    // The flow starts against the real https endpoint; the stored state's
    // token URL (the only one the callback reads) points at the fake one.
    const fakeProvider = Bun.serve({
      port: 0,
      async fetch(request) {
        const form = new URLSearchParams(await request.text())
        if (form.get("code") !== S.code) return new Response("{}", { status: 400 })
        const claims = Buffer.from(JSON.stringify({ email: "owner@example.com" })).toString(
          "base64url",
        )
        return Response.json({
          access_token: S.access,
          refresh_token: S.refresh,
          expires_in: 3600,
          id_token: `e30.${claims}.`,
        })
      },
    })
    try {
      await setMailProviderEnabled(orgId, "gmail", true)
      const connect = await agentAsks("oauth_connect", {
        app: "mail",
        connection: "gmail",
        mode: "personal",
      })
      responses.push(
        await personSaves(connect, async () => {
          const started = await call(`/api/secret-requests/${connect}/authorize`, "POST", {})
          const redirect = new URL(String(started.body.data?.redirectUrl))
          const state = redirect.searchParams.get("state") ?? ""
          const key = `oauth:state:${state}`
          const record = JSON.parse((await redis.get(key)) ?? "{}")
          await redis.set(
            key,
            JSON.stringify({ ...record, tokenUrl: `http://127.0.0.1:${fakeProvider.port}/token` }),
            "EX",
            600,
          )
          const res = await app.request(
            `/api/connections/callback?code=${S.code}&state=${encodeURIComponent(state)}`,
            { headers: { Cookie: started.cookie } },
          )
          expect(res.status).toBe(302)
          expect(res.headers.get("location")).toContain("result=connected")
          return { status: started.status }
        }),
      )
    } finally {
      fakeProvider.stop(true)
    }
    const crm = await agentAsks("api_connector_credentials", { identifier: "crm" })
    responses.push(
      await personSaves(crm, () =>
        call("/api/connections/api-connector/api/credentials", "POST", {
          mode: "org",
          credentials: { identifier: "crm", token: S.connector },
        }),
      ),
    )
    // A minted key: the person creates it; the plaintext is in that one response only.
    const keyRequest = await agentAsks("api_key", { label: "Website form" })
    let mintedKey = ""
    responses.push(
      await personSaves(keyRequest, async () => {
        const minted = await call("/api/apps/run-tool", "POST", {
          toolName: "tickets:apiKeys.create",
          params: { label: "Website form" },
        })
        mintedKey = String(minted.body.data?.key ?? "")
        return minted
      }),
    )
    expect(mintedKey.length).toBeGreaterThan(8)
    Object.assign(S, { minted: mintedKey })

    // The discriminator: an agent that passes a secret as a parameter.
    await agentAsks("api_key", { label: PLANTED })
  }, 300_000)

  afterAll(async () => {
    restoreLog()
    eventBus.resetEventBus()
    AgentServiceTestAccess.setStreamText()
    globalThis.fetch = realFetch
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  it("the search sees a secret an agent passed as a parameter (the discriminator)", async () => {
    const found = whereFound(await leakSurfaces(), PLANTED)
    // The agent message's tool-call metadata, and the frames that carried it.
    expect(found).toContain("messages")
    expect(found).toContain("published")
  })

  it("every flow saved, and the conversation and the agent heard it", async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.secret_requests
      WHERE org_id = ${orgId} AND status = 'saved' AND agent_id = ${agentId}`
    expect(row.n).toBe(7)
    // The searched surfaces are not empty: the audit log and the outbox saw the flows.
    const surfaces = await leakSurfaces()
    expect(surfaces.audit).not.toBe("[]")
    expect(surfaces.published.length).toBeGreaterThan(100)
    expect(surfaces.logs.length).toBeGreaterThan(100)
    const lines = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE org_id = ${orgId} AND metadata->>'type' = 'secret-request-result'`
    expect(lines[0].n).toBe(7)
  })

  for (const name of [
    "byok",
    "gitlab",
    "oauth",
    "google",
    "connector",
    "minted",
    "code",
    "access",
    "refresh",
  ] as const) {
    it(`the ${name} secret is in no message, approval, audit row, event, log line or model input`, async () => {
      const secret = (S as Record<string, string>)[name]
      expect(secret?.length ?? 0).toBeGreaterThan(8)
      expect(whereFound(await leakSurfaces(), secret)).toEqual([])
      // Nor in what the card's own routes answered.
      expect(responses.join("\n")).not.toContain(secret)
    })
  }
})
