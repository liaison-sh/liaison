// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The simulated node (C7, red-team R13): nobody can drive the demo's recorded
// laptop as a node. It never holds a credential (0193 CHECK), it exists only
// in a demo org and only from insert (trigger), enabling its device id as a
// real node is refused, and every node-auth route refuses to act for it:
// without a credential (401), with a made-up one (401), and with the owner's
// REAL node's credential (nothing claimed, appended or pulled for the replay).
// The WS hello never binds it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { submitCommand } from "~/modules/node-sessions/commands"
import { mintNodeCredential } from "~/modules/nodes/credentials"
import { openNodeSessionForHello } from "~/modules/nodes/presence"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { REPLAY_DEVICE_ID, type StartedReplay, startReplay } from "./replay"

describe("the simulated node refuses every node-auth path", () => {
  let visitor: minimal.Session
  let regular: minimal.Session
  let replay: StartedReplay
  let realCredential: string

  const call = (path: string, method: string, body?: unknown, credential?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${visitor.bearer}`,
        "Content-Type": "application/json",
        "X-Liaison-Node-Protocol": "9",
        ...(credential ? { "X-Node-Credential": credential } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  /** postgres.js queries run on `then`: an async wrapper makes `rejects` await them. */
  const run = async (query: PromiseLike<unknown>) => {
    await query
  }

  const replayState = async () =>
    (
      await sql<
        Array<{ status: string; lease_holder: string | null; last_seq: number; batch: number }>
      >`SELECT j.status, j.lease_holder, s.last_seq, s.last_batch_no AS batch
          FROM kernel.node_jobs j JOIN kernel.node_sessions s ON s.job_id = j.id
         WHERE j.id = ${replay.jobId}`
    )[0]

  beforeAll(async () => {
    await acquireTestLock()
    const regularOrg = await createTestOrg()
    regular = await minimal.session(regularOrg.id)
    const demoOrgId = (await minimal.secondOrg({ name: "Sim Node Demo" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    invalidateDemoMarker(demoOrgId)
    // The visitor already owns the personal agent the replay drives.
    visitor = await minimal.adminSession(demoOrgId)
    DemoModeTestAccess.set(true)
    replay = await startReplay(
      { orgId: visitor.orgId, ownerUserId: visitor.userId },
      { launch: false },
    )
    const enabled = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(enabled.status).toBe(201)
    realCredential = ((await enabled.json()) as { data: { credential: string } }).data.credential
  })

  afterAll(async () => {
    for (const s of [visitor, regular]) {
      if (!s) continue
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${s.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${s.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${s.orgId}`
    }
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  it("never holds a credential, exists only in a demo org, and is fixed at insert", async () => {
    const { hash } = mintNodeCredential()
    await expect(
      run(sql`INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name, simulated, credential_hash)
          VALUES (${visitor.orgId}, ${visitor.userId}, ${`d.${crypto.randomUUID()}`}, 'x', true, ${hash})`),
    ).rejects.toThrow(/nodes_simulated_no_credential/)
    await expect(
      run(sql`UPDATE kernel.nodes SET credential_hash = ${hash} WHERE id = ${replay.nodeId}`),
    ).rejects.toThrow(/nodes_simulated_no_credential/)
    await expect(
      run(sql`INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name, simulated)
          VALUES (${regular.orgId}, ${regular.userId}, ${REPLAY_DEVICE_ID}, 'x', true)`),
    ).rejects.toThrow(/only in a demo org/)
    await expect(
      run(sql`UPDATE kernel.nodes SET simulated = false WHERE id = ${replay.nodeId}`),
    ).rejects.toThrow(/fixed at insert/)
    const [real] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.nodes WHERE org_id = ${visitor.orgId} AND NOT simulated LIMIT 1`
    await expect(
      run(sql`UPDATE kernel.nodes SET simulated = true WHERE id = ${real.id}`),
    ).rejects.toThrow(/fixed at insert/)
    expect(await sql`SELECT 1 FROM kernel.nodes WHERE org_id = ${regular.orgId}`).toHaveLength(0)
  })

  it("enabling its device id as a real node is refused and mints nothing", async () => {
    const res = await call("/api/nodes", "POST", { deviceId: REPLAY_DEVICE_ID, name: "Mine" })
    expect(res.status).toBe(409)
    const [row] = await sql<{ credential_hash: string | null; name: string }[]>`
      SELECT credential_hash, name FROM kernel.nodes WHERE id = ${replay.nodeId}`
    expect(row).toEqual({ credential_hash: null, name: "Demo laptop (recorded)" })
  })

  const nodeRoutes = () => {
    const j = replay.jobId
    const s = replay.sessionId
    const n = replay.nodeId
    return [
      ["POST", `/api/nodes/jobs/${j}/claim`, {}],
      ["POST", `/api/nodes/jobs/${j}/heartbeat`, { leaseGeneration: 1 }],
      ["POST", `/api/nodes/jobs/${j}/started`, { leaseGeneration: 1 }],
      [
        "POST",
        `/api/nodes/jobs/${j}/connection`,
        { leaseGeneration: 1, mcpConnectionId: crypto.randomUUID() },
      ],
      ["POST", `/api/nodes/jobs/${j}/fail`, { leaseGeneration: 1, error: "x" }],
      ["POST", `/api/nodes/jobs/${j}/result`, { leaseGeneration: 1, text: "forged" }],
      [
        "POST",
        `/api/nodes/jobs/${j}/permission-requests`,
        { leaseGeneration: 1, toolName: "Bash", summary: "x" },
      ],
      ["GET", "/api/nodes/self", undefined],
      ["PUT", `/api/nodes/${n}/capabilities`, { sharedFolders: [], models: [] }],
      ["GET", "/api/node/sessions/commands?unacked=1", undefined],
      [
        "POST",
        `/api/node/sessions/${s}/events`,
        {
          jobId: j,
          leaseGeneration: 1,
          batchNo: 1,
          events: [
            { at: new Date().toISOString(), type: "assistant_text", payload: { text: "x" } },
          ],
        },
      ],
      ["POST", "/api/node/sessions/report", { sessions: [] }],
    ] as const
  }

  it("every node route answers 401 without a credential or with a made-up one, and changes nothing", async () => {
    const before = await replayState()
    for (const credential of [undefined, mintNodeCredential().token]) {
      for (const [method, path, body] of nodeRoutes()) {
        const res = await call(path, method, body, credential)
        expect({ path, status: res.status }).toEqual({ path, status: 401 })
      }
    }
    expect(await replayState()).toEqual(before)
  })

  it("the owner's real node credential cannot claim, feed or pull the replay", async () => {
    const before = await replayState()
    await submitCommand({
      orgId: visitor.orgId,
      userId: visitor.userId,
      sessionId: replay.sessionId,
      command: { type: "message", payload: { text: "hello" } },
    })
    for (const [method, path, body] of nodeRoutes()) {
      if (path.endsWith("/report") || path.endsWith("/self")) continue
      const res = await call(path, method, body, realCredential)
      if (path.includes("/commands")) {
        expect(res.status).toBe(200)
        const pulled = (await res.json()) as { data: { commands: Array<{ sessionId: string }> } }
        expect(pulled.data.commands.some((c) => c.sessionId === replay.sessionId)).toBe(false)
        continue
      }
      expect({ path, ok: res.ok }).toEqual({ path, ok: false })
    }
    expect(await replayState()).toEqual(before)
    const prompts =
      await sql`SELECT 1 FROM kernel.node_permission_prompts WHERE job_id = ${replay.jobId}`
    expect(prompts).toHaveLength(0)
  })

  it("the WS hello never binds it", async () => {
    for (const nodeCredential of [undefined, realCredential, mintNodeCredential().token]) {
      const opened = await openNodeSessionForHello({
        orgId: visitor.orgId,
        userId: visitor.userId,
        deviceId: REPLAY_DEVICE_ID,
        connId: crypto.randomUUID(),
        nodeCredential,
      })
      expect(opened).toBeNull()
    }
    expect(
      await sql`SELECT 1 FROM kernel.node_connections WHERE node_id = ${replay.nodeId}`,
    ).toHaveLength(0)
  })
})
