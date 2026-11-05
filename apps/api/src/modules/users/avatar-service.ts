// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { agents, users } from "~/db/schema/kernel"
import { getProfile } from "~/modules/users/service"

/** Storage object key for a user's avatar. Always webp (see avatar-image). */
export function avatarStorageKey(orgId: string, avatarKey: string): string {
  return `orgs/${orgId}/avatars/${avatarKey}.webp`
}

/** Public, unauthenticated serving URL stored in `users.avatar_url`. */
export function avatarPublicUrl(avatarKey: string): string {
  return `/api/avatars/${avatarKey}`
}

type ProfileResult = Awaited<ReturnType<typeof getProfile>>

interface RowDeps {
  now?: () => Date
}

/**
 * Point the caller's own user row at a freshly-stored avatar object and return
 * the prior key so the caller can purge the superseded object. Runs inside the
 * caller's RLS transaction (a user may update only their own row).
 */
export async function setAvatarRow(
  tx: RlsClient,
  params: { userId: string; orgId: string; avatarKey: string },
  deps: RowDeps = {},
): Promise<{ previousKey: string | null; profile: ProfileResult }> {
  const now = deps.now?.() ?? new Date()
  const [existing] = await tx
    .select({ avatarKey: users.avatarKey })
    .from(users)
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))
    .limit(1)
  const previousKey = existing?.avatarKey ?? null

  const [updated] = await tx
    .update(users)
    .set({
      avatarKey: params.avatarKey,
      avatarUrl: avatarPublicUrl(params.avatarKey),
      updatedAt: now,
    })
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))
    .returning({ id: users.id })
  if (!updated) return { previousKey, profile: null }

  await tx.queueEvent({
    app: "kernel",
    entity: "user",
    action: "updated",
    entityId: params.userId,
    orgId: params.orgId,
    actorId: params.userId,
    data: { avatarUrl: avatarPublicUrl(params.avatarKey) },
  })

  return { previousKey, profile: await getProfile(tx, params.userId) }
}

/**
 * Clear the caller's avatar (back to the initials fallback) and return the prior
 * key so the caller can purge the object. Runs inside the caller's RLS tx.
 */
export async function clearAvatarRow(
  tx: RlsClient,
  params: { userId: string; orgId: string },
  deps: RowDeps = {},
): Promise<{ previousKey: string | null; profile: ProfileResult }> {
  const now = deps.now?.() ?? new Date()
  const [existing] = await tx
    .select({ avatarKey: users.avatarKey })
    .from(users)
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))
    .limit(1)
  if (!existing) return { previousKey: null, profile: null }
  const previousKey = existing.avatarKey ?? null

  await tx
    .update(users)
    .set({ avatarKey: null, avatarUrl: null, updatedAt: now })
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))

  await tx.queueEvent({
    app: "kernel",
    entity: "user",
    action: "updated",
    entityId: params.userId,
    orgId: params.orgId,
    actorId: params.userId,
    data: { avatarUrl: null },
  })

  return { previousKey, profile: await getProfile(tx, params.userId) }
}

/**
 * Resolve the stored object key for a public avatar-serving request. Runs under
 * a no-org system (BYPASSRLS) transaction because the request is unauthenticated
 * — the globally-unique `avatar_key` IS the capability. Returns null when the key
 * matches no user (rotated or never existed).
 */
export async function resolveAvatarForServe(
  db: PrivilegedDb,
  avatarKey: string,
): Promise<{ storageKey: string } | null> {
  const [row] = await db
    .select({ orgId: users.orgId, avatarKey: users.avatarKey })
    .from(users)
    .where(eq(users.avatarKey, avatarKey))
    .limit(1)
  if (row?.avatarKey) return { storageKey: avatarStorageKey(row.orgId, row.avatarKey) }

  // AN AGENT'S PICTURE IS SERVED FROM THE SAME CAPABILITY URL. Agents carry no
  // `avatar_key` column: the key is the tail of the `/api/avatars/<key>` URL
  // their row stores, so the lookup is on the URL. Same object namespace, same
  // unguessable key, same rotate-on-upload behaviour.
  const [agentRow] = await db
    .select({ orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.avatarUrl, avatarPublicUrl(avatarKey)))
    .limit(1)
  if (!agentRow) return null
  return { storageKey: avatarStorageKey(agentRow.orgId, avatarKey) }
}
