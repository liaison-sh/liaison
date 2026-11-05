// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Filing a Liaison bug report. One function, two doors: the web form's
// `POST /api/bug-reports` and the `kernel:report_bug` tool an agent or an MCP
// client calls for its user. Both land in the same inbox with the same body
// layout, attributed to the person who is signed in, never to the agent.
//
// When the operator sends bug reports only to the Liaison team
// (`bugReportsTeamOnly`, operator org only), the form files NO local ticket: the
// previewed payload is queued in the outbox and its ticked files are staged
// for it (liaison-team/team-only.ts). An agent's report then waits for the
// reporter's own click (agent-drafts.ts).
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { createTicket } from "~/apps/tickets/create"
import { persistInboundAttachments } from "~/apps/tickets/inbound"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { getDiagErrorState } from "~/lib/error-tracker"
import { rootLogger } from "~/lib/logger"
import { scrubText } from "~/lib/scrub"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { isBlockedFileType } from "~/modules/files/attach"
import {
  BugReportForwardError,
  type BuiltForward,
  buildBugReportForward,
  enqueueBugReportForward,
  isBugReportTeamOnlyFor,
  isForwardingAvailable,
  type StoredForwardFile,
} from "~/modules/liaison-team/bug-report-payload"
import { createSnapshot, type ForwardSnapshot, readSnapshot } from "~/modules/liaison-team/snapshot"
import { deleteStagedFiles, stageForwardFiles } from "~/modules/liaison-team/team-only"

const log = rootLogger.child({ service: "bug-reports" })

// Per-entry and total caps keep a single report bounded: the client ring buffer
// already trims to its own cap, but the payload limits are enforced server-side
// so a hand-crafted request can't inflate a ticket body.
const MAX_LOG_ENTRIES = 400
const MAX_LOG_ENTRY_CHARS = 2_000
const MAX_LOGS_TOTAL_CHARS = 64_000
const MAX_DIAG_SIGNATURES = 15

// Screenshots / short recordings attached by the reporter. Sent inline as
// base64 in the JSON body (the reporter may hold no tickets scopes, so the
// staged-upload-session path — which enforces the target's writeScope at every
// step — is not usable here; the persist runs privileged like the ticket
// create itself). The /api/bug-reports body-limit exemption in app.ts is sized
// to these caps.
export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
// base64 inflates 3 bytes -> 4 chars (plus padding)
const MAX_ATTACHMENT_B64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4

const attachmentIndexesSchema = z
  .array(
    z
      .number()
      .int()
      .min(0)
      .max(MAX_ATTACHMENTS - 1),
  )
  .max(MAX_ATTACHMENTS)

/** What the reporter approved in the preview (S5.4): the submit must match it exactly. */
const forwardSchema = z.object({
  includeEmail: z.boolean(),
  snapshotId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  attachmentIndexes: attachmentIndexesSchema,
  /** The dialog showed "goes only to the Liaison team": refused (409) if that is no longer so. */
  teamOnly: z.boolean().optional(),
})

const reportFields = {
  description: z.string().trim().min(1).max(20_000),
  clientLogs: z.array(z.string().max(MAX_LOG_ENTRY_CHARS)).max(MAX_LOG_ENTRIES).optional(),
  context: z
    .object({
      url: z.string().max(2_000).optional(),
      userAgent: z.string().max(500).optional(),
      appVersion: z.string().max(100).optional(),
    })
    .optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(255),
        mimeType: z.string().trim().min(1).max(200),
        bytesBase64: z.string().min(1).max(MAX_ATTACHMENT_B64_CHARS),
      }),
    )
    .max(MAX_ATTACHMENTS)
    .optional(),
}

export const bugReportSchema = z.object({
  ...reportFields,
  /** Also send to the Liaison team (web form only, after the reporter's ticks). */
  forward: forwardSchema.optional(),
})

/** `POST /api/bug-reports/forward-preview`: the form plus the reporter's ticks. */
export const forwardPreviewSchema = z.object({
  ...reportFields,
  includeEmail: z.boolean().default(false),
  snapshotId: z.uuid().optional(),
  attachmentIndexes: attachmentIndexesSchema.default([]),
})

/**
 * The last hour's server error signatures (already scrubbed by the error
 * tracker), for the instance operator's org only: the tracker is process-wide,
 * so on a multi-tenant server they come from every org. Both the local ticket
 * and the forwarded snapshot go through this one rule.
 */
async function serverErrorsFor(
  orgId: string,
): Promise<Array<{ signature: string; count1h: number }> | undefined> {
  if (!(await isInstanceOperatorOrg(orgId))) return undefined
  return getDiagErrorState()
    .errorSignatures.slice(0, MAX_DIAG_SIGNATURES)
    .map((s) => ({ signature: s.signature, count1h: s.count1h }))
}

function buildReportBody(
  input: z.infer<typeof bugReportSchema>,
  reporter: { email: string; name: string },
  serverErrors: Array<{ signature: string; count1h: number }> | undefined,
): string {
  const sections: string[] = [input.description]

  const contextLines = [
    `Reported by: ${reporter.name} (${reporter.email})`,
    input.context?.url ? `Page: ${input.context.url}` : null,
    input.context?.userAgent ? `User agent: ${input.context.userAgent}` : null,
    input.context?.appVersion ? `App version: ${input.context.appVersion}` : null,
  ].filter(Boolean)
  sections.push(["--- Context ---", ...contextLines].join("\n"))

  if (input.clientLogs && input.clientLogs.length > 0) {
    // Value-level scrub (tokens, emails, connection strings) BEFORE the lines
    // land in a ticket other org members can read — same guarantee the error
    // tracker gives its samples.
    let total = 0
    const kept: string[] = []
    // Walk newest-first so the total-size cap drops the OLDEST lines.
    for (let i = input.clientLogs.length - 1; i >= 0; i--) {
      const line = scrubText(input.clientLogs[i])
      if (total + line.length > MAX_LOGS_TOTAL_CHARS) break
      total += line.length
      kept.unshift(line)
    }
    const dropped = input.clientLogs.length - kept.length
    sections.push(
      [
        `--- Recent client logs (${kept.length} entries, newest last${dropped > 0 ? `, ${dropped} older dropped` : ""}) ---`,
        ...kept,
      ].join("\n"),
    )
  }

  // Server-side error signatures from the last hour (operator org only, see
  // serverErrorsFor): cheap forensics for correlating the report with backend
  // failures without granting the reporter any diag access.
  if (serverErrors && serverErrors.length > 0) {
    sections.push(
      [
        "--- Server error signatures (last hour) ---",
        ...serverErrors.map((s) => `[x${s.count1h}] ${s.signature}`),
      ].join("\n"),
    )
  }

  return sections.join("\n\n")
}

export type BugReportInput = z.infer<typeof bugReportSchema>

export interface BugReportFiled {
  /** The local ticket; absent when the report went only to the Liaison team. */
  ticketId?: string
  ticketHandle?: string
  attachmentsPersisted: number
  attachmentsSkipped: Array<{ filename: string; reason: string }>
  /** Only when the reporter asked to forward: queued in the outbox, or not (switched off meanwhile, or a local error). */
  forwarded?: "queued" | "unavailable" | "failed"
  /** The report went only to the Liaison team: no local ticket exists. */
  teamOnly?: true
  /** The message id the Liaison team receives (team-only), the reporter's reference. */
  messageId?: string
}

/** What the forwarding preview shows, and what the submit must match. */
export interface ForwardPreview {
  snapshotId: string
  data: BuiltForward["data"]
  attachments: BuiltForward["attachments"]
  digest: string
}

export type ForwardPreviewInput = z.infer<typeof forwardPreviewSchema>

const unavailable = () =>
  new BugReportForwardError(
    "Forwarding bug reports to the Liaison team is not available on this server",
    409,
    "FORWARDING_UNAVAILABLE",
  )

async function reporterOf(
  orgId: string,
  userId: string,
): Promise<{ email: string; name: string } | undefined> {
  return withPrivilegedDb(orgId, "bug-report-reporter", async (tx) => {
    const [row] = await tx
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    return row
  })
}

/** Freeze the logs (and, for the operator org only, the server errors) of a new attempt. */
async function newSnapshot(
  orgId: string,
  userId: string,
  clientLogs: string[] | undefined,
): Promise<{ snapshotId: string; snapshot: ForwardSnapshot }> {
  const snapshot: ForwardSnapshot = { clientLogs: clientLogs ?? [] }
  const serverErrors = await serverErrorsFor(orgId)
  if (serverErrors) snapshot.serverErrors = serverErrors
  return { snapshotId: await createSnapshot(orgId, userId, snapshot), snapshot }
}

const previewOf = (snapshotId: string, built: BuiltForward): ForwardPreview => ({
  snapshotId,
  data: built.data,
  attachments: built.attachments,
  digest: built.digest,
})

/** `GET /api/bug-reports/forwarding`: may this reporter forward right now, and do reports go only to the Liaison team. */
export async function forwardingState(
  orgId: string,
): Promise<{ available: boolean; teamOnly: boolean }> {
  const available = await isForwardingAvailable()
  return { available, teamOnly: available && (await isBugReportTeamOnlyFor(orgId)) }
}

/** Who the report is from, for the agent tool (agent-drafts.ts builds from it). */
export async function reporterEmailOf(orgId: string, userId: string): Promise<string> {
  const reporter = await reporterOf(orgId, userId)
  if (!reporter) throw new BugReportError(404, "User not found")
  return reporter.email
}

/** A fresh snapshot holding no client logs: an agent's report has none. */
export async function serverSnapshotFor(orgId: string): Promise<ForwardSnapshot> {
  const snapshot: ForwardSnapshot = { clientLogs: [] }
  const serverErrors = await serverErrorsFor(orgId)
  if (serverErrors) snapshot.serverErrors = serverErrors
  return snapshot
}

/**
 * The exact `bug-report` data the reporter would forward. The first call of an
 * attempt (no `snapshotId`, or an expired one) freezes the logs and server
 * errors; later calls reuse them.
 */
export async function previewBugReportForward(
  orgId: string,
  userId: string,
  input: ForwardPreviewInput,
): Promise<ForwardPreview> {
  if (!(await isForwardingAvailable())) throw unavailable()
  const reporter = await reporterOf(orgId, userId)
  if (!reporter) throw new BugReportError(404, "User not found")
  let snapshotId = input.snapshotId
  let snapshot = snapshotId ? await readSnapshot(orgId, userId, snapshotId) : null
  if (!snapshotId || !snapshot) {
    ;({ snapshotId, snapshot } = await newSnapshot(orgId, userId, input.clientLogs))
  }
  const built = buildBugReportForward({
    form: input,
    snapshot,
    includeEmail: input.includeEmail,
    reporterEmail: reporter.email,
    attachmentIndexes: input.attachmentIndexes,
  })
  return previewOf(snapshotId, built)
}

/**
 * Before anything is filed: forwarding still available, the snapshot still
 * there, and the payload rebuilt from it and the submitted form equal to the
 * one the reporter saw. Otherwise a 409 carrying the new preview.
 */
async function approvedForward(
  orgId: string,
  userId: string,
  input: BugReportInput,
  reporterEmail: string,
): Promise<BuiltForward | null> {
  const forward = input.forward
  if (!forward) return null
  if (!(await isForwardingAvailable())) throw unavailable()
  const build = (snapshot: ForwardSnapshot) =>
    buildBugReportForward({
      form: input,
      snapshot,
      includeEmail: forward.includeEmail,
      reporterEmail,
      attachmentIndexes: forward.attachmentIndexes,
    })
  const changed = (preview: ForwardPreview) =>
    new BugReportForwardError(
      "The report changed since its preview: check the new preview and send again",
      409,
      "FORWARD_PAYLOAD_CHANGED",
      preview,
    )
  const snapshot = await readSnapshot(orgId, userId, forward.snapshotId)
  if (!snapshot) {
    const fresh = await newSnapshot(orgId, userId, input.clientLogs)
    throw changed(previewOf(fresh.snapshotId, build(fresh.snapshot)))
  }
  const built = build(snapshot)
  if (built.digest !== forward.digest) throw changed(previewOf(forward.snapshotId, built))
  return built
}

/** A refusal with the HTTP status the route answers it with. */
export class BugReportError extends Error {
  constructor(
    public status: 404 | 500,
    message: string,
  ) {
    super(message)
  }
}

/**
 * File one report as `userId`. The ticket is created privileged into the
 * configured bug inbox (most reporters hold no tickets scope), with the real
 * user as the actor of its audit event.
 */
export async function fileBugReport(
  orgId: string,
  userId: string,
  input: BugReportInput,
): Promise<BugReportFiled> {
  const reporter = await reporterOf(orgId, userId)
  if (!reporter) throw new BugReportError(404, "User not found")
  if (await isBugReportTeamOnlyFor(orgId)) return fileTeamOnly(orgId, userId, input, reporter)
  // The reporter was told nothing is filed here: a switch-off since files nothing either.
  if (input.forward?.teamOnly === true) throw unavailable()
  // Checked before the ticket exists: a refused forward files nothing (S5.4).
  const forward = await approvedForward(orgId, userId, input, reporter.email)

  const firstLine = input.description.split("\n")[0].trim()
  const subject = `Bug report: ${firstLine.slice(0, 120)}${firstLine.length > 120 ? "…" : ""}`
  const body = buildReportBody(input, reporter, await serverErrorsFor(orgId))

  // Bug reporting is open to EVERY authenticated member — most reporters hold no
  // tickets scopes, so the create runs privileged (same posture as the public
  // tickets webhook). The actor stays the real user for the audit event.
  const create = (sourceInboxId: string | undefined) =>
    withPrivilegedDb(orgId, "bug-report-create", async (tx) =>
      createTicket(
        tx,
        orgId,
        {
          subject,
          channel: "web_form",
          sourceInboxId,
          contactEmail: reporter.email,
          contactName: reporter.name,
          initialMessage: {
            kind: "inbound",
            fromEmail: reporter.email,
            fromName: reporter.name,
            subject,
            textBody: body,
          },
        },
        { actorType: "user", userId },
        { privilegedTx: tx },
      ),
    )

  let result = await create(env.BUG_REPORT_INBOX_ID || undefined)
  if ("error" in result && env.BUG_REPORT_INBOX_ID) {
    // A misconfigured/archived bug inbox must never eat the report — retry into
    // the org's default inbox and flag the config problem in the log.
    log.warn(
      { code: result.error.code, inboxId: env.BUG_REPORT_INBOX_ID },
      "bug report inbox rejected, falling back to default inbox",
    )
    result = await create(undefined)
  }
  if ("error" in result) {
    log.error({ err: result.error, userId }, "bug report ticket create failed")
    throw new BugReportError(500, "Unable to file bug report")
  }

  // Persist reporter attachments onto the ticket's initial message — the same
  // path (and caps) inbound email attachments take, so they render in the
  // ticket UI with zero extra wiring. A failed attachment must never lose the
  // filed report: failures are skipped and reported back, not thrown.
  let attachmentsPersisted = 0
  const attachmentsSkipped: Array<{ filename: string; reason: string }> = []
  // The stored file of each request index, for the forwarded attachment rows.
  const storedFileIds = new Map<number, string>()
  const requested = input.attachments ?? []
  if (requested.length > 0 && result.initialMessageId) {
    const messageId = result.initialMessageId
    const allowedIndexes: number[] = []
    const allowed = requested.filter((att, index) => {
      if (isBlockedFileType(att.filename, att.mimeType)) {
        attachmentsSkipped.push({ filename: att.filename, reason: "blocked file type" })
        return false
      }
      allowedIndexes.push(index)
      return true
    })
    if (allowed.length > 0) {
      try {
        const report = await withPrivilegedDb(orgId, "bug-report-attachments", (tx) =>
          // persistInboundAttachments only touches ctx.db.execute + ctx.orgId;
          // the privileged tx satisfies that surface (same cast the tickets
          // import CLI uses).
          persistInboundAttachments(
            { db: tx as never, orgId },
            {
              messageId,
              attachments: allowed.map((att) => ({
                filename: att.filename,
                mimeType: att.mimeType,
                bytesBase64: att.bytesBase64,
                disposition: "attachment" as const,
              })),
              uploadedBy: userId,
            },
          ),
        )
        attachmentsPersisted = report.persisted
        attachmentsSkipped.push(...report.skipped)
        for (const file of report.files) {
          const index = allowedIndexes[file.index]
          if (index !== undefined) storedFileIds.set(index, file.fileId)
        }
      } catch (err) {
        log.error({ err, ticketId: result.ticketId }, "bug report attachment persist failed")
        for (const att of allowed) {
          attachmentsSkipped.push({ filename: att.filename, reason: "storage failure" })
        }
      }
    }
    if (attachmentsSkipped.length > 0) {
      log.warn(
        { ticketId: result.ticketId, skipped: attachmentsSkipped },
        "bug report attachments skipped",
      )
    }
  }

  log.info({ ticketId: result.ticketId, userId, attachmentsPersisted }, "bug report filed")

  // The local report is filed whatever happens next: forwarding is queued in
  // the outbox and never fails the request.
  let forwarded: BugReportFiled["forwarded"]
  if (forward) {
    const files: StoredForwardFile[] = []
    for (const chosen of forward.chosen) {
      const fileId = storedFileIds.get(chosen.index)
      if (fileId) files.push({ ...chosen, fileId })
      else {
        log.warn(
          { ticketId: result.ticketId, index: chosen.index },
          "ticked attachment was not stored on the local report: not forwarded",
        )
      }
    }
    try {
      forwarded = (await enqueueBugReportForward(forward.data, files)).status
    } catch (err) {
      log.error({ err, ticketId: result.ticketId }, "bug report forward could not be queued")
      forwarded = "failed"
    }
  }

  return {
    ticketId: result.ticketId,
    ticketHandle: result.ticketHandle,
    attachmentsPersisted,
    attachmentsSkipped,
    ...(forwarded ? { forwarded } : {}),
  }
}

/**
 * Team-only: the report goes only to the Liaison team, as previewed. Nothing is
 * filed locally. The ticked files are staged for the outbox (no user can read
 * them) and deleted with the rows; a refused queue deletes them at once.
 */
async function fileTeamOnly(
  orgId: string,
  userId: string,
  input: BugReportInput,
  reporter: { email: string; name: string },
): Promise<BugReportFiled> {
  if (!input.forward) {
    throw new BugReportForwardError(
      "Bug reports on this server go only to the Liaison team: preview the report, then send it",
      409,
      "FORWARD_REQUIRED",
    )
  }
  const forward = await approvedForward(orgId, userId, input, reporter.email)
  if (!forward) throw unavailable()
  const ticked = new Set(forward.chosen.map((c) => c.index))
  const attachmentsSkipped = (input.attachments ?? [])
    .filter((_, index) => !ticked.has(index))
    .map((att) => ({ filename: att.filename, reason: "not ticked for the Liaison team" }))
  const stageId = randomUUID()
  try {
    const ids = await stageForwardFiles(
      orgId,
      stageId,
      forward.chosen.map((c) => ({
        index: c.index,
        filename: c.filename,
        mimeType: c.mimeType,
        bytes: Buffer.from(input.attachments?.[c.index]?.bytesBase64 ?? "", "base64"),
      })),
    )
    const files: StoredForwardFile[] = []
    for (const chosen of forward.chosen) {
      const fileId = ids.get(chosen.index)
      if (fileId) files.push({ ...chosen, fileId })
    }
    const queued = await enqueueBugReportForward(forward.data, files, new Date(), {
      teamOnly: { orgId },
    })
    if (queued.status === "unavailable") throw unavailable()
    log.info(
      { userId, messageId: queued.messageId, attachments: files.length },
      "bug report sent only to the Liaison team",
    )
    return {
      attachmentsPersisted: files.length,
      attachmentsSkipped,
      forwarded: "queued",
      teamOnly: true,
      messageId: queued.messageId,
    }
  } catch (err) {
    await deleteStagedFiles(orgId, stageId)
    if (err instanceof BugReportForwardError) throw err
    log.error({ err, userId }, "team-only bug report could not be queued")
    throw new BugReportError(500, "Unable to send the bug report to the Liaison team")
  }
}

/**
 * Whether the turn that held this approval had a person behind it, as recorded
 * on the row when it was held (`metadata.originHasPerson`, execute-tool.ts). A
 * row without the field (held before it existed) counts as having one: a
 * routine's is told apart by `metadata.originRoutineId`, which the caller reads.
 */
export async function approvalOriginHadPerson(
  orgId: string,
  approvalRequestId: string,
): Promise<boolean> {
  const [row] = await withPrivilegedDb(orgId, "report-bug-origin", (tx) =>
    tx
      .select({ metadata: approvalRequests.metadata })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, approvalRequestId), eq(approvalRequests.orgId, orgId))),
  )
  return (row?.metadata as { originHasPerson?: unknown } | null)?.originHasPerson !== false
}
