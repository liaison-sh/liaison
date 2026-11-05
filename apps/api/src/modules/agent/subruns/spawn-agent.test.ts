// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  agentRuns,
  appsActiveVersion,
  appsInstalled,
  threads as kernelThreads,
  users,
} from "~/db/schema/kernel"
import { KERNEL_QUEUE_CLASSES, planKernelSlots } from "~/infra/jobs/queue-classes"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  clamp,
  intersectScopes,
  isScopeSubset,
  KERNEL_CEILINGS,
  KERNEL_FLOORS,
  MAX_NESTING_DEPTH,
  type SpawnAgentError,
  spawnAgent,
} from "./spawn-agent"
import { createSubAgentDefinition } from "./sub-agent-definitions"

const SEEDED = seededApps()

function userActor(orgId: string, userId: string, scopes: string[]): UserContext {
  return {
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: {},
  }
}

async function installTestApp(grantedScopes: string[]): Promise<string> {
  const appName = SEEDED.track(`test-app-${crypto.randomUUID().slice(0, 8)}`)
  await withSystemDb("test-install-app", async (db) => {
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
      .onConflictDoUpdate({ target: appsActiveVersion.name, set: { version: "1.0.0" } })
  })
  return appName
}

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await SEEDED.cleanup()
  await releaseTestLock()
})

// ---------------------------------------------------------------------------
// Pure helpers — no DB
// ---------------------------------------------------------------------------

describe("isScopeSubset / intersectScopes / clamp", () => {
  it("isScopeSubset exact + glob", () => {
    expect(isScopeSubset(["mcp:jira:read"], ["mcp:jira:*"])).toBe(true)
    expect(isScopeSubset(["mcp:slack:write"], ["mcp:jira:*"])).toBe(false)
  })

  it("intersectScopes keeps glob-covered scopes", () => {
    expect(intersectScopes(["mcp:jira:read", "mcp:slack:write"], ["mcp:jira:*"])).toEqual([
      "mcp:jira:read",
    ])
  })

  it("clamp floors below floor and ceils above ceiling", () => {
    expect(clamp(0, undefined, "maxSteps")).toBe(KERNEL_FLOORS.maxSteps)
    expect(clamp(99999, undefined, "maxSteps")).toBe(KERNEL_CEILINGS.maxSteps)
    expect(clamp(undefined, 25, "maxSteps")).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — full spawn flow
// ---------------------------------------------------------------------------

async function setupRole(
  orgId: string,
  scopeCeiling: string[],
  opts: { agentType?: string; defaultMaxSteps?: number; defaultTimeoutMs?: number } = {},
): Promise<string> {
  const grantedScopes = scopeCeiling.length > 0 ? scopeCeiling : ["mcp:noop:*"]
  const appName = await installTestApp(grantedScopes)
  const agentType = opts.agentType ?? `inv-${crypto.randomUUID().slice(0, 6)}`
  await createSubAgentDefinition({
    orgId,
    appName,
    agentType,
    whenToUse: "test",
    scopeCeiling,
    systemPrompt: "test prompt",
    defaultMaxSteps: opts.defaultMaxSteps,
    defaultTimeoutMs: opts.defaultTimeoutMs,
  })
  return agentType
}

async function makeParentThread(orgId: string, userId: string): Promise<string> {
  const [t] = await withPrivilegedDb(orgId, "test-make-parent-thread", async (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `t-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  return t.id
}

describe("spawnAgent — happy path", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
  })

  it("inserts a queued agent_runs row with the computed effective scopes", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read", "mcp:tailspin-db:read"])
    const threadId = await makeParentThread(orgId, userId)

    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*", "mcp:tailspin-db:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "Investigate JIRA-1234",
      prompt: "Read the ticket and draft a response.",
      input: { ticketId: "JIRA-1234" },
    })
    expect(handle.runId).toBeDefined()

    const row = await withPrivilegedDb(orgId, "verify", async (tx) => {
      const [r] = await tx.select().from(agentRuns).where(eq(agentRuns.id, handle.runId))
      return r
    })
    expect(row.status).toBe("queued")
    expect(row.effectiveScopes.sort()).toEqual(["mcp:jira:read", "mcp:tailspin-db:read"])
    expect(row.nestingDepth).toBe(1)
    expect(row.subagentType).toBe(agentType)
    expect(row.input).toEqual({ ticketId: "JIRA-1234" })
  })

  it("creates a hidden subrun thread for the run", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
    })
    const subrunRow = await withPrivilegedDb(orgId, "verify-thread", async (tx) => {
      const [r] = await tx
        .select({ threadId: agentRuns.threadId })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    const hiddenThread = await withPrivilegedDb(orgId, "verify-hidden-thread", async (tx) => {
      const [t] = await tx
        .select({ type: kernelThreads.type, hiddenFromList: kernelThreads.hiddenFromList })
        .from(kernelThreads)
        .where(eq(kernelThreads.id, subrunRow.threadId))
      return t
    })
    expect(hiddenThread.type).toBe("subrun")
    expect(hiddenThread.hiddenFromList).toBe(true)
  })

  it("seeds the hidden subrun thread as tainted when the parent thread is tainted", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    // Taint the parent thread before spawning.
    await withPrivilegedDb(orgId, "test-taint-parent", (tx) =>
      tx.update(kernelThreads).set({ tainted: true }).where(eq(kernelThreads.id, threadId)),
    )
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
    })
    const subrunRow = await withPrivilegedDb(orgId, "verify-thread", async (tx) => {
      const [r] = await tx
        .select({ threadId: agentRuns.threadId })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    const [hidden] = await withPrivilegedDb(orgId, "verify-hidden-taint", (tx) =>
      tx
        .select({ tainted: kernelThreads.tainted })
        .from(kernelThreads)
        .where(eq(kernelThreads.id, subrunRow.threadId)),
    )
    expect(hidden.tainted).toBe(true)
  })

  it("leaves the hidden subrun thread untainted when the parent thread is clean", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
    })
    const subrunRow = await withPrivilegedDb(orgId, "verify-thread", async (tx) => {
      const [r] = await tx
        .select({ threadId: agentRuns.threadId })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    const [hidden] = await withPrivilegedDb(orgId, "verify-hidden-taint", (tx) =>
      tx
        .select({ tainted: kernelThreads.tainted })
        .from(kernelThreads)
        .where(eq(kernelThreads.id, subrunRow.threadId)),
    )
    expect(hidden.tainted).toBe(false)
  })

  it("sets root_run_id = self when parent is a root (parent.id null)", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
    })
    const row = await withPrivilegedDb(orgId, "verify-root", async (tx) => {
      const [r] = await tx
        .select({ id: agentRuns.id, rootRunId: agentRuns.rootRunId })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    expect(row.rootRunId).toBe(row.id)
  })
})

describe("spawnAgent — failure modes", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
  })

  it("rejects with E_UNKNOWN_AGENT_TYPE when the role doesn't exist", async () => {
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: 0,
        },
        subagentType: "nope",
        description: "x",
        prompt: "x",
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err).not.toBeNull()
    expect(err?.code).toBe("E_UNKNOWN_AGENT_TYPE")
  })

  it("rejects with E_SCOPE_NOT_SUBSET when callSite scopes exceed parent scopes", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read", "mcp:slack:write"])
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]), // no slack
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "x",
        prompt: "x",
        scopes: ["mcp:slack:write"],
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err?.code).toBe("E_SCOPE_NOT_SUBSET")
  })

  it("rejects with E_SCOPE_OUTSIDE_ROLE when callSite scopes exceed role ceiling", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:jira:*", "mcp:slack:*"]),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "x",
        prompt: "x",
        scopes: ["mcp:slack:write"], // in parent but not in role
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err?.code).toBe("E_SCOPE_OUTSIDE_ROLE")
  })

  it("rejects with E_INVALID_OUTPUT_SCHEMA when output_schema carries a backtracking pattern", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "x",
        prompt: "x",
        outputSchema: {
          type: "object",
          properties: { s: { type: "string", pattern: "^(a|a)+$" } },
        },
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err?.code).toBe("E_INVALID_OUTPUT_SCHEMA")
  })

  it("rejects with E_DEPTH_EXCEEDED at MAX_NESTING_DEPTH", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: MAX_NESTING_DEPTH,
        },
        subagentType: agentType,
        description: "x",
        prompt: "x",
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err?.code).toBe("E_DEPTH_EXCEEDED")
  })

  it("nests at most two sub-agent levels: a depth-2 run cannot spawn, with a typed 422 the model reads", async () => {
    expect(MAX_NESTING_DEPTH).toBe(2)
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: 2,
        },
        subagentType: agentType,
        description: "x",
        prompt: "x",
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err?.code).toBe("E_DEPTH_EXCEEDED")
    expect(err?.status).toBe(422)
    expect(err?.message).toContain("at most 2 levels deep")
    expect(err?.message).toContain("cannot spawn another sub-agent")
  })

  it("a full-depth chain never holds every agent slot at the production pool (15)", () => {
    // Every level of a chain holds a kernel-agent worker slot while it runs or
    // waits on its child. Rooted in an agent-class job (a routine tick), a full
    // chain holds 1 + MAX_NESTING_DEPTH slots; one must stay free for every
    // other LLM loop.
    const prod = planKernelSlots({}, 15)
    expect(prod.scaledDown).toBe(false)
    expect(prod.slots.agent).toBe(KERNEL_QUEUE_CLASSES.agent.concurrency)
    expect(prod.slots.agent).toBeGreaterThan(1 + MAX_NESTING_DEPTH)
  })

  it("rejects with E_ROLE_UNAVAILABLE when parent has no intersection with role ceiling", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    let err: SpawnAgentError | null = null
    try {
      await spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, ["mcp:slack:*"]), // no jira at all
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "x",
        prompt: "x",
      })
    } catch (e) {
      err = e as SpawnAgentError
    }
    expect(err?.code).toBe("E_ROLE_UNAVAILABLE")
  })
})

describe("spawnAgent — limit clamping", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
  })

  it("clamps maxSteps above the ceiling", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
      maxSteps: 9999,
    })
    const row = await withPrivilegedDb(orgId, "verify-maxsteps", async (tx) => {
      const [r] = await tx
        .select({ maxSteps: agentRuns.maxSteps })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    expect(row.maxSteps).toBe(KERNEL_CEILINGS.maxSteps)
  })

  it("floors maxSteps=0 to KERNEL_FLOORS.maxSteps", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"])
    const threadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
      maxSteps: 0,
    })
    const row = await withPrivilegedDb(orgId, "verify-floor", async (tx) => {
      const [r] = await tx
        .select({ maxSteps: agentRuns.maxSteps })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    expect(row.maxSteps).toBe(KERNEL_FLOORS.maxSteps)
  })

  it("falls back to AgentDefinition default when caller omits the limit", async () => {
    const agentType = await setupRole(orgId, ["mcp:jira:read"], { defaultMaxSteps: 25 })
    const threadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "x",
      prompt: "x",
    })
    const row = await withPrivilegedDb(orgId, "verify-default", async (tx) => {
      const [r] = await tx
        .select({ maxSteps: agentRuns.maxSteps })
        .from(agentRuns)
        .where(eq(agentRuns.id, handle.runId))
      return r
    })
    expect(row.maxSteps).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// Delegation bound: the parent side is the turn's effective scope
// ---------------------------------------------------------------------------

function turnFrame(effectiveScope?: string[]): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    ...(effectiveScope !== undefined ? { effectiveScope } : {}),
  }
}

async function runsFromThread(orgId: string, threadId: string) {
  return withPrivilegedDb(orgId, "verify-runs-from-thread", (tx) =>
    tx.select().from(agentRuns).where(eq(agentRuns.parentThreadId, threadId)),
  )
}

describe("spawnAgent: bounded by the turn effective scope", () => {
  let orgId: string
  let userId: string
  // Agent ceiling [a:b:read] in a DM with this requester gives the turn an
  // effective scope of [a:b:read]; the requester alone also holds c:d:write.
  const requesterScopes = ["a:b:read", "c:d:write"]
  const dmEffectiveScope = ["a:b:read"]

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
  })

  it("a role holding only c:d:write gets nothing past a turn scoped to a:b:read", async () => {
    const agentType = await setupRole(orgId, ["c:d:write"])
    const threadId = await makeParentThread(orgId, userId)

    await expect(
      runContextStore.run(turnFrame(dmEffectiveScope), () =>
        spawnAgent({
          parentRun: {
            id: null,
            threadId,
            actor: userActor(orgId, userId, requesterScopes),
            nestingDepth: 0,
          },
          subagentType: agentType,
          description: "widen attempt",
          prompt: "write to c:d",
        }),
      ),
    ).rejects.toThrow("E_ROLE_UNAVAILABLE")
    expect(await runsFromThread(orgId, threadId)).toHaveLength(0)
  })

  it("a role holding both scopes gets only the turn scope intersection", async () => {
    const agentType = await setupRole(orgId, ["a:b:read", "c:d:write"])
    const threadId = await makeParentThread(orgId, userId)

    const handle = await runContextStore.run(turnFrame(dmEffectiveScope), () =>
      spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, requesterScopes),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "bounded",
        prompt: "read a:b",
      }),
    )
    const [row] = (await runsFromThread(orgId, threadId)).filter((r) => r.id === handle.runId)
    expect(row.effectiveScopes).toEqual(["a:b:read"])
  })

  it("requested scopes outside the turn scope are rejected as not a subset", async () => {
    const agentType = await setupRole(orgId, ["a:b:read", "c:d:write"])
    const threadId = await makeParentThread(orgId, userId)

    await expect(
      runContextStore.run(turnFrame(dmEffectiveScope), () =>
        spawnAgent({
          parentRun: {
            id: null,
            threadId,
            actor: userActor(orgId, userId, requesterScopes),
            nestingDepth: 0,
          },
          subagentType: agentType,
          description: "explicit widen attempt",
          prompt: "write to c:d",
          scopes: ["c:d:write"],
        }),
      ),
    ).rejects.toThrow("E_SCOPE_NOT_SUBSET")
    expect(await runsFromThread(orgId, threadId)).toHaveLength(0)
  })

  it("an empty turn scope fails closed: the child gets nothing", async () => {
    const agentType = await setupRole(orgId, ["a:b:read"])
    const threadId = await makeParentThread(orgId, userId)

    await expect(
      runContextStore.run(turnFrame([]), () =>
        spawnAgent({
          parentRun: {
            id: null,
            threadId,
            actor: userActor(orgId, userId, requesterScopes),
            nestingDepth: 0,
          },
          subagentType: agentType,
          description: "empty turn scope",
          prompt: "read a:b",
        }),
      ),
    ).rejects.toThrow("E_ROLE_UNAVAILABLE")
    expect(await runsFromThread(orgId, threadId)).toHaveLength(0)
  })

  it("a frame without an effective scope keeps the actor scopes as the parent side", async () => {
    const agentType = await setupRole(orgId, ["a:b:read", "c:d:write"])
    const threadId = await makeParentThread(orgId, userId)

    const handle = await runContextStore.run(turnFrame(), () =>
      spawnAgent({
        parentRun: {
          id: null,
          threadId,
          actor: userActor(orgId, userId, requesterScopes),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "no turn scope",
        prompt: "read a:b, write c:d",
      }),
    )
    const [row] = (await runsFromThread(orgId, threadId)).filter((r) => r.id === handle.runId)
    expect([...row.effectiveScopes].sort()).toEqual(["a:b:read", "c:d:write"])
  })
})
