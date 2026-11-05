// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * FX4 -- D5 write inheritance across the approval wait.
 *
 * A gated tool call does not write when the agent makes it: it parks as an
 * approval_request and writes later, on the approved re-entry. That re-entry
 * runs OUTSIDE the proposing turn's AsyncLocalStorage frame (another request,
 * minutes or days later), so every scope-tagged sink it touched saw no frame
 * and tagged its row with the empty positive assertion -- which every member of
 * the room can read. The identical call made inline carried the turn's scopes.
 *
 * The scopes therefore travel on the approval row (migration 0067,
 * `proposing_turn_scopes`) and are seeded back into the execution on re-entry.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import {
  type RunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import {
  SINK_APP_KNOWLEDGE_DOCUMENTS,
  SINK_KERNEL_MESSAGES,
} from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  approvalReentryWriteScopes,
  proposingTurnWriteScopes,
} from "~/modules/agent/scopes/write-required-scopes"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalDedupeKeyRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { createHandlerApprovalRequest, executeTool } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { isMessageVisible } from "~/services/security/visibility"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000064001"
const USER = "00000000-0000-4000-8000-000000064002"
const LACKER = "00000000-0000-4000-8000-000000064003"
const THREAD = "00000000-0000-4000-8000-000000064004"

/** What the proposing turn READ. The gated tool's own write scope is not this. */
const READ = "mail:messages:read"
const WRITE = "fx4_test:gated:write"
const APPROVE = "fx4_test:approve"
const KNOWLEDGE = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
]
/** What a SECOND turn reads before re-staging the same keyed action. */
const OTHER_READ = "tickets:tickets:read"
// A member who writes threads and documents reads them too: the re-entry tag is
// the READ projection of what it falls back on, and a writer must be able to
// read back the row it writes (INSERT ... RETURNING is checked against the
// read policy).
const REQUESTER_SCOPES = [
  READ,
  OTHER_READ,
  WRITE,
  APPROVE,
  "kernel:threads:read",
  "kernel:threads:write",
  ...KNOWLEDGE,
]
/**
 * REQUESTER_SCOPES as a turn's scope taint records them: every scope lands on
 * its catalogued read sibling, and a scope with none (this fixture app's own
 * write and approve scopes) is dropped (scope-taint-read-projection.test.ts).
 */
const REQUESTER_TAINT = [
  "kernel:threads:read",
  "knowledge:documents:read",
  "mail:messages:read",
  "tickets:tickets:read",
]

function requester(): UserContext {
  return {
    actorType: "user",
    userId: USER,
    orgId: ORG,
    scopes: REQUESTER_SCOPES,
    dimensionGrants: {},
  }
}

/** A trusted one-tool app manifest whose only capability is posting a message. */
function posterManifest(): Record<string, unknown> {
  return {
    name: "fx4_test",
    trusted: true,
    capabilities: ["messages.post"],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

function personalDoc(title: string) {
  return {
    documentScope: "personal",
    title,
    body: "body written by the approved re-entry",
    collectionIds: [],
    tagNames: [],
    team: [],
    sensitivity: "internal",
    verifyNow: false,
  }
}

/** A proposing turn: a frame whose accumulator has already read `accumulated`. */
function turnFrame(accumulated: string[]): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(accumulated)
  return {
    runId: "00000000-0000-4000-8000-0000000640ff",
    parentRunId: null,
    rootRunId: "00000000-0000-4000-8000-0000000640ff",
    nestingDepth: 0,
    effectiveScope: REQUESTER_SCOPES,
    turnScopeAccumulator,
  }
}

/**
 * Propose a gated call the way an agent turn does: inside the turn's frame,
 * with the calling tool's own scope not yet counted as a read.
 */
async function proposeInTurn(tool: string, params: Record<string, unknown>, read: string[]) {
  const result = await runContextStore.run(turnFrame(read), () =>
    runWithToolCallScopesBefore(read, () =>
      executeTool({
        toolName: `fx4_test:${tool}`,
        orgId: ORG,
        actor: requester(),
        params,
        threadId: THREAD,
        // Forces the gated path even though the requester may self-approve.
        origin: "in-app-agent",
      }),
    ),
  )
  return result.blocked!.approvalRequestId!
}

async function storedScopesOf(approvalId: string): Promise<string[] | null> {
  const [row] = await sql`SELECT proposing_turn_scopes FROM kernel.approval_requests
    WHERE id = ${approvalId}`
  return (row?.proposing_turn_scopes as string[] | null) ?? null
}

async function approve(approvalId: string) {
  return decideApproval({
    orgId: ORG,
    requestId: approvalId,
    actor: requester(),
    decision: "approve",
  })
}

async function messageTag(body: string): Promise<string[] | undefined> {
  const [row] = await sql`SELECT required_scopes FROM kernel.messages
    WHERE org_id = ${ORG} AND content = ${body}`
  return row?.required_scopes as string[] | undefined
}

async function documentTag(title: string): Promise<string[] | undefined> {
  const [row] = await sql`SELECT required_scopes FROM app_knowledge.documents
    WHERE org_id = ${ORG} AND title = ${title}`
  return row?.required_scopes as string[] | undefined
}

/** Message ids a member can actually SELECT, under their own RLS context. */
async function messagesVisibleTo(userId: string, scopes: string[]): Promise<string[]> {
  return withRlsContext(
    { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
    async (tx) =>
      (
        await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, THREAD))
      ).map((r) => r.id),
  )
}

async function grantScopes(userId: string, scopes: string[]) {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${userId}`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

describe("approved re-entry inherits the proposing turn's scopes (FX4)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX4 Reentry Org', 'fx4-reentry-org') ON CONFLICT DO NOTHING`
    for (const [id, email, name] of [
      [USER, "fx4-requester@test.com", "Requester"],
      [LACKER, "fx4-lacker@test.com", "Lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${name}, 'active', 'hash') ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx4-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    for (const [id, role] of [
      [USER, "admin"],
      [LACKER, "member"],
    ] as const) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${THREAD}, ${id}, ${ORG}, ${role}) ON CONFLICT DO NOTHING`
    }
    await grantScopes(USER, REQUESTER_SCOPES)
    await grantScopes(LACKER, [])

    // A gated tool that POSTS A MESSAGE through the production bridge. The
    // bridge is built where execute-tool builds it -- inside whatever frame the
    // execution runs in -- and takes its tag from the frame it captured there.
    toolRegistry.set([ORG, "fx4_test", "postScoped"], {
      appName: "fx4_test",
      name: "postScoped",
      description: "Posts a message quoting what the turn read",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      // Every gated tool here is PROPOSED on a tainted turn, and T28's write
      // guard counts an undeclared target as a write, so a tool that does not
      // name its sink is refused before it can ever reach the gate. Each one
      // declares what it genuinely writes.
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async (params: any) =>
        withRlsContext(requester(), async (tx) => {
          const bridge = createRpcBridge(
            "fx4_test",
            USER,
            ORG,
            tx as never,
            posterManifest() as never,
            REQUESTER_SCOPES,
            "user",
            undefined,
            { actor: requester() as never, threadId: THREAD },
          ) as Record<string, (p: string) => Promise<string>>
          return JSON.parse(
            await bridge.messages_post!(JSON.stringify({ thread_id: THREAD, body: params.body })),
          )
        }),
    } as any)

    // The same gated post, but dedupe-keyed: a second staging call for the same
    // key RESTAGES the pending approval in place instead of stacking a new one.
    toolRegistry.set([ORG, "fx4_test", "dedupedPost"], {
      appName: "fx4_test",
      name: "dedupedPost",
      description: "A dedupe-keyed gated post",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async () => ({ ok: true }),
    } as any)
    approvalDedupeKeyRegistry.set([ORG, "fx4_test", "dedupedPost"], "dedupeKey")

    // A gated tool that CREATES A KNOWLEDGE DOCUMENT through the production
    // knowledge bridge (the P2b-T29 write path).
    toolRegistry.set([ORG, "fx4_test", "captureDoc"], {
      appName: "fx4_test",
      name: "captureDoc",
      description: "Files what the turn read as a knowledge document",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_APP_KNOWLEDGE_DOCUMENTS,
      handler: async (params: any) =>
        withRlsContext(requester(), async (tx) => {
          const bridge = createRpcBridge(
            "knowledge",
            USER,
            ORG,
            tx as never,
            knowledgeManifest as never,
            KNOWLEDGE,
            "user",
            undefined,
            {
              // A connector-origin create skips the collection-placement guard;
              // the tagging under test is independent of placement.
              callerApp: "calls",
              actor: {
                actorType: "user",
                userId: USER,
                orgId: ORG,
                scopes: KNOWLEDGE,
                dimensionGrants: {},
              } as never,
            },
          ) as Record<string, (p: string) => Promise<string>>
          return JSON.parse(
            await bridge.knowledge_create!(JSON.stringify(personalDoc(params.title))),
          )
        }),
    } as any)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    approvalDedupeKeyRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("a knowledge document written by an approved re-entry carries the proposing turn's scopes", async () => {
    const title = "What the turn read"
    const approvalId = await proposeInTurn("captureDoc", { title }, [READ])

    // The scopes are recorded when the call is DEFERRED: the frame is gone by
    // the time a human decides.
    expect(await storedScopesOf(approvalId)).toEqual([READ])

    const decided = await approve(approvalId)
    expect(decided.status).toBe("approved")

    expect(await documentTag(title)).toEqual([READ])
    // The Knowledge read filter is slice 3 (T30/T31); the shared predicate is
    // what both sides answer with today.
    const doc = { requiredScopes: [READ], disclosureList: null }
    expect(isMessageVisible(doc, { userId: LACKER, grants: [] })).toBe(false)
    expect(isMessageVisible(doc, { userId: USER, grants: REQUESTER_SCOPES })).toBe(true)
  })

  it("a message posted by an approved re-entry is tagged, and a member lacking the scope cannot read it", async () => {
    const body = "invoice INV-1 total 1200, from the mailbox the turn read"
    const approvalId = await proposeInTurn("postScoped", { body }, [READ])
    expect(await storedScopesOf(approvalId)).toEqual([READ])

    await approve(approvalId)

    expect(await messageTag(body)).toEqual([READ])
    const [row] =
      await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG} AND content = ${body}`
    const messageId = row!.id as string
    expect(await messagesVisibleTo(USER, REQUESTER_SCOPES)).toContain(messageId)
    expect(await messagesVisibleTo(LACKER, [])).not.toContain(messageId)
  })

  it("a conditionalGate approval records the proposing turn's scopes too", async () => {
    const created = await runContextStore.run(turnFrame([READ]), () =>
      runWithToolCallScopesBefore([READ], () =>
        createHandlerApprovalRequest({
          orgId: ORG,
          requestedBy: USER,
          actorScopes: REQUESTER_SCOPES,
          defaultAppName: "fx4_test",
          threadId: THREAD,
          origin: "in-app-agent",
          input: {
            tool_name: "fx4_test:postScoped",
            summary: "gated mid-handler",
            current_payload: { body: "conditional gate body" },
          },
        }),
      ),
    )
    expect(await storedScopesOf(created.approval_id as string)).toEqual([READ])
  })

  it("an approval with no recorded scopes falls back to the requester's scope set, never to the empty set", async () => {
    const body = "written by a re-entry whose proposing turn was never recorded"
    const approvalId = await proposeInTurn("postScoped", { body }, [READ])
    // Exactly what an approval created before migration 0067 looks like.
    await sql`UPDATE kernel.approval_requests SET proposing_turn_scopes = NULL
      WHERE id = ${approvalId}`

    await approve(approvalId)

    // The requester's scope set, as a turn's taint records it (its read projection).
    expect(await messageTag(body)).toEqual(REQUESTER_TAINT)
    const [row] =
      await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG} AND content = ${body}`
    expect(await messagesVisibleTo(LACKER, [])).not.toContain(row!.id as string)
  })

  it("re-staging the same keyed action unions the later turn's scopes into the recorded set", async () => {
    const first = await proposeInTurn("dedupedPost", { dedupeKey: "k1", body: "first draft" }, [
      READ,
    ])
    expect(await storedScopesOf(first)).toEqual([READ])

    // A later turn, which read something else, restages the SAME keyed action.
    const second = await proposeInTurn("dedupedPost", { dedupeKey: "k1", body: "second draft" }, [
      OTHER_READ,
    ])
    expect(second).toBe(first)
    expect(await storedScopesOf(first)).toEqual([READ, OTHER_READ].sort())
  })

  it("an untainted proposal still writes the empty assertion and stays visible to the room", async () => {
    const body = "nothing scoped was read before this was proposed"
    const approvalId = await proposeInTurn("postScoped", { body }, [])
    expect(await storedScopesOf(approvalId)).toEqual([])

    await approve(approvalId)

    expect(await messageTag(body)).toEqual([])
    const [row] =
      await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG} AND content = ${body}`
    expect(await messagesVisibleTo(LACKER, [])).toContain(row!.id as string)
  })
})

describe("the FX4 scope resolvers", () => {
  it("a proposal made outside any turn records the empty positive assertion", () => {
    expect(proposingTurnWriteScopes()).toEqual([])
  })

  it("a proposal made inside a turn records that turn's accumulated scopes", () => {
    const accumulator = createTurnScopeAccumulator()
    accumulator.recordInjected(["b:read", "a:read", "a:read"])
    const frame: RunContext = {
      runId: "r",
      parentRunId: null,
      rootRunId: "r",
      nestingDepth: 0,
      turnScopeAccumulator: accumulator,
    }
    expect(runContextStore.run(frame, () => proposingTurnWriteScopes())).toEqual([
      "a:read",
      "b:read",
    ])
  })

  it("a turn whose taint is unknowable records nothing, so the re-entry can fail closed", () => {
    const frame: RunContext = { runId: "r", parentRunId: null, rootRunId: "r", nestingDepth: 0 }
    expect(runContextStore.run(frame, () => proposingTurnWriteScopes())).toBeNull()
  })

  it("recorded scopes are used as they stand, sorted and deduplicated", () => {
    expect(approvalReentryWriteScopes(["b:read", "a:read", "a:read"], ["x:read"])).toEqual([
      "a:read",
      "b:read",
    ])
  })

  it("a recorded empty set is a positive assertion, not a missing value", () => {
    expect(approvalReentryWriteScopes([], ["x:read"])).toEqual([])
  })

  it("nothing recorded falls back to the requester's scope set", () => {
    expect(approvalReentryWriteScopes(null, ["b:read", "a:read"])).toEqual(["a:read", "b:read"])
    expect(approvalReentryWriteScopes(undefined, ["a:read"])).toEqual(["a:read"])
  })

  it("nothing recorded and no requester scopes to fall back on is refused", () => {
    expect(() => approvalReentryWriteScopes(null, [])).toThrow(/scope_unknown/)
    expect(() => approvalReentryWriteScopes(null, undefined)).toThrow(/scope_unknown/)
  })

  it("an unreadable recorded value is refused rather than treated as the empty set", () => {
    expect(() => approvalReentryWriteScopes("mail:read", ["a:read"])).toThrow(/scope_unknown/)
    expect(() => approvalReentryWriteScopes({ 0: "mail:read" }, ["a:read"])).toThrow(
      /scope_unknown/,
    )
    expect(() => approvalReentryWriteScopes(["mail:read", 7], ["a:read"])).toThrow(/scope_unknown/)
  })
})
