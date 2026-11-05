// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared setup for the reply-thread tests (0112): one org, three members and
// one outsider, a channel the three sit in and a second channel. Every read and
// write goes through the real HTTP routes with real tokens, so the request RLS
// is the one production runs.

import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

/** The kernel schema as a quoted identifier, under the test namespace's prefix. */
const K = () => sql(schemaRef("kernel"))

export interface Member {
  userId: string
  bearer: string
}

export interface ReplyFixture {
  orgId: string
  alice: Member
  bob: Member
  carol: Member
  /** In the org, in no room. */
  outsider: Member
  /** Alice, Bob and Carol. */
  room: string
  /** Alice alone. */
  otherRoom: string
}

export async function setupReplyFixture(): Promise<ReplyFixture> {
  const orgId = (await createTestOrg()).id
  const alice = await minimal.session(orgId)
  const bob = await minimal.session(orgId)
  const carol = await minimal.session(orgId)
  const outsider = await minimal.session(orgId)
  await sql`UPDATE ${K()}.users SET name = 'Alice' WHERE id = ${alice.userId}`
  await sql`UPDATE ${K()}.users SET name = 'Bob' WHERE id = ${bob.userId}`
  await sql`UPDATE ${K()}.users SET name = 'Carol' WHERE id = ${carol.userId}`
  await sql`UPDATE ${K()}.users SET name = 'Outsider' WHERE id = ${outsider.userId}`
  const room = await minimal.thread(orgId, alice.userId)
  for (const m of [bob, carol]) {
    await sql`INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id) VALUES (${room}, ${m.userId}, ${orgId})`
  }
  const otherRoom = await minimal.thread(orgId, alice.userId)
  return { orgId, alice, bob, carol, outsider, room, otherRoom }
}

/**
 * Grants a scope and re-mints the member's token: a grant bumps the
 * permission version, which the auth middleware then refuses on the old token.
 */
export async function grantScopeAndRefresh(member: Member, scope: string): Promise<void> {
  await minimal.grantScope(member.userId, scope)
  const [row] = await sql<
    { org_id: string; name: string; auth_version: number; permission_version: number }[]
  >`SELECT org_id, name, auth_version, permission_version FROM ${K()}.users WHERE id = ${member.userId}`
  const perms = await withPrivilegedDb(row.org_id, "test-refresh-token", (tx) =>
    loadEffectivePermissions(tx, member.userId, row.org_id),
  )
  member.bearer = await signAccessToken(
    {
      userId: member.userId,
      orgId: row.org_id,
      name: row.name,
      authVersion: row.auth_version,
      permissionVersion: row.permission_version,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
  )
}

export interface ApiResult<T = any> {
  status: number
  body: { data?: T; meta?: any; error?: { message: string; code?: string } }
}

export async function call<T = any>(
  member: Member,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${member.bearer}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

/** Posts through the real route and returns the created message. */
export async function post(
  member: Member,
  threadId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return call(member, "POST", `/threads/${threadId}/messages`, body)
}

/** A message row inserted directly, for fixtures the route would refuse. */
export async function plant(params: {
  orgId: string
  threadId: string
  authorId: string
  content: string
  replyRootId?: string | null
  requiredScopes?: string[]
  deleted?: boolean
  createdAt?: string
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ${K()}.messages
      (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id,
       deleted_at, created_at)
    VALUES (
      ${params.threadId}, ${params.orgId}, ${params.authorId}, 'user', ${params.content},
      ${params.requiredScopes ?? []}::text[], ${params.replyRootId ?? null},
      ${params.deleted ? new Date().toISOString() : null}::timestamptz,
      ${params.createdAt ?? new Date().toISOString()}::timestamptz
    )
    RETURNING id`
  return row.id
}

/** The event the write queued for one message, exactly as the outbox holds it. */
export async function queuedEvent(
  orgId: string,
  entity: string,
  action: string,
  entityId: string,
): Promise<AppEvent> {
  const rows = await sql`
    SELECT payload FROM ${K()}.pending_events
    WHERE org_id = ${orgId}
      AND payload->>'entity' = ${entity}
      AND payload->>'action' = ${action}
      AND payload->>'entityId' = ${entityId}
    ORDER BY seq DESC
    LIMIT 1`
  if (rows.length === 0) throw new Error(`no ${entity}:${action} event for ${entityId}`)
  const payload = rows[0].payload
  return (typeof payload === "string" ? JSON.parse(payload) : payload) as AppEvent
}

export async function followersOf(rootId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM ${K()}.reply_thread_followers WHERE root_message_id = ${rootId}
    ORDER BY user_id`
  return rows.map((r) => r.user_id)
}
