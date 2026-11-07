// SPDX-License-Identifier: FSL-1.1-ALv2
// Home: "Not now" on a persisted item, and "Today's brief" from the caller's own routine.
import { beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import { getEventAttentionItems } from "~/modules/attention/event-provider"
import { signAccessToken } from "~/modules/auth/jwt"

let orgId: string
let me: { id: string; token: string }
let other: { id: string; token: string }

async function makeUser(suffix: string, name: string, timezone: string | null) {
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version, timezone)
      VALUES (gen_random_uuid(), ${orgId}, ${`${name}-${suffix}@test.com`}, ${name}, 'active', 'hash', 1, 1, ${timezone})
      RETURNING id
    `),
  )
  await db.execute(drizzleSql`
    INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${user!.id}::uuid, ${orgId}::uuid, '*')`)
  const token = await signAccessToken(
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
  return { id: user!.id, token }
}

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Home Org', ${`home-${suffix}`}) RETURNING id
    `),
  )
  orgId = org!.id
  me = await makeUser(suffix, "elise", "Europe/Paris")
  other = await makeUser(suffix, "tom", "Europe/Paris")
})

async function seedEvent(userId: string): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.attention_events (
        id, org_id, user_id, app, entity_type, entity_id, kind, urgency,
        summary, actor_type, occurred_at, digest_eligible_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${userId}::uuid, 'kernel', 'notification',
        ${randomUUID()}, 'agent_notification', 50, 'A deal went quiet', 'system', now(), now()
      )
      RETURNING id
    `),
  )
  return row!.id
}

async function feedIds(userId: string): Promise<string[]> {
  const items = await getEventAttentionItems(db as never, orgId, userId)
  return items.map((i) => i.id)
}

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("POST /api/attention-items/set-aside", () => {
  it("sets the event aside until next Monday 00:00 in the person's zone, and it leaves the feed", async () => {
    const id = await seedEvent(me.id)
    expect(await feedIds(me.id)).toContain(id)
    const res = await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { setAsideUntil: string; timeZone: string } }
    expect(body.data.timeZone).toBe("Europe/Paris")
    const until = new Date(body.data.setAsideUntil)
    expect(until.getTime()).toBeGreaterThan(Date.now())
    // Midnight in Paris is 22:00 or 23:00 UTC on the Sunday.
    expect(until.getUTCDay()).toBe(0)
    expect([22, 23]).toContain(until.getUTCHours())
    expect(await feedIds(me.id)).not.toContain(id)
  })

  it("comes back once the moment passes", async () => {
    const id = await seedEvent(me.id)
    await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    expect(await feedIds(me.id)).not.toContain(id)
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events SET set_aside_until = now() - interval '1 minute' WHERE id = ${id}::uuid`)
    expect(await feedIds(me.id)).toContain(id)
  })

  it("set aside, then resolved elsewhere: it does not come back", async () => {
    const id = await seedEvent(me.id)
    await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events
      SET read_at = now(), set_aside_until = now() - interval '1 minute' WHERE id = ${id}::uuid`)
    expect(await feedIds(me.id)).not.toContain(id)
  })

  it("another person's event cannot be set aside", async () => {
    const id = await seedEvent(other.id)
    const res = await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    expect(res.status).toBe(404)
    expect(await feedIds(other.id)).toContain(id)
  })
})

async function seedBrief(ownerId: string, text: string): Promise<void> {
  const threadId = randomUUID()
  const agentId = randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.agents (id, org_id, kind, owner_user_id, handle, display_name, scope_ceiling)
    VALUES (${agentId}::uuid, ${orgId}::uuid, 'personal', ${ownerId}::uuid,
            ${`@brief-${agentId.slice(0, 8)}`}, 'Personal agent', '["*"]'::jsonb)`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}::uuid, ${orgId}::uuid, ${`brief-${threadId.slice(0, 8)}`}, 'agent_chat', ${ownerId}::uuid)`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}::uuid, ${ownerId}::uuid, ${orgId}::uuid, 'admin')`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.routines
      (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt, scopes,
       created_by_actor_type, template_key, output_thread_id, last_run_at)
    VALUES (gen_random_uuid(), ${orgId}::uuid, ${ownerId}::uuid, ${agentId}::uuid, 'Morning brief', 'brief', 'recurring',
            '30 7 * * 1-5', 'Europe/Paris', 'brief', '{}', 'user', 'morning-brief', ${threadId}::uuid, now())`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.messages (org_id, thread_id, author_id, author_agent_id, author_type, content, required_scopes)
    VALUES (${orgId}::uuid, ${threadId}::uuid, ${ownerId}::uuid, ${agentId}::uuid, 'agent', ${text}, '{}')`)
}

describe("GET /api/home/brief", () => {
  it("another person's is never readable", async () => {
    await seedBrief(other.id, "Tom's brief: 3 deals open")
    const res = await call("GET", "/api/home/brief", me.token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toBeNull()
  })

  it("the caller's own brief: newest agent message with its time", async () => {
    await seedBrief(me.id, "Monthly recurring revenue is up")
    const res = await call("GET", "/api/home/brief", me.token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { routineName: string; message: { text: string; at: string } | null }
    }
    expect(body.data.routineName).toBe("Morning brief")
    expect(body.data.message?.text).toBe("Monthly recurring revenue is up")
    expect(Number.isNaN(Date.parse(body.data.message?.at ?? ""))).toBe(false)
  })
})
