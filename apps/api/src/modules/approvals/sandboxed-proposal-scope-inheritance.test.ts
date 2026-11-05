// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * FX13 -- a gated call made through a SANDBOXED app records the REAL proposing
 * turn.
 *
 * FX4 puts the proposing turn's scopes on the approval row so the approved
 * re-entry writes a tagged row rather than a world-readable one. It reads them
 * with `proposingTurnWriteScopes()`, which consults the LIVE run frame. But a
 * sandboxed app's `ctx.executeTool` callback runs in a worker-pool hop that has
 * already LOST that frame, so the read answered "no turn proposed this" and
 * recorded `[]` -- the positive assertion that nothing scoped was read. The
 * approved re-entry then wrote an UNTAGGED row every member of the room can
 * read, while the identical ungated call carried the turn's scopes. FX4's
 * protection was defeated on exactly that path.
 *
 * The value therefore travels the way the read-only mark (FX10a) and the turn's
 * taint (FX12) already travel: captured at bridge construction where the frame
 * is still live, forwarded across the hop, and preferred over the blind
 * in-frame read. It is FX12's OWN captured value, reused rather than captured a
 * fourth time, so what a write is JUDGED against and what its approval RECORDS
 * can never drift apart.
 *
 * Every dispatch below is made with NO frame active, exactly as a worker-pool
 * callback is, and every bridge is built inside the frame, exactly as
 * `executeToolHandler` builds it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000065001"
const USER = "00000000-0000-4000-8000-000000065002"
const LACKER = "00000000-0000-4000-8000-000000065003"
const THREAD = "00000000-0000-4000-8000-000000065004"

const APP = "fx13_test"
/** The scoped data the calling turn READ: what makes the turn tainted. */
const READ = "mail:messages:read"
/** The gated tool's own write scope. Not a data read, so never the tag. */
const WRITE = `${APP}:gated:write`
/** Deliberately NOT held by the sandboxed actor, so the gate always holds. */
const APPROVE = `${APP}:approve`
/**
 * Exactly what USER is granted in the database: the fail-closed fallback set. A
 * member who writes threads reads them too, and must: the re-entry tags the row
 * with the READ projection of this set, and a writer has to be able to read back
 * the row it writes (INSERT ... RETURNING is checked against the read policy).
 */
const REQUESTER_GRANTS = [READ, WRITE, APPROVE, "kernel:threads:read", "kernel:threads:write"]
/**
 * REQUESTER_GRANTS as a turn's scope taint records them: every scope lands on
 * its catalogued read sibling, and this fixture app's own write and approve
 * scopes, which have none, are dropped (scope-taint-read-projection.test.ts).
 */
const REQUESTER_TAINT = ["kernel:threads:read", READ]

/** The human who decides. Holds the approve scope; the proposing actor does not. */
function approver(): UserContext {
  return {
    actorType: "user",
    userId: USER,
    orgId: ORG,
    scopes: REQUESTER_GRANTS,
    dimensionGrants: {},
  }
}

/**
 * The actor the sandboxed app dispatches as. It may CALL the gated tool but may
 * not approve it, which is what forces the gated branch: the bridge forwards no
 * `origin`, so a self-approving actor would take the direct-human bypass and
 * never stage an approval at all.
 */
function sandboxActor(scopes: string[]): UserContext {
  return { actorType: "user", userId: USER, orgId: ORG, scopes, dimensionGrants: {} }
}

function posterManifest(): Record<string, unknown> {
  return {
    name: APP,
    trusted: true,
    capabilities: ["messages.post"],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

/**
 * The bridge never touches its own transaction on this path: `ctx.executeTool`
 * dispatches through `executeToolCore`, which opens its own. A db access here
 * would mean the test is exercising something else, so it throws.
 */
function poison(): RlsClient {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined
        throw new Error(`unexpected sandbox-bridge db access via txDb.${String(prop)}`)
      },
    },
  ) as RlsClient
}

function frameOf(extra: Partial<RunContext>): RunContext {
  return {
    runId: "00000000-0000-4000-8000-0000000650ff",
    parentRunId: null,
    rootRunId: "00000000-0000-4000-8000-0000000650ff",
    nestingDepth: 0,
    ...extra,
  }
}

/** A proposing turn whose accumulator has already read `accumulated`. */
function turnFrame(accumulated: string[]): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(accumulated)
  return frameOf({ effectiveScope: REQUESTER_GRANTS, turnScopeAccumulator })
}

type Envelope = {
  data?: unknown
  blocked?: { approvalRequestId?: string }
  error?: { code?: string; message?: string }
}

/**
 * Build the sandboxed app's bridge where the frame is live (as
 * `executeToolHandler` does) and dispatch where it is not (as the QuickJS
 * worker callback does). `callerScopes` is left UNSET for the undeterminable
 * case: the bridge's actor still carries real scopes through `bridgeOptions`,
 * so the call is dispatchable while nothing can answer what the turn read.
 */
function bridgeFor(opts: {
  frame?: RunContext
  callerScopes?: string[]
  actorScopes?: string[]
  requestApprovalImpl?: (input: unknown, proposingTurnScopes?: string[] | null) => Promise<unknown>
}): Record<string, (...a: any[]) => Promise<string>> {
  const build = () =>
    createRpcBridge(
      APP,
      USER,
      ORG,
      poison(),
      posterManifest() as never,
      opts.callerScopes,
      "user",
      undefined,
      {
        actor: sandboxActor(opts.actorScopes ?? [READ, WRITE]) as never,
        threadId: THREAD,
        ...(opts.requestApprovalImpl
          ? { requestApprovalImpl: opts.requestApprovalImpl as never }
          : {}),
      },
    ) as Record<string, (...a: any[]) => Promise<string>>
  return opts.frame ? runContextStore.run(opts.frame, build) : build()
}

/** Propose the gated write from OUTSIDE the frame, as the sandbox hop does. */
async function proposeViaSandbox(
  frame: RunContext | undefined,
  body: string,
  extra: { callerScopes?: string[] } = {},
): Promise<string> {
  const bridge = bridgeFor({ frame, ...extra })
  const env = await runContextStore.exit(async () => {
    expect(runContextStore.getStore()).toBeUndefined()
    return JSON.parse(
      await bridge.executeTool!(`${APP}:postScoped`, JSON.stringify({ body })),
    ) as Envelope
  })
  if (!env.blocked?.approvalRequestId) {
    throw new Error(`expected the call to be gated, got ${JSON.stringify(env)}`)
  }
  return env.blocked.approvalRequestId
}

async function storedScopesOf(approvalId: string): Promise<string[] | null> {
  const [row] = await sql`SELECT proposing_turn_scopes FROM kernel.approval_requests
    WHERE id = ${approvalId}`
  return (row?.proposing_turn_scopes as string[] | null) ?? null
}

async function messageTag(body: string): Promise<string[] | undefined> {
  const [row] = await sql`SELECT required_scopes FROM kernel.messages
    WHERE org_id = ${ORG} AND content = ${body}`
  return row?.required_scopes as string[] | undefined
}

async function messageIdOf(body: string): Promise<string> {
  const [row] = await sql`SELECT id FROM kernel.messages
    WHERE org_id = ${ORG} AND content = ${body}`
  return row!.id as string
}

/** Message ids a member can actually SELECT under their own RLS context. */
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

describe("a gated call from a sandboxed app records the real proposing scopes (FX13)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX13 Sandbox Proposal Org', 'fx13-sandbox-proposal-org')
      ON CONFLICT DO NOTHING`
    for (const [id, email, name] of [
      [USER, "fx13-requester@test.com", "Requester"],
      [LACKER, "fx13-lacker@test.com", "Lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${name}, 'active', 'hash') ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx13-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    for (const [id, role] of [
      [USER, "admin"],
      [LACKER, "member"],
    ] as const) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${THREAD}, ${id}, ${ORG}, ${role}) ON CONFLICT DO NOTHING`
    }
    await grantScopes(USER, REQUESTER_GRANTS)
    await grantScopes(LACKER, [])

    // A GATED tool that posts a message through the production bridge on its
    // approved re-entry. It declares the messages sink so the FX12 taint guard
    // admits it: what is under test here is what the APPROVAL RECORDS, not
    // whether a tainted turn may reach an enforcing sink (FX12 pins that).
    toolRegistry.set([ORG, APP, "postScoped"], {
      appName: APP,
      name: "postScoped",
      description: "Posts a message quoting what the turn read",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async (params: any) =>
        withRlsContext(approver(), async (tx) => {
          const bridge = createRpcBridge(
            APP,
            USER,
            ORG,
            tx as never,
            posterManifest() as never,
            REQUESTER_GRANTS,
            "user",
            undefined,
            { actor: approver() as never, threadId: THREAD },
          ) as Record<string, (p: string) => Promise<string>>
          return JSON.parse(
            await bridge.messages_post!(JSON.stringify({ thread_id: THREAD, body: params.body })),
          )
        }),
    } as any)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("a tainted turn's sandboxed proposal records the turn's scopes, and the approved re-entry writes a row a lacking member cannot read", async () => {
    const body = "invoice INV-1 total 1200, from the mailbox the proposing turn read"
    const approvalId = await proposeViaSandbox(turnFrame([READ]), body, {
      callerScopes: [READ, WRITE],
    })

    // Recorded at DEFERRAL: the frame is gone by the time a human decides.
    const recorded = await storedScopesOf(approvalId)

    const decided = await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor: approver(),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")

    // One assertion, so a failing run reports the WHOLE leak at once rather
    // than stopping at the recorded value: before the fix this is
    // `{recorded: [], tag: [], lackerSees: true}` -- the approval says the turn
    // read nothing, and the re-entry publishes an untagged row to the room.
    const messageId = await messageIdOf(body)
    expect({
      recorded,
      tag: await messageTag(body),
      holderSees: (await messagesVisibleTo(USER, REQUESTER_GRANTS)).includes(messageId),
      lackerSees: (await messagesVisibleTo(LACKER, [])).includes(messageId),
    }).toEqual({ recorded: [READ], tag: [READ], holderSees: true, lackerSees: false })
  })

  it("an untainted turn's sandboxed proposal records the empty assertion and stays visible to the room", async () => {
    const body = "nothing scoped was read before this sandboxed proposal"
    const approvalId = await proposeViaSandbox(turnFrame([]), body, {
      callerScopes: [READ, WRITE],
    })

    expect(await storedScopesOf(approvalId)).toEqual([])

    await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor: approver(),
      decision: "approve",
    })

    expect(await messageTag(body)).toEqual([])
    expect(await messagesVisibleTo(LACKER, [])).toContain(await messageIdOf(body))
  })

  it("a sandboxed proposal whose turn is undeterminable records NOTHING, so the re-entry falls back to the requester's scope set", async () => {
    // A frame with no accumulator and no effective scope, reached with no caller
    // scopes either: nothing can answer what this turn read. FX4's contract is
    // to record SQL NULL -- never `[]` -- so the re-entry over-tags with the
    // requester's own scope set instead of publishing the write to the room.
    const body = "written by a re-entry whose proposing turn could not be determined"
    const approvalId = await proposeViaSandbox(frameOf({}), body)

    expect(await storedScopesOf(approvalId)).toBeNull()

    await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor: approver(),
      decision: "approve",
    })

    // The requester's scope set, as a turn's taint records it (its read projection).
    expect(await messageTag(body)).toEqual(REQUESTER_TAINT)
    expect(await messagesVisibleTo(LACKER, [])).not.toContain(await messageIdOf(body))
  })

  it("outside any turn a sandboxed proposal still records the empty assertion", async () => {
    // A cron, a job or a webhook builds its bridge with no frame at all. Nothing
    // was read, so today's behaviour stands and the re-entry writes untagged.
    const body = "proposed by a job, outside any agent turn"
    const approvalId = await proposeViaSandbox(undefined, body, { callerScopes: [READ, WRITE] })

    expect(await storedScopesOf(approvalId)).toEqual([])
  })

  it("ctx.requestApproval hands the handler-conditional gate the same captured scopes", async () => {
    // The other door into the same recording site: a handler that parks itself
    // mid-run. Its impl is injected by `executeToolHandler` and invoked from the
    // same frame-less callback, so it is handed the bridge's captured value
    // rather than being left to read a frame that is gone.
    const seen: Array<string[] | null | undefined> = []
    const bridge = bridgeFor({
      frame: turnFrame([READ]),
      callerScopes: [READ, WRITE],
      requestApprovalImpl: async (_input, proposingTurnScopes) => {
        seen.push(proposingTurnScopes)
        return { approval_id: "00000000-0000-4000-8000-0000000650aa" }
      },
    })

    await runContextStore.exit(async () =>
      bridge.requestApproval!(
        JSON.stringify({
          tool_name: `${APP}:postScoped`,
          summary: "parked mid-run",
          current_payload: { body: "conditional gate body" },
        }),
      ),
    )

    expect(seen).toEqual([[READ]])
  })

  it("createHandlerApprovalRequest records the scopes it is handed, with no frame of its own", async () => {
    // The receiving half of the hop above: called outside every frame, exactly
    // as the sandbox callback calls it, the forwarded value is what lands.
    const created = await runContextStore.exit(async () =>
      createHandlerApprovalRequest({
        orgId: ORG,
        requestedBy: USER,
        actorScopes: [READ, WRITE],
        defaultAppName: APP,
        threadId: THREAD,
        input: {
          tool_name: `${APP}:postScoped`,
          summary: "gated mid-handler",
          current_payload: { body: "handler-conditional body" },
        },
        proposingTurnScopes: [READ],
      }),
    )

    expect(await storedScopesOf(created.approval_id as string)).toEqual([READ])
  })
})
