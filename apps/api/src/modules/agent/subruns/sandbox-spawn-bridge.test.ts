// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sandbox RPC bridge `agent_spawn` / `agent_awaitRun` are gated by the
// `agent.spawn` capability alone (declared in the manifest, granted at
// install). No app is privileged by who published it.
//
//  - no cap → CAPABILITY_NOT_DECLARED (spawn and awaitRun)
//  - cap    → spawnAgent runs, runId returned
//
// Each test plants the minimum infrastructure for spawnAgent (org/user/role
// definition) and constructs an `AppManifestForBridge`-shaped object as the
// bridge expects. No real sandbox worker is involved.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import {
  agentRuns,
  appsActiveVersion,
  appsInstalled,
  threads as kernelThreads,
  users,
} from "~/db/schema/kernel"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { MAX_NESTING_DEPTH } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SEEDED = seededApps()

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await SEEDED.cleanup()
  await releaseTestLock()
})

async function installApp(grantedScopes: string[]): Promise<string> {
  const appName = SEEDED.track(`bridge-${crypto.randomUUID().slice(0, 8)}`)
  await withSystemDb("bridge-install-app", async (db) => {
    const [admin] = await db.select({ id: users.id }).from(users).limit(1)
    if (!admin) throw new Error("no admin user")
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

async function makeThread(orgId: string, userId: string): Promise<string> {
  const [t] = await withPrivilegedDb(orgId, "bridge-mkthread", async (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `bt-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  return t.id
}

interface ManifestArgs {
  capabilities: string[]
}

function makeManifest(name: string, args: ManifestArgs): Record<string, unknown> {
  return {
    name,
    capabilities: args.capabilities,
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

describe("sandbox agent_spawn bridge (T10)", () => {
  let orgId: string
  let userId: string
  let actor: ActorContext

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    actor = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["mcp:jira:*"],
      dimensionGrants: {},
    }
  })

  it("an app without the capability cannot await a run — CAPABILITY_NOT_DECLARED", async () => {
    const appName = await installApp(["mcp:jira:read"])
    const threadId = await makeThread(orgId, userId)
    const manifest = makeManifest(appName, { capabilities: [] })

    await withPrivilegedDb(orgId, "bridge-no-cap-await", async (tx) => {
      const bridge = createRpcBridge(
        appName,
        userId,
        orgId,
        tx as never,
        manifest as never,
        actor.scopes,
        "user",
        undefined,
        { actor, threadId },
      )
      const env = await bridge.agent_awaitRun(crypto.randomUUID())
      const parsed = JSON.parse(env) as { error?: { code?: string } }
      expect(parsed.error?.code).toBe("CAPABILITY_NOT_DECLARED")
    })
  })

  it("an app without the capability cannot spawn — CAPABILITY_NOT_DECLARED", async () => {
    const appName = await installApp(["mcp:jira:read"])
    const threadId = await makeThread(orgId, userId)
    const manifest = makeManifest(appName, { capabilities: [] })
    await withPrivilegedDb(orgId, "bridge-no-cap", async (tx) => {
      const bridge = createRpcBridge(
        appName,
        userId,
        orgId,
        tx as never,
        manifest as never,
        actor.scopes,
        "user",
        undefined,
        { actor, threadId },
      )
      const env = await bridge.agent_spawn(
        JSON.stringify({
          subagentType: "ticket-investigator",
          description: "x",
          prompt: "go",
        }),
      )
      const parsed = JSON.parse(env) as { error?: { code?: string } }
      expect(parsed.error?.code).toBe("CAPABILITY_NOT_DECLARED")
    })
  })

  it("an app that declares agent.spawn spawns and gets a runId", async () => {
    const appName = await installApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })
    const threadId = await makeThread(orgId, userId)
    const manifest = makeManifest(appName, { capabilities: ["agent.spawn"] })
    // A tool call's bridge runs on the caller's RLS transaction, as in production.
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge(
        appName,
        userId,
        orgId,
        tx as never,
        manifest as never,
        actor.scopes,
        "user",
        undefined,
        { actor, threadId },
      )
      const env = await bridge.agent_spawn(
        JSON.stringify({
          subagentType: agentType,
          description: "JIRA-1234",
          prompt: "investigate",
        }),
      )
      const parsed = JSON.parse(env) as { runId?: string; error?: unknown }
      expect(parsed.error).toBeUndefined()
      expect(typeof parsed.runId).toBe("string")
    })
  })

  // Owner ruling: sub-agents nest at most two levels. An app's
  // ctx.agent.spawn must nest below the agent run that called the app tool,
  // never start a fresh chain at depth 0.
  describe("nesting depth inherits the calling run", () => {
    async function setup(): Promise<{ appName: string; agentType: string; threadId: string }> {
      const appName = await installApp(["mcp:jira:read"])
      const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
      await createSubAgentDefinition({
        orgId,
        appName,
        agentType,
        whenToUse: "test",
        scopeCeiling: ["mcp:jira:read"],
        systemPrompt: "Investigate.",
      })
      const threadId = await makeThread(orgId, userId)
      return { appName, agentType, threadId }
    }

    function spawnUnder(
      frame: { runId: string; rootRunId: string; nestingDepth: number } | null,
      args: { appName: string; agentType: string; threadId: string },
    ): Promise<{ runId?: string; error?: { code?: string; message?: string } }> {
      const manifest = makeManifest(args.appName, { capabilities: ["agent.spawn"] })
      // On the caller's RLS transaction, as the tool dispatch gives the bridge.
      return withRlsContext(actor, async (tx) => {
        // The bridge is built in the calling run's frame (as the tool dispatch
        // builds it) and the spawn callback runs after that frame is gone.
        const build = () =>
          createRpcBridge(
            args.appName,
            userId,
            orgId,
            tx as never,
            manifest as never,
            actor.scopes,
            "user",
            undefined,
            { actor, threadId: args.threadId },
          )
        const bridge = frame
          ? runContextStore.run({ ...frame, parentRunId: null, background: true }, build)
          : build()
        const env = await bridge.agent_spawn(
          JSON.stringify({ subagentType: args.agentType, description: "d", prompt: "go" }),
        )
        return JSON.parse(env)
      })
    }

    async function depthOf(runId: string): Promise<{ depth: number; parent: string | null }> {
      const [row] = await withPrivilegedDb(orgId, "bridge-depth-read", async (tx) =>
        tx
          .select({ depth: agentRuns.nestingDepth, parent: agentRuns.parentRunId })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId)),
      )
      return { depth: row.depth, parent: row.parent }
    }

    it("a depth-2 run calling an app tool that spawns is refused E_DEPTH_EXCEEDED", async () => {
      expect(MAX_NESTING_DEPTH).toBe(2)
      const args = await setup()
      const rootRunId = crypto.randomUUID()
      const parsed = await spawnUnder(
        { runId: crypto.randomUUID(), rootRunId, nestingDepth: 2 },
        args,
      )
      expect(parsed.runId).toBeUndefined()
      expect(parsed.error?.code).toBe("E_DEPTH_EXCEEDED")
    })

    it("a depth-1 run calling an app tool spawns its child at depth 2", async () => {
      const args = await setup()
      // A real depth-1 run row to be the parent (spawned from a root turn).
      const rootRunId = crypto.randomUUID()
      const first = await spawnUnder({ runId: rootRunId, rootRunId, nestingDepth: 0 }, args)
      expect(first.error).toBeUndefined()
      const parentId = first.runId as string
      expect(await depthOf(parentId)).toEqual({ depth: 1, parent: null })

      // The sub-run's frame, as subrun-worker builds it: a depth-1 run spawned
      // from a root turn is its own chain's root row.
      const second = await spawnUnder(
        { runId: parentId, rootRunId: parentId, nestingDepth: 1 },
        args,
      )
      expect(second.error).toBeUndefined()
      expect(await depthOf(second.runId as string)).toEqual({ depth: 2, parent: parentId })
    })

    it("a spawn with no calling agent run starts a root chain at depth 1", async () => {
      const args = await setup()
      const parsed = await spawnUnder(null, args)
      expect(parsed.error).toBeUndefined()
      expect(await depthOf(parsed.runId as string)).toEqual({ depth: 1, parent: null })
    })
  })
})
