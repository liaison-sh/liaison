// SPDX-License-Identifier: FSL-1.1-ALv2
// tour-progress: a do beat's event that would move the person onto a world beat
// passes the demo-org guard first (the database marker, never the org context
// the consumer read). Here the context claims a demo org while the database
// says otherwise: the move is refused and logged, the row stays put, and the
// consumer does not throw.
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { findTour, type Tour } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import * as realService from "~/modules/tours/service"
import { createTestOrg } from "~/tests/helpers/org"

const service = { ...realService }
mock.module("~/modules/tours/service", () => ({
  ...service,
  loadTourOrgContext: async (orgId: string) => ({
    ...(await service.loadTourOrgContext(orgId)),
    isDemo: true,
  }),
}))

// mock.module outlives this file: put the real service back for later files in the process.
afterAll(() => {
  mock.module("~/modules/tours/service", () => service)
})

const { handleTourProgressEvent } = await import("~/modules/tours/consumer")

const TOUR = findTour("kernel.sample", { includeTestTours: true }) as Tour

let orgId: string
let alice: string

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  alice = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${alice}, ${orgId}, ${`tour-w-${alice}@test.com`}, 'Alice')`
  const beats = realService.tourBeats(TOUR, {
    ...(await service.loadTourOrgContext(orgId)),
    isDemo: true,
  })
  await withPrivilegedDb(orgId, "tour-world-guard-test", (tx) =>
    realService.startTour(tx, {
      orgId,
      userId: alice,
      tour: TOUR,
      beats,
      source: "cli",
      actor: { userId: alice, actorType: "user" },
    }),
  )
  await sql`UPDATE kernel.tour_progress
    SET beat_id = 'post-message', beat_index = 1, beat_states = '{"welcome":"done"}'::jsonb
    WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${TOUR.id}`
})

describe("tour-progress world-beat guard", () => {
  it("refuses a move onto a world beat outside a demo org (database marker)", async () => {
    await expect(
      handleTourProgressEvent({
        eventId: crypto.randomUUID(),
        event: {
          app: "kernel",
          entity: "message",
          action: "create",
          entityId: crypto.randomUUID(),
          orgId,
          actorId: alice,
          actorType: "user",
          data: { threadId: crypto.randomUUID() },
        },
      }),
    ).resolves.toBeUndefined()
    const [row] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${TOUR.id}`
    expect(row).toMatchObject({ beat_id: "post-message", beat_states: { welcome: "done" } })
    const frames = await sql`SELECT 1 FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'tour' AND payload->>'action' = 'update'`
    expect(frames).toHaveLength(0)
  })
})
