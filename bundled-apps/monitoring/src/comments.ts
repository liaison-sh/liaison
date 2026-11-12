// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Incident comments: free-text context people and agents attach to an incident at any time
// (vendor ticket, next step, what was tried), plus the archived previous episodes the webhook
// writes on a reopen (`kind: "episode"`). Both live in `incident_comments` and are returned
// by `incidents_get`, oldest first.
//
// Imports only `./lib/*` (never `./incidents`) so `incidents.ts -> comments.ts -> lib/*` stays
// acyclic.
import type { AppContext } from "@liaison/app-sdk"
import { type IncidentRecord, refFields, resolveIncident } from "./lib/refs"
import { errSummary, resolveActorUserId, stripNul, strOrNull, toIsoOrNull } from "./lib/values"

const COMMENT_MAX_CHARS = 4000

/** `incidents_get` returns the newest 200 entries; one more is read to detect truncation. */
const READ_LIMIT = 200

type Row = Record<string, unknown>

export interface CommentView {
  id: string
  kind: "comment" | "episode"
  body: string | null
  authorId: string | null
  createdAt: string | null
  episodeTitle: string | null
  episodeResolvedAt: string | null
  episodeResolutionNote: string | null
}

function commentView(row: Row): CommentView {
  const episode = row.kind === "episode"
  return {
    id: String(row.id),
    kind: episode ? "episode" : "comment",
    body: strOrNull(row.body),
    authorId: strOrNull(row.author_id),
    createdAt: toIsoOrNull(row.created_at),
    episodeTitle: episode ? strOrNull(row.episode_title) : null,
    episodeResolvedAt: episode ? toIsoOrNull(row.episode_resolved_at) : null,
    episodeResolutionNote: episode ? strOrNull(row.episode_resolution_note) : null,
  }
}

/** Trimmed body (U+0000 removed), or throws `empty_comment` / `comment_too_long`. */
export function validateCommentBody(body: unknown): string {
  const trimmed = typeof body === "string" ? stripNul(body).trim() : ""
  if (!trimmed) throw new Error("empty_comment: the comment is empty")
  if (trimmed.length > COMMENT_MAX_CHARS) {
    throw new Error(`comment_too_long: at most ${COMMENT_MAX_CHARS} characters`)
  }
  return trimmed
}

/**
 * The `incidents_resolve` note: trimmed (U+0000 removed), null when absent or blank; a
 * non-string or one longer than a comment throws. It is copied into an episode on every
 * reopen and returned by `incidents_get`, so it gets the comment bound.
 */
export function validateResolutionNote(note: unknown): string | null {
  if (note == null) return null
  if (typeof note !== "string")
    throw new Error("invalid_resolution_note: resolutionNote must be a string")
  const trimmed = stripNul(note).trim()
  if (trimmed.length > COMMENT_MAX_CHARS) {
    throw new Error(`resolution_note_too_long: at most ${COMMENT_MAX_CHARS} characters`)
  }
  return trimmed || null
}

/** The incident's comments and episodes, oldest first (newest 200 kept). */
export async function listComments(
  ctx: Pick<AppContext, "db">,
  incidentId: string,
): Promise<{ comments: CommentView[]; truncated: boolean }> {
  const rows = (await ctx.db.findMany("incident_comments", {
    where: { incident_id: incidentId },
    orderBy: { createdAt: "desc", id: "desc" },
    limit: READ_LIMIT + 1,
  })) as Row[]
  const truncated = rows.length > READ_LIMIT
  const kept = rows.slice(0, READ_LIMIT).reverse()
  return { comments: kept.map(commentView), truncated }
}

/**
 * Insert a validated comment on an incident row (already looked up from its UUID or ref) and
 * emit `incident:commented`. The insert commits on its own (tools are not atomic), so the emit
 * is best effort: its only consumer is the open UIs' refresh, and failing the call after the
 * comment is stored would invite a retry that duplicates it.
 */
export async function addComment(
  ctx: AppContext,
  row: IncidentRecord,
  body: string,
): Promise<CommentView> {
  const { id } = await ctx.db.insert("incident_comments", {
    incident_id: row.id,
    kind: "comment",
    body,
    author_id: await resolveActorUserId(ctx),
  })
  const saved = (await ctx.db.findOne("incident_comments", id)) as Row
  try {
    await ctx.emit({
      entity: "incident",
      action: "commented",
      entityId: row.id,
      data: {
        id: row.id,
        ...refFields(row.ref_number),
        source: row.source,
        title: row.title,
        commentId: id,
      },
      metadata: { source: row.source, severity: row.severity },
    })
  } catch (err) {
    ctx.logger.error("monitoring: commented emit failed", {
      incidentId: row.id,
      commentId: id,
      err: errSummary(err),
    })
  }
  return commentView(saved)
}

/**
 * Add a comment to an incident (UUID or `INC-<n>` ref), in any status. Not gated and not
 * atomic: one insert plus one emit. Comments never notify the feed (`incident:commented` has no
 * attention translation); open UIs refresh through the entity-change path.
 */
export async function incidentsCommentHandler(
  params: { incidentId: string; body: string },
  ctx: AppContext,
): Promise<{ data: CommentView }> {
  const row = await resolveIncident(ctx, params.incidentId)
  const body = validateCommentBody(params.body)
  return { data: await addComment(ctx, row, body) }
}
