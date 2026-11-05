// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T13 — subrun-worker emits `kernel:sub_run:update` ephemeral events on
// status transitions (queued→running→done|failed). Subscribing to the global
// event handler is the simplest way to assert that without spinning up a
// WebSocket. We register a handler, drive a sub-run end-to-end, and capture
// the events.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  appsActiveVersion,
  appsInstalled,
  creditBalances,
  messages as kernelMessages,
  threads as kernelThreads,
  modelPricing,
  users,
} from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { type AppEvent, initEventBus, onEvent } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { awaitSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import * as minimal from "~/seed/tiers/minimal"
import { stubStreamText } from "~/tests/helpers/agent-stub"
import { createTestOrg } from "~/tests/helpers/org"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SEEDED = seededApps()

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function userActor(orgId: string, userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function installTestApp(grantedScopes: string[]): Promise<string> {
  const appName = SEEDED.track(`wsupd-${crypto.randomUUID().slice(0, 8)}`)
  await withSystemDb("wsupd-install-app", async (db) => {
    const [admin] = await db.select({ id: users.id }).from(users).limit(1)
    if (!admin) throw new Error("no admin")
    await db.insert(appsInstalled).values({
      name: appName,
      version: "1.0.0",
      sourceUrl: `file:///tmp/${appName}.liaisonapp`,
      sha256: "0".repeat(64),
      grantedScopes,
      installedBy: admin.id,
    })
    await db
      .insert(appsActiveVersion)
      .values({ name: appName, version: "1.0.0" })
      .onConflictDoUpdate({
        target: appsActiveVersion.name,
        set: { version: "1.0.0" },
      })
  })
  return appName
}

async function makeParentThread(orgId: string, userId: string): Promise<string> {
  const [t] = await withPrivilegedDb(orgId, "wsupd-parent", async (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `pt-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  return t.id
}

async function seedPricingAndCredits(orgId: string): Promise<void> {
  await withSystemDb("wsupd-seed", async (db) => {
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5-wsupd",
        displayName: "WS Updates Haiku",
        inputCostPerM: "1.00",
        outputCostPerM: "5.00",
        contextWindow: 200000,
        autoEligible: true,
        tierMinimum: "starter",
      })
      .onConflictDoNothing()
    await db
      .insert(creditBalances)
      .values({
        orgId,
        includedBalance: "10.00000000",
        purchasedBalance: "0",
        currency: "EUR",
      })
      .onConflictDoNothing()
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-wsupd-stub"
})

afterAll(async () => {
  await SEEDED.cleanup()
  if (ORIG_ANTHROPIC_KEY !== undefined) {
    process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  } else {
    delete process.env.LIAISON_ANTHROPIC_API_KEY
  }
  await releaseTestLock()
})

afterEach(() => {
  AgentServiceTestAccess.setStreamText()
})

describe("subrun-worker WS status updates (T13)", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    await seedPricingAndCredits(orgId)
  })

  it("emits running + done events for a successful sub-run", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })
    AgentServiceTestAccess.setStreamText(stubStreamText.respondWithFinalize({ ok: true }) as never)
    await startSubrunWorker()

    const captured: AppEvent[] = []
    const handler = async (event: AppEvent) => {
      if (event.app === "kernel" && event.entity === "sub_run" && event.orgId === orgId) {
        captured.push(event)
      }
    }
    onEvent(handler, { delivery: "per-replica" })

    try {
      const parentThreadId = await makeParentThread(orgId, userId)
      const handle = await spawnAgent({
        parentRun: {
          id: null,
          threadId: parentThreadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "ws-test",
        prompt: "go",
        outputSchema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      })
      const result = await awaitSubRunResult(handle.runId, orgId, {
        timeoutMs: 10_000,
      })
      expect(result.ok).toBe(true)

      // Allow the worker's broadcastEphemeral microtasks to flush.
      await new Promise((r) => setTimeout(r, 50))
      // Terminal transitions (done|failed|cancelled) are DURABLE since the F2
      // durability change: they ride the transactional outbox, not
      // broadcastEphemeral. No outbox worker runs in this test process, so
      // drain one batch explicitly to dispatch the queued `done` event.
      // initEventBus (idempotent) declares the FULL kernel emit set first —
      // without it, publish validation falls through to the 4-event `*:kernel`
      // subscription set from ensureAppsForOrg and rejects sub_run:update.
      initEventBus()
      await processOutboxBatch()
      await new Promise((r) => setTimeout(r, 50))

      const statuses = captured.map((e) => (e.data as { status: string }).status)
      expect(statuses).toContain("running")
      expect(statuses).toContain("done")
      const doneEvent = captured.find((e) => (e.data as { status: string }).status === "done")
      expect(doneEvent).toBeDefined()
      expect((doneEvent!.data as { runId: string }).runId).toBe(handle.runId)

      // The card row carries the terminal state too: a thread loaded after the
      // live frame shows `done`, never the spawn-time `queued`.
      const cards = await withSystemDb("wsupd-card-read", (tx) =>
        tx
          .select({ metadata: kernelMessages.metadata })
          .from(kernelMessages)
          .where(eq(kernelMessages.threadId, parentThreadId)),
      )
      const card = cards
        .map((c) => c.metadata as { kind?: string; subRun?: Record<string, unknown> } | null)
        .find((m) => m?.kind === "sub_run" && m.subRun?.runId === handle.runId)
      expect(card?.subRun?.status).toBe("done")
      expect(card?.subRun?.usage).toBeDefined()
    } finally {
      // No unregister API exposed — the handler simply scopes its captures by
      // orgId so subsequent tests in the suite aren't affected.
    }
  })

  // X11 (1): the terminal sub_run event is emitted AFTER the run's own tx has
  // committed, outside the sub-run frame, so it can only name the acting agent
  // if the run ROW carries it. Before 0074 there was no column to carry it and
  // the row was anonymous.
  it("the terminal sub-run event names the agent the spawn ran under", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `x11-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })
    const agentId = await withPrivilegedDb(orgId, "x11-seed-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `@x11-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Liaison",
          ownerUserId: userId,
        })
        .returning({ id: agents.id })
      return a.id
    })
    AgentServiceTestAccess.setStreamText(stubStreamText.respondWithFinalize({ ok: true }) as never)
    await startSubrunWorker()

    const captured: AppEvent[] = []
    onEvent(
      async (event: AppEvent) => {
        if (event.app === "kernel" && event.entity === "sub_run" && event.orgId === orgId) {
          captured.push(event)
        }
      },
      { delivery: "per-replica" },
    )

    const parentThreadId = await makeParentThread(orgId, userId)
    const rootRunId = crypto.randomUUID()
    const handle = await runContextStore.run(
      {
        runId: rootRunId,
        parentRunId: null,
        rootRunId,
        nestingDepth: 0,
        background: false,
        agentId,
        agentCeiling: ["mcp:jira:read"],
        effectiveScope: ["mcp:jira:read"],
        turnScopeAccumulator: createTurnScopeAccumulator(),
      },
      () =>
        spawnAgent({
          parentRun: {
            id: null,
            threadId: parentThreadId,
            actor: userActor(orgId, userId, ["mcp:jira:*"]),
            nestingDepth: 0,
          },
          subagentType: agentType,
          description: "x11-test",
          prompt: "go",
          outputSchema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        }),
    )
    const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 10_000 })
    expect(result.ok).toBe(true)

    await new Promise((r) => setTimeout(r, 50))
    initEventBus()
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 50))

    const terminal = captured.find(
      (e) =>
        (e.data as { runId: string }).runId === handle.runId &&
        (e.data as { status: string }).status === "done",
    )
    expect(terminal).toBeDefined()
    expect(terminal?.agentId).toBe(agentId)
  })
})
