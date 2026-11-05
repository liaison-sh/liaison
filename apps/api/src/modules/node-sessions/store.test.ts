// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T10: the node session store (D33, D40). Real database: a session of a
// running job held by a node, batches appended with server-numbered seqs,
// fenced by node and lease generation, idempotent by batch number and body
// hash, projected into the row, and fanned out to the owner only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { NodeSessionEventIn } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { nodes } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import type { NodeRow } from "~/modules/nodes/credentials"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  appendServerEvents,
  createSessionForJob,
  fanOut,
  frameRow,
  ingestBatch,
  type NodeSessionRow,
  publicRow,
} from "./store"

let orgId: string
let userId: string
let node: NodeRow
let otherNode: NodeRow
let jobId: string
let sessionId: string

const at = () => new Date().toISOString()
const text = (t: string): NodeSessionEventIn => ({
  at: at(),
  type: "assistant_text",
  payload: { text: t },
})

async function seedNode(name: string): Promise<NodeRow> {
  return withSystemDb("store-test-node", async (tx) => {
    const [row] = await tx
      .insert(nodes)
      .values({ orgId, ownerUserId: userId, deviceId: `dev-${crypto.randomUUID()}`, name })
      .returning()
    return row
  })
}

async function events(id = sessionId) {
  return withSystemDb("store-test-read", async (tx) =>
    extractRows<{
      seq: number
      type: string
      payload: Record<string, unknown>
      truncated: boolean
      full_bytes: number | null
    }>(
      await tx.execute(drizzleSql`
        SELECT seq, type, payload, truncated, full_bytes FROM kernel.node_session_events
        WHERE session_id = ${id} ORDER BY seq`),
    ),
  )
}

async function sessionRow(id = sessionId): Promise<Record<string, unknown>> {
  return withSystemDb(
    "store-test-row",
    async (tx) =>
      extractRows<Record<string, unknown>>(
        await tx.execute(drizzleSql`SELECT * FROM kernel.node_sessions WHERE id = ${id}`),
      )[0],
  )
}

const batch = (batchNo: number, evs: NodeSessionEventIn[], leaseGeneration = 1) => ({
  jobId,
  leaseGeneration,
  batchNo,
  events: evs,
})

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(releaseTestLock)

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  userId = await withSystemDb(
    "store-test-user",
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
        ),
      )[0].id,
  )
  node = await seedNode("Laptop")
  otherNode = await seedNode("Desktop")
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
  const agentId = await withSystemDb(
    "store-test-agent",
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${orgId}, 'role', ${`store${suffix}`}, 'Store', '["*"]'::jsonb) RETURNING id`),
      )[0].id,
  )
  jobId = await withSystemDb(
    "store-test-job",
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.node_jobs
          (org_id, owner_user_id, agent_id, node_id, source, prompt, status, lease_holder, lease_generation)
        VALUES (${orgId}, ${userId}, ${agentId}, ${node.id}, 'app', 'Fix the build', 'running',
          ${node.id}, 1)
        RETURNING id`),
      )[0].id,
  )
  const created = await withPrivilegedDb(orgId, "store-test-create", (tx) =>
    createSessionForJob(tx, {
      job: { id: jobId, orgId, ownerUserId: userId, agentId },
      source: "app",
      configKind: "owner",
      prompt: "Fix the build\nand tell me",
      folderName: "liaison",
      folderPath: "/Users/someone/code/liaison",
      model: "claude-haiku-4-5",
      level: "strict",
    }),
  )
  sessionId = created.row.id
  // What the claim does (T17): the claiming node and the running status.
  await withSystemDb("store-test-claim", async (tx) => {
    await tx.execute(
      drizzleSql`UPDATE kernel.node_sessions SET node_id = ${node.id} WHERE id = ${sessionId}`,
    )
  })
  await withPrivilegedDb(orgId, "store-test-running", (tx) =>
    appendServerEvents(tx, orgId, sessionId, [
      { at: at(), type: "status", payload: { status: "running" } },
    ]),
  )
})

describe("node session store (P1-T10)", () => {
  it("creates the row queued with its title and a first status event", async () => {
    const all = await events()
    expect(all[0]).toMatchObject({ seq: 1, type: "status", payload: { status: "queued" } })
    expect((await sessionRow()).title).toBe("Fix the build")
  })

  it("seq is gapless across node batches and server events interleaved", async () => {
    const first = await ingestBatch(node, sessionId, batch(1, [text("a"), text("b")]), "h1")
    expect(first).toMatchObject({ kind: "appended", lastSeq: 4 })
    await withPrivilegedDb(orgId, "store-test-server", (tx) =>
      appendServerEvents(tx, orgId, sessionId, [
        { at: at(), type: "system", payload: { subtype: "still_queued", text: "x" } },
      ]),
    )
    const second = await ingestBatch(node, sessionId, batch(2, [text("c")]), "h2")
    expect(second).toMatchObject({ kind: "appended", lastSeq: 6 })
    expect((await events()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await sessionRow()).last_seq).toBe(6)
  })

  it("a re-sent batch stores nothing and returns the same lastSeq", async () => {
    const first = await ingestBatch(node, sessionId, batch(1, [text("a")]), "same")
    const again = await ingestBatch(node, sessionId, batch(1, [text("a")]), "same")
    expect(again).toEqual({ kind: "replayed", lastSeq: (first as { lastSeq: number }).lastSeq })
    expect((await events()).length).toBe(3)
  })

  it("batch 3 after 1 answers gap with expectedBatchNo 2", async () => {
    await ingestBatch(node, sessionId, batch(1, [text("a")]), "h1")
    expect(await ingestBatch(node, sessionId, batch(3, [text("c")]), "h3")).toEqual({
      kind: "gap",
      expectedBatchNo: 2,
    })
  })

  it("batch 2 twice with different bodies answers conflict", async () => {
    await ingestBatch(node, sessionId, batch(1, [text("a")]), "h1")
    await ingestBatch(node, sessionId, batch(2, [text("b")]), "h2")
    expect(await ingestBatch(node, sessionId, batch(2, [text("other")]), "h2-other")).toEqual({
      kind: "conflict",
    })
  })

  it("another node's credential is refused; an older lease generation is stale", async () => {
    expect(await ingestBatch(otherNode, sessionId, batch(1, [text("a")]), "h1")).toEqual({
      kind: "not_your_node",
    })
    await withSystemDb("store-test-bump", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE kernel.node_jobs SET lease_generation = 2 WHERE id = ${jobId}`,
      )
    })
    expect(await ingestBatch(node, sessionId, batch(1, [text("a")], 1), "h1")).toEqual({
      kind: "stale",
    })
    expect(
      await ingestBatch(
        node,
        sessionId,
        { ...batch(1, [text("a")], 2), jobId: crypto.randomUUID() },
        "h1",
      ),
    ).toEqual({
      kind: "stale",
    })
    expect((await events()).length).toBe(2)
  })

  it("a permission_request makes the row waiting with its reason; the decision brings it back to running", async () => {
    await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "permission_request",
          payload: {
            requestId: "r1",
            tool: "Bash",
            input: { command: "rm -rf build" },
            reason: "outside",
          },
        },
      ]),
      "h1",
    )
    let row = await sessionRow()
    expect(row).toMatchObject({
      status: "waiting",
      pending_count: 1,
      waiting_reason: "permission: Bash",
    })
    expect((await events()).at(-1)).toMatchObject({
      type: "status",
      payload: { status: "waiting", reason: "permission: Bash" },
    })

    // A second request in a later batch, then the first is answered: still
    // waiting, and the reason moves to the remaining (oldest open) request.
    await ingestBatch(
      node,
      sessionId,
      batch(2, [
        {
          at: at(),
          type: "question",
          payload: {
            requestId: "q1",
            questions: [{ header: "Branch", question: "Which branch?" }],
          },
        },
        { at: at(), type: "decision", payload: { requestId: "r1", outcome: "allow", by: "owner" } },
      ]),
      "h2",
    )
    row = await sessionRow()
    expect(row).toMatchObject({
      status: "waiting",
      pending_count: 1,
      waiting_reason: "question: Branch",
    })

    await ingestBatch(
      node,
      sessionId,
      batch(3, [
        {
          at: at(),
          type: "decision",
          payload: { requestId: "q1", outcome: "answered", by: "owner" },
        },
      ]),
      "h3",
    )
    row = await sessionRow()
    expect(row).toMatchObject({ status: "running", pending_count: 0, waiting_reason: null })
    expect((await events()).at(-1)).toMatchObject({
      type: "status",
      payload: { status: "running" },
    })
    expect((await events()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  // P1-walk D13: a session that failed while a permission was open kept
  // pendingCount 1 and its waiting reason, with no decision recorded.
  it("a session that ends with a request open expires it with a decision and clears the reason (D13)", async () => {
    await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "permission_request",
          payload: { requestId: "w1", tool: "Write", input: { file_path: "x" }, reason: "outside" },
        },
      ]),
      "h1",
    )
    expect(await sessionRow()).toMatchObject({ status: "waiting", pending_count: 1 })
    await withPrivilegedDb(orgId, "store-test-end", (tx) =>
      appendServerEvents(tx, orgId, sessionId, [
        { at: at(), type: "status", payload: { status: "failed", code: "lease_expired" } },
      ]),
    )
    expect(await sessionRow()).toMatchObject({
      status: "failed",
      pending_count: 0,
      waiting_reason: null,
    })
    const decisions = (await events()).filter((e) => e.type === "decision")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.payload).toMatchObject({
      requestId: "w1",
      outcome: "expired",
      by: "process_exit",
    })
  })

  it("S51: the node's driver event gives the row a localisable reason code that a needs_you end keeps and a new run clears", async () => {
    const driver = (elsewhere: boolean, via: string | null): NodeSessionEventIn => ({
      at: at(),
      type: "system",
      payload: { subtype: "driver", text: "Driven from VS Code", data: { elsewhere, via } },
    })
    const res = await ingestBatch(node, sessionId, batch(1, [driver(true, "vscode")]), "h1")
    if (res.kind !== "appended") throw new Error(res.kind)
    expect(publicRow(res.row).reasonCode).toBe("driven_elsewhere_vscode")
    expect(await sessionRow()).toMatchObject({ reason_code: "driven_elsewhere_vscode" })
    const end = (status: string, reason?: string) =>
      withPrivilegedDb(orgId, "store-test-end", (tx) =>
        appendServerEvents(tx, orgId, sessionId, [
          { at: at(), type: "status", payload: { status, ...(reason ? { reason } : {}) } },
        ]),
      )
    await end("needs_you", "turn_ended")
    expect(await sessionRow()).toMatchObject({
      status: "needs_you",
      reason_code: "driven_elsewhere_vscode",
    })
    // The next run starts here: no reason any more.
    await end("running")
    expect(await sessionRow()).toMatchObject({ reason_code: null })
    // A terminal (cli), then no other driver: cleared.
    await ingestBatch(node, sessionId, batch(2, [driver(true, "cli")]), "h2")
    expect(await sessionRow()).toMatchObject({ reason_code: "driven_elsewhere_cli" })
    await ingestBatch(node, sessionId, batch(3, [driver(false, null)]), "h3")
    expect(await sessionRow()).toMatchObject({ reason_code: null })
    // An unknown driver is the generic code; a hard token limit has its own.
    await ingestBatch(node, sessionId, batch(4, [driver(true, "jetbrains")]), "h4")
    expect(await sessionRow()).toMatchObject({ reason_code: "driven_elsewhere" })
    await end("running")
    await end("needs_you", "token_limit")
    expect(await sessionRow()).toMatchObject({ reason_code: "token_limit" })
  })

  it("usage events sum into tokens", async () => {
    await ingestBatch(
      node,
      sessionId,
      batch(1, [
        { at: at(), type: "usage", payload: { tokensIn: 100, tokensOut: 20, model: "m" } },
        { at: at(), type: "usage", payload: { tokensIn: 50, tokensOut: 5, model: "m" } },
      ]),
      "h1",
    )
    const row = await sessionRow()
    expect([Number(row.tokens_in), Number(row.tokens_out)]).toEqual([150, 25])
  })

  it("D23: a usage event with a cache split adds to each cache counter; one without leaves them", async () => {
    const res = await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "usage",
          payload: {
            tokensIn: 1300,
            tokensOut: 20,
            model: "m",
            cacheRead: 1000,
            cacheWrite5m: 200,
            cacheWrite1h: 60,
            contextTokens: 1300,
          },
        },
        {
          at: at(),
          type: "usage",
          payload: { tokensIn: 900, tokensOut: 5, model: "m", cacheRead: 800, cacheWrite5m: 7 },
        },
        // An older node's usage: no split.
        { at: at(), type: "usage", payload: { tokensIn: 50, tokensOut: 5, model: "m" } },
      ]),
      "h1",
    )
    if (res.kind !== "appended") throw new Error(res.kind)
    const row = await sessionRow()
    expect(
      [
        row.tokens_in,
        row.tokens_out,
        row.tokens_cache_read,
        row.tokens_cache_write_5m,
        row.tokens_cache_write_1h,
      ].map(Number),
    ).toEqual([2250, 30, 1800, 207, 60])
    expect(publicRow(res.row)).toMatchObject({
      tokensIn: 2250,
      tokensOut: 30,
      tokensCacheRead: 1800,
      tokensCacheWrite5m: 207,
      tokensCacheWrite1h: 60,
    })
  })

  it("D23: a usage event's bad counters (negative, fractional, too large) are dropped and the batch is stored", async () => {
    const res = await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "usage",
          payload: { tokensIn: 10, tokensOut: 2, model: "m", cacheRead: 5, cacheWrite5m: 1 },
        },
        {
          at: at(),
          type: "usage",
          payload: {
            tokensIn: -5,
            tokensOut: 1.5,
            model: "m",
            cacheRead: -5,
            cacheWrite5m: 1.5,
            cacheWrite1h: 1e19,
          },
        },
        { at: at(), type: "usage", payload: { tokensIn: 1e19, model: "m", cacheRead: 1e19 } },
      ]),
      "h1",
    )
    expect(res.kind).toBe("appended")
    const row = await sessionRow()
    expect(
      [
        row.tokens_in,
        row.tokens_out,
        row.tokens_cache_read,
        row.tokens_cache_write_5m,
        row.tokens_cache_write_1h,
      ].map(Number),
    ).toEqual([10, 2, 5, 1, 0])
  })

  it("a tool call sets the activity line, the result its summary, the start event its facts", async () => {
    const res = await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "system",
          payload: {
            subtype: "start",
            text: "Claude Code 2.1.286",
            data: {
              sessionId: "sdk-1",
              claudeCode: "2.1.286 bundled /x/cli.js",
              configDir: "/x/cfg",
            },
          },
        },
        {
          at: at(),
          type: "tool_call",
          payload: { id: "t1", name: "Bash", input: { command: "bun test" } },
        },
        {
          at: at(),
          type: "result",
          payload: {
            text: "Done.",
            isError: false,
            subtype: "success",
            branch: "fix/build",
            pushed: true,
          },
        },
      ]),
      "h1",
    )
    expect(res.kind).toBe("appended")
    const row = await sessionRow()
    expect(row).toMatchObject({
      latest_activity: "Bash: bun test",
      result_summary: "Done.",
      branch: "fix/build",
      pushed: true,
      sdk_session_id: "sdk-1",
      claude_code: "2.1.286 bundled /x/cli.js",
      config_dir: "/x/cfg",
    })
  })

  it("final walk F1: the start event's branch is on the row while the session runs", async () => {
    const res = await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "system",
          payload: { subtype: "start", text: "Claude Code", data: { branch: "node/app-5fdd" } },
        },
      ]),
      "h1",
    )
    expect(res.kind).toBe("appended")
    expect((await sessionRow()).branch).toBe("node/app-5fdd")
  })

  it("W2-D10: a session dispatched with no finish step records the one its start applied; an explicit one is kept", async () => {
    const start = (finishWith: unknown): NodeSessionEventIn => ({
      at: at(),
      type: "system",
      payload: { subtype: "start", text: "Claude Code", data: { finishWith } },
    })
    expect((await sessionRow()).finish_with).toBeNull()
    expect((await ingestBatch(node, sessionId, batch(1, [start("pr")]), "h1")).kind).toBe(
      "appended",
    )
    expect((await sessionRow()).finish_with).toBe("pr")
    // An explicit choice is never overwritten; an unknown value never lands.
    await withSystemDb("store-test-finish", (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.node_sessions SET finish_with = 'commit' WHERE id = ${sessionId}`,
      ),
    )
    await ingestBatch(node, sessionId, batch(2, [start("none")]), "h2")
    expect((await sessionRow()).finish_with).toBe("commit")
    await withSystemDb("store-test-finish", (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.node_sessions SET finish_with = NULL WHERE id = ${sessionId}`,
      ),
    )
    await ingestBatch(node, sessionId, batch(3, [start("merge")]), "h3")
    expect((await sessionRow()).finish_with).toBeNull()
  })

  const atelier = (data: Record<string, unknown>): NodeSessionEventIn => ({
    at: at(),
    type: "system",
    payload: { subtype: "atelier", text: "Atelier", data },
  })
  const atelierState = {
    id: "2026-10-15-x",
    rung: "R2",
    phase: "execute",
    plan: ["frame", "spec", "execute", "validate"],
    done: ["frame", "spec"],
    status: "running",
    awaiting: null,
    boards: [{ title: "Proof", url: "https://example.com/board" }],
  }

  it("S35: an atelier system event with a valid state sets row.atelier; one with status 'paused' leaves it unchanged", async () => {
    const first = await ingestBatch(node, sessionId, batch(1, [atelier(atelierState)]), "h1")
    expect(first.kind).toBe("appended")
    expect((await sessionRow()).atelier).toEqual(atelierState)
    const bad = await ingestBatch(
      node,
      sessionId,
      batch(2, [atelier({ ...atelierState, phase: "validate", status: "paused" })]),
      "h2",
    )
    expect(bad.kind).toBe("appended")
    expect((await sessionRow()).atelier).toEqual(atelierState)
    // A javascript: board is not a valid state either: nothing stored.
    await ingestBatch(
      node,
      sessionId,
      batch(3, [
        atelier({
          ...atelierState,
          phase: "handoff",
          boards: [{ title: "x", url: "javascript:1" }],
        }),
      ]),
      "h3",
    )
    expect((await sessionRow()).atelier).toEqual(atelierState)
  })

  it("S57: a result event's https prUrl sets pr_url; a javascript: one is dropped", async () => {
    const result = (prUrl: string): NodeSessionEventIn => ({
      at: at(),
      type: "result",
      payload: { text: "Done.", isError: false, subtype: "success", prUrl },
    })
    await ingestBatch(node, sessionId, batch(1, [result("javascript:alert(1)")]), "h1")
    expect((await sessionRow()).pr_url).toBeNull()
    await ingestBatch(node, sessionId, batch(2, [result("https://github.com/o/r/pull/7")]), "h2")
    expect((await sessionRow()).pr_url).toBe("https://github.com/o/r/pull/7")
  })

  it("S30: publicRow and the node_session frame carry autonomy, finishWith, atelier", async () => {
    await withSystemDb("store-test-autonomy", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE kernel.node_sessions SET autonomy = 'autonomous', finish_with = 'commit'
                    WHERE id = ${sessionId}`,
      )
    })
    const res = await ingestBatch(node, sessionId, batch(1, [atelier(atelierState)]), "h1")
    if (res.kind !== "appended") throw new Error(res.kind)
    const expected = { autonomy: "autonomous", finishWith: "commit", atelier: atelierState }
    expect(publicRow(res.row)).toMatchObject(expected)
    expect(frameRow(res.row)).toMatchObject(expected)
  })

  it("S41: publicRow and the frame carry importMode, importFrom, following, cwdSubdir (relative)", async () => {
    const plain = await ingestBatch(node, sessionId, batch(1, [text("a")]), "h1")
    if (plain.kind !== "appended") throw new Error(plain.kind)
    expect(publicRow(plain.row)).toMatchObject({
      importMode: null,
      importFrom: null,
      following: false,
      cwdSubdir: null,
      worktreePath: null,
    })
    await withSystemDb("store-test-import", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE kernel.node_sessions
                      SET source = 'import', import_mode = 'follow', import_from = 'vscode',
                          import_sdk_session_id = ${crypto.randomUUID()}, cwd_subdir = 'app/web',
                          worktree_path = '/tmp/repo-wt', following = true, finish_with = 'none'
                    WHERE id = ${sessionId}`,
      )
    })
    const res = await ingestBatch(node, sessionId, batch(2, [text("b")]), "h2")
    if (res.kind !== "appended") throw new Error(res.kind)
    const expected = {
      source: "import",
      importMode: "follow",
      importFrom: "vscode",
      following: true,
      cwdSubdir: "app/web",
      // D53: the shared repo's worktree outside the folder it ran in.
      worktreePath: "/tmp/repo-wt",
    }
    expect(publicRow(res.row)).toMatchObject(expected)
    expect(frameRow(res.row)).toMatchObject(expected)
    expect("importSdkSessionId" in publicRow(res.row)).toBe(false)
    expect("importReplayOffset" in publicRow(res.row)).toBe(false)
  })

  it("publicRow never carries folder_path and carries lastSeq", async () => {
    const res = await ingestBatch(node, sessionId, batch(1, [text("a")]), "h1")
    if (res.kind !== "appended") throw new Error(res.kind)
    const pub = publicRow(res.row)
    expect(JSON.stringify(pub)).not.toContain("/Users/someone/code/liaison")
    expect("folderPath" in pub).toBe(false)
    expect("configDir" in pub).toBe(false)
    expect(pub).toMatchObject({ folderName: "liaison", lastSeq: 3, ownerUserId: userId })
  })

  it("an event's truncated and fullBytes are stored and read back", async () => {
    const res = await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "tool_result",
          payload: { id: "t1", isError: false, output: "cut" },
          truncated: true,
          fullBytes: 70000,
        },
      ]),
      "h1",
    )
    if (res.kind !== "appended") throw new Error(res.kind)
    expect(res.events[0]).toMatchObject({ seq: 3, truncated: true, fullBytes: 70000 })
    expect((await events()).at(-1)).toMatchObject({ truncated: true, full_bytes: 70000 })
  })

  it("fanOut sends the row and one owner-tagged frame per event, ephemerally", async () => {
    const spy = spyOn(eventBusModule, "broadcastEphemeral").mockResolvedValue(undefined)
    try {
      const res = await ingestBatch(node, sessionId, batch(1, [text("a"), text("b")]), "h1")
      if (res.kind !== "appended") throw new Error(res.kind)
      await fanOut(res.row as NodeSessionRow, res.events)
      const frames = spy.mock.calls.map((c) => c[0])
      expect(frames.map((f) => `${f.entity}:${f.action}`)).toEqual([
        "node_session:update",
        "node_session_event:create",
        "node_session_event:create",
      ])
      for (const f of frames) {
        expect((f.data as { ownerUserId: string }).ownerUserId).toBe(userId)
        expect(JSON.stringify(f.data)).not.toContain("/Users/someone")
      }
      expect(frames[0].data).toMatchObject({ lastSeq: 4 })
      // P1a skeptic S6: the prompt (up to 200,000 characters, fixed at
      // creation) is not re-broadcast with every batch; a GET carries it.
      expect("prompt" in (frames[0].data as Record<string, unknown>)).toBe(false)
      expect((frames[0].data as { title: string }).title).toBe("Fix the build")
      expect(frames.slice(1).map((f) => (f.data as { seq: number }).seq)).toEqual([3, 4])
    } finally {
      spy.mockRestore()
    }
  })
})

describe("node session store, steering (P3-T07)", () => {
  it("model_changed and level_changed the owner asked for update the row", async () => {
    // The owner's requests (P3-fix m6: an unasked change never lands).
    await withSystemDb("store-test-asked", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.node_session_commands (session_id, seq, type, payload)
        VALUES (${sessionId}, 1, 'set_model', '{"model":"claude-sonnet-4-5"}'::jsonb),
               (${sessionId}, 2, 'set_level', '{"level":"standard"}'::jsonb)`),
    )
    const out = await ingestBatch(
      node,
      sessionId,
      batch(1, [
        {
          at: at(),
          type: "model_changed",
          payload: { from: "claude-haiku-4-5", to: "claude-sonnet-4-5" },
        },
        { at: at(), type: "level_changed", payload: { from: "strict", to: "standard" } },
      ]),
      "h-steer-1",
    )
    expect(out.kind).toBe("appended")
    const row = await sessionRow()
    expect(row.model).toBe("claude-sonnet-4-5")
    expect(row.level).toBe("standard")
    // A level outside the three never lands on the row.
    await ingestBatch(
      node,
      sessionId,
      batch(2, [{ at: at(), type: "level_changed", payload: { from: "standard", to: "root" } }]),
      "h-steer-2",
    )
    expect((await sessionRow()).level).toBe("standard")
  })
})

// A new session is announced through the outbox as `kernel/node_session:create`
// (in addition to the ephemeral fan-out), so a durable consumer (a guided tour
// beat) can see it. The frame is the live row without its prompt, and names its
// owner: the socket fan-out sends it to that owner only.
describe("node session store, create event", () => {
  it("createSessionForJob queues kernel/node_session:create with the frame row and no prompt", async () => {
    expect(eventBusModule.KERNEL_DECLARED_EMITS.has("node_session:create")).toBe(true)
    const rows = await withSystemDb("store-test-create-event", async (tx) =>
      extractRows<{ payload: Record<string, unknown> & { data: Record<string, unknown> } }>(
        await tx.execute(drizzleSql`
          SELECT payload FROM kernel.pending_events
          WHERE org_id = ${orgId} AND payload->>'app' = 'kernel'
            AND payload->>'entity' = 'node_session' AND payload->>'action' = 'create'
            AND payload->>'entityId' = ${sessionId}`),
      ),
    )
    expect(rows).toHaveLength(1)
    const p = rows[0]!.payload
    expect(p.actorId).toBe(userId)
    expect(p.actorType).toBe("user")
    expect(p.data.ownerUserId).toBe(userId)
    expect(p.data.id).toBe(sessionId)
    expect(p.data.source).toBe("app")
    expect("prompt" in p.data).toBe(false)
    expect(JSON.stringify(p.data)).not.toContain("Fix the build\\nand tell me")
  })
})
