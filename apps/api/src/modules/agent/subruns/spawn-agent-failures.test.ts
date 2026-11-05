// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T7 — Failure semantics: continueOnError flag + closed error taxonomy.
// Exercises the four terminal failure modes of a sub-run:
//   - schema_failure (model ended without a valid finalize, but had budget)
//   - timeout       (timeoutMs elapsed before finalize)
//   - step_limit    (maxSteps consumed without finalize)
//   - credits_exhausted (preCheck or mid-step credit shortfall)
//
// `continueOnError` toggles between rejection (false) and resolved-with-error
// (true) on awaitResult(). awaitSubRunResult() is the underlying primitive.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  appsActiveVersion,
  appsInstalled,
  creditBalances,
  threads as kernelThreads,
  modelPricing,
  users,
} from "~/db/schema/kernel"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
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
  const appName = SEEDED.track(`spawnfail-${crypto.randomUUID().slice(0, 8)}`)
  await withSystemDb("spawnfail-install-app", async (db) => {
    const [admin] = await db.select({ id: users.id }).from(users).limit(1)
    if (!admin) throw new Error("installTestApp: no user found")
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
  const [t] = await withPrivilegedDb(orgId, "spawnfail-parent-thread", async (tx) =>
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
  await withSystemDb("spawnfail-seed-pricing", async (db) => {
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5-spawnfail",
        displayName: "Spawnfail Haiku",
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
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-spawnfail-stub"
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

const SCHEMA_BASIC = {
  type: "object",
  required: ["draft"],
  properties: { draft: { type: "string" } },
}

async function setupRole(orgId: string): Promise<string> {
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
  return agentType
}

describe("spawn-agent failure semantics (T7)", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    await seedPricingAndCredits(orgId)
  })

  it("continueOnError=false rejects on schema_failure", async () => {
    const agentType = await setupRole(orgId)
    AgentServiceTestAccess.setStreamText(stubStreamText.neverFinalize() as never)
    await startSubrunWorker()
    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "schema-fail",
      prompt: "go",
      outputSchema: SCHEMA_BASIC,
      continueOnError: false,
    })
    let caught: { code?: string } | null = null
    try {
      await handle.awaitResult()
    } catch (e) {
      caught = e as { code?: string }
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe("schema_failure")
  })

  it("continueOnError=true returns ok=false with error on schema_failure", async () => {
    const agentType = await setupRole(orgId)
    AgentServiceTestAccess.setStreamText(stubStreamText.neverFinalize() as never)
    await startSubrunWorker()
    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "schema-fail-coe",
      prompt: "go",
      outputSchema: SCHEMA_BASIC,
      continueOnError: true,
    })
    const result = await handle.awaitResult()
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("schema_failure")
  })

  it("step_limit produces error.code=step_limit when budget is exhausted", async () => {
    const agentType = await setupRole(orgId)
    // Worker is configured to maxSteps=2; stub emits 2 step cycles, never finalize.
    AgentServiceTestAccess.setStreamText(stubStreamText.neverFinalizeWithSteps(2) as never)
    await startSubrunWorker()
    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "step-limit",
      prompt: "go",
      outputSchema: SCHEMA_BASIC,
      maxSteps: 2,
      continueOnError: true,
    })
    const result = await handle.awaitResult()
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("step_limit")
  })

  it("timeout produces error.code=timeout when the stream stalls past timeoutMs", async () => {
    const agentType = await setupRole(orgId)
    // Stream that hangs until worker's timeoutMs abort fires.
    AgentServiceTestAccess.setStreamText(stubStreamText.stallUntilAbort() as never)
    await startSubrunWorker()
    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "timeout",
      prompt: "go",
      outputSchema: SCHEMA_BASIC,
      timeoutMs: 1_000,
      continueOnError: true,
    })
    const result = await handle.awaitResult()
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("timeout")
  }, 15_000)
})
