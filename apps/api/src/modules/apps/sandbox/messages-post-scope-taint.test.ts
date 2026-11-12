// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint on ctx.messages.post. A sandboxed app's bridge callbacks run
// outside the calling turn's AsyncLocalStorage frame, so the post takes its
// requiredScopes from the frame the bridge captured when it was built. Every
// post below is made with no frame active, as a worker-pool callback is.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, threadParticipants, threads } from "~/db/schema/kernel"
import {
  type RunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const READ = "mpt:items:read"
const TOOL = "mpt:poster:run"
const ACTOR_SCOPES = [READ, TOOL, "kernel:threads:write"]

let orgId: string
let ownerId: string
let lackerId: string
let threadId: string
let appName: string

function actor(): UserContext {
  return { actorType: "user", userId: ownerId, orgId, scopes: ACTOR_SCOPES, dimensionGrants: {} }
}

function manifest(): Record<string, unknown> {
  return {
    name: appName,
    trusted: true,
    capabilities: ["messages.post"],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

type Kind = "createRpcBridge" | "createSessionRpcBridge"

/** Builds the bridge inside `frame` (when given), then posts with no frame active. */
async function postVia(
  kind: Kind,
  opts: { frame?: RunContext; scopesBefore?: string[]; callerScopes?: string[] },
  body: string,
): Promise<{ message_id?: string; error?: { code?: string } }> {
  const build = (tx?: RlsClient): Record<string, any> =>
    kind === "createSessionRpcBridge"
      ? createSessionRpcBridge(
          appName,
          ownerId,
          orgId,
          {
            ctx: actor(),
            run: <T>(fn: (tx: RlsClient) => Promise<T>) =>
              withRlsContext(actor(), (rlsTx) => fn(rlsTx as unknown as RlsClient)),
          } as never,
          manifest() as never,
          opts.callerScopes,
          "user",
          undefined,
          { actor: actor(), threadId },
        )
      : createRpcBridge(
          appName,
          ownerId,
          orgId,
          tx as RlsClient,
          manifest() as never,
          opts.callerScopes,
          "user",
          undefined,
          { actor: actor(), threadId },
        )
  const inFrame = (tx?: RlsClient) => {
    const withBefore = () =>
      opts.scopesBefore
        ? runWithToolCallScopesBefore(opts.scopesBefore, () => build(tx))
        : build(tx)
    return opts.frame ? runContextStore.run(opts.frame, withBefore) : withBefore()
  }
  const post = async (bridge: Record<string, any>) => {
    expect(runContextStore.getStore()).toBeUndefined()
    return JSON.parse(await bridge.messages_post(JSON.stringify({ thread_id: threadId, body })))
  }
  if (kind === "createSessionRpcBridge") return post(inFrame())
  return withRlsContext(actor(), async (tx) => post(inFrame(tx as unknown as RlsClient)))
}

async function scopesOf(messageId: string): Promise<string[] | undefined> {
  const [row] = await withPrivilegedDb(orgId, "mpt-read-scopes", (tx) =>
    tx
      .select({ requiredScopes: messages.requiredScopes })
      .from(messages)
      .where(eq(messages.id, messageId)),
  )
  return row?.requiredScopes
}

async function visibleTo(userId: string, scopes: string[]): Promise<string[]> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes, dimensionGrants: {} },
    async (tx) =>
      (
        await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId))
      ).map((r) => r.id),
  )
}

function frameOf(extra: Partial<RunContext>): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, ...extra }
}

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  ownerId = (await minimal.person(orgId, { role: "admin" })).id
  lackerId = (await minimal.person(orgId)).id
  appName = `mpt-${crypto.randomUUID().slice(0, 8)}`
  threadId = await withPrivilegedDb(orgId, "mpt-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({ orgId, handle: `mpt-${crypto.randomUUID().slice(0, 8)}`, createdBy: ownerId })
      .returning({ id: threads.id })
    await tx.insert(threadParticipants).values([
      { threadId: t.id, userId: ownerId, orgId, role: "admin" },
      { threadId: t.id, userId: lackerId, orgId, role: "member" },
    ])
    return t.id
  })
})

describe("sandbox messages.post: requiredScopes from the captured turn frame", () => {
  for (const kind of ["createRpcBridge", "createSessionRpcBridge"] as const) {
    it(`${kind}: a post from an app tool in a tainted turn carries the turn's snapshot and RLS hides it from a member lacking it`, async () => {
      const turnScopeAccumulator = createTurnScopeAccumulator()
      turnScopeAccumulator.recordInjected([READ])
      const scopesBefore = turnScopeAccumulator.snapshot()
      // The bridge records the calling app tool's scope before the tool runs.
      turnScopeAccumulator.recordInjected([TOOL])
      const frame = frameOf({ effectiveScope: ACTOR_SCOPES, turnScopeAccumulator })

      const env = await postVia(
        kind,
        { frame, scopesBefore, callerScopes: ACTOR_SCOPES },
        "invoice INV-1 total 1200",
      )

      expect(env.error).toBeUndefined()
      const id = env.message_id as string
      expect(await scopesOf(id)).toEqual([READ, TOOL])
      expect(await visibleTo(ownerId, ACTOR_SCOPES)).toContain(id)
      expect(await visibleTo(lackerId, [])).not.toContain(id)
    })
  }

  it("a direct invocation, with no turn frame, posts with no required scopes", async () => {
    const env = await postVia("createSessionRpcBridge", { callerScopes: ACTOR_SCOPES }, "hello")

    expect(env.error).toBeUndefined()
    const id = env.message_id as string
    expect(await scopesOf(id)).toEqual([])
    expect(await visibleTo(lackerId, [])).toContain(id)
  })

  // scope-taint.ts rule 14: a person's own external client (an MCP connection bound to no agent)
  // now runs under a gateway frame. Through this bridge it posts as it did with no frame.
  it("a person's own external client's gateway frame posts with no required scopes, as before", async () => {
    const turnScopeAccumulator = createTurnScopeAccumulator()
    turnScopeAccumulator.recordInjected([READ])
    const frame = frameOf({ mcpGateway: true, effectiveScope: ACTOR_SCOPES, turnScopeAccumulator })
    const env = await postVia(
      "createSessionRpcBridge",
      { frame, scopesBefore: [READ], callerScopes: ACTOR_SCOPES },
      "posted from an external client",
    )
    expect(env.error).toBeUndefined()
    const id = env.message_id as string
    expect(await scopesOf(id)).toEqual([])
    expect(await visibleTo(lackerId, [])).toContain(id)
  })

  it("an agent-bound gateway frame still stamps the post with what its turn read", async () => {
    const turnScopeAccumulator = createTurnScopeAccumulator()
    turnScopeAccumulator.recordInjected([READ])
    const frame = frameOf({
      mcpGateway: true,
      agentId: crypto.randomUUID(),
      agentCeiling: ACTOR_SCOPES,
      effectiveScope: ACTOR_SCOPES,
      turnScopeAccumulator,
    })
    const env = await postVia(
      "createSessionRpcBridge",
      { frame, scopesBefore: [READ], callerScopes: ACTOR_SCOPES },
      "posted from an agent connection",
    )
    expect(env.error).toBeUndefined()
    expect(await scopesOf(env.message_id as string)).toEqual([READ])
  })

  it("fail closed: a frame without an accumulator tags the post with the turn's effective scope", async () => {
    const env = await postVia(
      "createSessionRpcBridge",
      { frame: frameOf({ effectiveScope: [READ] }), callerScopes: ACTOR_SCOPES },
      "figures from an unknown read",
    )

    expect(env.error).toBeUndefined()
    const id = env.message_id as string
    expect(await scopesOf(id)).toEqual([READ])
    expect(await visibleTo(lackerId, [])).not.toContain(id)
  })

  it("fail closed: a frame with no accumulator, no effective scope and no caller scopes refuses the post", async () => {
    const env = await postVia("createSessionRpcBridge", { frame: frameOf({}) }, "unknown taint")

    expect(env.error?.code).toBe("scope_unknown")
    expect(await visibleTo(ownerId, ACTOR_SCOPES)).toEqual([])
  })
})
