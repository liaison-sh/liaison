// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The documents waiting for a vector at the instance's new width.
//
// When EMBEDDING_DIMENSIONS changes, the index is rebuilt with the embedder at
// the new width (reindex.ts) and the old vectors cannot be carried over: they
// are the wrong length. The documents that HAD a vector are noted here first,
// by the rows they are built from, and the re-embed job (infra/jobs/
// embedding-backfill.ts) rebuilds them from Postgres with a fresh vector, a
// bounded batch per step. Documents that never had a vector (a history
// imported keyword only) are not noted: re-embedding them is a provider bill
// nobody asked for.
//
// In Redis, like the backfill's cursor: it is progress, not state. One set per
// org of `<kind>:<id>` members, plus the set of orgs with work left. Adding a
// member twice is a no-op, so noting is idempotent and safe to repeat after a
// restart; a member leaves its set only once its batch was written.
import { searchLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"

const ORGS_KEY = "search:reembed:orgs"
const orgKey = (orgId: string) => `search:reembed:org:${orgId}`

/** What a noted member re-indexes: the message (and the windows it anchors), or a brief or episode row. */
export type ReembedKind = "message" | "brief_row" | "episode"

export interface ReembedItem {
  kind: ReembedKind
  id: string
}

/**
 * The row a search document is rebuilt from, or null for a document that
 * carries no vector of its own kind. A window (`<threadId>:<anchorId>`) is
 * rebuilt by re-indexing its anchor message.
 */
export function reembedItemOf(doc: Record<string, unknown>): ReembedItem | null {
  const type = doc.entity_type
  const id = typeof doc.entity_id === "string" ? doc.entity_id : null
  if (!id) return null
  if (type === "message") return { kind: "message", id }
  if (type === "message_window") {
    const anchor = id.slice(id.lastIndexOf(":") + 1)
    return anchor ? { kind: "message", id: anchor } : null
  }
  if (type === "brief_row" || type === "episode") return { kind: type, id }
  return null
}

function member(item: ReembedItem): string {
  return `${item.kind}:${item.id}`
}

export function parseReembedMember(value: string): ReembedItem | null {
  const at = value.indexOf(":")
  if (at <= 0) return null
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  if (!id || (kind !== "message" && kind !== "brief_row" && kind !== "episode")) return null
  return { kind, id }
}

/** Note documents (as Meili documents or hits) for re-embedding. Never throws. */
export async function noteForReembed(
  orgId: string,
  docs: ReadonlyArray<Record<string, unknown>>,
): Promise<number> {
  const members = [
    ...new Set(docs.map(reembedItemOf).flatMap((item) => (item ? [member(item)] : []))),
  ]
  if (members.length === 0) return 0
  try {
    await redis
      .multi()
      .sadd(orgKey(orgId), ...members)
      .sadd(ORGS_KEY, orgId)
      .exec()
    return members.length
  } catch (err) {
    log.warn({ err, orgId, count: members.length }, "Could not note documents for re-embedding")
    return 0
  }
}

/** The orgs with documents still waiting. */
export async function orgsAwaitingReembed(): Promise<string[]> {
  return await redis.smembers(ORGS_KEY)
}

/** Up to `count` waiting members of one org (not removed). */
export async function peekReembed(orgId: string, count: number): Promise<string[]> {
  const out = await redis.srandmember(orgKey(orgId), count)
  return Array.isArray(out) ? out : out ? [out] : []
}

/** Remove members whose batch was written; drop the org once its set is empty. */
export async function settleReembed(orgId: string, members: string[]): Promise<number> {
  if (members.length > 0) await redis.srem(orgKey(orgId), ...members)
  const left = await redis.scard(orgKey(orgId))
  if (left === 0) await redis.srem(ORGS_KEY, orgId)
  return left
}

/** Forget an org's waiting documents (it has no embedder any more). */
export async function dropReembed(orgId: string): Promise<void> {
  await redis.multi().del(orgKey(orgId)).srem(ORGS_KEY, orgId).exec()
}

/** How many documents of the org are waiting. */
export async function reembedRemaining(orgId: string): Promise<number> {
  return await redis.scard(orgKey(orgId))
}
