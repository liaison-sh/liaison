// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T27, the P1a gate (S1, S5, S6, S7, S11, D24, D40, D49, K11): the whole
// server pipe end to end through the real routes, with a scripted node and
// nothing mocked between them.
//
// 1. The pipe. The personal agent's run_on_my_computer starts one session
//    and posts one card; the node gets an offer naming the agent, claims the
//    job (the session's folder path on this node and its model), and posts
//    its events in three batches built by the node's own `capEvent` and
//    `splitIntoBatches` and checked against the shared batch schema first:
//    one re-sent, one sent out of order (409 gap, then sent in order). The
//    events the OWNER'S SOCKET received, through the real event bus and the
//    real WebSocket manager, must equal a GET pull of the whole log (count,
//    order, and a digest of `(seq, type, parent, truncation, sha256(payload))`),
//    so a dropped, reordered or duplicated event, or one delivered to a
//    non-owner, fails it (K11: the socket against the pull, never GET against
//    GET). The result ends the session done with its summary; the result
//    route posts no message, and the session's post-back (S60) is the one
//    agent message after its card.
// 2. D24 end to end: the owner confirms Standard in the app, saves the
//    profile with it, a dispatch is claimed at Standard carrying that
//    confirmation, the node consumes it once (a second consume is 409), and
//    an app session at Open is 403 until its own session_start confirmation.
// 3. D49 at claim: the session's own repo is answered before its routine's.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  capEvent,
  type NodeSessionEvent,
  type NodeSessionEventIn,
  nodeSessionBatchSchema,
  splitIntoBatches,
} from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { _getGlobalHandlerCount, flushEventHandlers } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import { createNodeJob } from "~/modules/nodes/jobs"
import { handleRunOnMyComputer } from "~/modules/nodes/run-on-my-computer"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { NODE_SESSION_RESULT_KIND } from "./post-back"
import { canonicalJson } from "./routes-node"

const MODEL = "claude-haiku-4-5"
const MONOREPO_PATH = "/Users/owner/code/liaison-monorepo"
const KiB = 1024

interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
  frames: Array<Record<string, any>>
}

function fakeWs(): FakeWs {
  const ws: FakeWs = {
    frames: [],
    readyState: 1,
    send(data: string) {
      ws.frames.push(JSON.parse(data))
    },
    close() {},
  }
  return ws
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/** The fields a replay must reproduce, one line per event, in order. */
function tuples(events: ReadonlyArray<NodeSessionEvent>): string[] {
  return events.map((e) =>
    JSON.stringify([
      e.seq,
      e.type,
      e.parentToolUseId ?? null,
      e.truncated ?? false,
      e.fullBytes ?? null,
      sha256(canonicalJson(e.payload)),
    ]),
  )
}
const digest = (events: ReadonlyArray<NodeSessionEvent>) => sha256(tuples(events).join("\n"))

/** What a socket received of one session's events, in arrival order. */
function socketEvents(ws: FakeWs, sessionId: string): NodeSessionEvent[] {
  return ws.frames
    .filter(
      (f) =>
        f.type === "event" &&
        f.payload?.entity === "node_session_event" &&
        f.payload?.data?.sessionId === sessionId,
    )
    .map((f) => {
      const { ownerUserId: _o, sessionId: _s, ...event } = f.payload.data
      return event as NodeSessionEvent
    })
}

const sessionFrames = (ws: FakeWs) =>
  ws.frames.filter(
    (f) =>
      f.type === "event" &&
      (f.payload?.entity === "node_session" || f.payload?.entity === "node_session_event"),
  )

describe("the node session pipe through the real routes (P1-T27, P1a gate)", () => {
  let owner: minimal.Session
  let member: minimal.Session
  let agentId: string
  let threadId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const call = (
    path: string,
    method: string,
    body?: unknown,
    opts: { cred?: string; session?: minimal.Session } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${(opts.session ?? owner).bearer}`,
        ...(opts.cred ? { "X-Node-Credential": opts.cred, "X-Liaison-Node-Protocol": "2" } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  interface Node {
    nodeId: string
    credential: string
    deviceId: string
    ws: FakeWs
  }

  /** A node the owner enabled, publishing its folders and models, connected. */
  async function liveNode(): Promise<Node> {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await call("/api/nodes", "POST", { deviceId, name: "Studio Mac" })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const nodeId = d.node.id as string
    const credential = d.credential as string
    const caps = await call(
      `/api/nodes/${nodeId}/capabilities`,
      "PUT",
      {
        sharedFolders: [
          { name: "liaison-monorepo", path: MONOREPO_PATH, kind: "repo" },
          {
            name: "liaison-mcp-upload",
            path: "/Users/owner/code/liaison-mcp-upload",
            kind: "root",
          },
        ],
        models: [{ id: MODEL, label: "Haiku 4.5" }],
      },
      { cred: credential },
    )
    expect(caps.status).toBe(200)
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(owner.userId, ws, ["*"], owner.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), { deviceId })
    await onNodeConnectionHello({
      orgId: owner.orgId,
      userId: owner.userId,
      deviceId,
      connId: entry!.connId,
      nodeCredential: credential,
      bindConnection: (id) => manager.markNodeConnection(ws, id),
    })
    return { nodeId, credential, deviceId, ws }
  }

  /** A browser tab of `who`: a plain socket of theirs, receiving events only. */
  function webSocketOf(who: minimal.Session): FakeWs {
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(who.userId, ws, ["*"], who.orgId)
    return ws
  }

  const actor = (): UserContext => ({
    actorType: "user",
    userId: owner.userId,
    orgId: owner.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  function frame(): RunContext {
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
    }
  }

  /** The personal agent's tool call, as a chat turn makes it. */
  function dispatch(params: Record<string, unknown>) {
    return withRlsContext(actor(), (tx) =>
      runContextStore.run(frame(), () =>
        handleRunOnMyComputer(
          { task: "List the top-level files and summarise the README", ...params } as Parameters<
            typeof handleRunOnMyComputer
          >[0],
          {
            userId: owner.userId,
            orgId: owner.orgId,
            db: tx,
            agentExecutionThreadId: threadId,
            scopes: ["*"],
            actingAgentId: agentId,
          },
        ),
      ),
    )
  }

  const agentMessages = () =>
    sql<Array<{ id: string; content: string; metadata: Record<string, unknown> }>>`
      SELECT id, content, metadata FROM kernel.messages
       WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`

  /** Every event of a session, pulled page by page as a client heals (after=lastSeq). */
  async function pullAll(sessionId: string, limit = 5): Promise<NodeSessionEvent[]> {
    const out: NodeSessionEvent[] = []
    for (let page = 0; page < 100; page++) {
      const after = out.at(-1)?.seq ?? 0
      const res = await call(
        `/api/me/node-sessions/${sessionId}/events?after=${after}&limit=${limit}`,
        "GET",
      )
      expect(res.status).toBe(200)
      const { events } = (await json(res)).data as { events: NodeSessionEvent[] }
      if (events.length === 0) return out
      out.push(...events)
    }
    throw new Error("pull did not end")
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    member = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    // The real fan-out: the event bus's handlers deliver to this manager's
    // sockets, as the server wires them at boot. Registered once, here.
    expect(_getGlobalHandlerCount()).toBe(0)
    registerEventSubscribers(manager)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@pipe-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await cleanup()
    threadId = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
  })

  afterAll(async () => {
    if (owner) {
      await cleanup()
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("dispatch, claim, batches, replay and result: the owner's socket equals the pull, and nobody else hears it", async () => {
    const node = await liveNode()
    const ownerTab = webSocketOf(owner)
    const memberTab = webSocketOf(member)

    // ── dispatch: one session, one card ──
    const started = await dispatch({ folder: "liaison-mono", model: MODEL })
    expect(started).toMatchObject({
      status: "started",
      folder: "liaison-monorepo",
      model: MODEL,
      level: "strict",
    })
    const sessionId = started.sessionId as string
    const cards = await agentMessages()
    expect(cards).toHaveLength(1)
    expect(cards[0].metadata).toMatchObject({ kind: "node_session", sessionId })

    // ── offer: the node is told which job, for which agent ──
    const [session] = await sql<Array<{ job_id: string; status: string }>>`
      SELECT job_id, status FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(session.status).toBe("queued")
    const offers = node.ws.frames.filter((f) => f.type === "node_job_offer")
    expect(offers).toEqual([{ type: "node_job_offer", jobId: session.job_id, agentId }])
    const jobId = session.job_id

    // ── claim: the folder's path on this node and the model ──
    const claimed = await call(
      `/api/nodes/jobs/${jobId}/claim`,
      "POST",
      {},
      { cred: node.credential },
    )
    expect(claimed.status).toBe(200)
    const claim = (await json(claimed)).data
    expect(claim.session).toMatchObject({
      id: sessionId,
      folderPath: MONOREPO_PATH,
      folderName: "liaison-monorepo",
      model: MODEL,
      level: "strict",
      configKind: "owner",
    })
    const leaseGeneration = claim.leaseGeneration as number
    expect(
      (
        await call(
          `/api/nodes/jobs/${jobId}/started`,
          "POST",
          { leaseGeneration },
          {
            cred: node.credential,
          },
        )
      ).status,
    ).toBe(200)

    // ── the node's events, capped and batched by the node's own code ──
    let tick = Date.parse("2026-10-13T10:00:00.000Z")
    const ev = (
      type: NodeSessionEventIn["type"],
      payload: Record<string, unknown>,
      parentToolUseId?: string,
    ): NodeSessionEventIn => {
      tick += 250
      return capEvent({
        at: new Date(tick).toISOString(),
        type,
        payload,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      })
    }
    const sent: NodeSessionEventIn[] = [
      ev("system", {
        subtype: "start",
        text: "Session started",
        data: { sessionId: "sdk-1", claudeCode: "2.1.7 bundled /opt/claude", configDir: "/tmp/c" },
      }),
      ev("user_message", { text: "List the top-level files and summarise the README" }),
      ev("thinking", { text: "I should list the files first." }),
      ev("assistant_text", { text: "Looking at the repository." }),
      ev("tool_call", { id: "tu-task", name: "Task", input: { description: "Explore" } }),
      ev(
        "tool_call",
        { id: "tu-read", name: "Read", input: { file_path: "README.md" } },
        "tu-task",
      ),
      ev("tool_result", { id: "tu-read", isError: false, output: "# Liaison" }, "tu-task"),
      ev("tool_result", { id: "tu-task", isError: false, output: "Explored." }),
      ev("tool_call", { id: "tu-bash", name: "Bash", input: { command: "cat build.log" } }),
      // 70 KiB of output: the node cuts it to 64 KiB and says so.
      ev("tool_result", { id: "tu-bash", isError: false, output: "x".repeat(70 * KiB) }),
      ev("todo", {
        from: "TodoWrite",
        items: [
          { content: "List files", status: "completed" },
          { content: "Summarise", status: "in_progress" },
        ],
      }),
      ev("usage", { tokensIn: 1200, tokensOut: 300, model: MODEL }),
      ev("permission_request", {
        requestId: "req-1",
        tool: "Edit",
        input: { file_path: "notes.md" },
        reason: "a write",
      }),
      ev("decision", { requestId: "req-1", outcome: "allow", by: "owner" }),
      ev("assistant_text", { text: "Here is the summary." }),
      ev("result", {
        text: "The README describes the monorepo.",
        isError: false,
        subtype: "success",
      }),
    ]
    const capped = sent[9]
    expect(capped.truncated).toBe(true)
    expect(capped.fullBytes).toBeGreaterThan(70 * KiB)

    const batches = splitIntoBatches(sent, 32 * KiB)
    expect(batches.map((b) => b.length)).toEqual([9, 1, 6])
    const body = (batchNo: number) =>
      nodeSessionBatchSchema.parse({
        jobId,
        leaseGeneration,
        batchNo,
        events: batches[batchNo - 1],
      })
    const post = (batchNo: number) =>
      call(`/api/node/sessions/${sessionId}/events`, "POST", body(batchNo), {
        cred: node.credential,
      })

    const first = await post(1)
    expect(first.status).toBe(200)
    const afterFirst = (await json(first)).data.lastSeq as number
    // Re-sent (a lost reply): the same lastSeq, nothing stored twice.
    const resent = await post(1)
    expect(resent.status).toBe(200)
    expect((await json(resent)).data.lastSeq).toBe(afterFirst)
    // Out of order: refused with the batch expected, then sent in order.
    const early = await post(3)
    expect(early.status).toBe(409)
    expect((await json(early)).error).toMatchObject({ code: "gap", expectedBatchNo: 2 })
    expect((await post(2)).status).toBe(200)
    expect((await post(3)).status).toBe(200)

    // ── result: the session's, never a message ──
    const result = await call(
      `/api/nodes/jobs/${jobId}/result`,
      "POST",
      {
        leaseGeneration,
        text: "The README describes the monorepo.",
        completion: { by: "session" },
      },
      { cred: node.credential },
    )
    expect(result.status).toBe(201)
    expect((await json(result)).data).toEqual({ messageId: null })
    await flushEventHandlers()

    // ── replay: the whole log, paged as a client pulls it ──
    const pulled = await pullAll(sessionId)
    expect(pulled.map((e) => e.seq)).toEqual(pulled.map((_, i) => i + 1))
    // Every node event is there once, in the order it was sent, as sent
    // (server status events sit between them).
    // The node sent no status event: every one in the log is the server's.
    expect(sent.some((e) => e.type === "status")).toBe(false)
    const nodeOnes = pulled.filter((e) => e.type !== "status")
    expect(
      nodeOnes.map((e) => [e.type, e.parentToolUseId ?? null, sha256(canonicalJson(e.payload))]),
    ).toEqual(
      sent.map((e) => [e.type, e.parentToolUseId ?? null, sha256(canonicalJson(e.payload))]),
    )
    expect(
      pulled.find((e) => e.type === "tool_result" && e.payload.id === "tu-bash"),
    ).toMatchObject({ truncated: true, fullBytes: capped.fullBytes })
    // The server's own status events: created, claimed, the request, its decision, the result.
    expect(pulled.filter((e) => e.type === "status").map((e) => e.payload.status)).toEqual([
      "queued",
      "running",
      "waiting",
      "running",
      "done",
    ])
    // The one-shot GET answers the same log as the paged pull.
    const whole = (await json(await call(`/api/me/node-sessions/${sessionId}/events`, "GET"))).data
    expect(whole.lastSeq).toBe(pulled.length)
    expect(digest(whole.events)).toBe(digest(pulled))

    // ── K11: what the owner's socket received IS the log ──
    const heard = socketEvents(ownerTab, sessionId)
    expect(heard).toHaveLength(pulled.length)
    expect(tuples(heard)).toEqual(tuples(pulled))
    expect(digest(heard)).toBe(digest(pulled))
    // The owner's row frames end on the same lastSeq, done.
    const rows = ownerTab.frames.filter(
      (f) =>
        f.type === "event" &&
        f.payload?.entity === "node_session" &&
        f.payload.data.id === sessionId,
    )
    expect(rows.at(-1)?.payload.data).toMatchObject({ status: "done", lastSeq: pulled.length })
    // Another member of the org heard nothing of it.
    expect(sessionFrames(memberTab)).toEqual([])

    // ── the session is done with its summary; the result route posted no message ──
    const row = (await json(await call(`/api/me/node-sessions/${sessionId}`, "GET"))).data
    expect(row).toMatchObject({
      status: "done",
      resultSummary: "The README describes the monorepo.",
      lastSeq: pulled.length,
      tokensIn: 1200,
      tokensOut: 300,
      claudeCode: "2.1.7 bundled /opt/claude",
    })
    expect(row).not.toHaveProperty("folderPath")
    // The one agent message after the card is the session's post-back (S60): the
    // status hook writes it after the result's commit, off the request, so wait
    // for it rather than read the thread before or after it by chance.
    const deadline = Date.now() + 10_000
    let messages = await agentMessages()
    while (messages.length < 2 && Date.now() < deadline) {
      await Bun.sleep(20)
      messages = await agentMessages()
    }
    expect(messages).toHaveLength(2)
    expect(messages[0]?.id).toBe(cards[0]?.id)
    expect(messages[1]?.metadata).toMatchObject({ kind: NODE_SESSION_RESULT_KIND, sessionId })
    expect(messages[1]?.content).toContain("The README describes the monorepo.")
    // And the member cannot read it either.
    expect(
      (await call(`/api/me/node-sessions/${sessionId}`, "GET", undefined, { session: member }))
        .status,
    ).toBe(404)
  })

  it("D24: a raise confirmed in the app is claimed at Standard, consumed once, and Open needs its own confirmation", async () => {
    const node = await liveNode()
    const confirm = (body: Record<string, unknown>, cred?: string) =>
      call("/api/me/node-level-confirmations", "POST", body, cred ? { cred } : {})

    // Without a confirmation, Standard is not saved.
    const bare = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", {
      level: "standard",
      liaisonTools: true,
    })
    expect(bare.status).toBe(403)
    expect((await json(bare)).error).toMatchObject({
      code: "confirmation_required",
      nodeIds: [node.nodeId],
    })
    // A node never confirms its own raise.
    const byNode = await confirm(
      { nodeId: node.nodeId, agentId, level: "standard", purpose: "profile_raise" },
      node.credential,
    )
    expect(byNode.status).toBe(403)

    // The owner confirms in the app, then saves with it.
    const minted = await confirm({
      nodeId: node.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    expect(minted.status).toBe(201)
    const confirmationId = (await json(minted)).data.confirmationId as string
    const saved = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", {
      level: "standard",
      liaisonTools: true,
      confirmationIds: [confirmationId],
    })
    expect(saved.status).toBe(200)

    // A dispatch runs at the profile's Standard; its claim carries the confirmation.
    const started = await dispatch({ folder: "liaison-monorepo", model: MODEL })
    expect(started).toMatchObject({ status: "started", level: "standard" })
    const [s] = await sql<Array<{ job_id: string }>>`
      SELECT job_id FROM kernel.node_sessions WHERE id = ${started.sessionId as string}`
    const claimed = await call(
      `/api/nodes/jobs/${s.job_id}/claim`,
      "POST",
      {},
      {
        cred: node.credential,
      },
    )
    expect(claimed.status).toBe(200)
    expect((await json(claimed)).data.session).toMatchObject({
      level: "standard",
      profileLevel: "standard",
      profileConfirmationId: confirmationId,
    })

    // The node uses it up once.
    const consume = () =>
      call(
        `/api/node/level-confirmations/${confirmationId}/consume`,
        "POST",
        { agentId, level: "standard" },
        { cred: node.credential },
      )
    const once = await consume()
    expect(once.status).toBe(200)
    expect((await json(once)).data).toMatchObject({ purpose: "profile_raise", level: "standard" })
    const twice = await consume()
    expect(twice.status).toBe(409)
    expect((await json(twice)).error.code).toBe("confirmation_consumed")

    // An app session at Open from this Standard profile asks for its own confirmation.
    const start = (extra: Record<string, unknown> = {}) =>
      call("/api/me/node-sessions", "POST", {
        prompt: "Tidy the notes",
        folderName: "liaison-monorepo",
        model: MODEL,
        agentId,
        level: "open",
        ...extra,
      })
    const refused = await start()
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.code).toBe("confirmation_required")
    const forOpen = await confirm({
      nodeId: node.nodeId,
      agentId,
      level: "open",
      purpose: "session_start",
    })
    expect(forOpen.status).toBe(201)
    const accepted = await start({ confirmationId: (await json(forOpen)).data.confirmationId })
    expect(accepted.status).toBe(201)
    expect((await json(accepted)).data).toMatchObject({ level: "open", source: "app" })
  })

  it("D49: the claim answers the session's own repo before its routine's", async () => {
    const node = await liveNode()
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type, repo)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user',
              'git@github.com:example-org/routine-repo.git') RETURNING id`
    const routineJob = (repo: string | null) =>
      createNodeJob({
        orgId: owner.orgId,
        ownerUserId: owner.userId,
        agentId,
        threadId,
        source: "routine",
        routineId: routine.id,
        prompt: "Nightly check",
        sourceRequiredScopes: [],
        session: { source: "routine", configKind: "owner", repo, model: MODEL, level: "strict" },
      })
    const claimRepo = async (jobId: string) => {
      const res = await call(
        `/api/nodes/jobs/${jobId}/claim`,
        "POST",
        {},
        { cred: node.credential },
      )
      expect(res.status).toBe(200)
      const d = (await json(res)).data
      return { repo: d.session.repo as string | null, leaseGeneration: d.leaseGeneration as number }
    }

    const own = await routineJob("git@github.com:example-org/session-repo.git")
    const first = await claimRepo(own.id)
    expect(first.repo).toBe("git@github.com:example-org/session-repo.git")
    // Free the node (one running job per node), then the routine's own repo.
    expect(
      (
        await call(
          `/api/nodes/jobs/${own.id}/fail`,
          "POST",
          { leaseGeneration: first.leaseGeneration, error: "stopped by the test" },
          { cred: node.credential },
        )
      ).status,
    ).toBe(200)
    const plain = await routineJob(null)
    expect((await claimRepo(plain.id)).repo).toBe("git@github.com:example-org/routine-repo.git")
  })
})
