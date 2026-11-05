// SPDX-License-Identifier: FSL-1.1-ALv2
// An org moving to another instance (migration 0266, modules/org/transfer-state/),
// against the real database, Redis, middleware and job dispatch:
//  - frozen: a write answers 503 `org_moving` with Retry-After, a read 200;
//  - draining: only the routes that start an agent turn are refused;
//  - incoming / moved: every request refused;
//  - webhooks refused while frozen, taken while draining; an agent turn of a
//    frozen org is refused;
//  - a queued job of a frozen org is held (kept, delayed, not run, not
//    completed) and runs once after the unfreeze; the dispatch refuses every
//    job of a frozen org, suspended-exempt ones and the materializer included;
//  - outbox events of a frozen org stay unclaimed; one published anyway is
//    deferred (EventDeferredError), released unprocessed, never dropped;
//  - only the transfer holding the org changes its state;
//  - two process views agree within a second; every live instance must ack,
//    a missing ack fails closed; the quiesce probe sees live work;
//  - the deadline resolver follows the control plane's decision;
//  - `x-liaison-cell` in managed, absent self-hosted;
//  - an org that is not moving: unchanged.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { MoveState } from "@liaison/control-plane-contract"
import { ORG_MOVING_CODE, orgMovingErrorSchema } from "@liaison/shared"
import { sql as dsql } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _publishEventInternal, EventDeferredError, onEvent } from "~/infra/events/event-bus"
import { OutboxWorkerTestAccess, processOutboxBatch } from "~/infra/events/outbox-worker"
import {
  enqueueAppJob,
  exportOrgJobs,
  getJobQueue,
  JobsTestAccess,
  OrgTransferHeldJobError,
  registerJobWorker,
} from "~/infra/jobs/jobs"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import {
  initializedOrgRuntimes,
  orgRuntimeReleases,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { STATE_MATERIALIZER_ORG_JOB } from "~/modules/attention/state-materializer"
import { createSession, logout, refreshSession } from "~/modules/auth/auth"
import { CELL_HEADER, clearCellHeaderCache } from "~/modules/cloud/cell-header"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  readIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { seedPendingEvent } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { OrgMovingError, requestRefused } from "./gate"
import {
  CONTROL_ASK_AFTER_MS,
  LEASE_LAPSE_MARGIN_MS,
  nextLeaseAskDelay,
  RESOLVER_INTERVAL_MS,
  ResolverLoopTestAccess,
  resolveOverdueMoves,
} from "./resolver"
import { SKIPPED_MOVING, sweepSkippingMoving, writeUnlessMoving } from "./skip-moving"
import {
  awaitOrgQuiesced,
  awaitOrgTransferAcks,
  OrgTransferConflictError,
  OrgTransferView,
  orgQuiesceReport,
  orgTransferStateOf,
  orgTransferView,
  readMovingOrgs,
  setOrgTransferState,
} from "./state"

interface Org {
  id: string
  bearer: string
  userId: string
  threadId: string
}

const orgs: string[] = []

async function setUpOrg(): Promise<Org> {
  const { orgId } = await minimal.secondOrg({ name: "Moving Org" })
  orgs.push(orgId)
  const session = await minimal.adminSession(orgId)
  const thread = await minimal.thread(orgId, session.userId)
  return { id: orgId, bearer: session.bearer, userId: session.userId, threadId: thread }
}

const req = (org: Org, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${org.bearer}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function expectMoving(res: Response) {
  expect(res.status).toBe(503)
  expect(res.headers.get("Retry-After")).toBe("2")
  const body = (await res.json()) as { error: Record<string, unknown> }
  const { message: _m, ...error } = body.error
  expect(orgMovingErrorSchema.parse(error).code).toBe(ORG_MOVING_CODE)
}

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  for (const orgId of orgs) {
    await sql`UPDATE kernel.organizations
                SET transfer_state = NULL, transfer_id = NULL, transfer_at = NULL
              WHERE id = ${orgId}`
  }
  await releaseTestLock()
})

describe("what each state refuses", () => {
  test("pure policy", () => {
    const rec = (state: "draining" | "frozen" | "incoming" | "moved") => ({
      orgId: "o",
      state,
      transferId: "t",
      at: 0,
    })
    expect(requestRefused(null, "POST", "/api/threads")).toBe(false)
    expect(requestRefused(rec("draining"), "POST", "/api/agent/chat")).toBe(true)
    expect(requestRefused(rec("draining"), "POST", "/api/threads/abc/messages")).toBe(true)
    expect(requestRefused(rec("draining"), "PATCH", "/api/threads/abc")).toBe(false)
    expect(requestRefused(rec("draining"), "GET", "/api/threads")).toBe(false)
    expect(requestRefused(rec("frozen"), "POST", "/api/contacts")).toBe(true)
    expect(requestRefused(rec("frozen"), "DELETE", "/api/contacts/1")).toBe(true)
    expect(requestRefused(rec("frozen"), "GET", "/api/contacts")).toBe(false)
    expect(requestRefused(rec("frozen"), "HEAD", "/api/contacts")).toBe(false)
    for (const s of ["incoming", "moved"] as const) {
      expect(requestRefused(rec(s), "GET", "/api/contacts")).toBe(true)
    }
  })
})

describe("requests", () => {
  test("not moving: unchanged; frozen: writes 503 org_moving, reads 200; back after unfreeze", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    expect((await req(org, "GET", "/api/threads")).status).toBe(200)
    const created = await req(org, "POST", "/api/threads", { title: "Before", participantIds: [] })
    expect(created.status).toBeLessThan(300)

    await setOrgTransferState(org.id, "frozen", transfer)
    const get = await req(org, "GET", "/api/threads")
    expect(get.status).toBe(200)
    await expectMoving(
      await req(org, "POST", "/api/threads", { title: "During", participantIds: [] }),
    )
    await expectMoving(
      await req(org, "POST", `/api/threads/${org.threadId}/messages`, { content: "hi" }),
    )
    // The websocket ticket is a write too: no new socket while frozen.
    await expectMoving(await req(org, "POST", "/api/auth/ws-ticket"))

    await setOrgTransferState(org.id, null, transfer)
    const after = await req(org, "POST", "/api/threads", { title: "After", participantIds: [] })
    expect(after.status).toBeLessThan(300)
  }, 60_000)

  test("sign-in, refresh and sign-out of a frozen org answer 503; the token still works after", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    const pair = await createSession(org.userId, org.id)
    await setOrgTransferState(org.id, "frozen", transfer)
    try {
      await expect(createSession(org.userId, org.id)).rejects.toBeInstanceOf(OrgMovingError)
      await expect(refreshSession(pair.refreshToken)).rejects.toBeInstanceOf(OrgMovingError)
      await expect(logout(pair.refreshToken)).rejects.toBeInstanceOf(OrgMovingError)
      expect(orgTransferView.activityOf(org.id).writes).toBe(0)
      await setOrgTransferState(org.id, null, transfer)
      // The refused refresh spent nothing: the same token rotates now.
      const next = await refreshSession(pair.refreshToken)
      expect(next.refreshToken).not.toBe(pair.refreshToken)
    } finally {
      await setOrgTransferState(org.id, null, transfer).catch(() => {})
    }
  }, 60_000)

  test("a write parked in the org setup is already counted: the quiesce sees it", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    await setOrgTransferState(org.id, "draining", transfer)
    // The org's setup is in progress here (a release not done): the request waits for it.
    initializedOrgRuntimes.delete(org.id)
    let finish: () => void = () => {}
    orgRuntimeReleases.set(
      org.id,
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    try {
      const pending = req(org, "POST", "/api/auth/ws-ticket")
      await Bun.sleep(500)
      expect(orgTransferView.activityOf(org.id).writes).toBe(1)
      orgRuntimeReleases.delete(org.id)
      finish()
      expect((await pending).status).toBeLessThan(300)
      expect(orgTransferView.activityOf(org.id).writes).toBe(0)
      // A refused request holds no count once answered.
      await setOrgTransferState(org.id, "frozen", transfer)
      await expectMoving(await req(org, "POST", "/api/auth/ws-ticket"))
      expect(orgTransferView.activityOf(org.id).writes).toBe(0)
    } finally {
      orgRuntimeReleases.delete(org.id)
      finish()
      await setOrgTransferState(org.id, null, transfer)
    }
  }, 60_000)

  test("a webhook accepted while draining is counted as a live write until it answers", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    // The org's setup is in progress here: the delivery waits for it, already counted.
    initializedOrgRuntimes.delete(org.id)
    let finish: () => void = () => {}
    orgRuntimeReleases.set(
      org.id,
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    try {
      await setOrgTransferState(org.id, "draining", transfer)
      const pending = app.request(`/webhooks/${org.id}/kernel/slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      await Bun.sleep(500)
      expect(orgTransferView.activityOf(org.id).writes).toBe(1)
      orgRuntimeReleases.delete(org.id)
      finish()
      await pending
      expect(orgTransferView.activityOf(org.id).writes).toBe(0)
    } finally {
      orgRuntimeReleases.delete(org.id)
      finish()
      await setOrgTransferState(org.id, null, transfer)
    }
  }, 60_000)

  test("draining: only turn-starting routes refused; incoming and moved refuse reads", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    await setOrgTransferState(org.id, "draining", transfer)
    await expectMoving(
      await req(org, "POST", `/api/threads/${org.threadId}/messages`, { content: "hi" }),
    )
    expect((await req(org, "GET", "/api/threads")).status).toBe(200)
    const patch = await req(org, "PATCH", `/api/threads/${org.threadId}`, { isPinned: true })
    expect(patch.status).not.toBe(503)

    await setOrgTransferState(org.id, "moved", transfer)
    await expectMoving(await req(org, "GET", "/api/threads"))
    await setOrgTransferState(org.id, null, transfer)

    const other = randomUUID()
    await setOrgTransferState(org.id, "incoming", other)
    await expectMoving(await req(org, "GET", "/api/threads"))
    await setOrgTransferState(org.id, null, other)
  }, 60_000)

  test("only the holding transfer changes the state", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    await setOrgTransferState(org.id, "frozen", transfer)
    const at = (await orgTransferStateOf(org.id))!.at
    await expect(setOrgTransferState(org.id, null, randomUUID())).rejects.toBeInstanceOf(
      OrgTransferConflictError,
    )
    await expect(setOrgTransferState(org.id, "moved", randomUUID())).rejects.toBeInstanceOf(
      OrgTransferConflictError,
    )
    // Re-setting the same state keeps the deadline's start.
    expect((await setOrgTransferState(org.id, "frozen", transfer))!.at).toBe(at)
    expect((await orgTransferStateOf(org.id))?.state).toBe("frozen")
    await setOrgTransferState(org.id, null, transfer)
    expect(await orgTransferStateOf(org.id)).toBeNull()
  }, 60_000)

  test("webhooks: 503 while frozen, taken while draining; agent turn refused while frozen", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    const handler = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    webhookHandlers.set([org.id, "kernel", "probe"], {
      appName: "kernel",
      orgId: org.id,
      verify: async () => ({ valid: true as const }),
      handler,
    } as never)
    const hook = () =>
      app.request(`/webhooks/${org.id}/kernel/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    try {
      await setOrgTransferState(org.id, "frozen", transfer)
      await expectMoving(await hook())
      expect(handler).not.toHaveBeenCalled()
      await expect(
        invokeAgentForThread(
          org.threadId,
          randomUUID(),
          { userId: org.userId, orgId: org.id, scopes: [] },
          org.id,
        ),
      ).rejects.toBeInstanceOf(OrgMovingError)

      // The public ticket routes are mounted before the generic webhook router:
      // the same gate stands in front of them.
      for (const path of ["tickets/create", "tickets/attachments", "tickets/csat/x"]) {
        await expectMoving(
          await app.request(`/webhooks/${org.id}/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        )
      }

      await setOrgTransferState(org.id, "draining", transfer)
      expect((await hook()).status).not.toBe(503)
    } finally {
      webhookHandlers.delete([org.id, "kernel", "probe"])
      await setOrgTransferState(org.id, null, transfer)
    }
  }, 60_000)
})

describe("jobs", () => {
  test("the dispatch holds every job of a frozen org, exempt and materializer jobs included", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    const run = mock(async (_p: unknown) => {})
    registerJobWorker("kernel", "files-orphan-gc", run, { txMode: "session" })
    await setOrgTransferState(org.id, "frozen", transfer)
    try {
      for (const name of ["files-orphan-gc", "org-export-sweep", STATE_MATERIALIZER_ORG_JOB]) {
        await expect(
          JobsTestAccess.processJob("kernel", name, { orgId: org.id }),
        ).rejects.toBeInstanceOf(OrgTransferHeldJobError)
      }
      expect(run).not.toHaveBeenCalled()
    } finally {
      await setOrgTransferState(org.id, null, transfer)
    }
    await JobsTestAccess.processJob("kernel", "files-orphan-gc", { orgId: org.id })
    expect(run).toHaveBeenCalledTimes(1)
  }, 60_000)

  test("a queued job of a frozen org is kept, delayed, and runs once after the unfreeze", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    const ran: unknown[] = []
    registerJobWorker(
      "kernel",
      "load-synthetic",
      async (p) => {
        ran.push(p)
      },
      { txMode: "session" },
    )
    await setOrgTransferState(org.id, "frozen", transfer)
    const marker = randomUUID()
    const jobId = await enqueueAppJob("kernel", "load-synthetic", { orgId: org.id, marker })
    await Bun.sleep(1_500)
    expect(ran).toHaveLength(0)
    const queue = getJobQueue("kernel", "load-synthetic")
    const held = await queue.getJob(jobId)
    expect(held).toBeDefined()
    expect(await held!.getState()).toBe("delayed")
    expect(held!.data).toMatchObject({ orgId: org.id, marker })

    await setOrgTransferState(org.id, null, transfer)
    const deadline = Date.now() + 15_000
    while (ran.length === 0 && Date.now() < deadline) await Bun.sleep(100)
    expect(ran).toHaveLength(1)
    await Bun.sleep(500)
    expect(ran).toHaveLength(1)
  }, 30_000)

  test("the in-gap job export carries every held job through the hold's churn", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    registerJobWorker("kernel", "load-synthetic", async () => {}, { txMode: "session" })
    await setOrgTransferState(org.id, "frozen", transfer)
    const ids = new Set<string>()
    for (let i = 0; i < 40; i++) {
      ids.add(await enqueueAppJob("kernel", "load-synthetic", { orgId: org.id, n: i }))
    }
    try {
      // The worker keeps picking each held job up and putting it back.
      const until = Date.now() + 7_000
      let reads = 0
      while (Date.now() < until) {
        const { jobs } = await exportOrgJobs(org.id)
        const carried = new Set(jobs.map((j) => j.id))
        for (const id of ids) expect(carried.has(id)).toBe(true)
        reads++
        await Bun.sleep(150)
      }
      expect(reads).toBeGreaterThan(3)
    } finally {
      const queue = getJobQueue("kernel", "load-synthetic")
      for (const id of ids) await (await queue.getJob(id))?.remove().catch(() => {})
      await setOrgTransferState(org.id, null, transfer)
    }
  }, 60_000)

  test("one export reads a populated queue whole, and its time is measured", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    registerJobWorker("kernel", "load-synthetic", async () => {}, { txMode: "session" })
    const queue = getJobQueue("kernel", "load-synthetic")
    const otherOrg = randomUUID()
    // Another org's backlog in the same queue: 5,000 jobs due in an hour.
    const backlog = await queue.addBulk(
      Array.from({ length: 5_000 }, (_, n) => ({
        name: "load-synthetic",
        data: { orgId: otherOrg, n },
        opts: { delay: 3_600_000 },
      })),
    )
    await setOrgTransferState(org.id, "frozen", transfer)
    const ids = new Set<string>()
    for (let i = 0; i < 40; i++) {
      ids.add(await enqueueAppJob("kernel", "load-synthetic", { orgId: org.id, n: i }))
    }
    try {
      await Bun.sleep(1_000)
      const started = performance.now()
      const { jobs } = await exportOrgJobs(org.id)
      const ms = performance.now() - started
      console.info(
        `org transfer job export: ${Math.round(ms)} ms over ${backlog.length + 40} queued jobs`,
      )
      expect(new Set(jobs.map((j) => j.id))).toEqual(ids)
      expect(ms).toBeLessThan(5_000)
    } finally {
      for (const id of ids) await (await queue.getJob(id))?.remove().catch(() => {})
      for (const j of backlog) await j.remove().catch(() => {})
      await setOrgTransferState(org.id, null, transfer)
    }
  }, 120_000)

  test("a scheduler tick due while the org is frozen is carried once; the future one is not", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    registerJobWorker("kernel", "load-synthetic", async () => {}, { txMode: "session" })
    const queue = getJobQueue("kernel", "load-synthetic")
    const schedulerId = `xfer-tick-${org.id}`
    await setOrgTransferState(org.id, "frozen", transfer)
    await queue.upsertJobScheduler(
      schedulerId,
      { every: 300 },
      { name: "load-synthetic", data: { orgId: org.id } },
    )
    try {
      await Bun.sleep(2_000)
      const now = Date.now()
      const { jobs, schedulers } = await exportOrgJobs(org.id, { now })
      expect(schedulers.map((x) => x.id)).toContain(schedulerId)
      const ticks = jobs.filter((j) => j.id.startsWith(`repeat:${schedulerId}:`))
      expect(ticks.length).toBeGreaterThan(0)
      for (const t of ticks) {
        expect(Number(t.id.split(":").pop())).toBeLessThanOrEqual(now)
        expect(t.delayMs).toBe(0)
      }
    } finally {
      await queue.removeJobScheduler(schedulerId)
      for (const j of await queue.getJobs(["delayed", "waiting", "active"])) {
        if (j?.data?.orgId === org.id) await j.remove().catch(() => {})
      }
      await setOrgTransferState(org.id, null, transfer)
    }
  }, 60_000)
})

describe("events", () => {
  afterEach(() => OutboxWorkerTestAccess.setOrgInit(null))

  test("outbox events of a frozen org stay unclaimed and flow after the unfreeze", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    OutboxWorkerTestAccess.setOrgInit(async () => {})
    await setOrgTransferState(org.id, "frozen", transfer)
    const payload = JSON.stringify({
      app: "transfer-probe",
      entity: "probe",
      action: "ping",
      entityId: "1",
      orgId: org.id,
      actorType: "system",
      timestamp: new Date().toISOString(),
    })
    const row = { id: await seedPendingEvent(org.id, JSON.parse(payload)) }
    await processOutboxBatch()
    const [frozen] =
      await sql`SELECT claimed_at, processed_at FROM kernel.pending_events WHERE id = ${row!.id}`
    expect(frozen!.claimed_at).toBeNull()
    expect(frozen!.processed_at).toBeNull()

    await setOrgTransferState(org.id, null, transfer)
    for (let i = 0; i < 5; i++) await processOutboxBatch()
    const [after] =
      await sql`SELECT claimed_at, processed_at, failed_at FROM kernel.pending_events WHERE id = ${row!.id}`
    expect(
      after!.claimed_at !== null || after!.processed_at !== null || after!.failed_at !== null,
    ).toBe(true)
    await sql`DELETE FROM kernel.pending_events WHERE id = ${row!.id}`
  }, 60_000)

  test("a frozen org's event is deferred, not dropped: no handler runs, it flows after the unfreeze", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    const once: string[] = []
    const replica: string[] = []
    onEvent(
      async (e) => {
        if (e.orgId === org.id) once.push(e.action)
      },
      { delivery: "once" },
    )
    onEvent(
      async (e) => {
        if (e.orgId === org.id) replica.push(e.action)
      },
      { delivery: "per-replica" },
    )
    const publish = (action: string) =>
      _publishEventInternal({
        app: "transfer-probe",
        entity: "probe",
        action,
        entityId: "1",
        orgId: org.id,
        actorType: "system",
        actorId: null,
        data: {},
        timestamp: new Date().toISOString(),
      } as never)
    await setOrgTransferState(org.id, "frozen", transfer)
    await expect(publish("frozen")).rejects.toBeInstanceOf(EventDeferredError)
    await Bun.sleep(300)
    await setOrgTransferState(org.id, null, transfer)
    await publish("live")
    await Bun.sleep(300)
    expect(once).toEqual(["live"])
    expect(replica).toEqual(["live"])
  }, 60_000)

  test("a publish that fails before its dispatch ends the org's work count", async () => {
    const org = await setUpOrg()
    expect(orgTransferView.hasOwnActivity(org.id)).toBe(false)
    // A BigInt cannot be serialised: the publish throws after the org's work was counted.
    await expect(
      _publishEventInternal({
        app: "transfer-probe",
        entity: "probe",
        action: "unserialisable",
        entityId: "1",
        orgId: org.id,
        actorType: "system",
        actorId: null,
        data: { n: 1n },
        timestamp: new Date().toISOString(),
      } as never),
    ).rejects.toBeInstanceOf(TypeError)
    // Nothing was dispatched, so nothing of the org is still live: a move's quiesce would not wait.
    expect(orgTransferView.hasOwnActivity(org.id)).toBe(false)
  }, 60_000)

  test("an event claimed just before the freeze is released unprocessed, attempts untouched", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    // The org freezes between the claim and the publish (the org setup runs in between).
    initializedOrgRuntimes.delete(org.id)
    OutboxWorkerTestAccess.setOrgInit(async (orgId) => {
      if (orgId === org.id) await setOrgTransferState(org.id, "frozen", transfer)
    })
    const payload = JSON.stringify({
      app: "transfer-probe",
      entity: "probe",
      action: "claimed",
      entityId: "1",
      orgId: org.id,
      actorType: "system",
      timestamp: new Date().toISOString(),
    })
    const row = { id: await seedPendingEvent(org.id, JSON.parse(payload)) }
    await processOutboxBatch()
    const [held] = await sql`SELECT claimed_at, processed_at, failed_at, attempts
      FROM kernel.pending_events WHERE id = ${row!.id}`
    expect(held!.claimed_at).toBeNull()
    expect(held!.processed_at).toBeNull()
    expect(held!.failed_at).toBeNull()
    expect(Number(held!.attempts ?? 0)).toBe(0)
    await setOrgTransferState(org.id, null, transfer)
    await sql`DELETE FROM kernel.pending_events WHERE id = ${row!.id}`
  }, 60_000)
})

describe("confirmation across processes", () => {
  test("two views agree within a second; acks of every instance; quiesce sees live work", async () => {
    const org = await setUpOrg()
    const transfer = randomUUID()
    const a = new OrgTransferView({ instanceId: `test-a-${randomUUID()}`, read: readMovingOrgs })
    const b = new OrgTransferView({ instanceId: `test-b-${randomUUID()}`, read: readMovingOrgs })
    const silent = `test-c-${randomUUID()}`
    await a.refresh()
    await b.refresh()
    expect(await b.stateOf(org.id)).toBeNull()

    const startedAt = Date.now()
    await setOrgTransferState(org.id, "frozen", transfer)
    // b hears no broadcast here: its snapshot ages out within a second.
    let seen = await b.stateOf(org.id)
    while (seen === null && Date.now() - startedAt < 3_000) {
      await Bun.sleep(50)
      seen = await b.stateOf(org.id)
    }
    expect(seen?.state).toBe("frozen")
    expect(Date.now() - startedAt).toBeLessThanOrEqual(1_500)

    const end = a.begin(org.id, "writes")
    await a.refresh()
    await b.refresh()
    const both = [a.instanceId, b.instanceId]
    expect((await awaitOrgTransferAcks(org.id, "frozen", transfer, { instances: both })).ok).toBe(
      true,
    )
    // An instance that never confirms fails the wait closed.
    const missing = await awaitOrgTransferAcks(org.id, "frozen", transfer, {
      instances: [...both, silent],
      timeoutMs: 300,
    })
    expect(missing).toEqual({ ok: false, missing: [silent] })

    const busy = await orgQuiesceReport(org.id, "frozen", transfer, { instances: both })
    expect(busy.quiet).toBe(false)
    expect(busy.writes).toBe(1)
    end()
    const quiet = await awaitOrgQuiesced(org.id, "frozen", transfer, { instances: both })
    expect(quiet).toMatchObject({ quiet: true, writes: 0, jobs: 0, turns: 0, claimedEvents: 0 })

    await setOrgTransferState(org.id, null, transfer)
    await a.refresh()
    await b.refresh()
    expect((await awaitOrgTransferAcks(org.id, null, transfer, { instances: both })).ok).toBe(true)
  }, 60_000)
})

describe("cross-org sweeps", () => {
  test("a sweep that read the moving set before a freeze counts as a write until it ends", async () => {
    const org = await setUpOrg()
    const other = await setUpOrg()
    const transfer = randomUUID()
    const otherTransfer = randomUUID()
    await setOrgTransferState(other.id, "frozen", otherTransfer)
    await orgTransferView.refresh()
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let fragment = ""
    const sweep = sweepSkippingMoving(async (notMoving) => {
      fragment = notMoving(dsql.raw("org_id")) ? "built" : ""
      await held
    })
    try {
      // The org freezes while the sweep (which may write it) is still running.
      await setOrgTransferState(org.id, "frozen", transfer)
      await orgTransferView.refresh()
      expect(orgTransferView.activityOf(org.id).writes).toBe(1)
      // The org the sweep left alone does not wait for it.
      expect(orgTransferView.activityOf(other.id).writes).toBe(0)
      release()
      await sweep
      expect(fragment).not.toBe("")
      expect(orgTransferView.activityOf(org.id).writes).toBe(0)
      // A per-org write of the sweep, once the org is frozen, is skipped and not run.
      let ran = false
      expect(
        await writeUnlessMoving(org.id, async () => {
          ran = true
        }),
      ).toBe(SKIPPED_MOVING)
      expect(ran).toBe(false)
    } finally {
      release()
      await setOrgTransferState(org.id, null, transfer)
      await setOrgTransferState(other.id, null, otherTransfer)
      await orgTransferView.refresh()
    }
  }, 60_000)
})

describe("deadline resolver (D34)", () => {
  const backdate = (orgId: string) =>
    sql`UPDATE kernel.organizations SET transfer_at = now() - interval '60 seconds' WHERE id = ${orgId}`

  test("follows the control plane: aborted unfreezes, committed marks moved, unreachable keeps", async () => {
    const aborted = await setUpOrg()
    const committed = await setUpOrg()
    const unreachable = await setUpOrg()
    const recent = await setUpOrg()
    const incoming = await setUpOrg()
    const t = Object.fromEntries(
      [aborted, committed, unreachable, recent, incoming].map((o) => [o.id, randomUUID()]),
    )
    await setOrgTransferState(aborted.id, "frozen", t[aborted.id]!)
    await setOrgTransferState(committed.id, "frozen", t[committed.id]!)
    await setOrgTransferState(unreachable.id, "frozen", t[unreachable.id]!)
    await setOrgTransferState(recent.id, "frozen", t[recent.id]!)
    await setOrgTransferState(incoming.id, "incoming", t[incoming.id]!)
    for (const o of [aborted, committed, unreachable, incoming]) await backdate(o.id)
    const mine = new Set([aborted.id, committed.id, unreachable.id, recent.id, incoming.id])
    const asked: string[] = []
    const outcomes = await resolveOverdueMoves({
      moving: async () => (await readMovingOrgs()).filter((r) => mine.has(r.orgId)),
      askControl: async (orgId) => {
        asked.push(orgId)
        if (orgId === aborted.id) return "aborted"
        if (orgId === committed.id || orgId === incoming.id) return "committed"
        throw new Error("control plane unreachable")
      },
      purgeIncoming: null,
    })
    expect(asked).not.toContain(recent.id)
    const actionOf = (id: string) => outcomes.find((o) => o.orgId === id)?.action
    expect(actionOf(aborted.id)).toBe("unfrozen")
    expect(actionOf(committed.id)).toBe("marked-moved")
    expect(actionOf(unreachable.id)).toBe("unreachable")
    expect(actionOf(incoming.id)).toBe("served")
    expect(await orgTransferStateOf(aborted.id)).toBeNull()
    expect((await orgTransferStateOf(committed.id))?.state).toBe("moved")
    expect((await orgTransferStateOf(unreachable.id))?.state).toBe("frozen")
    expect((await orgTransferStateOf(recent.id))?.state).toBe("frozen")
    expect(await orgTransferStateOf(incoming.id)).toBeNull()
  }, 60_000)
})

describe("resolver: a committed move is served without waiting for the deadline", () => {
  const NOW = 1_000_000_000
  type Rec = {
    orgId: string
    state: "draining" | "frozen" | "incoming"
    transferId: string
    at: number
  }
  const run = async (recs: Rec[], answer: (orgId: string) => MoveState | Error) => {
    const asked: string[] = []
    const set: Array<[string, string | null]> = []
    const purged: string[] = []
    const out = await resolveOverdueMoves({
      moving: async () => recs,
      askControl: async (orgId) => {
        asked.push(orgId)
        const a = answer(orgId)
        if (a instanceof Error) throw a
        return a
      },
      setState: async (orgId, state) => {
        set.push([orgId, state])
        return null
      },
      purgeIncoming: async (orgId) => {
        purged.push(orgId)
      },
      resumeAfterCommit: null,
      now: () => NOW,
    })
    return {
      out,
      asked,
      set,
      purged,
      action: (id: string) => out.find((o) => o.orgId === id)?.action,
    }
  }

  test("past the first ask: committed is acted on at once, open and aborted incoming wait", async () => {
    const age = CONTROL_ASK_AFTER_MS + 1_000
    const rec = (orgId: string, state: Rec["state"], ageMs = age): Rec => ({
      orgId,
      state,
      transferId: randomUUID(),
      at: NOW - ageMs,
    })
    const answers: Record<string, MoveState | Error> = {
      inCommitted: "committed",
      srcCommitted: "committed",
      srcFrozen: "frozen",
      srcAborted: "aborted",
      inAborted: "aborted",
      inAbortedLate: "aborted",
      unreachable: new Error("down"),
      fresh: "committed",
    }
    const r = await run(
      [
        rec("inCommitted", "incoming"),
        rec("srcCommitted", "frozen"),
        rec("srcFrozen", "frozen"),
        rec("srcAborted", "frozen"),
        rec("inAborted", "incoming"),
        rec("inAbortedLate", "incoming", 46_000),
        rec("unreachable", "frozen"),
        rec("fresh", "incoming", CONTROL_ASK_AFTER_MS - 1),
      ],
      (id) => answers[id] as MoveState | Error,
    )
    expect(r.action("inCommitted")).toBe("served")
    expect(r.action("srcCommitted")).toBe("marked-moved")
    expect(r.action("srcFrozen")).toBe("waiting")
    expect(r.action("srcAborted")).toBe("unfrozen")
    // An aborted incoming copy is purged only past the deadline: an import may still be running.
    expect(r.action("inAborted")).toBe("waiting")
    expect(r.action("inAbortedLate")).toBe("purged")
    expect(r.action("unreachable")).toBe("unreachable")
    expect(r.asked).not.toContain("fresh")
    expect(r.set).toEqual([
      ["inCommitted", null],
      ["srcCommitted", "moved"],
      ["srcAborted", null],
    ])
    expect(r.purged).toEqual(["inAbortedLate"])
  })

  test("the worst case after a commit is one ask delay plus one pass, well under the 20 s bound", () => {
    // The incoming state is entered at the first import, before the freeze, so
    // a commit is served at most CONTROL_ASK_AFTER_MS + one pass after it.
    expect(CONTROL_ASK_AFTER_MS + RESOLVER_INTERVAL_MS).toBeLessThanOrEqual(10_000)
  })
})

describe("unknown move state", () => {
  test("a state this release does not know gates as frozen and is never acted on", async () => {
    const orgId = randomUUID()
    let asked = 0
    let set = 0
    const outcomes = await resolveOverdueMoves({
      moving: async () => [
        { orgId, state: "frozen", transferId: randomUUID(), at: 0, unknown: true },
      ],
      askControl: async () => {
        asked++
        return "committed"
      },
      setState: async () => {
        set++
        return null
      },
      purgeIncoming: null,
      resumeAfterCommit: null,
    })
    expect(outcomes.map((o) => o.action)).toEqual(["unknown-state"])
    expect(asked).toBe(0)
    expect(set).toBe(0)
  })
})

describe("x-liaison-cell", () => {
  const mutableEnv = env as { LIAISON_EDITION?: string }
  const saved = mutableEnv.LIAISON_EDITION

  test("managed: names the registered instance; self-hosted: absent", async () => {
    const previous = await withSystemDb("test-cell-header", (db) => readIdentity(db))
    const identity = {
      ...mintIdentity(),
      keyCiphertext: encryptInstanceKey("e6".repeat(32)),
      state: "registered" as const,
      registeredAt: new Date().toISOString(),
    }
    try {
      await withSystemDb("test-cell-header", (db) => writeIdentity(db, identity))
      mutableEnv.LIAISON_EDITION = "managed"
      _setEdition(null)
      clearCellHeaderCache()
      const managed = await app.request("/healthz")
      expect(managed.headers.get(CELL_HEADER)).toBe(identity.instanceId)

      mutableEnv.LIAISON_EDITION = "self_hosted"
      _setEdition(null)
      const selfHosted = await app.request("/healthz")
      expect(selfHosted.headers.get(CELL_HEADER)).toBeNull()
    } finally {
      mutableEnv.LIAISON_EDITION = saved
      _setEdition(null)
      clearCellHeaderCache()
      await withSystemDb("test-cell-header", async (db) => {
        if (previous) await writeIdentity(db, previous)
        else await deleteIdentity(db)
      })
    }
  })
})

describe("resolver: a lapsed lease is asked about at its end, not a pass later", () => {
  const NOW = 2_000_000_000
  test("an open move's lease end is kept and drives one extra ask just past it", async () => {
    const leaseEnd = NOW + 2_000
    const out = await resolveOverdueMoves({
      moving: async () => [
        { orgId: "frozenLease", state: "frozen", transferId: randomUUID(), at: NOW - 12_000 },
        { orgId: "frozenNoLease", state: "frozen", transferId: randomUUID(), at: NOW - 12_000 },
        { orgId: "aborted", state: "frozen", transferId: randomUUID(), at: NOW - 12_000 },
      ],
      askControl: async (orgId) =>
        orgId === "frozenLease"
          ? { state: "frozen", leaseUntil: new Date(leaseEnd).toISOString() }
          : orgId === "aborted"
            ? { state: "aborted", leaseUntil: null }
            : "frozen",
      setState: async () => null,
      purgeIncoming: null,
      resumeAfterCommit: null,
      now: () => NOW,
    })
    const of = (id: string) => out.find((o) => o.orgId === id)
    expect(of("frozenLease")).toMatchObject({ action: "waiting", leaseUntil: leaseEnd })
    expect(of("frozenNoLease")?.leaseUntil).toBeUndefined()
    // The object answer form is read like the bare state.
    expect(of("aborted")?.action).toBe("unfrozen")
    expect(nextLeaseAskDelay(out, NOW)).toBe(2_000 + LEASE_LAPSE_MARGIN_MS)
  })

  test("one resolver pass at a time: a pass started while one runs is skipped", async () => {
    ResolverLoopTestAccess.runPass()
    expect(ResolverLoopTestAccess.isRunning()).toBe(true)
    ResolverLoopTestAccess.runPass()
    for (let i = 0; i < 200 && ResolverLoopTestAccess.isRunning(); i++) await Bun.sleep(25)
    expect(ResolverLoopTestAccess.isRunning()).toBe(false)
  })

  test("no extra ask when the regular pass comes first, or nothing is open", () => {
    const waiting = (leaseUntil?: number) => ({
      orgId: "o",
      transferId: "t",
      from: "frozen" as const,
      decided: "frozen" as const,
      action: "waiting" as const,
      ...(leaseUntil === undefined ? {} : { leaseUntil }),
    })
    expect(nextLeaseAskDelay([waiting(NOW + RESOLVER_INTERVAL_MS + 1)], NOW)).toBeNull()
    expect(nextLeaseAskDelay([waiting()], NOW)).toBeNull()
    expect(nextLeaseAskDelay([], NOW)).toBeNull()
    // A lease already past (clock skew): asked again after the margin alone.
    expect(nextLeaseAskDelay([waiting(NOW - 3_000)], NOW)).toBe(LEASE_LAPSE_MARGIN_MS)
    // ...once: a transfer that already had its extra ask waits for the regular
    // pass (a cell clock ahead of Control's would otherwise poll at 4 Hz).
    const skewed = waiting(NOW - 3_000)
    expect(
      nextLeaseAskDelay([skewed], NOW, RESOLVER_INTERVAL_MS, new Set([skewed.transferId])),
    ).toBeNull()
    // A lease still ahead is asked about whatever the set says.
    const ahead = waiting(NOW + 1_000)
    expect(nextLeaseAskDelay([ahead], NOW, RESOLVER_INTERVAL_MS, new Set([ahead.transferId]))).toBe(
      1_000 + LEASE_LAPSE_MARGIN_MS,
    )
    // The soonest lease wins.
    expect(nextLeaseAskDelay([waiting(NOW + 3_000), waiting(NOW + 1_000)], NOW)).toBe(
      1_000 + LEASE_LAPSE_MARGIN_MS,
    )
  })
})
