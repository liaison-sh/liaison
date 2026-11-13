// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP tool handlers — the triage surface an operator (or Claude over MCP)
// works incidents with: list → get → ack → resolve. Mutations stamp who/when
// and emit lifecycle events (no attention translations — triage actions are
// the operator's own doing, not news).
import { type AppContext, type ConfigSecretReveal, configSecretReveal } from "@liaison/app-sdk"
import {
  addComment,
  type CommentView,
  listComments,
  validateCommentBody,
  validateResolutionNote,
} from "./comments"
import { SIGNATURE_HEADER, WEBHOOK_SECRET_KEY } from "./lib/hmac"
import {
  MONITORING_URL_CONFIG_KEY,
  orderSources,
  parseMonitoringUrl,
  parseSourceProfiles,
  SOURCES_CONFIG_KEY,
} from "./lib/profiles"
import { refFields, resolveIncident } from "./lib/refs"
import { type IncidentsSummary, type IncidentsSummaryWithConfig, summarize } from "./lib/summarize"
import { resolveActorUserId, strOrNull, toIsoOrNull } from "./lib/values"

export interface IncidentView {
  id: string
  /** The incident's short per-org name (`INC-<n>`); null until it is numbered. */
  ref: string | null
  source: string
  severity: string
  title: string
  body: string | null
  dedupKey: string | null
  url: string | null
  status: string
  count: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  alertTs: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  reopenedAt: string | null
  resolutionNote: string | null
}

/** `incidents_get` result: the incident plus its comments and archived episodes, oldest first. */
export interface IncidentDetailView extends IncidentView {
  comments: CommentView[]
  /** True when older entries exist beyond the newest 200 returned. */
  commentsTruncated: boolean
}

type Row = Record<string, unknown>

function view(row: Row): IncidentView {
  return {
    id: String(row.id),
    ref: refFields(row.ref_number).ref,
    source: String(row.source),
    severity: String(row.severity),
    title: String(row.title),
    body: strOrNull(row.body),
    dedupKey: strOrNull(row.dedup_key),
    url: strOrNull(row.url),
    status: String(row.status),
    count: Number(row.count ?? 1),
    firstSeenAt: toIsoOrNull(row.first_seen_at),
    lastSeenAt: toIsoOrNull(row.last_seen_at),
    alertTs: toIsoOrNull(row.alert_ts),
    acknowledgedAt: toIsoOrNull(row.acknowledged_at),
    acknowledgedBy: strOrNull(row.acknowledged_by),
    resolvedAt: toIsoOrNull(row.resolved_at),
    resolvedBy: strOrNull(row.resolved_by),
    reopenedAt: toIsoOrNull(row.reopened_at),
    resolutionNote: strOrNull(row.resolution_note),
  }
}

/** List incidents, most recently seen first, with optional filters. */
export async function incidentsListHandler(
  params: { status?: string; severity?: string; source?: string; limit?: number },
  ctx: AppContext,
): Promise<{ data: IncidentView[] }> {
  const where: Record<string, unknown> = {}
  if (params.status) where.status = params.status
  if (params.severity) where.severity = params.severity
  if (params.source) where.source = params.source
  const limit = Math.max(1, Math.min(200, Math.trunc(params.limit ?? 25)))
  const rows = (await ctx.db.findMany("incidents", {
    where,
    orderBy: { last_seen_at: "desc" },
    limit,
  })) as Row[]
  return { data: rows.map(view) }
}

/**
 * Fetch one incident by UUID or `INC-<n>` ref, with its comments and archived previous
 * episodes (oldest first, the newest 200). Read-only: it never writes, not even a lazy ref.
 */
export async function incidentsGetHandler(
  params: { incidentId: string },
  ctx: AppContext,
): Promise<{ data: IncidentDetailView }> {
  const row = await resolveIncident(ctx, params.incidentId)
  const { comments, truncated } = await listComments(ctx, row.id)
  return { data: { ...view(row), comments, commentsTruncated: truncated } }
}

/**
 * Acknowledge an open incident (UUID or `INC-<n>` ref): someone is on it. An optional `note`
 * is saved as a comment AFTER the ack. Not atomic (the runtime drops a tool-level `atomic`
 * flag for installed apps): the note is validated before any write, and if its insert fails
 * the incident stays acknowledged and the tool returns the error; calling again is safe.
 */
export async function incidentsAckHandler(
  params: { incidentId: string; note?: string | null },
  ctx: AppContext,
): Promise<{ data: IncidentView }> {
  const row = await resolveIncident(ctx, params.incidentId)
  const note = params.note != null ? validateCommentBody(params.note) : null
  if (row.status === "resolved") {
    throw new Error(
      `already_resolved: ${params.incidentId}: a resolved incident reopens only when its alert re-fires`,
    )
  }
  const now = new Date().toISOString()
  await ctx.db.update("incidents", row.id, {
    status: "acknowledged",
    acknowledged_at: now,
    // Same author rule as comments: a system actor (non-uuid id) is stamped null, never refused.
    acknowledged_by: await resolveActorUserId(ctx),
  })
  await ctx.emit({
    entity: "incident",
    action: "acknowledged",
    entityId: row.id,
    data: { id: row.id, ...refFields(row.ref_number), source: row.source, title: row.title },
    metadata: { source: row.source, severity: row.severity },
  })
  if (note) await addComment(ctx, row, note)
  return { data: view((await ctx.db.findOne("incidents", row.id)) as Row) }
}

/**
 * Resolve an incident (UUID or `INC-<n>` ref), optionally recording what fixed it. The note is
 * validated before any write (trimmed, at most 4000 characters, blank means none).
 */
export async function incidentsResolveHandler(
  params: { incidentId: string; resolutionNote?: string | null },
  ctx: AppContext,
): Promise<{ data: IncidentView }> {
  const row = await resolveIncident(ctx, params.incidentId)
  const resolutionNote = validateResolutionNote(params.resolutionNote)
  if (row.status === "resolved") {
    throw new Error(`already_resolved: ${params.incidentId}`)
  }
  const now = new Date().toISOString()
  await ctx.db.update("incidents", row.id, {
    status: "resolved",
    resolved_at: now,
    resolved_by: await resolveActorUserId(ctx),
    resolution_note: resolutionNote,
  })
  await ctx.emit({
    entity: "incident",
    action: "resolved",
    entityId: row.id,
    // `status` is the constant the manifest's resolveWhen translations key on
    // to clear this incident's attention-feed rows (a resolved incident must
    // not linger as an unread feed item).
    data: {
      id: row.id,
      ...refFields(row.ref_number),
      status: "resolved",
      source: row.source,
      title: row.title,
      resolutionNote,
    },
    metadata: { source: row.source, severity: row.severity },
  })
  return { data: view((await ctx.db.findOne("incidents", row.id)) as Row) }
}

/** One count of the summary, as a dashboard block reads it. */
export interface SummaryRow {
  key: "critical" | "warning" | "info" | "acknowledged" | "resolved24h"
  status: "open" | "acknowledged" | "resolved"
  value: number
}

/**
 * The summary's counts as rows (`key`, `status`, `value`): the open incidents by severity, the
 * acknowledged ones, and those resolved in the trailing 24h. The sets do not overlap, so the rows
 * add up to every incident the summary counts. `data.sources` stays the per-source list.
 */
function summaryRows(s: IncidentsSummary): SummaryRow[] {
  return [
    { key: "critical", status: "open", value: s.open.critical },
    { key: "warning", status: "open", value: s.open.warning },
    { key: "info", status: "open", value: s.open.info },
    { key: "acknowledged", status: "acknowledged", value: s.acknowledged },
    { key: "resolved24h", status: "resolved", value: s.resolved24h },
  ]
}

/**
 * Dashboard aggregate: open counts by severity, acknowledged count, resolved
 * in the trailing 24h, and per-source health (live count, worst severity,
 * last-seen). Bounded reads (500 live + 200 recent resolved) — the dashboard
 * is a glanceable board, not an authoritative report at pathological volumes.
 */
export async function incidentsSummaryHandler(
  _params: Record<string, never>,
  ctx: AppContext,
): Promise<{ data: IncidentsSummaryWithConfig; rows: SummaryRow[] }> {
  const [open, acknowledged, resolved, sourcesConfig, urlConfig, canConfigure] = await Promise.all([
    ctx.db.findMany("incidents", {
      where: { status: "open" },
      orderBy: { last_seen_at: "desc" },
      limit: 500,
    }),
    ctx.db.findMany("incidents", {
      where: { status: "acknowledged" },
      orderBy: { last_seen_at: "desc" },
      limit: 500,
    }),
    ctx.db.findMany("incidents", {
      where: { status: "resolved" },
      orderBy: { resolved_at: "desc" },
      limit: 200,
    }),
    ctx.config.get(SOURCES_CONFIG_KEY),
    ctx.config.get(MONITORING_URL_CONFIG_KEY),
    callerCanConfigure(ctx),
  ])
  const live = [...(open as Row[]), ...(acknowledged as Row[])].map(view)
  const recentResolved = (resolved as Row[]).map(view)
  const summary = summarize(live, recentResolved, Date.now())
  const { profiles, warnings } = parseSourceProfiles(sourcesConfig)
  const bySource = new Map(profiles.map((p) => [p.source, p]))
  return {
    rows: summaryRows(summary),
    data: {
      ...summary,
      sources: summary.sources.map((s) => ({ ...s, profile: bySource.get(s.source) ?? null })),
      profiles,
      warnings,
      sourceOrder: orderSources(
        summary.sources.map((s) => s.source),
        profiles,
      ),
      monitoringUrl: parseMonitoringUrl(urlConfig),
      canConfigure,
    },
  }
}

/**
 * Whether the caller may edit this app's config (the Sources panel writes
 * through `PUT /api/apps/monitoring/config/:key`, gated on `kernel:apps:admin`).
 * The sandbox bridge exposes `hasScope` over the caller's scopes (same
 * wildcard rules as the kernel check); it is not on the public AppContext
 * type, so it is probed, and a host without it answers false.
 */
async function callerCanConfigure(ctx: AppContext): Promise<boolean> {
  const probe = (ctx as AppContext & { hasScope?: (scope: string) => Promise<unknown> }).hasScope
  if (typeof probe !== "function") return false
  try {
    return (await probe.call(ctx, "kernel:apps:admin")) === true
  } catch {
    return false
  }
}

/**
 * Operator setup read (admin scope, not agent-visible): whether the webhook
 * signing secret has been minted, and its value — the operator pastes it into
 * the external alert system's outgoing-webhook config.
 */
export async function webhookInfoHandler(
  _params: Record<string, never>,
  ctx: AppContext,
): Promise<{
  data: {
    configured: boolean
    /** The secret, written in by the host (the app answers its marker). */
    secret: ConfigSecretReveal | null
    signatureHeader: string
    algorithm: string
  }
}> {
  // The secret itself never enters the app: the host writes it in where the marker stands
  // (the manifest lets this tool reveal WEBHOOK_SECRET_KEY, `revealsSecrets`).
  const configured = await ctx.config.has(WEBHOOK_SECRET_KEY)
  return {
    data: {
      configured,
      secret: configured ? configSecretReveal(WEBHOOK_SECRET_KEY) : null,
      signatureHeader: SIGNATURE_HEADER,
      algorithm: "HMAC-SHA256, base64-encoded digest of the raw request body",
    },
  }
}
