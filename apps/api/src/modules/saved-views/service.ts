// SPDX-License-Identifier: FSL-1.1-ALv2
import type { CreateSavedView, UpdateSavedView } from "@liaison/shared"
import { and, asc, desc, eq } from "drizzle-orm"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { savedViews, users } from "~/db/schema/kernel"
import { hasScope } from "~/modules/permissions/permissions"

export const ME_TOKEN = "$me"

export class SavedViewError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function applyMeSubstitution(value: unknown, userId: string): unknown {
  if (value === ME_TOKEN) return userId
  if (Array.isArray(value)) return value.map((v) => applyMeSubstitution(v, userId))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyMeSubstitution(v, userId)
    }
    return out
  }
  return value
}

type UserActor = Extract<ActorContext, { actorType: "user" }>

function requireUserActor(ctx: ActorContext): UserActor {
  if (ctx.actorType !== "user") {
    throw new SavedViewError("USER_REQUIRED", "saved views require a user actor")
  }
  return ctx
}

export interface SavedViewRow {
  id: string
  app: string
  viewId: string
  manifestKey: string | null
  name: string
  payload: Record<string, unknown>
  ownerUserId: string | null
  owner: { id: string; name: string; status: "active" | "suspended" | "deactivated" } | null
  sharedWithOrg: boolean
  isDefault: boolean
  position: number
  createdAt: string
  updatedAt: string
}

function toRow(record: any): SavedViewRow {
  return {
    id: record.id,
    app: record.app,
    viewId: record.viewId,
    manifestKey: record.manifestKey ?? null,
    name: record.name,
    payload: record.payload ?? {},
    ownerUserId: record.ownerUserId ?? null,
    owner: record.ownerId
      ? { id: record.ownerId, name: record.ownerName, status: record.ownerStatus }
      : null,
    sharedWithOrg: !!record.sharedWithOrg,
    isDefault: !!record.isDefault,
    position: record.position ?? 0,
    createdAt:
      record.createdAt instanceof Date ? record.createdAt.toISOString() : String(record.createdAt),
    updatedAt:
      record.updatedAt instanceof Date ? record.updatedAt.toISOString() : String(record.updatedAt),
  }
}

interface ListParams {
  app: string
  viewId: string
}

export async function listSavedViews(
  ctx: UserActor,
  { app, viewId }: ListParams,
): Promise<SavedViewRow[]> {
  return withRlsContext(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: savedViews.id,
        app: savedViews.app,
        viewId: savedViews.viewId,
        manifestKey: savedViews.manifestKey,
        name: savedViews.name,
        payload: savedViews.payload,
        ownerUserId: savedViews.ownerUserId,
        sharedWithOrg: savedViews.sharedWithOrg,
        isDefault: savedViews.isDefault,
        position: savedViews.position,
        createdAt: savedViews.createdAt,
        updatedAt: savedViews.updatedAt,
        ownerId: users.id,
        ownerName: users.name,
        ownerStatus: users.status,
      })
      .from(savedViews)
      .leftJoin(users, eq(users.id, savedViews.ownerUserId))
      .where(and(eq(savedViews.app, app), eq(savedViews.viewId, viewId)))
      .orderBy(desc(savedViews.isDefault), asc(savedViews.position), asc(savedViews.createdAt))
    return rows.map(toRow)
  })
}

export async function createSavedView(
  ctx: ActorContext,
  input: CreateSavedView,
): Promise<SavedViewRow> {
  const user = requireUserActor(ctx)
  if (input.sharedWithOrg && !hasScope("kernel:saved_views:share", user.scopes)) {
    throw new SavedViewError("SCOPE_DENIED", "sharing requires kernel:saved_views:share")
  }
  return withRlsContext(user, async (tx) => {
    const [row] = await tx
      .insert(savedViews)
      .values({
        orgId: user.orgId,
        app: input.app,
        viewId: input.viewId,
        name: input.name,
        payload: input.payload as Record<string, unknown>,
        ownerUserId: user.userId,
        sharedWithOrg: !!input.sharedWithOrg,
      })
      .returning()
    await tx.queueEvent({
      app: "kernel",
      entity: "saved_view",
      action: "created",
      entityId: row.id,
      data: { app: row.app, viewId: row.viewId, sharedWithOrg: row.sharedWithOrg },
      actorId: user.userId,
      actorType: "user",
      orgId: user.orgId,
      timestamp: new Date().toISOString(),
    })
    return toRow(row)
  })
}

async function loadOwned(tx: any, viewId: string) {
  const [row] = await tx.select().from(savedViews).where(eq(savedViews.id, viewId)).limit(1)
  return row
}

function canEdit(row: any, user: UserActor): boolean {
  if (row.ownerUserId === user.userId) return true
  if ((row.isDefault || row.sharedWithOrg) && hasScope("kernel:saved_views:admin", user.scopes)) {
    return true
  }
  return false
}

export async function updateSavedView(
  ctx: ActorContext,
  viewId: string,
  patch: UpdateSavedView,
): Promise<SavedViewRow> {
  const user = requireUserActor(ctx)
  return withRlsContext(user, async (tx) => {
    const existing = await loadOwned(tx, viewId)
    if (!existing) throw new SavedViewError("NOT_FOUND", "saved view not found")
    if (!canEdit(existing, user)) {
      throw new SavedViewError("SCOPE_DENIED", "not authorized to edit this view")
    }
    if (
      patch.sharedWithOrg === true &&
      !existing.sharedWithOrg &&
      !hasScope("kernel:saved_views:share", user.scopes)
    ) {
      throw new SavedViewError("SCOPE_DENIED", "sharing requires kernel:saved_views:share")
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if (patch.name !== undefined) updates.name = patch.name
    if (patch.payload !== undefined) updates.payload = patch.payload
    if (patch.sharedWithOrg !== undefined) updates.sharedWithOrg = patch.sharedWithOrg
    if (patch.position !== undefined) updates.position = patch.position
    const [row] = await tx
      .update(savedViews)
      .set(updates)
      .where(eq(savedViews.id, viewId))
      .returning()
    await tx.queueEvent({
      app: "kernel",
      entity: "saved_view",
      action: "updated",
      entityId: row.id,
      data: { app: row.app, viewId: row.viewId },
      actorId: user.userId,
      actorType: "user",
      orgId: user.orgId,
      timestamp: new Date().toISOString(),
    })
    return toRow(row)
  })
}

export async function deleteSavedView(ctx: ActorContext, viewId: string): Promise<void> {
  const user = requireUserActor(ctx)
  await withRlsContext(user, async (tx) => {
    const existing = await loadOwned(tx, viewId)
    if (!existing) throw new SavedViewError("NOT_FOUND", "saved view not found")
    if (existing.isDefault && !hasScope("kernel:saved_views:admin", user.scopes)) {
      throw new SavedViewError("SCOPE_DENIED", "deleting defaults requires admin")
    }
    if (!canEdit(existing, user)) {
      throw new SavedViewError("SCOPE_DENIED", "not authorized to delete this view")
    }
    await tx.delete(savedViews).where(eq(savedViews.id, viewId))
    await tx.queueEvent({
      app: "kernel",
      entity: "saved_view",
      action: "deleted",
      entityId: viewId,
      data: { app: existing.app, viewId: existing.viewId },
      actorId: user.userId,
      actorType: "user",
      orgId: user.orgId,
      timestamp: new Date().toISOString(),
    })
  })
}

export async function cloneSavedView(ctx: ActorContext, viewId: string): Promise<SavedViewRow> {
  const user = requireUserActor(ctx)
  return withRlsContext(user, async (tx) => {
    const src = await loadOwned(tx, viewId)
    if (!src) throw new SavedViewError("NOT_FOUND", "saved view not found")
    const [row] = await tx
      .insert(savedViews)
      .values({
        orgId: user.orgId,
        app: src.app,
        viewId: src.viewId,
        name: src.name,
        payload: src.payload as Record<string, unknown>,
        ownerUserId: user.userId,
        sharedWithOrg: false,
        isDefault: false,
      })
      .returning()
    await tx.queueEvent({
      app: "kernel",
      entity: "saved_view",
      action: "created",
      entityId: row.id,
      data: { app: row.app, viewId: row.viewId, clonedFrom: src.id },
      actorId: user.userId,
      actorType: "user",
      orgId: user.orgId,
      timestamp: new Date().toISOString(),
    })
    return toRow(row)
  })
}
