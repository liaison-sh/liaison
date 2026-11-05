// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T16 (C4, S6, S7, D33): the node posts event batches for a session it
// runs. Through the real app with the owner's session and the node
// credential: server-numbered seqs, re-sends idempotent, gaps named, a
// conflicting re-send fails the run, the run fence (lease generation, node),
// the protocol's 413s, the server-side field cap, and the owner-only fan-out.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { type NodeSessionEventIn, parseNodeCommandPull, splitIntoBatches } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const KiB = 1024

describe("node session ingest (P1-T16)", () => {
  let owner: minimal.Session
  let agentId: string
  let node: { nodeId: string; credential: string }
  let otherNode: { nodeId: string; credential: string }
  let jobId: string
  let sessionId: string

  const call = (p: string, method: string, body?: unknown, cred?: string) =>
    app.request(p, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(cred ? { "X-Node-Credential": cred } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable() {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    return { nodeId: d.node.id as string, credential: d.credential as string }
  }

  const at = () => new Date().toISOString()
  const text = (t: string): NodeSessionEventIn => ({
    at: at(),
    type: "assistant_text",
    payload: { text: t },
  })

  const post = (
    batchNo: number,
    events: NodeSessionEventIn[],
    over: { leaseGeneration?: number; cred?: string; jobId?: string } = {},
  ) =>
    call(
      `/api/node/sessions/${sessionId}/events`,
      "POST",
      {
        jobId: over.jobId ?? jobId,
        leaseGeneration: over.leaseGeneration ?? 2,
        batchNo,
        events,
      },
      over.cred ?? node.credential,
    )

  const readEvents = async () =>
    (await json(await call(`/api/me/node-sessions/${sessionId}/events`, "GET"))).data

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@in-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    node = await enable()
    otherNode = await enable()
    // A running app job held by `node` at lease generation 2, and its session.
    const [job] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs
        (org_id, owner_user_id, agent_id, node_id, source, prompt, status, lease_holder,
         lease_generation, lease_expires_at, claimed_at, started_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${node.nodeId}, 'app', 'Fix it',
              'running', ${node.nodeId}, 2, now() + interval '2 minutes', now(), now())
      RETURNING id`
    jobId = job.id
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, job_id, agent_id, source, config_kind, title, prompt,
         model, level, status, started_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${node.nodeId}, ${jobId}, ${agentId}, 'app',
              'owner', 'Fix it', 'Fix it', 'claude-haiku-4-5', 'strict', 'running', now())
      RETURNING id`
    sessionId = session.id
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  it("200 with lastSeq; GET events shows them", async () => {
    const res = await post(1, [text("one"), text("two")])
    expect(res.status).toBe(200)
    expect((await json(res)).data).toEqual({ lastSeq: 2 })
    const d = await readEvents()
    expect(d.lastSeq).toBe(2)
    expect(d.events.map((e: any) => [e.seq, e.payload.text])).toEqual([
      [1, "one"],
      [2, "two"],
    ])
  })

  it("a re-send returns the same lastSeq and stores nothing", async () => {
    const events = [text("one"), text("two")]
    expect((await json(await post(1, events))).data).toEqual({ lastSeq: 2 })
    const again = await post(1, events)
    expect(again.status).toBe(200)
    expect((await json(again)).data).toEqual({ lastSeq: 2 })
    expect((await readEvents()).events).toHaveLength(2)
  })

  it("gap names the expected batch", async () => {
    await post(1, [text("one")])
    const res = await post(3, [text("three")])
    expect(res.status).toBe(409)
    const body = await json(res)
    expect(body.error).toMatchObject({ code: "gap", expectedBatchNo: 2 })
    expect((await readEvents()).events).toHaveLength(1)
  })

  it("conflict fails the job and the session", async () => {
    await post(1, [text("one")])
    const res = await post(1, [text("another body")])
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("conflict")
    const [job] = await sql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM kernel.node_jobs WHERE id = ${jobId}`
    expect(job.status).toBe("failed")
    expect(job.error).toContain("ingest conflict: batch 1")
    const [session] = await sql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(session.status).toBe("failed")
    expect(session.error).toContain("ingest conflict: batch 1")
    // The failed run's later batches are stale.
    expect((await post(2, [text("late")])).status).toBe(409)
  })

  it("an older lease generation is stale; another node is 403", async () => {
    const old = await post(1, [text("zombie")], { leaseGeneration: 1 })
    expect(old.status).toBe(409)
    expect((await json(old)).error.code).toBe("stale")
    const otherJob = await post(1, [text("zombie")], { jobId: crypto.randomUUID() })
    expect(otherJob.status).toBe(409)
    expect((await json(otherJob)).error.code).toBe("stale")
    const foreign = await post(1, [text("not mine")], { cred: otherNode.credential })
    expect(foreign.status).toBe(403)
    const none = await call(`/api/node/sessions/${sessionId}/events`, "POST", {
      jobId,
      leaseGeneration: 2,
      batchNo: 1,
      events: [text("x")],
    })
    expect(none.status).toBe(401)
    expect((await readEvents()).events).toHaveLength(0)
  })

  it("257 events or 1.1 MiB is 413 batch_too_large; one 300 KiB event is 413 event_too_large", async () => {
    const many = Array.from({ length: 257 }, (_, i) => text(`e${i}`))
    const tooMany = await post(1, many)
    expect(tooMany.status).toBe(413)
    expect((await json(tooMany)).error.code).toBe("batch_too_large")

    // Five events of about 220 KiB each: every one under 256 KiB, the batch over 1 MiB.
    const fat = Array.from({ length: 5 }, () => ({
      at: at(),
      type: "tool_result" as const,
      payload: {
        a: "x".repeat(60 * KiB),
        b: "y".repeat(60 * KiB),
        c: "z".repeat(60 * KiB),
        d: "w".repeat(40 * KiB),
      },
    }))
    const heavy = await post(1, fat)
    expect(heavy.status).toBe(413)
    expect((await json(heavy)).error.code).toBe("batch_too_large")

    const big: NodeSessionEventIn = {
      at: at(),
      type: "tool_result",
      payload: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`f${i}`, "q".repeat(60 * KiB)]),
      ),
    }
    const one = await post(1, [text("small"), big])
    expect(one.status).toBe(413)
    expect((await json(one)).error).toMatchObject({ code: "event_too_large", index: 1 })
    expect((await readEvents()).events).toHaveLength(0)
  })

  it("a 70 KiB field POSTed untruncated is stored at 64 KiB with truncated and fullBytes, and GET returns them", async () => {
    const field = "a".repeat(70 * KiB)
    const event: NodeSessionEventIn = { at: at(), type: "tool_result", payload: { output: field } }
    const fullBytes = new TextEncoder().encode(JSON.stringify(event)).length
    const res = await post(1, [event])
    expect(res.status).toBe(200)
    const [stored] = (await readEvents()).events
    expect(stored.truncated).toBe(true)
    expect(stored.fullBytes).toBe(fullBytes)
    expect(stored.payload.output.length).toBe(64 * KiB)
  })

  it("a node-truncated event keeps its truncated and fullBytes through POST and GET", async () => {
    const event: NodeSessionEventIn = {
      at: at(),
      type: "tool_result",
      payload: { output: "cut by the node" },
      truncated: true,
      fullBytes: 999_999,
    }
    expect((await post(1, [event])).status).toBe(200)
    const [stored] = (await readEvents()).events
    expect(stored).toMatchObject({ truncated: true, fullBytes: 999_999 })
    expect(stored.payload.output).toBe("cut by the node")
  })

  it("a batch split by splitIntoBatches at the boundary is accepted, never 413", async () => {
    // Events of about 200 KiB: five fill a node batch right up to its limit.
    const events: NodeSessionEventIn[] = Array.from({ length: 11 }, (_, i) => ({
      at: at(),
      type: "tool_result",
      payload: { output: `${i}`.padEnd(200 * KiB, "x") },
    }))
    const batches = splitIntoBatches(events)
    expect(batches.length).toBeGreaterThan(1)
    let batchNo = 0
    for (const b of batches) {
      const res = await post(++batchNo, b)
      expect(res.status).toBe(200)
    }
    const d = await readEvents()
    expect(d.lastSeq).toBe(11)
  })

  it("the owner's fake socket gets one node_session update and one node_session_event per event within the request", async () => {
    const frames: Array<Record<string, any>> = []
    const spy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async (e) => {
      frames.push(e as Record<string, any>)
    })
    try {
      const res = await post(1, [text("one"), text("two"), text("three")])
      expect(res.status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    const rows = frames.filter((f) => f.entity === "node_session")
    const events = frames.filter((f) => f.entity === "node_session_event")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: "update", entityId: sessionId })
    expect(rows[0].data).toMatchObject({ ownerUserId: owner.userId, lastSeq: 3 })
    expect(rows[0].data.folderPath).toBeUndefined()
    expect(events.map((f) => f.data.seq)).toEqual([1, 2, 3])
    for (const f of events) {
      expect(f.action).toBe("create")
      expect(f.data).toMatchObject({ ownerUserId: owner.userId, sessionId })
    }
  })

  // P1a skeptic S2 (D33): a batch is fenced to the session's CURRENT run. The
  // node holds another running job of its own (session B's, valid lease); it
  // must not write into session A with it.
  it("a batch carrying another session's live job on the same node is stale", async () => {
    // Session A is an older, finished session; the node now runs B's job.
    await sql`UPDATE kernel.node_jobs SET status = 'done', finished_at = now() WHERE id = ${jobId}`
    await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now() WHERE id = ${sessionId}`
    const [jobB] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs
        (org_id, owner_user_id, agent_id, node_id, source, prompt, status, lease_holder,
         lease_generation, lease_expires_at, claimed_at, started_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${node.nodeId}, 'app', 'Other',
              'running', ${node.nodeId}, 2, now() + interval '2 minutes', now(), now())
      RETURNING id`
    const [sessionB] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, job_id, agent_id, source, config_kind, title, prompt,
         model, level, status, started_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${node.nodeId}, ${jobB.id}, ${agentId}, 'app',
              'owner', 'Other', 'Other', 'claude-haiku-4-5', 'strict', 'running', now())
      RETURNING id`
    const cross = await post(1, [text("into A with B's run")], { jobId: jobB.id })
    expect(cross.status).toBe(409)
    expect((await json(cross)).error.code).toBe("stale")
    expect((await readEvents()).events).toHaveLength(0)
    // B's own run still writes into B.
    const own = await call(
      `/api/node/sessions/${sessionB.id}/events`,
      "POST",
      { jobId: jobB.id, leaseGeneration: 2, batchNo: 1, events: [text("b")] },
      node.credential,
    )
    expect(own.status).toBe(200)
  })

  // P1a skeptic S4 (D33): the server numbers events; a seq sent by the node
  // is never honoured, whatever its value.
  it("a node-sent seq is ignored: the server numbers the events", async () => {
    const withSeq = [
      { ...text("one"), seq: 99 },
      { ...text("two"), seq: 7 },
    ] as unknown as NodeSessionEventIn[]
    const res = await post(1, withSeq)
    expect(res.status).toBe(200)
    expect((await json(res)).data).toEqual({ lastSeq: 2 })
    const d = await readEvents()
    expect(d.events.map((e: any) => [e.seq, e.payload.text])).toEqual([
      [1, "one"],
      [2, "two"],
    ])
  })

  // P1a skeptic S5: the re-send hash covers the body as received, so a re-send
  // that differs only in keys the schema strips is a conflict, not a replay.
  it("a re-send differing only in a stripped key is a conflict", async () => {
    const one = text("one")
    expect((await post(1, [one])).status).toBe(200)
    const changed = [{ ...one, extra: "x" }] as unknown as NodeSessionEventIn[]
    const res = await post(1, changed)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("conflict")
  })

  // ── P3-T07: the node's command pull and the acks ──────────────────────────

  async function command(
    sid: string,
    seq: number,
    type = "message",
    payload: object = { text: `m${seq}` },
  ) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_session_commands (session_id, seq, type, payload)
      VALUES (${sid}, ${seq}, ${type}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id`
    await sql`UPDATE kernel.node_sessions SET last_command_seq = ${seq} WHERE id = ${sid}`
    return row.id
  }

  const pull = (cred: string) =>
    call("/api/node/sessions/commands?unacked=1", "GET", undefined, cred)

  it("the node pulls only its own current runs' unacked commands, in order", async () => {
    const c2 = await command(sessionId, 2)
    const c1 = await command(sessionId, 1, "stop", {})
    const acked = await command(sessionId, 3)
    await sql`UPDATE kernel.node_session_commands SET acked_at = now(), outcome = 'applied'
               WHERE id = ${acked}`
    // A session whose job is no longer running: none of its commands.
    const [doneJob] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, node_id, source, prompt,
                                    status, lease_holder, lease_generation)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${node.nodeId}, 'app', 'old', 'done',
              ${node.nodeId}, 1) RETURNING id`
    const [ended] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, job_id, agent_id, source, config_kind, title, prompt,
         model, level, status)
      VALUES (${owner.orgId}, ${owner.userId}, ${node.nodeId}, ${doneJob.id}, ${agentId}, 'app',
              'owner', 'Old', 'Old', 'claude-haiku-4-5', 'strict', 'done') RETURNING id`
    await command(ended.id, 1)

    const res = await pull(node.credential)
    expect(res.status).toBe(200)
    const body = await json(res)
    const listed = body.data.commands
    const expected = [
      { commandId: c1, sessionId, jobId, seq: 1, type: "stop", payload: {} },
      { commandId: c2, sessionId, jobId, seq: 2, type: "message", payload: { text: "m2" } },
    ]
    expect(listed).toEqual(expected)
    // Walk D1 contract: the node reads this route's `data` with the shared
    // parser (apps/desktop adapters.ts getCommands), so the two cannot drift.
    expect(parseNodeCommandPull(body.data)).toEqual(expected)
  })

  it("another node's credential gets none; no credential is 401", async () => {
    await command(sessionId, 1)
    const res = await pull(otherNode.credential)
    expect(res.status).toBe(200)
    expect((await json(res)).data.commands).toEqual([])
    expect((await call("/api/node/sessions/commands?unacked=1", "GET")).status).toBe(401)
  })

  it("a command_applied in a node batch acks the command with its outcome and job", async () => {
    const id = await command(sessionId, 1)
    const failed = await command(sessionId, 2, "set_model", { model: "x" })
    // Delivered to this run first (m6: only a delivered command is acked).
    expect((await pull(node.credential)).status).toBe(200)
    const res = await post(1, [
      { at: at(), type: "user_message", payload: { text: "m1", commandId: id } },
      {
        at: at(),
        type: "command_applied",
        payload: { commandId: id, type: "message", outcome: "applied" },
      },
      {
        at: at(),
        type: "command_applied",
        payload: {
          commandId: failed,
          type: "set_model",
          outcome: "failed",
          error: "model_unavailable",
        },
      },
      // Not a command id: ignored, the batch still lands.
      {
        at: at(),
        type: "command_applied",
        payload: { commandId: "../x", type: "stop", outcome: "noop" },
      },
    ])
    expect(res.status).toBe(200)
    const rows = await sql<
      Array<{ id: string; acked_at: Date | null; outcome: string; job_id: string; result: unknown }>
    >`SELECT id, acked_at, outcome, job_id, result FROM kernel.node_session_commands
       WHERE session_id = ${sessionId} ORDER BY seq`
    expect(rows[0]).toMatchObject({ outcome: "applied", job_id: jobId })
    expect(rows[0].acked_at).not.toBeNull()
    expect(rows[1]).toMatchObject({
      outcome: "failed",
      job_id: jobId,
      result: { error: "model_unavailable" },
    })
    expect((await json(await pull(node.credential))).data.commands).toEqual([])
  })

  it("a command_applied from a stale run is refused with the batch (409 stale) and acks nothing", async () => {
    const id = await command(sessionId, 1)
    const res = await post(
      1,
      [
        {
          at: at(),
          type: "command_applied",
          payload: { commandId: id, type: "message", outcome: "applied" },
        },
      ],
      { leaseGeneration: 1 },
    )
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("stale")
    const [row] = await sql<Array<{ acked_at: Date | null }>>`
      SELECT acked_at FROM kernel.node_session_commands WHERE id = ${id}`
    expect(row.acked_at).toBeNull()
  })

  it("a command_applied naming another session's command acks nothing", async () => {
    const [jobB] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, node_id, source, prompt,
                                    status, lease_holder, lease_generation)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${node.nodeId}, 'app', 'B', 'running',
              ${node.nodeId}, 2) RETURNING id`
    const [sessionB] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, job_id, agent_id, source, config_kind, title, prompt,
         model, level, status)
      VALUES (${owner.orgId}, ${owner.userId}, ${node.nodeId}, ${jobB.id}, ${agentId}, 'app',
              'owner', 'B', 'B', 'claude-haiku-4-5', 'strict', 'running') RETURNING id`
    const other = await command(sessionB.id, 1)
    const res = await post(1, [
      {
        at: at(),
        type: "command_applied",
        payload: { commandId: other, type: "message", outcome: "applied" },
      },
    ])
    expect(res.status).toBe(200)
    const [row] = await sql<Array<{ acked_at: Date | null }>>`
      SELECT acked_at FROM kernel.node_session_commands WHERE id = ${other}`
    expect(row.acked_at).toBeNull()
  })

  // ── P3-fix m6: what a node may tell the server about its own session ──

  it("a command_applied for a command never delivered to this run acks nothing (m6)", async () => {
    const id = await command(sessionId, 1)
    const res = await post(1, [
      {
        at: at(),
        type: "command_applied",
        payload: { commandId: id, type: "message", outcome: "applied" },
      },
    ])
    expect(res.status).toBe(200)
    const [row] = await sql<Array<{ acked_at: Date | null }>>`
      SELECT acked_at FROM kernel.node_session_commands WHERE id = ${id}`
    expect(row.acked_at).toBeNull()
    // Once pulled by this run, the same ack lands.
    expect((await pull(node.credential)).status).toBe(200)
    await post(2, [
      {
        at: at(),
        type: "command_applied",
        payload: { commandId: id, type: "message", outcome: "applied" },
      },
    ])
    const [after] = await sql<Array<{ acked_at: Date | null; job_id: string }>>`
      SELECT acked_at, job_id FROM kernel.node_session_commands WHERE id = ${id}`
    expect(after.acked_at).not.toBeNull()
    expect(after.job_id).toBe(jobId)
  })

  it("a level_changed or model_changed the owner never asked for leaves the row alone (m6)", async () => {
    const levelOf = async () =>
      (
        await sql<Array<{ level: string; model: string }>>`
          SELECT level, model FROM kernel.node_sessions WHERE id = ${sessionId}`
      )[0]
    // Unasked: a raise to open and a model switch are not taken.
    expect(
      (
        await post(1, [
          { at: at(), type: "level_changed", payload: { from: "strict", to: "open" } },
          {
            at: at(),
            type: "model_changed",
            payload: { from: "claude-haiku-4-5", to: "claude-opus-4-5" },
          },
        ])
      ).status,
    ).toBe(200)
    expect(await levelOf()).toEqual({ level: "strict", model: "claude-haiku-4-5" })
    expect((await readEvents()).events.map((e: { type: string }) => e.type)).not.toContain(
      "level_changed",
    )
    // Asked (a confirmed set_level, a set_model): taken.
    await command(sessionId, 1, "set_level", { level: "standard" })
    await command(sessionId, 2, "set_model", { model: "claude-opus-4-5" })
    await post(2, [
      { at: at(), type: "level_changed", payload: { from: "strict", to: "standard" } },
      {
        at: at(),
        type: "model_changed",
        payload: { from: "claude-haiku-4-5", to: "claude-opus-4-5-20251101" },
      },
    ])
    expect(await levelOf()).toEqual({ level: "standard", model: "claude-opus-4-5-20251101" })
    // A raise the latest request does not name is refused (an old request replayed).
    await command(sessionId, 3, "set_level", { level: "strict" })
    await post(3, [{ at: at(), type: "level_changed", payload: { from: "strict", to: "strict" } }])
    await sql`UPDATE kernel.node_sessions SET level = 'strict' WHERE id = ${sessionId}`
    await post(4, [
      { at: at(), type: "level_changed", payload: { from: "strict", to: "standard" } },
    ])
    expect((await levelOf()).level).toBe("strict")
  })
})
