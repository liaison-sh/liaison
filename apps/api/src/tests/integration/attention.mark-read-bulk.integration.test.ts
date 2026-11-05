// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Home's "Mark all as read" (D21 follow-up): one request clears the slice the
// viewer is looking at, under their own RLS, and never a row that needs a
// decision (an access request, a node permission prompt, an approval). The
// Undo in the confirmation toast restores exactly the rows that request read.
import { beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"

let orgId: string
let userId: string
let otherUserId: string
let token: string
let otherToken: string

async function makeUser(suffix: string, name: string): Promise<{ id: string; token: string }> {
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`${name}-${suffix}@test.com`}, ${name}, 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  const signed = await signAccessToken(
    {
      userId: user!.id,
      orgId,
      name,
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      authVersion: 1,
      permissionVersion: 1,
    },
    env.JWT_SECRET,
  )
  return { id: user!.id, token: signed }
}

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Read All Org', ${`readall-${suffix}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const me = await makeUser(suffix, "reader")
  const other = await makeUser(suffix, "other")
  userId = me.id
  token = me.token
  otherUserId = other.id
  otherToken = other.token
})

interface Seed {
  user?: string
  app?: string
  entityType?: string
  entityId?: string
  kind?: string
  metadata?: Record<string, unknown>
}

async function seedEvent(s: Seed = {}): Promise<{
  id: string
  app: string
  entityType: string
  entityId: string
}> {
  const app_ = s.app ?? "kernel"
  const entityType = s.entityType ?? "notification"
  const entityId = s.entityId ?? randomUUID()
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.attention_events (
        id, org_id, user_id, app, entity_type, entity_id, kind, urgency,
        summary, actor_type, occurred_at, digest_eligible_at, metadata
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${s.user ?? userId}::uuid, ${app_},
        ${entityType}, ${entityId}, ${s.kind ?? "agent_notification"}, 50,
        'Something happened', 'system', now(), now(),
        ${s.metadata ? JSON.stringify(s.metadata) : null}::jsonb
      )
      RETURNING id
    `),
  )
  return { id: row!.id, app: app_, entityType, entityId }
}

async function readAt(ids: string[]): Promise<Map<string, string | null>> {
  const rows = extractRows<{ id: string; read_at: string | null }>(
    await db.execute(drizzleSql`
      SELECT id, read_at FROM kernel.attention_events
      WHERE id IN (${drizzleSql.join(
        ids.map((id) => drizzleSql`${id}::uuid`),
        drizzleSql`, `,
      )})`),
  )
  return new Map(rows.map((r) => [r.id, r.read_at]))
}

async function post(path: string, body: unknown, as = token): Promise<Response> {
  return await app.request(`/api/attention-items/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const ref = (e: { app: string; entityType: string; entityId: string }) => ({
  app: e.app,
  entityType: e.entityType,
  entityId: e.entityId,
})

describe("POST /attention-items/mark-read-bulk", () => {
  it("reads exactly the listed entities for the caller, in one request", async () => {
    const a = await seedEvent()
    const b = await seedEvent({ app: "invoicing", entityType: "document", kind: "system_alert" })
    const untouched = await seedEvent()

    const res = await post("mark-read-bulk", { items: [ref(a), ref(b)] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { marked: number; eventIds: string[] } }
    expect(body.data.marked).toBe(2)
    expect(new Set(body.data.eventIds)).toEqual(new Set([a.id, b.id]))

    const after = await readAt([a.id, b.id, untouched.id])
    expect(after.get(a.id)).not.toBeNull()
    expect(after.get(b.id)).not.toBeNull()
    expect(after.get(untouched.id)).toBeNull()
  }, 15_000)

  it("never reads a row that needs a decision, even when listed", async () => {
    const access = await seedEvent({ kind: "scope_request", entityType: "scope_request" })
    const prompt = await seedEvent({
      kind: "system_alert",
      entityType: "node_permission_prompt",
      metadata: { nodePermissionPromptId: randomUUID() },
    })
    const approval = await seedEvent({ kind: "approval_pending", entityType: "approval" })
    const fyi = await seedEvent()

    const res = await post("mark-read-bulk", {
      items: [ref(access), ref(prompt), ref(approval), ref(fyi)],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { marked: number; eventIds: string[] } }
    expect(body.data.marked).toBe(1)
    expect(body.data.eventIds).toEqual([fyi.id])

    const after = await readAt([access.id, prompt.id, approval.id, fyi.id])
    expect(after.get(access.id)).toBeNull()
    expect(after.get(prompt.id)).toBeNull()
    expect(after.get(approval.id)).toBeNull()
    expect(after.get(fyi.id)).not.toBeNull()
  }, 15_000)

  it("leaves another user's rows on the same entity alone", async () => {
    const mine = await seedEvent()
    const theirs = await seedEvent({ user: otherUserId, entityId: mine.entityId })

    const res = await post("mark-read-bulk", { items: [ref(mine)] })
    expect(res.status).toBe(200)

    const after = await readAt([mine.id, theirs.id])
    expect(after.get(mine.id)).not.toBeNull()
    expect(after.get(theirs.id)).toBeNull()
  }, 15_000)

  it("rejects an empty list", async () => {
    const res = await post("mark-read-bulk", { items: [] })
    expect(res.status).toBe(400)
  }, 15_000)
})

describe("POST /attention-items/mark-unread (the toast's Undo)", () => {
  it("restores exactly the rows a bulk read cleared, and only the caller's", async () => {
    const a = await seedEvent()
    const b = await seedEvent()
    const res = await post("mark-read-bulk", { items: [ref(a), ref(b)] })
    const { data } = (await res.json()) as { data: { eventIds: string[] } }

    // Someone else's read row: an Undo naming it must not resurrect it.
    const theirs = await seedEvent({ user: otherUserId })
    await post("mark-read-bulk", { items: [ref(theirs)] }, otherToken)

    const undo = await post("mark-unread", { eventIds: [...data.eventIds, theirs.id] })
    expect(undo.status).toBe(200)
    const undoBody = (await undo.json()) as { data: { restored: number } }
    expect(undoBody.data.restored).toBe(2)

    const after = await readAt([a.id, b.id, theirs.id])
    expect(after.get(a.id)).toBeNull()
    expect(after.get(b.id)).toBeNull()
    expect(after.get(theirs.id)).not.toBeNull()
  }, 15_000)

  it("skips a row whose entity got a fresh unread row since (no duplicate unread)", async () => {
    const a = await seedEvent()
    const res = await post("mark-read-bulk", { items: [ref(a)] })
    const { data } = (await res.json()) as { data: { eventIds: string[] } }
    // The same notice arrives again before the Undo.
    const fresh = await seedEvent({ entityId: a.entityId })

    const undo = await post("mark-unread", { eventIds: data.eventIds })
    expect(undo.status).toBe(200)
    const undoBody = (await undo.json()) as { data: { restored: number } }
    expect(undoBody.data.restored).toBe(0)
    const after = await readAt([a.id, fresh.id])
    expect(after.get(a.id)).not.toBeNull()
    expect(after.get(fresh.id)).toBeNull()
  }, 15_000)
})
