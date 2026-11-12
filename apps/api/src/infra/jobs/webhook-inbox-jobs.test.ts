// SPDX-License-Identifier: FSL-1.1-ALv2
// The webhook inbox's replay, sweep and legacy drain (webhook-inbox-jobs.ts),
// against the real database and queue; the handler call goes through the
// manifest executor seam, so no sandbox runs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import * as jobsModule from "~/infra/jobs/jobs"
import { getJobQueue } from "~/infra/jobs/jobs"
import {
  drainLegacyRetryJobs,
  replayInboxDelivery,
  sweepWebhookInbox,
} from "~/infra/jobs/webhook-inbox-jobs"
import { effectOnce } from "~/lib/effect-once"
import { webhookHandlers } from "~/modules/apps/app-registries"
import * as appDayCapModule from "~/modules/apps/usage/app-day-cap"
import { WebhookHandlerRunTestAccess } from "~/modules/webhooks/handler-run"
import {
  claimForReplay,
  type InboxDelivery,
  pruneWebhookInbox,
  settleDelivery,
  storeDelivery,
  WEBHOOK_INBOX_DEAD_RETENTION_DAYS,
  WEBHOOK_INBOX_MAX_ATTEMPTS,
} from "~/modules/webhooks/inbox"
import { seedOrgRow } from "~/seed/factories/org/rows"

const ORG = "00000000-0000-0000-0000-0000000000c7"
const APP = "inboxapp"
const ENDPOINT = "orders"

let tmpDir: string
let bundlePath: string
/** What the handler was called with, and what it answers next. */
const calls: { params: unknown; headers: unknown }[] = []
let answer: () => Promise<unknown> = async () => ({ status: 200 })

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "webhook-inbox-"))
  bundlePath = join(tmpDir, "bundle.js")
  writeFileSync(bundlePath, "globalThis.onOrder = async () => {}\n")
  await seedOrgRow(
    { id: ORG, name: "Webhook Inbox Org", slug: "webhook-inbox-org" },
    { onConflict: "skip" },
  )
  WebhookHandlerRunTestAccess.setManifestExecutor(async (opts) => {
    calls.push({ params: opts.params, headers: opts.extraArgs?.[0] })
    return answer()
  })
})

afterAll(async () => {
  WebhookHandlerRunTestAccess.setManifestExecutor()
  rmSync(tmpDir, { recursive: true, force: true })
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

let enqueued: { name: string; data: unknown; opts: unknown }[] = []

beforeEach(() => {
  calls.length = 0
  answer = async () => ({ status: 200 })
  enqueued = []
  // The replay wakes are observed, not queued.
  spyOn(jobsModule, "enqueueAppJob").mockImplementation(async (_app, name, data, opts) => {
    enqueued.push({ name, data, opts })
    return "stub"
  })
  spyOn(jobsModule, "enqueueAppJobs").mockImplementation(async (_app, jobs) => {
    for (const j of jobs) enqueued.push({ name: j.jobName, data: j.payload, opts: j.opts })
  })
  webhookHandlers.set([ORG, APP, ENDPOINT], {
    appName: APP,
    orgId: ORG,
    handler: { bundlePath, exportName: "onOrder" },
    verify: { bundlePath, exportName: "verify" },
    _manifest: { name: APP } as never,
  })
})

afterEach(async () => {
  webhookHandlers.delete([ORG, APP, ENDPOINT])
  await sql`DELETE FROM kernel.webhook_inbox WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.effect_ledger WHERE org_id = ${ORG}`
  const { mock } = await import("bun:test")
  mock.restore()
})

function delivery(over: Partial<InboxDelivery> = {}): InboxDelivery {
  return {
    orgId: ORG,
    appName: APP,
    endpointName: ENDPOINT,
    deliveryHash: createHash("sha256").update(randomUUID()).digest("hex"),
    dedupTtlSeconds: 3600,
    payload: { order: 1 },
    headers: { "x-provider-id": "evt-1" },
    scopes: [`${APP}:*`],
    ...over,
  }
}

type Row = { status: string; attempts: number; payload: unknown; due_in_ms: number }
async function row(id: string): Promise<Row | undefined> {
  const [r] = await sql<Row[]>`
    SELECT status, attempts, payload,
      (extract(epoch FROM due_at - now()) * 1000)::float8 AS due_in_ms
    FROM kernel.webhook_inbox WHERE id = ${id}`
  return r
}
const makeDue = (id: string) =>
  sql`UPDATE kernel.webhook_inbox SET due_at = now() - interval '1 second' WHERE id = ${id}`

describe("webhook inbox replay", () => {
  // A process that stored the delivery and died before (or while) running the
  // handler: the row stays `processing` until its lease ends, then the sweep
  // wakes it and the replay runs the handler with the stored payload and headers.
  it("replays a delivery whose process died between store and handle", async () => {
    const stored = await storeDelivery(delivery(), { claimLeaseMs: 60_000 })
    if (!stored) throw new Error("not stored")
    // Lease still live: not due, the replay does not touch it.
    const wakesOf = () =>
      enqueued.filter(
        (j) =>
          j.name === "webhook-inbox-replay" &&
          (j.data as { inboxId?: string }).inboxId === stored.id,
      )
    await sweepWebhookInbox()
    expect(wakesOf()).toHaveLength(0)
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    expect(calls).toHaveLength(0)

    await makeDue(stored.id)
    await sweepWebhookInbox()
    const [wake] = wakesOf()
    expect(wake?.data).toEqual({ orgId: ORG, inboxId: stored.id })
    await replayInboxDelivery(wake?.data as { orgId: string; inboxId: string })

    expect(calls).toEqual([{ params: { order: 1 }, headers: { "x-provider-id": "evt-1" } }])
    expect(await row(stored.id)).toMatchObject({ status: "done", attempts: 2, payload: null })
  })

  it("runs a delivery once when its replay is woken twice", async () => {
    const stored = await storeDelivery(delivery(), { claimLeaseMs: 60_000 })
    if (!stored) throw new Error("not stored")
    await makeDue(stored.id)
    await Promise.all([
      replayInboxDelivery({ orgId: ORG, inboxId: stored.id }),
      replayInboxDelivery({ orgId: ORG, inboxId: stored.id }),
    ])
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    expect(calls).toHaveLength(1)
  })

  it("a duplicate delivery of a stored identity is not stored twice", async () => {
    const d = delivery()
    const first = await storeDelivery(d, { claimLeaseMs: 60_000 })
    expect(first).not.toBeNull()
    // Being processed under a live lease, then done within the dedup window.
    expect(await storeDelivery(d, { claimLeaseMs: 60_000 })).toBeNull()
    await makeDue(first?.id as string)
    await replayInboxDelivery({ orgId: ORG, inboxId: first?.id })
    expect(await storeDelivery(d, { claimLeaseMs: 60_000 })).toBeNull()
    // Past the dedup window, the same identity is a new delivery again.
    await sql`UPDATE kernel.webhook_inbox SET dedup_until = now() - interval '1 second'
      WHERE id = ${first?.id as string}`
    expect(await storeDelivery(d, { claimLeaseMs: 60_000 })).not.toBeNull()
  })

  it("an identity delivered again after its dedup window is a new delivery, replayed too", async () => {
    const d = delivery()
    const first = await storeDelivery(d, { claimLeaseMs: 60_000 })
    if (!first) throw new Error("not stored")
    await makeDue(first.id)
    await replayInboxDelivery({ orgId: ORG, inboxId: first.id })
    await sql`UPDATE kernel.webhook_inbox SET dedup_until = now() - interval '1 second'
      WHERE id = ${first.id}`
    const again = await storeDelivery({ ...d, payload: { order: 2 } }, { claimLeaseMs: 60_000 })
    if (!again) throw new Error("not stored again")
    // Its first run lost its process: the replay runs it.
    await makeDue(again.id)
    await replayInboxDelivery({ orgId: ORG, inboxId: again.id })
    expect(calls.map((c) => c.params)).toEqual([{ order: 1 }, { order: 2 }])
    expect(await row(again.id)).toMatchObject({ status: "done" })
  })

  it("a failing handler backs off, then the delivery is dead after its last attempt", async () => {
    answer = async () => ({ status: 503 })
    const stored = await storeDelivery(delivery(), { claimLeaseMs: 60_000 })
    if (!stored) throw new Error("not stored")
    for (let attempt = 2; attempt <= WEBHOOK_INBOX_MAX_ATTEMPTS; attempt++) {
      await makeDue(stored.id)
      await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
      const r = await row(stored.id)
      if (attempt < WEBHOOK_INBOX_MAX_ATTEMPTS) {
        expect(r).toMatchObject({ status: "pending", attempts: attempt })
        expect(r?.due_in_ms ?? 0).toBeGreaterThan(0)
      } else {
        // Kept with its payload for diagnosis.
        expect(r).toMatchObject({ status: "dead", payload: { order: 1 } })
      }
    }
    expect(calls).toHaveLength(WEBHOOK_INBOX_MAX_ATTEMPTS - 1)
    // Each failure woke the next attempt at its backoff.
    const wakes = enqueued.filter((j) => j.name === "webhook-inbox-replay")
    expect(wakes).toHaveLength(WEBHOOK_INBOX_MAX_ATTEMPTS - 2)
  })

  it("a handler that rejects the delivery (4xx) is settled rejected, not retried", async () => {
    answer = async () => ({ status: 422, body: "unknown topic" })
    const stored = await storeDelivery(delivery(), { claimLeaseMs: 60_000 })
    if (!stored) throw new Error("not stored")
    await makeDue(stored.id)
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    expect(await row(stored.id)).toMatchObject({ status: "rejected", payload: null })
    expect(enqueued).toHaveLength(0)
  })

  it("holds a delivery at an app day cap, then runs it once the cap is lifted", async () => {
    const HOLD_MS = 3_600_000
    const hold = spyOn(appDayCapModule, "appRunHoldMs").mockResolvedValue(HOLD_MS)
    const stored = await storeDelivery(delivery(), { holdMs: HOLD_MS })
    if (!stored) throw new Error("not stored")
    expect(await row(stored.id)).toMatchObject({ status: "held", attempts: 0 })
    // Not due before its hold ends.
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    expect(calls).toHaveLength(0)

    // Due, but the org is still capped: held again, no attempt spent.
    await makeDue(stored.id)
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    const held = await row(stored.id)
    expect(held).toMatchObject({ status: "held", attempts: 0 })
    expect(Math.abs((held?.due_in_ms ?? 0) - HOLD_MS)).toBeLessThan(60_000)
    expect(enqueued.find((j) => j.name === "webhook-inbox-replay")?.opts).toMatchObject({
      delay: HOLD_MS,
    })
    expect(calls).toHaveLength(0)

    // Released: the next UTC day.
    hold.mockResolvedValue(null)
    await makeDue(stored.id)
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    expect(calls).toHaveLength(1)
    expect(await row(stored.id)).toMatchObject({ status: "done", attempts: 1 })
  })
})

describe("webhook inbox: claims, privacy and retention", () => {
  // A replay that lost its claim (its lease ended and another runner took the
  // row over) must not settle the row under the new runner.
  it("a settle whose claim was taken over is lost and leaves the new claim's row alone", async () => {
    const first = await storeDelivery(delivery(), { claimLeaseMs: 60_000 })
    if (!first) throw new Error("not stored")
    await makeDue(first.id)
    const second = await claimForReplay(ORG, first.id)
    if (!second) throw new Error("not claimed")
    expect(second.claimToken).not.toBe(first.claimToken)

    expect(await settleDelivery(first, { status: "done" })).toEqual({ state: "lost" })
    const [r] = await sql<{ status: string; claim_token: string | null; payload: unknown }[]>`
      SELECT status, claim_token::text AS claim_token, payload
      FROM kernel.webhook_inbox WHERE id = ${first.id}`
    expect(r).toEqual({
      status: "processing",
      claim_token: second.claimToken,
      payload: { order: 1 },
    })

    expect(await settleDelivery(second, { status: "done" })).toEqual({ state: "done" })
    expect(await row(first.id)).toMatchObject({ status: "done", payload: null })
  })

  // The inbox is a database table, so in backups: it keeps the provider's
  // event headers a handler reads, never credentials, cookies or the client's
  // address, and the handler sees the same headers on a replay as inline.
  it("stores only the provider's event headers: no credentials, cookies or client addresses", async () => {
    const stored = await storeDelivery(
      delivery({
        headers: {
          "content-type": "application/json",
          "user-agent": "Provider-Hookshot/1.0",
          "x-shopify-topic": "orders/create",
          "x-shopify-webhook-id": "wh-1",
          "x-goog-resource-state": "exists",
          authorization: "Bearer secret",
          "proxy-authorization": "Basic x",
          cookie: "sid=1",
          "x-forwarded-for": "203.0.113.9",
          "x-real-ip": "203.0.113.9",
          "cf-connecting-ip": "203.0.113.9",
          forwarded: "for=203.0.113.9",
          "true-client-ip": "203.0.113.9",
          "x-shopify-hmac-sha256": "c2ln",
          "x-hub-signature-256": "sha256=ab",
          "x-goog-channel-token": "tok",
          "x-api-key": "k",
          host: "liaison.example",
        },
      }),
      { claimLeaseMs: 60_000 },
    )
    if (!stored) throw new Error("not stored")
    const kept = {
      "content-type": "application/json",
      "user-agent": "Provider-Hookshot/1.0",
      "x-goog-resource-state": "exists",
      "x-shopify-topic": "orders/create",
      "x-shopify-webhook-id": "wh-1",
    }
    const [r] = await sql<{ headers: Record<string, string> }[]>`
      SELECT headers FROM kernel.webhook_inbox WHERE id = ${stored.id}`
    expect(r?.headers).toEqual(kept)
    await makeDue(stored.id)
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    expect(calls[0]?.headers).toEqual(kept)
  })

  // Settled rows hold no payload; they are kept only while their identity
  // dedups a redelivery. A dead row keeps its payload for diagnosis, briefly.
  it("deletes a settled row once its dedup window closed, a dead row after its short window", async () => {
    // Stored through the inbox, then aged in place.
    const make = async (status: string, dedupAgo: string, settledAgo: string) => {
      const stored = await storeDelivery(delivery(), { claimLeaseMs: 60_000 })
      if (!stored) throw new Error("not stored")
      await sql`UPDATE kernel.webhook_inbox SET status = ${status}, claim_token = NULL,
          dedup_until = now() - ${dedupAgo}::interval, settled_at = now() - ${settledAgo}::interval,
          payload = CASE WHEN ${status} = 'dead' THEN payload ELSE NULL END
        WHERE id = ${stored.id}`
      return stored.id
    }
    const doneClosed = await make("done", "1 minute", "1 hour")
    const doneOpen = await make("done", "-1 hour", "1 minute")
    const rejectedClosed = await make("rejected", "1 minute", "1 hour")
    const deadOld = await make("dead", "1 minute", `${WEBHOOK_INBOX_DEAD_RETENTION_DAYS + 1} days`)
    const deadRecent = await make(
      "dead",
      "1 minute",
      `${WEBHOOK_INBOX_DEAD_RETENTION_DAYS - 1} days`,
    )
    expect(WEBHOOK_INBOX_DEAD_RETENTION_DAYS).toBeLessThanOrEqual(7)

    await pruneWebhookInbox()
    const left = (
      await sql<{ id: string }[]>`SELECT id FROM kernel.webhook_inbox WHERE org_id = ${ORG}`
    ).map((x) => x.id)
    expect(left.sort()).toEqual([doneOpen, deadRecent].sort())
    expect(left).not.toContain(doneClosed)
    expect(left).not.toContain(rejectedClosed)
    expect(left).not.toContain(deadOld)
  })
})

describe("legacy retry-webhook jobs drained into the inbox", () => {
  const queue = () => getJobQueue("kernel", "retry-webhook")
  const added: string[] = []

  afterEach(async () => {
    for (const id of added.splice(0)) await (await queue().getJob(id))?.remove()
  })

  // A delayed job enqueued by the previous release's route (a capped delivery,
  // or a failed one in its backoff): the payload, headers and delivery id it
  // carried, as the previous release wrote them.
  const legacyJob = (deliveryId?: string) => ({
    orgId: ORG,
    appName: APP,
    endpointName: ENDPOINT,
    payload: { order: 99 },
    headers: { "x-provider-id": "evt-99" },
    ...(deliveryId ? { deliveryId } : {}),
  })

  it("moves a delayed job into the inbox once, keeping its delivery id, data and due time", async () => {
    const deliveryId = randomUUID()
    const job = await queue().add("retry-webhook", legacyJob(deliveryId), { delay: 3_600_000 })
    added.push(job.id as string)

    expect((await drainLegacyRetryJobs()).moved).toBeGreaterThanOrEqual(1)
    expect(await queue().getJob(job.id as string)).toBeUndefined()
    const r = await row(deliveryId)
    expect(r).toMatchObject({ status: "pending", attempts: 0, payload: { order: 99 } })
    expect(Math.abs((r?.due_in_ms ?? 0) - 3_600_000)).toBeLessThan(60_000)

    // Idempotent: the same delivery drained again (a crash after the row was
    // written, before the job was removed) is still one row.
    const again = await queue().add("retry-webhook", legacyJob(deliveryId), { delay: 3_600_000 })
    added.push(again.id as string)
    await drainLegacyRetryJobs()
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.webhook_inbox WHERE org_id = ${ORG}`
    expect(n).toBe(1)

    // Replayed under the previous release's effect-ledger key for that delivery.
    await makeDue(deliveryId)
    await replayInboxDelivery({ orgId: ORG, inboxId: deliveryId })
    expect(calls).toEqual([{ params: { order: 99 }, headers: { "x-provider-id": "evt-99" } }])
    const [ledger] = await sql<{ state: string }[]>`SELECT state FROM kernel.effect_ledger
      WHERE org_id = ${ORG} AND key = ${`webhook:${APP}:${ENDPOINT}:${deliveryId}`}`
    expect(ledger?.state).toBe("done")
  })

  it("a delivery the previous release's retry already applied is not applied again", async () => {
    const deliveryId = randomUUID()
    // The previous release's retry ran it: its effect-ledger key is done.
    await effectOnce(ORG, `webhook:${APP}:${ENDPOINT}:${deliveryId}`, async () => ({
      applied: true,
    }))
    const job = await queue().add("retry-webhook", legacyJob(deliveryId), { delay: 1 })
    added.push(job.id as string)
    await drainLegacyRetryJobs(Date.now() + 10_000)
    await makeDue(deliveryId)
    await replayInboxDelivery({ orgId: ORG, inboxId: deliveryId })
    expect(calls).toHaveLength(0)
    expect(await row(deliveryId)).toMatchObject({ status: "done" })
  })

  it("a job without a delivery id gets a stable row id; an invalid one is left to the worker", async () => {
    const job = await queue().add("retry-webhook", legacyJob(), { delay: 600_000 })
    const bad = await queue().add("retry-webhook", { appName: "Bad Name" }, { delay: 600_000 })
    added.push(job.id as string, bad.id as string)
    await drainLegacyRetryJobs()
    const rows = await sql<
      { id: string }[]
    >`SELECT id FROM kernel.webhook_inbox WHERE org_id = ${ORG}`
    expect(rows).toHaveLength(1)
    expect(await queue().getJob(bad.id as string)).toBeDefined()
  })
})
