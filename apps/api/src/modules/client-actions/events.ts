// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one writer of a client action's trail. `meta` never holds a token, a proof
// or a code: a key of that name anywhere in it is refused before anything is
// written. The address and browser an event came from go to their own table,
// readable with the portal log scope only.

import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import type {
  CLIENT_ACTION_ACTOR_KINDS,
  CLIENT_ACTION_EVENTS,
} from "~/db/schema/kernel/client-actions"
import { schemaRef } from "~/db/schema-ref"

export type ClientActionEventName = (typeof CLIENT_ACTION_EVENTS)[number]
export type ClientActionActorKind = (typeof CLIENT_ACTION_ACTOR_KINDS)[number]

const SECRET_KEYS = new Set(["token", "proof", "code", "t", "rawtoken", "raw_token"])

/** The key path of the first secret-named key in `meta`, or null. */
export function secretKeyIn(meta: unknown, path = ""): string | null {
  if (Array.isArray(meta)) {
    for (const [i, v] of meta.entries()) {
      const hit = secretKeyIn(v, `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (!meta || typeof meta !== "object") return null
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k
    if (SECRET_KEYS.has(k.toLowerCase())) return here
    const hit = secretKeyIn(v, here)
    if (hit) return hit
  }
  return null
}

export interface ClientActionEventInput {
  orgId: string
  actionId: string
  event: ClientActionEventName
  actorKind: ClientActionActorKind
  actorUserId?: string | null
  mailId?: string | null
  meta?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

export async function writeClientActionEvent(
  tx: Pick<PrivilegedDb, "execute">,
  e: ClientActionEventInput,
): Promise<string> {
  const meta = e.meta ?? {}
  const secret = secretKeyIn(meta)
  if (secret) throw new Error(`a client action event's meta cannot hold "${secret}"`)
  const K = sql.raw(schemaRef("kernel"))
  const [row] = extractRows<{ id: string }>(
    await tx.execute(sql`
    INSERT INTO ${K}.client_action_events (org_id, action_id, event, actor_kind, actor_user_id, mail_id, meta)
    VALUES (${e.orgId}, ${e.actionId}, ${e.event}, ${e.actorKind}, ${e.actorUserId ?? null},
            ${e.mailId ?? null}, ${JSON.stringify(meta)}::jsonb)
    RETURNING id
  `),
  )
  if (!row) throw new Error("client action event not written")
  const id = row.id
  if (e.ip || e.userAgent) {
    await tx.execute(sql`
      INSERT INTO ${K}.client_action_devices (event_id, org_id, ip, user_agent)
      VALUES (${id}, ${e.orgId}, ${e.ip ?? null}, ${(e.userAgent ?? "").slice(0, 512) || null})
    `)
  }
  return id
}
