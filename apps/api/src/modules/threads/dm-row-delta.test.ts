// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T18: the companion invariant to the creation census. The census proves
// every INSERT site is an accounted-for anchor; this proves the one route a
// person and an agent actually hit on every turn — `POST /threads/dm` — never
// grows the `threads` table on a repeat call. "Continue in a DM" (P4b-D8) is
// pressed on every panel open and every "Discuss" card, so if resolving the
// personal DM were even occasionally non-idempotent, chat history would
// scatter across silent duplicate rows and nobody would notice until Direct
// Messages filled up with empties.
//
// Driven through the real HTTP surface (not the service function directly),
// against a real thread count, for TWO differently-provisioned users: one
// built through the shared test factories (`createTestUserSession`, the
// "seeded" user other suites in this file use), and one built by hand with
// raw SQL (the "fresh" user), so the invariant is not an artifact of
// whatever the factory happens to pre-create.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = crypto.randomUUID().slice(0, 8)

interface Actor {
  orgId: string
  userId: string
  bearer: string
}

async function seatPersonalAgent(
  orgId: string,
  userId: string,
  handleSuffix: string,
): Promise<string> {
  const agentId = crypto.randomUUID()
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
    VALUES (${agentId}, ${orgId}, 'personal', ${`@dmrd-${handleSuffix}`}, 'Liaison', ${userId}, '[]'::jsonb)`
  return agentId
}

/** The "seeded" actor: provisioned through the same factory every other suite in this file uses. */
async function seededActor(): Promise<Actor> {
  const org = await createTestOrg()
  const session = await minimal.session(org.id)
  await seatPersonalAgent(org.id, session.userId, `seeded-${tag}`)
  return { orgId: org.id, userId: session.userId, bearer: session.bearer }
}

/** The "fresh" actor: built by hand, no factory in the path at all. */
async function freshActor(): Promise<Actor> {
  const orgId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'DM Delta Fresh', ${`dmrd-fresh-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${userId}, ${orgId}, ${`dmrd-fresh-${tag}@t.com`}, 'Fresh User')`
  await seatPersonalAgent(orgId, userId, `fresh-${tag}`)
  const bearer = await signAccessToken(
    {
      userId,
      orgId,
      name: "Fresh User",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:threads:read", "kernel:threads:write"],
    },
    env.JWT_SECRET,
  )
  return { orgId, userId, bearer }
}

async function threadCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${orgId}`
  return row.n
}

async function resolvePersonalDm(
  actor: Actor,
): Promise<{ status: number; created: boolean; id: string }> {
  const res = await app.request("/api/threads/dm", {
    method: "POST",
    headers: { Authorization: `Bearer ${actor.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
  const body = ((await res.json()) as { data?: { id: string; created: boolean } }).data
  if (!body) throw new Error(`resolvePersonalDm: no data in response (status ${res.status})`)
  return { status: res.status, created: body.created, id: body.id }
}

async function postMessage(actor: Actor, threadId: string, content: string): Promise<void> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${actor.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  expect(res.status).toBe(200)
}

async function openChannel(actor: Actor, title: string): Promise<string> {
  const res = await app.request("/api/threads", {
    method: "POST",
    headers: { Authorization: `Bearer ${actor.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, participantIds: [actor.userId] }),
  })
  expect(res.status).toBe(200)
  const body = ((await res.json()) as { data: { id: string } }).data
  return body.id
}

/**
 * The shared walk: count, resolve, post two messages, resolve again (zero
 * growth), open a channel (legitimate +1, not the DM path), resolve a third
 * time (zero growth again).
 */
async function walkDmRowDelta(actor: Actor, expectFirstCallCreates: boolean): Promise<void> {
  const count0 = await threadCount(actor.orgId)

  const first = await resolvePersonalDm(actor)
  expect(first.created).toBe(expectFirstCallCreates)
  const count1 = await threadCount(actor.orgId)
  expect(count1 - count0).toBe(expectFirstCallCreates ? 1 : 0)

  await postMessage(actor, first.id, "Hello from the row-delta test")
  await postMessage(actor, first.id, "A second message, same thread")

  const second = await resolvePersonalDm(actor)
  expect(second.created).toBe(false)
  expect(second.id).toBe(first.id)
  const count2 = await threadCount(actor.orgId)
  expect(count2 - count1, "resolving the personal DM a second time must not grow threads").toBe(0)

  const channelId = await openChannel(actor, `Row delta channel ${crypto.randomUUID().slice(0, 8)}`)
  expect(channelId).not.toBe(first.id)
  const count3 = await threadCount(actor.orgId)
  expect(count3 - count2, "opening a channel is a legitimate, separate +1").toBe(1)

  const third = await resolvePersonalDm(actor)
  expect(third.created).toBe(false)
  expect(third.id).toBe(first.id)
  const count4 = await threadCount(actor.orgId)
  expect(
    count4 - count3,
    "resolving the personal DM after a channel exists must not grow threads",
  ).toBe(0)
}

describe("POST /threads/dm never grows the threads table on a repeat resolution", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("a fresh user (no factory in the path): +1 on the first call, +0 on every call after", async () => {
    const actor = await freshActor()
    await walkDmRowDelta(actor, true)
  })

  it("a seeded user (created via the shared test factory): +1 on the first call, +0 after", async () => {
    const actor = await seededActor()
    await walkDmRowDelta(actor, true)
  })
})
