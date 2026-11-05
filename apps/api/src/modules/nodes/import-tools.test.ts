// SPDX-License-Identifier: FSL-1.1-ALv2
//
// W3 T10 (S42, A46, A55, D46): the person's agent lists and searches their
// importable Claude Code sessions only in their own live turn in a private
// conversation, and offers an import only as an approval card the node's
// owner clicks. The card is `noAutoApprove`: no org policy, on the tool or on
// `kernel:*`, starts an import, and no edit can swap the candidate under it.
// Every call goes through the real registry and dispatch (executeTool).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { handleToolCall } from "~/modules/mcp/tool-call"
import { SESSION_DATA_NOTICE } from "~/modules/node-sessions/agent-tools"
import { createNodeJob } from "~/modules/nodes/jobs"
import * as minimal from "~/seed/tiers/minimal"
import {
  answeringImports,
  checkOk,
  connectImportNode,
  enableImportNode,
  type FakeNode,
  type FakeWs,
  IMPORT_HAIKU,
  importRow,
  listAndCheck,
} from "~/tests/helpers/import-node"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { shareFolderPreflight } from "./folder-tools"

const LIST = "computer_session_import_list"
const IMPORT = "computer_session_import"

describe("the agent's session import tools (W3 T10)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let admin: minimal.Session
  let agentId: string
  let dm: string
  let shared: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const actorOf = (s: minimal.Session): UserContext => ({
    actorType: "user",
    userId: s.userId,
    orgId: s.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  /** The person's own live turn: a message they typed to their agent. */
  function turn(extra: Partial<RunContext> = {}): RunContext {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
      humanTurn: true,
      ...extra,
    }
  }

  /** A tool call by the owner's agent, through executeTool, inside `frame`, in `thread`. */
  async function call(
    name: string,
    params: Record<string, unknown>,
    frame: RunContext = turn(),
    thread: string = dm,
  ): Promise<any> {
    return runContextStore.run(frame, () =>
      executeTool({
        toolName: `kernel:${name}`,
        orgId: owner.orgId,
        actor: actorOf(owner),
        origin: "in-app-agent",
        params,
        threadId: thread,
      }),
    )
  }

  async function online(): Promise<FakeNode> {
    const node = await enableImportNode(owner)
    sockets.push(await connectImportNode(manager, node))
    return node
  }

  const importFrames = (node: FakeNode) =>
    (node.ws?.frames ?? []).filter((f) => f.type === "node_import_request").length

  /** Lists through the agent's tool while the node answers `rows`. */
  async function listed(node: FakeNode, rows: unknown[], frame = turn(), thread = dm) {
    const nodeSide = answeringImports(node, listAndCheck(rows))
    const res = await call(LIST, {}, frame, thread)
    await nodeSide.done()
    return res
  }

  /** A candidate minted by the agent's own listing. */
  async function candidate(node: FakeNode, id = crypto.randomUUID()): Promise<string> {
    const res = await listed(node, [importRow(id)])
    const c = res.data?.rows?.[0]?.candidateId
    if (typeof c !== "string") throw new Error(`no candidate: ${JSON.stringify(res)}`)
    return c
  }

  async function counts() {
    const [row] = await sql<Array<{ sessions: number; jobs: number }>>`
      SELECT (SELECT count(*)::int FROM kernel.node_sessions
                WHERE org_id = ${owner.orgId} AND source = 'import') AS sessions,
             (SELECT count(*)::int FROM kernel.node_jobs
                WHERE org_id = ${owner.orgId} AND kind = 'follow') AS jobs`
    return row
  }

  async function approvalRow(id: string) {
    const [row] = await sql<
      Array<{ status: string; thread_id: string; resource_owner_id: string | null }>
    >`SELECT status, thread_id, resource_owner_id FROM kernel.approval_requests WHERE id = ${id}`
    return row
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE approval_request_id IN
                (SELECT id FROM kernel.approval_requests WHERE org_id = ${owner.orgId})`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await sql`UPDATE kernel.threads SET tainted = false WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    other = await minimal.session(org.id)
    admin = await minimal.session(org.id, { role: "admin" })
    agentId = await withPrivilegedDb(owner.orgId, "test", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: owner.orgId, userId: owner.userId }),
    )
    // The owner's DM with their personal agent: one human, one agent seat.
    dm = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
              VALUES (${dm}, ${agentId}, ${owner.orgId}, 'agent')`
    // A conversation with another member of the org.
    shared = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${shared}, ${other.userId}, ${owner.orgId})`
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    await registerKernelAgentTools(owner.orgId)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    if (owner) await cleanup()
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("S42: list in a human-typed turn of the owner in a DM with the personal agent returns candidates fenced as session data and marks the turn untrusted", async () => {
    const node = await online()
    const res = await listed(node, [
      importRow(crypto.randomUUID(), { title: "Fix <b>the</b> build" }),
      importRow(crypto.randomUUID(), { from: "liaison", worktreePath: "/tmp/code-wt" }),
    ])
    expect(res.error).toBeUndefined()
    const out = res.data
    expect(out.status).toBe("listed")
    expect(out.notice).toBe(SESSION_DATA_NOTICE)
    expect(out.rows).toHaveLength(2)
    const [vscode, own] = out.rows
    expect(vscode.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(vscode.title).toBe("<session-data>Fix ‹b›the‹/b› build</session-data>")
    expect(vscode.firstPrompt).toBe("<session-data>fix the build please</session-data>")
    expect(vscode.folder).toBe("<session-data>code</session-data>")
    expect(vscode.subdir).toBe("<session-data>app</session-data>")
    // D53: the worktree a row ran in is named, fenced; none otherwise.
    expect(vscode.worktree).toBeNull()
    expect(out.rows[1].worktree).toBe("<session-data>/tmp/code-wt</session-data>")
    expect(vscode.branch).toBe("<session-data>main</session-data>")
    expect(vscode).toMatchObject({
      from: "vscode",
      liveNow: false,
      inLiaison: null,
      sizeBytes: 4096,
    })
    // No CLI id ever reaches the agent.
    expect(JSON.stringify(out)).not.toContain("sdkSessionId")
    // Liaison's own session: nothing to import.
    expect(own.candidateId).toBeNull()
    const [thread] = await sql<Array<{ tainted: boolean }>>`
      SELECT tainted FROM kernel.threads WHERE id = ${dm}`
    expect(thread.tainted).toBe(true)
  })

  it("S19: list asks with detail and surfaces folder counts, unshared groups by candidateId and skipped; `folder` lists one folder", async () => {
    const node = await online()
    const TOKEN = "ab".repeat(16)
    const nodeSide = answeringImports(node, async (op) => ({
      ok: true,
      data: {
        rows: [importRow(crypto.randomUUID())],
        truncated: false,
        ...(op.detail
          ? {
              folders: [{ name: "code", sessions: 230 }],
              unshared: [
                {
                  name: "site",
                  display: "~/work/site",
                  token: TOKEN,
                  sessions: 3,
                  lastModified: 1_760_000_000_000,
                  refusal: null,
                },
                {
                  name: "scratch",
                  display: "scratch",
                  token: null,
                  sessions: 1,
                  lastModified: 1_760_000_000_000,
                  refusal: "outside_search",
                },
              ],
              skipped: 2,
              unsharedPartial: true,
            }
          : {}),
      },
    }))
    const res = await call(LIST, {})
    const one = await call(LIST, { folder: "<session-data>code</session-data>" })
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([
      { kind: "list", detail: true },
      { kind: "list", detail: true, folder: "code" },
    ])
    const out = res.data
    expect(out.status).toBe("listed")
    expect(out.folders).toEqual([{ name: "<session-data>code</session-data>", sessions: 230 }])
    expect(out.skipped).toBe(2)
    expect(out.unsharedPartial).toBe(true)
    const [site, scratch] = out.unshared
    expect(site).toMatchObject({
      name: "<session-data>site</session-data>",
      display: "<session-data>~/work/site</session-data>",
      sessions: 3,
      refusal: null,
    })
    expect(site.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(scratch).toMatchObject({ candidateId: null, refusal: "outside_search", sessions: 1 })
    // The node's proof never reaches the agent; the id shares the folder like a lookup's.
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(
      await shareFolderPreflight(
        { candidateId: site.candidateId },
        { orgId: owner.orgId, userId: owner.userId },
      ),
    ).toEqual({ ok: true })
    expect(one.data.status).toBe("listed")
    // The description says what each field means and where to go next.
    const def = toolRegistry.get([owner.orgId, "kernel", LIST])
    for (const word of [
      "unshared",
      "skipped",
      "kernel__share_folder_on_my_computer",
      "outside_search",
      "computers",
    ]) {
      expect(def?.description).toContain(word)
    }
  })

  it("S42: list in a thread with another human → E_IMPORT_PRIVATE_THREAD and no node request", async () => {
    const node = await online()
    const res = await listed(node, [importRow(crypto.randomUUID())], turn(), shared)
    expect(res.data).toMatchObject({ status: "refused", reason: "E_IMPORT_PRIVATE_THREAD" })
    expect(importFrames(node)).toBe(0)
  })

  it("S42: list from a routine, an agents_ask callee, a background run, and a node session → refused, no node request", async () => {
    const node = await online()
    const outsiders: Record<string, RunContext> = {
      routine: turn({ routineId: crypto.randomUUID(), humanTurn: false }),
      agentAsk: turn({ coordinated: true, coordinatedBy: "agent", humanTurn: false }),
      background: turn({ background: true, humanTurn: false }),
      subRun: turn({ nestingDepth: 1, parentRunId: crypto.randomUUID(), humanTurn: false }),
      gatewayWithoutTurn: turn({ mcpGateway: true, humanTurn: false }),
    }
    for (const [who, frame] of Object.entries(outsiders)) {
      const res = await listed(node, [importRow(crypto.randomUUID())], frame)
      expect({ who, res: res.data }).toMatchObject({
        who,
        res: { status: "refused", reason: "interactive_only" },
      })
    }
    // A session running on the computer: its MCP connection neither lists nor runs them.
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: dm,
      source: "dispatch",
      prompt: "x",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: { source: "dispatch", configKind: "owner", model: IMPORT_HAIKU, level: "strict" },
    })
    const connectionId = crypto.randomUUID()
    await sql`UPDATE kernel.node_jobs SET mcp_connection_id = ${connectionId} WHERE id = ${job.id}`
    for (const [name, args] of [
      [`kernel__${LIST}`, {}],
      [`kernel__${IMPORT}`, { candidateId: crypto.randomUUID(), mode: "follow" }],
    ] as const) {
      const res = await handleToolCall(
        {
          orgId: owner.orgId,
          actor: actorOf(owner),
          connectionId,
          ownerUserId: owner.userId,
          agentId,
          connectionThreadId: null,
          discovered: new Set(),
        },
        name,
        args as Record<string, unknown>,
      )
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain("not_from_a_session")
    }
    expect(importFrames(node)).toBe(0)
  })

  it("S42: list from a valid gateway turn (D37) → allowed", async () => {
    const node = await online()
    const res = await listed(
      node,
      [importRow(crypto.randomUUID())],
      turn({
        mcpGateway: true,
        gatewayTurn: { threadId: dm, messageId: crypto.randomUUID() },
        humanTurn: false,
      }),
    )
    expect(res.data?.status).toBe("listed")
    expect(res.data.rows[0].candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(importFrames(node)).toBe(1)
  })

  it("S42: import parks as an approval in the person's conversation; nothing reaches the node before approval", async () => {
    const node = await online()
    const c = await candidate(node)
    const before = importFrames(node)
    const res = await call(IMPORT, { candidateId: c, mode: "follow" })
    const approvalId = res.blocked?.approvalRequestId as string
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await approvalRow(approvalId)).toMatchObject({
      status: "pending",
      thread_id: dm,
      resource_owner_id: owner.userId,
    })
    expect(importFrames(node)).toBe(before)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
    // The card says what, from where, on which computer, and how long the offer lasts.
    const [card] = await sql<Array<{ summary: any }>>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${approvalId}`
    const text = JSON.stringify(card.summary)
    expect(text).toContain('Follow \\"Fix the build\\" from code')
    expect(text).toContain("This offer is valid for 1 hour.")
  })

  it("S42: an import approval decided by another member (an org admin) never starts the import", async () => {
    const node = await online()
    const c = await candidate(node)
    const res = await call(IMPORT, { candidateId: c, mode: "take_over" })
    const approvalId = res.blocked?.approvalRequestId as string
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)
    const before = importFrames(node)
    await expect(
      decideApproval({
        orgId: owner.orgId,
        requestId: approvalId,
        actor: { ...actorOf(admin), scopes: ["*", "kernel:approve"] },
        decision: "approve",
      }),
    ).rejects.toThrow()
    expect((await approvalRow(approvalId)).status).toBe("pending")
    // The handler itself, run as another approver, refuses before any node call.
    const def = toolRegistry.get([owner.orgId, "kernel", IMPORT])
    const direct = await (def!.handler as (p: unknown, c: unknown) => Promise<unknown>)(
      { candidateId: c, mode: "take_over" },
      { orgId: owner.orgId, userId: owner.userId, approverUserId: admin.userId } as never,
    )
    expect(direct).toMatchObject({ status: "refused", reason: "not_owner" })
    expect(importFrames(node)).toBe(before)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("S42: preflight refuses a candidate of another user and a shared thread", async () => {
    const node = await online()
    const c = await candidate(node)
    // A candidate minted for the owner, named by another user's agent: no card.
    const foreign = await runContextStore
      .run(turn(), () =>
        executeTool({
          toolName: `kernel:${IMPORT}`,
          orgId: other.orgId,
          actor: actorOf(other),
          origin: "in-app-agent",
          params: { candidateId: c, mode: "follow" },
          threadId: shared,
        }),
      )
      .then(
        () => null,
        (e: { code?: string }) => e.code,
      )
    expect(foreign).toBe("NOT_FOUND")
    // The owner's own candidate, offered in a conversation with another human: no card.
    const inShared = await call(IMPORT, { candidateId: c, mode: "follow" }, turn(), shared).then(
      () => null,
      (e: { code?: string }) => e.code,
    )
    expect(inShared).toBe("E_IMPORT_PRIVATE_THREAD")
    const [n] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${owner.orgId}`
    expect(n.n).toBe(0)
    // The candidate was not consumed by either refusal.
    expect(await redis.exists(`nic:${c}`)).toBe(1)
  })

  it("S42: the owner's approval starts the follow (one row, one follow job)", async () => {
    const node = await online()
    const c = await candidate(node)
    const res = await call(IMPORT, { candidateId: c, mode: "follow" })
    const approvalId = res.blocked?.approvalRequestId as string
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => checkOk()),
    )
    await decideApproval({
      orgId: owner.orgId,
      requestId: approvalId,
      actor: actorOf(owner),
      decision: "approve",
    })
    await nodeSide.done()
    expect(nodeSide.ops.map((o) => o.kind)).toEqual(["check"])
    expect(await counts()).toEqual({ sessions: 1, jobs: 1 })
    const result = (await readDecidedResult(owner.orgId, approvalId)) as any
    expect(result).toMatchObject({ status: "started", mode: "follow" })
    const [row] = await sql<Array<{ id: string; import_mode: string; owner_user_id: string }>>`
      SELECT id, import_mode, owner_user_id FROM kernel.node_sessions
       WHERE org_id = ${owner.orgId} AND source = 'import'`
    expect(row).toMatchObject({ import_mode: "follow", owner_user_id: owner.userId })
    expect(result.sessionId).toBe(row.id)
  })

  it("S42/A55: with an org auto-approve policy on kernel:* (and one on the tool itself), computer_session_import still parks for the owner's click and nothing reaches the node", async () => {
    const node = await online()
    const c = await candidate(node)
    await sql`INSERT INTO kernel.auto_approve_policies
                (org_id, tool_name, enabled, allow_after_untrusted_content)
              VALUES (${owner.orgId}, 'kernel:*', true, true),
                     (${owner.orgId}, ${`kernel:${IMPORT}`}, true, true)`
    const before = importFrames(node)
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => checkOk()),
    )
    const res = await call(IMPORT, { candidateId: c, mode: "follow" })
    await Bun.sleep(100)
    await nodeSide.done()
    expect(res.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await approvalRow(res.blocked.approvalRequestId)).status).toBe("pending")
    expect(nodeSide.ops).toEqual([])
    expect(importFrames(node)).toBe(before)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("A55: approval_update_payload on a computer_session_import card is refused (no editable field)", async () => {
    const node = await online()
    const c = await candidate(node)
    const swap = await candidate(node)
    const res = await call(IMPORT, { candidateId: c, mode: "follow" })
    const approvalId = res.blocked?.approvalRequestId as string
    const edited = await call("approval_update_payload", {
      requestId: approvalId,
      fields: { candidateId: swap },
    }).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    )
    expect(edited?.code).toBe("invalid_edit")
    expect(edited?.message).toContain("editable fields: (none)")
    const [card] = await sql<Array<{ current_payload: any }>>`
      SELECT current_payload FROM kernel.approval_requests WHERE id = ${approvalId}`
    expect(JSON.stringify(card.current_payload)).toContain(c)
    expect(JSON.stringify(card.current_payload)).not.toContain(swap)
  })

  it("m13: an approval after the candidate expired answers not_found with the list-again text", async () => {
    const node = await online()
    const c = await candidate(node)
    const res = await call(IMPORT, { candidateId: c, mode: "take_over" })
    const approvalId = res.blocked?.approvalRequestId as string
    // The hour is over: the candidate lapses while the card waits.
    await redis.del(`nic:${c}`)
    const before = importFrames(node)
    await decideApproval({
      orgId: owner.orgId,
      requestId: approvalId,
      actor: actorOf(owner),
      decision: "approve",
    })
    const result = (await readDecidedResult(owner.orgId, approvalId)) as any
    expect(result).toMatchObject({
      status: "refused",
      reason: "not_found",
      instruction: "This offer expired. List the sessions again.",
    })
    expect(importFrames(node)).toBe(before)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })
})
