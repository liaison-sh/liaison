// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { refreshAllAppAttention } from "~/modules/apps/attention-store"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { signAccessToken } from "~/modules/auth/jwt"

const FIXTURE_PATH = new URL("../fixtures/attention-providers.ts", import.meta.url).pathname

let orgId: string
let userId: string
let token: string

const cleanupKeys: Array<[string, string]> = []

function registerFakeKernelProvider(appName: string, handler: string): void {
  const key: [string, string] = ["*", appName]
  attentionItemsRegistry.set(key, {
    handler,
    bundlePath: FIXTURE_PATH,
    trusted: true,
  } as never)
  cleanupKeys.push(key)
}

/**
 * The apps' attention lists are stored, recomputed after the app was woken
 * (attention-store.ts): rows written straight into an app's tables wake
 * nothing, so the test recomputes them, as the attention minute tick would.
 */
async function refreshStoredAttention(): Promise<void> {
  await ensureAppsForOrg(orgId)
  await refreshAllAppAttention(orgId, {
    userIds: [userId],
    loadActor: async (o, u) => ({
      actorType: "user",
      userId: u,
      orgId: o,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }),
  })
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

async function seedProjectAttentionItem(): Promise<string> {
  const projectRes = await app.request("/api/projects", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: `Attention Project ${randomUUID()}` }),
  })
  expect(projectRes.status).toBe(200)
  const project = (await projectRes.json()) as { data: { id: string } }
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const taskRes = await app.request(`/api/projects/${project.data.id}/tasks`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      title: "Real project attention",
      assigneeId: userId,
      dueDate: yesterday,
    }),
  })
  expect(taskRes.status).toBe(200)
  const task = (await taskRes.json()) as { data: { id: string } }
  return task.data.id
}

async function seedTicketAttentionItem(): Promise<string> {
  const handle = `ATTN-${randomUUID().slice(0, 8)}`
  const [ticket] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, last_inbound_at,
        last_message_at, message_count, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${handle}, 'Real ticket attention',
        'open', 'normal', 'api', 'internal', ${randomUUID()}, 3600,
        now() + INTERVAL '10 minutes', now() - INTERVAL '5 minutes',
        now() - INTERVAL '5 minutes', 1, now() - INTERVAL '2 hours', now()
      )
      RETURNING id
    `),
  )
  return ticket!.id
}

/** Same attention-worthy ticket shape as seedTicketAttentionItem, but sourced
 *  from a monitoring inbox (inboxes.suppress_attention) — must NOT surface. */
async function seedSuppressedInboxTicket(): Promise<string> {
  const [inbox] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (
        id, org_id, kind, connected_account_id, name, email_address,
        suppress_attention, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, 'api', NULL,
        ${`Bug Reports ${randomUUID().slice(0, 8)}`}, NULL, true, now(), now()
      )
      RETURNING id
    `),
  )
  const handle = `MON-${randomUUID().slice(0, 8)}`
  const [ticket] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, source_inbox_id, sla_target_seconds, sla_deadline,
        last_inbound_at, last_message_at, message_count, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${handle}, 'Monitoring ticket',
        'open', 'normal', 'api', 'internal', ${randomUUID()}, ${inbox!.id}::uuid, 3600,
        now() + INTERVAL '10 minutes', now() - INTERVAL '5 minutes',
        now() - INTERVAL '5 minutes', 1, now() - INTERVAL '2 hours', now()
      )
      RETURNING id
    `),
  )
  return ticket!.id
}

async function seedApprovalAttentionItem(): Promise<string> {
  const [thread] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`approval-${randomUUID()}`}, 'Approval', 'approval', ${userId}::uuid)
      RETURNING id
    `),
  )
  const [origin] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`origin-${randomUUID()}`}, 'Origin', 'thread', ${userId}::uuid)
      RETURNING id
    `),
  )
  const [approval] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.approval_requests (
        id, org_id, handle, thread_id, originating_thread_id, tool_name,
        tool_params, current_payload, expires_at, notify_user_ids, requested_by,
        status, summary
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${`APR-${randomUUID().slice(0, 8)}`},
        ${thread!.id}::uuid, ${origin!.id}::uuid, 'projects:createTask', '{}'::jsonb,
        '{}'::jsonb, now() + INTERVAL '30 minutes', ARRAY[${userId}::uuid],
        ${userId}::uuid, 'pending', ${JSON.stringify({ title: "Real approval attention" })}::jsonb
      )
      RETURNING id
    `),
  )
  return approval!.id
}

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Attention Org', ${`attn-org-${suffix}`}) RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`attn-${suffix}@test.com`}, 'Attn User', 'active', 'hash', 1, 1) RETURNING id
    `),
  )
  userId = user.id
  token = await signAccessToken(
    {
      userId,
      orgId,
      name: "Attn User",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      authVersion: 1,
      permissionVersion: 1,
    },
    env.JWT_SECRET,
  )
})

afterEach(() => {
  while (cleanupKeys.length > 0) {
    const key = cleanupKeys.pop()!
    attentionItemsRegistry.delete(key)
  }
})

describe("attention feed integration", () => {
  it("attention.http.three-providers", async () => {
    const projectTaskId = await seedProjectAttentionItem()
    const ticketId = await seedTicketAttentionItem()
    const approvalId = await seedApprovalAttentionItem()
    await refreshStoredAttention()

    const res = await app.request("/api/attention-items", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { items: Array<{ app: string; entityId: string; kind: string }>; errors: unknown[] }
    }
    expect(body.data.errors).toEqual([])
    expect(body.data.items.some((i) => i.app === "projects" && i.entityId === projectTaskId)).toBe(
      true,
    )
    expect(body.data.items.some((i) => i.app === "tickets" && i.entityId === ticketId)).toBe(true)
    expect(body.data.items.some((i) => i.app === "kernel" && i.entityId === approvalId)).toBe(true)
  }, 15_000)

  it("attention.suppressed-inbox.tickets-excluded", async () => {
    const normalTicketId = await seedTicketAttentionItem()
    const suppressedTicketId = await seedSuppressedInboxTicket()
    await refreshStoredAttention()

    const res = await app.request("/api/attention-items", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { items: Array<{ app: string; entityId: string; kind: string }>; errors: unknown[] }
    }
    expect(body.data.errors).toEqual([])
    // Identical attention-worthy state; only the source inbox differs.
    expect(body.data.items.some((i) => i.app === "tickets" && i.entityId === normalTicketId)).toBe(
      true,
    )
    expect(
      body.data.items.some((i) => i.app === "tickets" && i.entityId === suppressedTicketId),
    ).toBe(false)
  }, 15_000)

  it("attention.inbox-cutoff.stale-tickets-excluded-fresh-included", async () => {
    // Inbox with an attention cutoff set 1h ago (a historical import just ran).
    const [inbox] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (
          id, org_id, kind, connected_account_id, name, email_address,
          attention_cutoff_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, 'api', NULL,
          ${`Imported ${randomUUID().slice(0, 8)}`}, NULL,
          now() - INTERVAL '1 hour', now(), now()
        )
        RETURNING id
      `),
    )
    async function seedInboxTicket(lastInbound: string): Promise<string> {
      const handle = `CUT-${randomUUID().slice(0, 8)}`
      const [ticket] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, source_inbox_id, sla_target_seconds, sla_deadline,
            last_inbound_at, last_message_at, message_count, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${handle}, 'Cutoff ticket',
            'open', 'normal', 'api', 'internal', ${randomUUID()}, ${inbox!.id}::uuid, 3600,
            now() + INTERVAL '10 minutes', ${drizzleSql.raw(lastInbound)},
            ${drizzleSql.raw(lastInbound)}, 1, now() - INTERVAL '2 hours', now()
          )
          RETURNING id
        `),
      )
      return ticket!.id
    }
    // Last customer activity BEFORE the cutoff: imported history, stays quiet.
    const staleTicketId = await seedInboxTicket("now() - INTERVAL '3 days'")
    // Last customer activity AFTER the cutoff: live work, must surface.
    const freshTicketId = await seedInboxTicket("now() - INTERVAL '5 minutes'")
    await refreshStoredAttention()

    const res = await app.request("/api/attention-items", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { items: Array<{ app: string; entityId: string; kind: string }>; errors: unknown[] }
    }
    expect(body.data.errors).toEqual([])
    expect(body.data.items.some((i) => i.app === "tickets" && i.entityId === staleTicketId)).toBe(
      false,
    )
    expect(body.data.items.some((i) => i.app === "tickets" && i.entityId === freshTicketId)).toBe(
      true,
    )
  }, 15_000)

  it("attention.http.per-app-endpoints-removed", async () => {
    const ticketsRes = await app.request("/api/apps/tickets/attention-items", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(ticketsRes.status).toBe(404)
    const projectsRes = await app.request("/api/apps/projects/attention-items", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(projectsRes.status).toBe(404)
  })

  it("attention.mark-read.group-with-kinds", async () => {
    // Persist two unread attention rows for one app with manifest-style
    // colon-bearing kinds. The group "Mark all read" posts {app, kinds}; a naive
    // `kind = ANY(${kinds})` binding threw "malformed array literal" -> 500.
    async function seedEvent(kind: string): Promise<string> {
      const [row] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO kernel.attention_events (
            id, org_id, user_id, app, entity_type, entity_id, kind, urgency,
            summary, actor_type, occurred_at, digest_eligible_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${userId}::uuid, 'invoicing',
            'document', ${randomUUID()}, ${kind}, 50, 'Invoice needs you',
            'system', now(), now()
          )
          RETURNING id
        `),
      )
      return row!.id
    }
    const editedId = await seedEvent("invoicing:order.edited")
    const paidId = await seedEvent("invoicing:order.paid")

    const res = await app.request("/api/attention-items/mark-read", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        app: "invoicing",
        kinds: ["invoicing:order.edited", "invoicing:order.paid"],
      }),
    })
    expect(res.status).toBe(204)

    const rows = extractRows<{ id: string; read_at: string | null }>(
      await db.execute(drizzleSql`
        SELECT id, read_at FROM kernel.attention_events
        WHERE id IN (${editedId}::uuid, ${paidId}::uuid)`),
    )
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.read_at !== null)).toBe(true)
  }, 15_000)

  it("attention.mark-read.group-single-kind", async () => {
    // The single-element array case is what actually 500'd in production
    // (`ANY(($2))` with a scalar param).
    const [row] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.attention_events (
          id, org_id, user_id, app, entity_type, entity_id, kind, urgency,
          summary, actor_type, occurred_at, digest_eligible_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${userId}::uuid, 'invoicing',
          'document', ${randomUUID()}, 'invoicing:order.edited', 50,
          'Invoice needs you', 'system', now(), now()
        )
        RETURNING id
      `),
    )
    const res = await app.request("/api/attention-items/mark-read", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ app: "invoicing", kinds: ["invoicing:order.edited"] }),
    })
    expect(res.status).toBe(204)
    const rows = extractRows<{ read_at: string | null }>(
      await db.execute(drizzleSql`
        SELECT read_at FROM kernel.attention_events WHERE id = ${row!.id}::uuid`),
    )
    expect(rows[0]?.read_at).not.toBeNull()
  }, 15_000)

  it("attention.aggregator.provider-timeout", async () => {
    registerFakeKernelProvider("slowApp", "slowProvider")

    const res = await app.request("/api/attention-items", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        items: Array<{ id: string }>
        errors: Array<{ app: string; reason: string; message: string }>
      }
    }
    const slowError = body.data.errors.find((e) => e.app === "slowApp")
    expect(slowError).toBeDefined()
    expect(slowError?.reason).toBe("timeout")
    expect(body.data.items.find((i) => i.id === "slow:item:x")).toBeUndefined()
  }, 10_000)
})

describe("attention translator — thread mute (real DB)", () => {
  // End-to-end: message:create -> processTranslationEvent (production DB
  // defaults, no injected deps) -> kernel.attention_events. Proves
  // `defaultLoadMutedThreadUserIds` against a real `user_thread_state` row,
  // not a test double.
  it("attention.mute.thread-reply-quiet-for-muted-participant", async () => {
    const { processTranslationEvent } = await import("~/modules/attention/translator")
    const suffix = randomUUID()
    const [otherUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`attn-mute-${suffix}@test.com`}, 'Muted User', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const mutedUserId = otherUser!.id

    const [thread] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`mute-thread-${suffix}`}, 'Mute Test', 'thread', ${userId}::uuid)
        RETURNING id
      `),
    )
    const threadId = thread!.id

    // mutedUserId muted the thread; userId (the actor below is a third party
    // so both are recipients) did not.
    await db.execute(drizzleSql`
      INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id, is_muted)
      VALUES (${mutedUserId}::uuid, ${threadId}::uuid, ${orgId}::uuid, true)
    `)

    const [actorUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`attn-actor-${suffix}@test.com`}, 'Actor User', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )

    const messageId = randomUUID()
    await processTranslationEvent({
      app: "kernel",
      entity: "message",
      action: "create",
      orgId,
      actorId: actorUser!.id,
      actorType: "user",
      entityId: messageId,
      timestamp: new Date().toISOString(),
      data: {
        threadId,
        participantIds: [actorUser!.id, userId, mutedUserId],
        preview: "integration mute test",
        authorType: "user",
        // The preview quotes the message, so the translator drops every
        // recipient who could not see it and reaches NO ONE when the event
        // carries no requiredScopes array. sendMessage always puts the field
        // on a message-create event, so a synthetic event must too.
        requiredScopes: [],
      },
    } as never)

    // Mute means mute (notifications/router.ts): the muted participant keeps the
    // in-app record, marked quiet so no badge, push or mail counts it; the other
    // participant's row is not quiet.
    const rows = extractRows<{ user_id: string; quiet: boolean | null }>(
      await db.execute(drizzleSql`
        SELECT user_id, (metadata->>'quiet')::boolean AS quiet FROM kernel.attention_events
        WHERE org_id = ${orgId}::uuid AND entity_type = 'thread' AND entity_id = ${threadId}
          AND kind = 'thread_reply'
      `),
    )
    const quietOf = new Map(rows.map((r) => [r.user_id, r.quiet === true]))
    expect([...quietOf.keys()].sort()).toEqual([userId, mutedUserId].sort())
    expect(quietOf.get(mutedUserId)).toBe(true)
    expect(quietOf.get(userId)).toBe(false)
  }, 15_000)
})

describe("attention translator — digest_state for row-less users (real DB)", () => {
  // Falsifies the DEFAULT_PREFS.digestCadence flip in translator.ts: without
  // it, a recipient with no kernel.user_preferences row would compute
  // digestState via the OLD 'off' fallback and land 'suppressed' forever.
  it("attention.digest-default.rowless-user-thread-reply-is-pending", async () => {
    const { processTranslationEvent } = await import("~/modules/attention/translator")
    const suffix = randomUUID()
    const [rowlessUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`attn-rowless-${suffix}@test.com`}, 'Rowless User', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    // Deliberately no kernel.user_preferences row for rowlessUser.

    const [thread] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`rowless-thread-${suffix}`}, 'Rowless Test', 'thread', ${userId}::uuid)
        RETURNING id
      `),
    )
    const threadId = thread!.id

    const [actorUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`attn-rowless-actor-${suffix}@test.com`}, 'Actor', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )

    await processTranslationEvent({
      app: "kernel",
      entity: "message",
      action: "create",
      orgId,
      actorId: actorUser!.id,
      actorType: "user",
      entityId: randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        threadId,
        participantIds: [actorUser!.id, rowlessUser!.id],
        preview: "rowless digest_state test",
        authorType: "user",
        // As above: without the field the fail-closed visibility gate drops
        // every recipient and no attention row is written at all.
        requiredScopes: [],
      },
    } as never)

    const rows = extractRows<{ digest_state: string }>(
      await db.execute(drizzleSql`
        SELECT digest_state FROM kernel.attention_events
        WHERE org_id = ${orgId}::uuid AND entity_type = 'thread' AND entity_id = ${threadId}
          AND kind = 'thread_reply' AND user_id = ${rowlessUser!.id}::uuid
      `),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.digest_state).toBe("pending")
  }, 15_000)
})
