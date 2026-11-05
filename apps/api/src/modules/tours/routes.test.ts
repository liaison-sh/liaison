// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/tours: the catalogue, start, the person's own moves (CAS, refusals,
// completion) and RLS: another member of the org can neither read nor move
// someone else's progress. Every change queues an owner-addressed
// kernel/tour:* frame.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { ListToursResponse, TourFrameData, TourProgressResponse } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { declaredEmits } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { createTestOrg } from "~/tests/helpers/org"

let orgId: string
let alice: string
let bob: string
let aliceToken: string
let bobToken: string
let priorKernelEmits: Set<string> | undefined
const TOUR = "kernel.sample"

function call(t: string, method: string, path: string, body?: unknown) {
  return app.request(`/api/tours${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function progressOf(res: Response): Promise<TourProgressResponse["progress"]> {
  return ((await res.json()) as { data: TourProgressResponse }).data.progress
}

async function frames(
  ownerUserId: string,
): Promise<Array<{ action: string; data: TourFrameData }>> {
  return (
    await sql`SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'kernel' AND payload->>'entity' = 'tour'
        AND payload->'data'->>'ownerUserId' = ${ownerUserId}
      ORDER BY payload->'data'->>'emittedAt'`
  ).map((r) => r.payload as { action: string; data: TourFrameData })
}

beforeAll(async () => {
  priorKernelEmits = declaredEmits.get("kernel")
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  orgId = (await createTestOrg()).id
  alice = crypto.randomUUID()
  bob = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES
    (${alice}, ${orgId}, ${`tour-alice-${alice}@test.com`}, 'Alice'),
    (${bob}, ${orgId}, ${`tour-bob-${bob}@test.com`}, 'Bob')`
  const token = (userId: string) =>
    signAccessToken(
      { userId, orgId, name: "T", authVersion: 1, permissionVersion: 1, scopes: ["*"] },
      env.JWT_SECRET,
    )
  aliceToken = await token(alice)
  bobToken = await token(bob)
})

afterAll(async () => {
  if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
  else declaredEmits.delete("kernel")
  await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId}`
})

describe("/api/tours", () => {
  it("lists the sample tour, not started, with the org's effective beat count", async () => {
    const res = await call(aliceToken, "GET", "")
    expect(res.status).toBe(200)
    const body = ((await res.json()) as { data: ListToursResponse }).data
    const item = body.tours.find((t) => t.tourId === TOUR)
    // welcome, post-message, tickets-inbox: the world beat is a demo-only beat.
    expect(item).toMatchObject({ app: "kernel", beatCount: 3, progress: null })
  })

  it("unknown tours are 404", async () => {
    expect((await call(aliceToken, "POST", "/kernel.nope/start", {})).status).toBe(404)
    expect((await call(aliceToken, "GET", "/kernel.nope/progress")).status).toBe(404)
  })

  it("start puts the person on the first beat and pushes kernel/tour:start to them", async () => {
    const res = await call(aliceToken, "POST", `/${TOUR}/start`, { source: "help" })
    expect(res.status).toBe(200)
    expect(await progressOf(res)).toMatchObject({
      tourId: TOUR,
      status: "active",
      beatId: "welcome",
      beatIndex: 0,
      beatCount: 3,
      beatStates: {},
      source: "help",
    })
    const [f] = (await frames(alice)).filter((x) => x.action === "start")
    expect(f?.data).toMatchObject({
      ownerUserId: alice,
      tourId: TOUR,
      status: "active",
      beatId: "welcome",
    })
  })

  it("Next on a show beat moves on; Next on a do beat is refused", async () => {
    const next = await call(aliceToken, "PATCH", `/${TOUR}`, {
      advance: true,
      fromBeatId: "welcome",
    })
    expect(next.status).toBe(200)
    expect(await progressOf(next)).toMatchObject({ beatId: "post-message", beatIndex: 1 })
    const refused = await call(aliceToken, "PATCH", `/${TOUR}`, { advance: true })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "tour_event_beat",
    )
  })

  it("a stale fromBeatId is a 409 carrying the fresh progress", async () => {
    const res = await call(aliceToken, "PATCH", `/${TOUR}`, { skip: true, fromBeatId: "welcome" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string }; data: TourProgressResponse }
    expect(body.error.code).toBe("tour_beat_moved")
    expect(body.data.progress?.beatId).toBe("post-message")
  })

  it("never moves forward by index, and rejects two intents at once", async () => {
    const fwd = await call(aliceToken, "PATCH", `/${TOUR}`, { beatIndex: 2 })
    expect(fwd.status).toBe(409)
    expect(
      (await call(aliceToken, "PATCH", `/${TOUR}`, { skip: true, advance: true })).status,
    ).toBe(400)
  })

  it("pause, resume, then skip to the end completes with the skipped beats recorded", async () => {
    expect(
      await progressOf(await call(aliceToken, "PATCH", `/${TOUR}`, { status: "paused" })),
    ).toMatchObject({
      status: "paused",
      beatId: "post-message",
    })
    expect((await call(aliceToken, "PATCH", `/${TOUR}`, { skip: true })).status).toBe(409)
    await call(aliceToken, "PATCH", `/${TOUR}`, { status: "active" })
    await call(aliceToken, "PATCH", `/${TOUR}`, { skip: true })
    const done = await progressOf(await call(aliceToken, "PATCH", `/${TOUR}`, { skip: true }))
    expect(done).toMatchObject({
      status: "completed",
      beatId: null,
      beatIndex: 3,
      beatStates: { welcome: "done", "post-message": "skipped", "tickets-inbox": "skipped" },
    })
    const got = await progressOf(await call(aliceToken, "GET", `/${TOUR}/progress`))
    expect(got?.status).toBe("completed")
    const updates = (await frames(alice)).filter((x) => x.action === "update")
    expect(updates.at(-1)?.data).toMatchObject({
      ownerUserId: alice,
      status: "completed",
      beatId: null,
    })
  })

  it("another member reads null and cannot move someone else's progress (RLS)", async () => {
    expect(await progressOf(await call(bobToken, "GET", `/${TOUR}/progress`))).toBeNull()
    const res = await call(bobToken, "PATCH", `/${TOUR}`, { status: "paused" })
    expect(res.status).toBe(404)
    const list = ((await (await call(bobToken, "GET", "")).json()) as { data: ListToursResponse })
      .data
    expect(list.tours.find((t) => t.tourId === TOUR)?.progress).toBeNull()

    // Straight at the table under Bob's RLS context (scope "*"): no row, no update.
    const ctx = {
      actorType: "user" as const,
      userId: bob,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const seen = await withRlsContext(ctx, async (tx) =>
      extractRows(
        await tx.execute(
          drizzleSql`SELECT tour_id FROM kernel.tour_progress WHERE user_id = ${alice}::uuid`,
        ),
      ),
    )
    expect(seen).toHaveLength(0)
    const updated = await withRlsContext(ctx, async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          UPDATE kernel.tour_progress SET status = 'abandoned'
          WHERE user_id = ${alice}::uuid RETURNING tour_id`),
      ),
    )
    expect(updated).toHaveLength(0)
    const [row] = await sql`SELECT status FROM kernel.tour_progress
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${TOUR}`
    expect(row?.status).toBe("completed")
    // Bob cannot write a row for Alice either.
    await expect(
      withRlsContext(ctx, (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO kernel.tour_progress (org_id, user_id, tour_id, status, source)
          VALUES (${orgId}::uuid, ${alice}::uuid, 'kernel.other', 'active', 'help')`),
      ),
    ).rejects.toThrow()
  })

  it("start again restarts a finished tour from the first beat", async () => {
    const res = await call(aliceToken, "POST", `/${TOUR}/start`, {})
    expect(await progressOf(res)).toMatchObject({
      status: "active",
      beatId: "welcome",
      beatStates: {},
    })
  })
})
