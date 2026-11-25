// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the kernel's events change for client reports:
// - a report's send card a person rejected, or that expired, closes the draft as
//   `rejected` or `expired`. Nothing is sent either way; the row is read from the
//   approval itself, never taken from the event's words.
// - a person opening a project's reports share turns the Friday report routine on for
//   the org, owned by that person, in the org's own time zone. Once per org: a second
//   share, or a second person, adds no routine.

import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { afterCurrentCommit } from "~/db/commit-hooks"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { UUID_RE } from "~/lib/uuid"

const log = rootLogger.child({ module: "projects/client-report-events" })

const K = () => drizzleSql.raw(schemaRef("kernel"))

export const CLIENT_REPORT_SEND_TOOL = "projects:client_report_send"
export const CLIENT_REPORTS_TEMPLATE = "client-reports"

interface Base {
  tx: RlsClient
  orgId: string
}

export type CardClosedOutcome =
  | { status: "rejected" | "expired"; reportId: string }
  | { status: "ignored"; reason: string }

/** Closes the draft whose send card a person rejected or that expired. */
export async function clientReportCardClosed(
  b: Base & { approvalId: string },
): Promise<CardClosedOutcome> {
  if (!UUID_RE.test(b.approvalId)) return { status: "ignored", reason: "not an approval id" }
  const [a] = extractRows<{ status: string; tool_name: string; report_id: string | null }>(
    await b.tx.execute(drizzleSql`
      SELECT status, tool_name, current_payload->>'reportId' AS report_id
        FROM ${K()}.approval_requests
       WHERE id = ${b.approvalId}::uuid AND org_id = ${b.orgId}::uuid
       LIMIT 1`),
  )
  if (!a || a.tool_name !== CLIENT_REPORT_SEND_TOOL)
    return { status: "ignored", reason: "not a client report's send card" }
  const outcome = a.status === "denied" ? "rejected" : a.status === "expired" ? "expired" : null
  if (!outcome) return { status: "ignored", reason: `the card is ${a.status}` }
  if (!a.report_id || !UUID_RE.test(a.report_id))
    return { status: "ignored", reason: "the card names no report" }
  // Only a draft nobody sent closes: a report whose send already wrote what went out stays.
  const [row] = extractRows<{ id: string; project_id: string; period_end: string }>(
    await b.tx.execute(drizzleSql`
      UPDATE ${projectsRel("client_reports")}
         SET status = ${outcome}, updated_at = now()
       WHERE id = ${a.report_id}::uuid AND org_id = ${b.orgId}::uuid
         AND status = 'draft' AND sections_sent IS NULL
      RETURNING id::text AS id, project_id::text AS project_id, period_end::text AS period_end`),
  )
  if (!row) return { status: "ignored", reason: "the report is no longer a draft" }
  await b.tx.queueEvent({
    app: "projects",
    entity: "client_report",
    action: outcome,
    entityId: row.id,
    data: { reportId: row.id, projectId: row.project_id, periodEnd: row.period_end },
    actorId: null,
    actorType: "system",
    orgId: b.orgId,
  })
  return { status: outcome, reportId: row.id }
}

export type RoutineOnOutcome =
  | { status: "enabling"; ownerUserId: string }
  | { status: "ignored"; reason: string }

/**
 * Turns the client reports routine on when a person opened a project's reports share.
 * The share is re-read: open, of kind `project_reports`, opened by a person of this org.
 */
export async function clientReportsRoutineOn(
  b: Base & { shareId: string },
): Promise<RoutineOnOutcome> {
  if (!UUID_RE.test(b.shareId)) return { status: "ignored", reason: "not a share id" }
  const [share] = extractRows<{ by: string | null }>(
    await b.tx.execute(drizzleSql`
      SELECT s.shared_by_user_id::text AS by
        FROM ${K()}.portal_shares s
        JOIN ${K()}.users u ON u.id = s.shared_by_user_id AND u.org_id = s.org_id
       WHERE s.id = ${b.shareId}::uuid AND s.org_id = ${b.orgId}::uuid
         AND s.kind = 'project_reports' AND s.closed_at IS NULL
         AND u.user_type = 'member' AND u.status = 'active'
       LIMIT 1`),
  )
  if (!share?.by) return { status: "ignored", reason: "not an open reports share a person opened" }
  const [existing] = extractRows<{ id: string }>(
    await b.tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${K()}.routines
       WHERE org_id = ${b.orgId}::uuid AND app_name = 'projects'
         AND template_key = ${CLIENT_REPORTS_TEMPLATE}
       LIMIT 1`),
  )
  if (existing) return { status: "ignored", reason: "the routine is already on" }
  // The person's own scopes, read now; the routine is created once this transaction ends (the
  // template's own writer takes a privileged slot of its own, never one inside an event's).
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const perms = await loadEffectivePermissions(b.tx as never, share.by, b.orgId)
  const by = share.by
  const queued = afterCurrentCommit(() => {
    void enableReportRoutine(b.orgId, by, perms.scopes).catch((err) =>
      log.error({ err, orgId: b.orgId }, "client reports routine could not be turned on"),
    )
  })
  if (!queued) await enableReportRoutine(b.orgId, by, perms.scopes)
  return { status: "enabling", ownerUserId: by }
}

async function enableReportRoutine(orgId: string, userId: string, scopes: string[]): Promise<void> {
  const { handleEnableRoutineTemplate } = await import(
    "~/modules/agent/tools/skills-routines-tools"
  )
  const out = (await handleEnableRoutineTemplate(
    { appName: "projects", templateKey: CLIENT_REPORTS_TEMPLATE },
    { orgId, userId, actorType: "user", scopes } as never,
  )) as { routine?: { id: string }; error?: { code: string; message?: string } }
  if (!out.routine && out.error?.code !== "already_enabled")
    log.warn(
      { orgId, userId, code: out.error?.code },
      "client reports routine not turned on: the person who shared lacks its scopes or the template",
    )
}
