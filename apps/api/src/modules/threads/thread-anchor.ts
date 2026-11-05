// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The entity a thread belongs to (`threads.created_from`): a task's comments,
// a contact's discussion. Such a thread is read where its entity is, so every
// notification about a message in it names the entity and opens on it, and a
// direct visit to the thread says whose conversation it is (the shape and its
// wording: @liaison/shared threads/thread-anchor.ts).
//
// Generic on purpose: the kernel names no app here. A `created_from` is an
// anchor when the apps' manifests give its kind an in-app page to open
// (resolveReferenceMetadataFromManifests); its name comes from the entity's
// declared `labelField`, and the fact that tells two of the same name apart
// from its declared `labelSecondaryFrom` (a task's project).
import type { ThreadAnchor } from "@liaison/shared"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { attachMentionSecondaryLabels } from "~/modules/search/mention-secondary"
import type { MentionHit } from "~/modules/search/service"
import {
  resolveEntityLabel,
  resolveReferenceMetadataFromManifests,
} from "~/modules/threads/reference-display"

const log = rootLogger.child({ module: "thread-anchor" })

/** The ids of a thread's anchor: what a `message:create` event carries. */
export interface ThreadAnchorRef {
  app: string
  entityType: string
  entityId: string
}

/** The ids a stored `created_from` names, shape-checked only: what a `message:create` event carries. */
export function threadAnchorIds(createdFrom: unknown): ThreadAnchorRef | null {
  if (!createdFrom || typeof createdFrom !== "object") return null
  const c = createdFrom as Record<string, unknown>
  if (typeof c.app !== "string" || typeof c.entityType !== "string") return null
  if (typeof c.entityId !== "string" || c.entityId.length === 0) return null
  return { app: c.app, entityType: c.entityType, entityId: c.entityId }
}

/**
 * The anchor a stored `created_from` names, or null: no `created_from`, a
 * malformed one, or a kind no app gives a page to (an internal origin such as
 * an MCP connection's working thread stays a plain thread).
 */
export function threadAnchorRef(createdFrom: unknown, orgId = ""): ThreadAnchorRef | null {
  const ids = threadAnchorIds(createdFrom)
  if (!ids || !resolveReferenceMetadataFromManifests(ids.app, ids.entityType, orgId)) return null
  return ids
}

/** A thread asked to belong to an entity its creator may not see (403). */
export class CreatedFromNotVisibleError extends Error {
  readonly code = "created_from_not_visible"
  constructor() {
    super("The entity this thread would belong to does not exist or is not visible to you")
    this.name = "CreatedFromNotVisibleError"
  }
}

type LabelTx = Parameters<typeof resolveEntityLabel>[0]

/**
 * Whether `tx`'s reader may see the entity a `created_from` names: its row
 * reads under that reader's RLS. A kind with no label reader, a missing row or
 * a row the policies hide all answer no (fail closed).
 */
export async function canReadThreadAnchorEntity(
  tx: LabelTx,
  orgId: string,
  ref: ThreadAnchorRef,
): Promise<boolean> {
  try {
    const label = await resolveEntityLabel(tx, {
      orgId,
      app: ref.app,
      entityType: ref.entityType,
      entityId: ref.entityId,
    })
    return label !== null
  } catch (err) {
    log.warn({ err, app: ref.app, entityType: ref.entityType }, "thread anchor visibility failed")
    return false
  }
}

/**
 * The anchor with its words, read with `tx`'s visibility: a reader who may not
 * see the entity gets its kind and no name, and the fact that tells it apart
 * (a task's project) only when that reader may see it too. Never throws.
 */
export async function resolveThreadAnchor(
  tx: LabelTx,
  orgId: string,
  ref: ThreadAnchorRef,
): Promise<ThreadAnchor> {
  const meta = resolveReferenceMetadataFromManifests(ref.app, ref.entityType, orgId)
  const kindLabel = meta?.label ?? ref.entityType
  let label: string | null = null
  try {
    label = await resolveEntityLabel(tx, {
      orgId,
      app: ref.app,
      entityType: ref.entityType,
      entityId: ref.entityId,
    })
  } catch (err) {
    log.warn({ err, app: ref.app, entityType: ref.entityType }, "thread anchor label failed")
  }
  let secondaryLabel: string | null = null
  if (label) {
    try {
      const hit: MentionHit = {
        type: ref.entityType,
        id: ref.entityId,
        label,
        app: ref.app,
        entityType: ref.entityType,
      }
      await attachMentionSecondaryLabels(orgId, [hit], tx)
      secondaryLabel = hit.secondaryLabel ?? null
    } catch (err) {
      log.warn({ err, app: ref.app, entityType: ref.entityType }, "thread anchor detail failed")
    }
  }
  return { ...ref, kindLabel, label, secondaryLabel }
}

/** How many readers' RLS reads run at once for one event. */
const READER_CONCURRENCY = 4

/**
 * The anchor's words for EACH reader of a notification, under that reader's
 * own visibility (an RLS transaction as them, the same policies their own
 * request would meet), never one privileged read for the whole audience: a
 * member seated by a mention, one who lost access to the entity, or one in a
 * thread whose anchor was set by someone else gets null for an entity they may
 * not see, and their notification names nothing of it.
 *
 * One call per event for all its readers: their grants are loaded in one
 * privileged transaction, then each reader's label read runs as that reader
 * (Postgres pins one identity per RLS transaction, so a cross-reader read
 * cannot be one statement). A reader whose read fails gets null (fail closed).
 */
export async function resolveThreadAnchorForReaders(
  orgId: string,
  ref: ThreadAnchorRef,
  userIds: readonly string[],
): Promise<Map<string, ThreadAnchor | null>> {
  const out = new Map<string, ThreadAnchor | null>()
  const readers = [...new Set(userIds)]
  for (const id of readers) out.set(id, null)
  if (readers.length === 0) return out
  let grants: Map<string, Awaited<ReturnType<typeof loadEffectivePermissions>>>
  try {
    grants = await withPrivilegedDb(orgId, "thread-anchor-reader-grants", async (tx) => {
      const byUser = new Map<string, Awaited<ReturnType<typeof loadEffectivePermissions>>>()
      for (const userId of readers) {
        byUser.set(userId, await loadEffectivePermissions(tx, userId, orgId))
      }
      return byUser
    })
  } catch (err) {
    log.warn({ err, app: ref.app, entityType: ref.entityType }, "thread anchor grants failed")
    return out
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < readers.length) {
      const userId = readers[next]
      next += 1
      const perms = grants.get(userId)
      if (!perms) continue
      try {
        const anchor = await withRlsContext(
          {
            actorType: "user",
            userId,
            orgId,
            scopes: perms.scopes,
            dimensionGrants: perms.dimensionGrants,
            roles: perms.roles,
          },
          (tx) => resolveThreadAnchor(tx, orgId, ref),
          { pool: "jobs" },
        )
        out.set(userId, anchor.label ? anchor : null)
      } catch (err) {
        log.warn(
          { err, app: ref.app, entityType: ref.entityType, userId },
          "thread anchor read failed",
        )
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(READER_CONCURRENCY, readers.length) }, () => worker()),
  )
  return out
}
