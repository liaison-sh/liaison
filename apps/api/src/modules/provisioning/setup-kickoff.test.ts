// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first run: a new workspace's first administrator signs in and their
// agent conversation gets the "Set up your space" card, pinned for them. It is
// posted once per workspace, never in a demo workspace, never in a workspace
// where somebody already wrote (so a deploy kicks off nobody), never for a
// member, a device session or a session still enrolling its second factor.
// Sign-in never waits for it and never fails because of it.
//
// Real database and real sign-in route; the model is stubbed at the provider
// boundary and the job queue is captured so each job runs here, in order.
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"

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
const { app } = await import("~/app")
const { sql } = await import("~/db")
const { withPrivilegedDb, withSystemDb } = await import("~/db/privileged")
const { withRlsContext } = await import("~/db/rls")
const schema = await import("~/db/schema/kernel")
const { env } = await import("~/lib/env")
const { ENV_KEY_MAP } = await import("~/modules/agent/credits/platform-key-env")
const { SETUP_KICKOFF_LINE } = await import("~/modules/agent/context/system-event-replay")
const { getOrCreatePersonalAgentId } = await import("~/modules/agent/directory/personal-agent")
const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
const { createSession } = await import("~/modules/auth/auth")
const { markOrgAsDemo, reservedMarker, visitorMarker } = await import("~/modules/demo/demo-org")
const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
const { runSetupKickoff, SETUP_KICKOFF_JOB, SetupKickoffTestAccess } = await import(
  "~/modules/provisioning/setup-kickoff"
)
const { runSecretRequestTurn } = await import("~/modules/secret-requests/announce")
const { ensureOrg } = await import("~/modules/provisioning/ensure-org")
const { ensureUser } = await import("~/modules/provisioning/ensure-user")
const { sendMessage } = await import("~/modules/threads/message")
const { countThreadUnread } = await import("~/modules/threads/thread-state")
const { createThread } = await import("~/modules/threads/thread")
const minimal = await import("~/seed/tiers/minimal")
const { createTestOrg } = await import("~/tests/helpers/org")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

type Json = Record<string, unknown>

const PASSWORD = "Passw0rd!"
const MODEL_ID = "claude-haiku-4-5-setup-kickoff"
const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}
const savedKickoff = env.LIAISON_SETUP_KICKOFF
/** Everything the stubbed model was shown. */
const modelInputs: string[] = []

/** A model that says "ok" and records what it was shown. */
function model() {
  return (opts: { system?: unknown; messages?: unknown }) => {
    modelInputs.push(JSON.stringify({ system: opts.system, messages: opts.messages }))
    return {
      fullStream: (async function* () {
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

function clearModelKeys(): void {
  for (const name of Object.values(ENV_KEY_MAP)) delete process.env[name]
}

function giveModelKey(): void {
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
}

/** A fresh workspace whose admin has never signed in through the route. */
async function freshOrg(): Promise<{ orgId: string; adminId: string; email: string }> {
  const email = `first-admin-${crypto.randomUUID()}@acme.example`
  // Registration itself signs the admin in: the hook stays off until the
  // workspace exists, so each test starts from the sign-in it is about.
  env.LIAISON_SETUP_KICKOFF = false
  const { id: orgId } = await createTestOrg({ email, password: PASSWORD })
  // The registration's own check runs in the background: let it see "off".
  await new Promise((r) => setTimeout(r, 200))
  env.LIAISON_SETUP_KICKOFF = true
  enqueued.length = 0
  const [admin] = await sql<Array<{ id: string }>>`
    SELECT id FROM kernel.users WHERE org_id = ${orgId} AND email = ${email}`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${orgId}, '10.00000000', '0', 'EUR')
    ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
  // Registration clears the model catalog with the org tables: the stubbed
  // model's row goes back each time.
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Setup Kickoff', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT DO NOTHING`
  return { orgId, adminId: admin!.id, email }
}

async function signIn(email: string): Promise<Response> {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
}

/** Wait for the sign-in's background check to settle (or prove it never enqueues). */
async function settle(orgId: string, ms = 1500): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (SetupKickoffTestAccess.settledOrgs.has(orgId)) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

function kickoffJobs(orgId: string) {
  return enqueued.filter((j) => j.jobName === SETUP_KICKOFF_JOB && j.payload.orgId === orgId)
}

async function kickoffRows(orgId: string) {
  return sql<
    Array<{
      id: string
      thread_id: string
      metadata: Json
      content: string
      author_type: string
      author_agent_id: string | null
    }>
  >`
    SELECT id, thread_id, metadata, content, author_type, author_agent_id FROM kernel.messages
    WHERE org_id = ${orgId} AND metadata->>'type' = 'setup-kickoff'`
}

async function actorFor(orgId: string, userId: string) {
  const perms = await withPrivilegedDb(orgId, "test-kickoff-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

beforeAll(async () => {
  await acquireTestLock()
  for (const name of [...Object.values(ENV_KEY_MAP), "LIAISON_DEMO_URL"]) {
    savedEnv[name] = process.env[name]
  }
  AgentServiceTestAccess.setStreamText(model() as never)
})

beforeEach(() => {
  clearModelKeys()
  enqueued.length = 0
  modelInputs.length = 0
  SetupKickoffTestAccess.reset()
})

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  env.LIAISON_SETUP_KICKOFF = savedKickoff
  SetupKickoffTestAccess.reset()
  globalThis.fetch = realFetch
  await releaseTestLock()
})

describe("the first admin sign-in opens the setup conversation", () => {
  it("posts one pinned card in the admin's agent conversation, with the key card when no key is usable; saving the key wakes the agent", async () => {
    const { orgId, adminId, email } = await freshOrg()
    const res = await signIn(email)
    expect(res.status).toBe(200)
    await settle(orgId)
    expect(kickoffJobs(orgId)).toHaveLength(1)
    const payload = kickoffJobs(orgId)[0]!.payload as { orgId: string; userId: string }
    expect(payload.userId).toBe(adminId)

    // The job enqueued twice (two sign-ins racing): one card.
    const [a, b] = await Promise.all([runSetupKickoff(payload), runSetupKickoff(payload)])
    expect([a.posted, b.posted].filter(Boolean)).toHaveLength(1)
    const rows = await kickoffRows(orgId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    const meta = row.metadata as Json
    expect(meta.demoUrl).toBe("https://demo.liaison.sh")
    expect((meta.state as Json).next).toBe("aiKey")
    expect(row.content).toContain("Set up your space")

    // In the admin's ONE conversation with their personal agent.
    const agentId = await withPrivilegedDb(orgId, "test-agent", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId, userId: adminId }),
    )
    expect(meta.agentId).toBe(agentId)
    // Posted by the admin's agent, under its "{name}'s agent" identity, so the
    // conversation reads unread for the admin and leads them to it.
    expect(row.author_type).toBe("agent")
    expect(row.author_agent_id).toBe(agentId)
    expect(meta.agentAuthorLabel).toBe("A's agent")
    const unread = await withRlsContext(await actorFor(orgId, adminId), (tx) =>
      countThreadUnread(tx, { userId: adminId, threadId: row.thread_id }),
    )
    expect(unread).toBe(1)
    const chats = await sql<Array<{ id: string; is_pinned: boolean; title: string | null }>>`
      SELECT t.id, t.is_pinned, t.title FROM kernel.threads t
      JOIN kernel.thread_participants p ON p.thread_id = t.id AND p.agent_id = ${agentId}
      WHERE t.org_id = ${orgId} AND t.type = 'agent_chat'`
    expect(chats.map((c) => c.id)).toEqual([row.thread_id])
    expect(chats[0]!.is_pinned).toBe(false)
    expect(chats[0]!.title).toBeNull()
    const pins = await sql<Array<{ user_id: string; is_pinned: boolean }>>`
      SELECT user_id, is_pinned FROM kernel.user_thread_state WHERE thread_id = ${row.thread_id}`
    expect([...pins]).toEqual([{ user_id: adminId, is_pinned: true }])

    // No key: the key card is part of the card, owned by the admin; no turn ran.
    expect(typeof meta.secretRequestId).toBe("string")
    const [request] = await sql<Array<Json>>`
      SELECT kind, target, status, requested_by, agent_id, thread_id FROM kernel.secret_requests
      WHERE id = ${String(meta.secretRequestId)}`
    expect(request).toMatchObject({
      kind: "byok",
      status: "pending",
      requested_by: adminId,
      agent_id: agentId,
      thread_id: row.thread_id,
    })
    expect(modelInputs).toHaveLength(0)

    // A re-login and a second admin: still one card, not even a probe enqueued.
    expect((await signIn(email)).status).toBe(200)
    const second = await minimal.person(orgId, { role: "admin" })
    SetupKickoffTestAccess.settledOrgs.clear()
    expect((await signIn(second.email)).status).toBe(200)
    await settle(orgId)
    expect(kickoffJobs(orgId)).toHaveLength(1)
    expect(await kickoffRows(orgId)).toHaveLength(1)

    // The person saves the key on the card: the agent's turn runs off the
    // saved line and reads the kickoff line in its transcript.
    giveModelKey()
    await registerKernelAgentTools(orgId)
    const token = await minimal.token(adminId)
    const call = async (path: string, method: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    globalThis.fetch = Object.assign(async () => new Response("{}", { status: 200 }), {
      preconnect: realFetch.preconnect,
    })
    try {
      const stored = await call("/api/settings/ai/keys", "POST", {
        provider: "openrouter",
        apiKey: `sk-or-v1-${crypto.randomUUID()}`,
      })
      expect(stored.status).toBeLessThan(300)
    } finally {
      globalThis.fetch = realFetch
    }
    // Saved in Settings (or by the card, which posts to the same route): the
    // pending key request completes on the save itself and wakes the agent.
    const [settled] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.secret_requests WHERE id = ${String(meta.secretRequestId)}`
    expect(settled?.status).toBe("saved")
    // The card's own completion call after that save still reads "saved".
    const done = await call(`/api/secret-requests/${String(meta.secretRequestId)}/complete`, "POST")
    expect(done.status).toBe(200)
    const lines = await sql`SELECT id FROM kernel.messages
      WHERE org_id = ${orgId} AND metadata->>'type' = 'secret-request-result'`
    expect(lines).toHaveLength(1)
    const turn = enqueued.find((j) => j.payload.secretRequestId === meta.secretRequestId)
    expect(turn?.jobName).toBe("secret-request-turn")
    expect(turn?.payload.agentId).toBe(agentId)
    const ran = await runSecretRequestTurn({
      orgId,
      threadId: String(turn!.payload.threadId),
      messageId: String(turn!.payload.messageId),
      requesterId: String(turn!.payload.requesterId),
      agentId: String(turn!.payload.agentId),
      secretRequestId: String(turn!.payload.secretRequestId),
    })
    expect(ran).toBe(true)
    const seen = modelInputs.join("\n")
    expect(seen).toContain(SETUP_KICKOFF_LINE.slice(0, 40))
    expect(seen).toContain("saved by")
  }, 120_000)

  it("with a usable key the agent's own first turn follows the card", async () => {
    const { orgId, email } = await freshOrg()
    giveModelKey()
    await registerKernelAgentTools(orgId)
    expect((await signIn(email)).status).toBe(200)
    await settle(orgId)
    const job = kickoffJobs(orgId)[0]
    expect(job).toBeDefined()
    const result = await runSetupKickoff(job!.payload as { orgId: string; userId: string })
    expect(result).toMatchObject({ posted: true, turnStarted: true })
    const [row] = await kickoffRows(orgId)
    expect((row!.metadata as Json).secretRequestId).toBeUndefined()
    expect(modelInputs.join("\n")).toContain(SETUP_KICKOFF_LINE.slice(0, 40))
  }, 60_000)

  it("an org made by config apply gets it on its admin's first sign-in", async () => {
    // Registration made the instance's first org; config apply makes the next.
    await freshOrg()
    const slug = `cfg-${crypto.randomUUID().slice(0, 8)}`
    const { orgId } = await ensureOrg({ slug, name: "Config Applied" })
    const email = `cfg-admin-${crypto.randomUUID()}@acme.example`
    await ensureUser({ orgId, email, name: "Cora", password: PASSWORD, role: "admin" })
    expect((await signIn(email)).status).toBe(200)
    await settle(orgId)
    expect(kickoffJobs(orgId)).toHaveLength(1)
    const result = await runSetupKickoff(
      kickoffJobs(orgId)[0]!.payload as {
        orgId: string
        userId: string
      },
    )
    expect(result.posted).toBe(true)
  }, 60_000)

  it("an org whose only messages were imported still gets it", async () => {
    const { orgId, adminId, email } = await freshOrg()
    const actor = await actorFor(orgId, adminId)
    const thread = await withRlsContext(actor, (tx) =>
      createThread(tx, { orgId, userId: adminId, participantIds: [], title: "Imported" }),
    )
    await withSystemDb("test-imported-message", (db) =>
      db.insert(schema.messages).values({
        orgId,
        threadId: thread!.id,
        authorId: adminId,
        authorType: "user",
        content: "From the old tool",
        requiredScopes: [],
        externalRef: `slack:${crypto.randomUUID()}`,
      }),
    )
    expect((await signIn(email)).status).toBe(200)
    await settle(orgId)
    expect(kickoffJobs(orgId)).toHaveLength(1)
  }, 60_000)
})

describe("nobody else gets it", () => {
  it("a workspace where somebody already wrote (an existing org on deploy) gets none", async () => {
    const { orgId, adminId, email } = await freshOrg()
    const actor = await actorFor(orgId, adminId)
    await withRlsContext(actor, async (tx) => {
      const thread = await createThread(tx, {
        orgId,
        userId: adminId,
        participantIds: [],
        title: "General",
      })
      await sendMessage(tx, {
        requiredScopes: [],
        orgId,
        userId: adminId,
        threadId: thread!.id,
        content: "Hello team",
      })
    })
    expect((await signIn(email)).status).toBe(200)
    await settle(orgId)
    expect(SetupKickoffTestAccess.settledOrgs.has(orgId)).toBe(true)
    expect(kickoffJobs(orgId)).toHaveLength(0)
    expect((await runSetupKickoff({ orgId, userId: adminId })).posted).toBe(false)
    expect(await kickoffRows(orgId)).toHaveLength(0)
  }, 60_000)

  it("an established org that never used chat (mail and tickets only) gets none", async () => {
    const { orgId, adminId, email } = await freshOrg()
    await sql`UPDATE kernel.organizations SET created_at = now() - interval '30 days'
      WHERE id = ${orgId}`
    await withSystemDb("test-old-mailbox", (db) =>
      db.insert(schema.connectedAccounts).values({
        orgId,
        appName: "mail",
        connectionName: "imap",
        ownerType: "org",
        providerType: "credentials",
        createdBy: adminId,
        identifier: `support-${crypto.randomUUID()}@acme.example`,
        status: "active",
      }),
    )
    expect((await signIn(email)).status).toBe(200)
    await settle(orgId)
    expect(kickoffJobs(orgId)).toHaveLength(0)
    expect((await runSetupKickoff({ orgId, userId: adminId })).posted).toBe(false)
  }, 60_000)

  for (const [label, marker] of [
    ["visitor", () => visitorMarker(24)],
    ["reserved", () => reservedMarker()],
  ] as const) {
    it(`a ${label} demo workspace gets none, whoever signs in`, async () => {
      const { orgId, adminId, email } = await freshOrg()
      await markOrgAsDemo(orgId, marker())
      expect((await signIn(email)).status).toBe(200)
      await settle(orgId)
      expect(kickoffJobs(orgId)).toHaveLength(0)
      // The job itself refuses too, whatever enqueued it.
      expect((await runSetupKickoff({ orgId, userId: adminId })).posted).toBe(false)
      expect(await kickoffRows(orgId)).toHaveLength(0)
    }, 60_000)
  }

  it("a member, a device session and an admin still enrolling a second factor get none", async () => {
    const { orgId, adminId, email } = await freshOrg()
    const member = await minimal.person(orgId)
    expect((await signIn(member.email)).status).toBe(200)
    await createSession(adminId, orgId, ["kernel:threads:read"])
    await sql`UPDATE kernel.organizations
      SET settings = settings || '{"requireAdminSecondFactor": true}'::jsonb WHERE id = ${orgId}`
    const pending = await createSession(adminId, orgId)
    expect(pending.accessToken).toBeTruthy()
    await settle(orgId, 500)
    expect(kickoffJobs(orgId)).toHaveLength(0)

    // The same admin's full session, once the requirement is lifted: due.
    await sql`UPDATE kernel.organizations
      SET settings = settings - 'requireAdminSecondFactor' WHERE id = ${orgId}`
    expect((await signIn(email)).status).toBe(200)
    await settle(orgId)
    expect(kickoffJobs(orgId)).toHaveLength(1)
  }, 60_000)

  it("turned off by configuration, nothing happens", async () => {
    const { orgId, email } = await freshOrg()
    env.LIAISON_SETUP_KICKOFF = false
    try {
      expect((await signIn(email)).status).toBe(200)
      await settle(orgId, 300)
      expect(kickoffJobs(orgId)).toHaveLength(0)
    } finally {
      env.LIAISON_SETUP_KICKOFF = true
    }
  }, 60_000)
})

describe("sign-in never waits for it and never fails because of it", () => {
  it("a check that throws, or never answers, leaves the sign-in untouched", async () => {
    const { orgId, email } = await freshOrg()
    SetupKickoffTestAccess.deps.isDue = async () => {
      throw new Error("probe exploded")
    }
    const failing = await signIn(email)
    expect(failing.status).toBe(200)
    expect(((await failing.json()) as { data?: Json }).data).toBeDefined()

    let release: () => void = () => undefined
    SetupKickoffTestAccess.deps.isDue = () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(false)
      })
    const started = Date.now()
    const hanging = await signIn(email)
    expect(hanging.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
    release()
    expect(kickoffJobs(orgId)).toHaveLength(0)
  }, 60_000)

  it("a workspace on the demo deployment itself is offered no demo (the box it is on)", async () => {
    const { orgId, adminId } = await freshOrg()
    const base = env.BASE_URL
    env.BASE_URL = "https://demo.liaison.sh"
    try {
      await runSetupKickoff({ orgId, userId: adminId })
    } finally {
      env.BASE_URL = base
    }
    const [row] = await kickoffRows(orgId)
    expect((row!.metadata as Json).demoUrl).toBeNull()
    expect(row!.content).not.toContain("demo.liaison.sh")
  })

  it("the demo offer follows the configured URL, and off leaves it out", async () => {
    const { orgId, adminId } = await freshOrg()
    env.LIAISON_DEMO_URL = "off"
    try {
      await runSetupKickoff({ orgId, userId: adminId })
    } finally {
      env.LIAISON_DEMO_URL = "https://demo.liaison.sh"
    }
    const [row] = await kickoffRows(orgId)
    expect((row!.metadata as Json).demoUrl).toBeNull()
    expect(row!.content).not.toContain("demo.liaison.sh")
    // Read through RLS by the admin, as the web reads it.
    const visible = await withRlsContext(await actorFor(orgId, adminId), (tx) =>
      tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.id, row!.id))),
    )
    expect(visible).toHaveLength(1)
  }, 60_000)
})
