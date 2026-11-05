// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client job REST surface, against real rows and the real RLS boundary.
//
// The properties under test are all about what the server refuses:
//   * Two sessions cannot hold the same lease. The claim is single winner or
//     the queue runs the same work twice on two of the user's devices.
//   * A result posted by a session that no longer holds the lease is refused,
//     so a tab waking from a long sleep cannot overwrite newer work.
//   * Another user's job is invisible, and a claim on it answers 404 rather
//     than 403: a 403 would make the route an existence oracle over someone
//     else's mailbox.
//   * There is no route that enqueues a job.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { errorHandler } from "~/middleware/error-handler"
import { mailboxJobsRoutes } from "~/modules/mailbox-jobs/routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

function appFor(user: minimal.Person): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    c.set("scopes", ["mail:*"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox", mailboxJobsRoutes)
  app.onError(errorHandler)
  return app
}

async function seedJob(user: minimal.Person, kind = "summarise"): Promise<string> {
  const [row] = await withSystemDb("mailbox-jobs-seed", async (tx) => {
    const result = await tx.execute(drizzleSql`
      INSERT INTO kernel.mailbox_client_jobs (org_id, user_id, kind, payload, expires_at)
      VALUES (${user.orgId}::uuid, ${user.id}::uuid, ${kind},
              ${JSON.stringify({ messageIds: ["m1"], labels: ["INBOX"] })}::jsonb,
              now() + interval '7 days')
      RETURNING id::text AS id`)
    return result as unknown as Array<{ id: string }>
  })
  return row!.id
}

describe("client job REST surface", () => {
  test("a listing shows the pending job, without its result blob", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const jobId = await seedJob(user)
    const res = await appFor(user).request("/api/mailbox/client-jobs")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: any[] }
    const job = body.data.find((entry) => entry.id === jobId)
    // Non-vacuity: the listing really returned the seeded row.
    expect(job).toBeDefined()
    expect(job.status).toBe("pending")
    expect(job.payload.messageIds).toEqual(["m1"])
    expect(job).not.toHaveProperty("resultCiphertext")
    expect(job.hasResult).toBe(false)
  })

  test("two sessions claim concurrently and exactly one wins", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const jobId = await seedJob(user)
    const app = appFor(user)
    const claim = (sessionId: string) =>
      app.request(`/api/mailbox/client-jobs/${jobId}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })

    const [a, b] = await Promise.all([claim("tab-a"), claim("tab-b")])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])

    const winner = a.status === 200 ? a : b
    const body = (await winner.json()) as { data: { leaseExpiresAt: string; attempts: number } }
    expect(new Date(body.data.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(body.data.attempts).toBe(1)
  })

  test("a result from a session that does not hold the lease is refused", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const jobId = await seedJob(user)
    const app = appFor(user)
    await app.request(`/api/mailbox/client-jobs/${jobId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "tab-a" }),
    })
    const res = await app.request(`/api/mailbox/client-jobs/${jobId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "tab-b",
        status: "done",
        resultCiphertext: Buffer.from("sealed").toString("base64"),
      }),
    })
    expect(res.status).toBe(409)
  })

  test("the lease holder completes the job and the sealed result is stored", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const jobId = await seedJob(user)
    const app = appFor(user)
    await app.request(`/api/mailbox/client-jobs/${jobId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "tab-a" }),
    })
    const res = await app.request(`/api/mailbox/client-jobs/${jobId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "tab-a",
        status: "done",
        resultCiphertext: Buffer.from("sealed-bytes").toString("base64"),
      }),
    })
    expect(res.status).toBe(200)
    const stored = await withSystemDb("mailbox-jobs-read", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT status, result_ciphertext FROM kernel.mailbox_client_jobs
        WHERE id = ${jobId}::uuid`)) as unknown as Array<{
        status: string
        result_ciphertext: Buffer
      }>
      return rows[0]
    })
    expect(stored?.status).toBe("done")
    expect(Buffer.from(stored!.result_ciphertext).toString()).toBe("sealed-bytes")
  })

  test("a colleague's job is invisible, and claiming it is a 404 not a 403", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    // Same org on purpose: the queue is OWNER scoped, not org scoped, so a
    // colleague with the same app scopes must still see nothing.
    const stranger = await minimal.person(owner.orgId)
    const jobId = await seedJob(owner)

    const listing = await appFor(stranger).request("/api/mailbox/client-jobs")
    const body = (await listing.json()) as { data: any[] }
    expect(body.data.some((entry) => entry.id === jobId)).toBe(false)

    const res = await appFor(stranger).request(`/api/mailbox/client-jobs/${jobId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "tab-a" }),
    })
    expect(res.status).toBe(404)
  })

  test("there is no route that enqueues a job", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const res = await appFor(user).request("/api/mailbox/client-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "summarise", payload: {} }),
    })
    expect(res.status).toBe(404)
  })

  test("a result that is not base64 is refused before it reaches the database", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const jobId = await seedJob(user)
    const app = appFor(user)
    await app.request(`/api/mailbox/client-jobs/${jobId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "tab-a" }),
    })
    const res = await app.request(`/api/mailbox/client-jobs/${jobId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "tab-a", status: "done", resultCiphertext: "not base64!" }),
    })
    expect(res.status).toBe(400)
  })
})
