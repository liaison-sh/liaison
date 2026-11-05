// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `bug-report` message a reporter may forward to the Liaison team, built
// from their form and the frozen forward snapshot (snapshot.ts). The result is
// exactly what the preview shows and what is queued: the version and edition,
// the description (the instance host replaced by `<instance>`), the page path
// with its query keys only, the user agent, the scrubbed logs, the server error
// signatures (operator org only), the ticked attachments' metadata, and the
// reporter's email only with the second tick. Never the reporter's name, ids,
// the local ticket, unticked files or any file bytes
// (docs/self-hosting/liaison-team.md lists every field).
//
// The envelope stays under 256 KiB: the oldest log lines are dropped first and
// `logsTruncated` says so. Files over MAX_FORWARD_ATTACHMENT_BYTES (or of a
// blocked type) can be listed but not ticked.

import { createHash } from "node:crypto"
import {
  bugReportForwardSchema,
  CONTRACT_VERSION,
  MAX_BUG_REPORT_ENVELOPE_BYTES,
  MAX_FORWARD_ATTACHMENT_BYTES,
  type MessageData,
} from "@liaison/control-plane-contract"
import { digest } from "@liaison/control-plane-contract/node"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { edition } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { scrubText } from "~/lib/scrub"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { isBlockedFileType } from "~/modules/files/attach"
import { lockLiaisonTeam, readIdentity } from "./identity"
import { enqueue, liaisonTeamEndpoint } from "./outbox"
import { readSharing } from "./settings"
import type { ForwardSnapshot } from "./snapshot"

export type BugReportForwardData = MessageData<"bug-report">

const MAX_DESCRIPTION_CHARS = 40_000
const MAX_PAGE_CHARS = 2_048
const MAX_USER_AGENT_CHARS = 1_024
const MAX_LOG_LINE_CHARS = 4_000
const MAX_LOG_LINES = 400
const MAX_SERVER_ERROR_CHARS = 2_000
const MAX_SERVER_ERRORS = 15
const HOST_PLACEHOLDER = "<instance>"

/** A refused forward, answered with its status and code (and a fresh preview for a 409). */
export class BugReportForwardError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly code:
      | "FORWARDING_UNAVAILABLE"
      | "FORWARD_PAYLOAD_CHANGED"
      | "ATTACHMENT_NOT_FORWARDABLE"
      | "FORWARD_TOO_LARGE"
      | "FORWARD_REQUIRED",
    details?: unknown,
  ) {
    super(message)
    this.name = "BugReportForwardError"
    // The preview in `details` can hold the reporter's email: the error handler
    // still reads it for the response, but it is not enumerable, so the logger's
    // error serializer never writes it to the server log.
    Object.defineProperty(this, "details", { value: details, enumerable: false })
  }
  declare readonly details?: unknown
}

export interface ForwardForm {
  description: string
  context?: { url?: string; userAgent?: string }
  attachments?: Array<{ filename: string; mimeType: string; bytesBase64: string }>
}

/** One attachment of the local report, as the preview lists it. */
export interface PreviewAttachment {
  index: number
  filename: string
  mimeType: string
  sizeBytes: number
  /** Over MAX_FORWARD_ATTACHMENT_BYTES: stays on the local report only. */
  tooLarge: boolean
  /** A file type the local report refuses too. */
  blocked: boolean
}

export interface ChosenAttachment {
  index: number
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

export interface BuiltForward {
  data: BugReportForwardData
  attachments: PreviewAttachment[]
  chosen: ChosenAttachment[]
  digest: string
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Replace this server's host (from BASE_URL) by `<instance>`, case-insensitively. */
function hostReplacer(): (text: string) => string {
  let hosts: string[] = []
  try {
    const url = new URL(env.BASE_URL)
    hosts = [...new Set([url.host, url.hostname])].filter((h) => h.length > 0)
  } catch {
    hosts = []
  }
  if (hosts.length === 0) return (t) => t
  // Longest first, so `host:port` is replaced whole before the bare hostname.
  const re = new RegExp(
    hosts
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "gi",
  )
  return (text) => text.replace(re, HOST_PLACEHOLDER)
}

/** The path plus the query keys only: values, origin and fragment removed. */
export function pageOf(url: string | undefined): string {
  if (!url) return ""
  let u: URL
  try {
    u = new URL(url, "http://page.invalid")
  } catch {
    return ""
  }
  const keys = [...new Set(u.searchParams.keys())]
  return `${u.pathname}${keys.length > 0 ? `?${keys.join("&")}` : ""}`
}

function decode(bytesBase64: string): Buffer {
  return Buffer.from(bytesBase64, "base64")
}

/** Every attachment of the form, as the preview lists it. */
export function listAttachments(form: ForwardForm): PreviewAttachment[] {
  return (form.attachments ?? []).map((att, index) => {
    const sizeBytes = decode(att.bytesBase64).byteLength
    return {
      index,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes,
      tooLarge: sizeBytes > MAX_FORWARD_ATTACHMENT_BYTES,
      blocked: isBlockedFileType(att.filename, att.mimeType),
    }
  })
}

/**
 * The `bug-report` data for this form and snapshot, the attachment list and
 * the digest the submit must match. Throws a 400 for an index that cannot be
 * forwarded, or when the report does not fit even without any log line.
 */
export function buildBugReportForward(args: {
  form: ForwardForm
  snapshot: ForwardSnapshot
  includeEmail: boolean
  reporterEmail: string
  attachmentIndexes: number[]
}): BuiltForward {
  const replaceHost = hostReplacer()
  const attachments = listAttachments(args.form)
  const indexes = [...new Set(args.attachmentIndexes)].sort((a, b) => a - b)
  const chosen: ChosenAttachment[] = []
  for (const index of indexes) {
    const listed = attachments[index]
    if (!listed || listed.tooLarge || listed.blocked) {
      throw new BugReportForwardError(
        listed?.tooLarge
          ? `Attachment ${index} is too large to send to the Liaison team`
          : `Attachment ${index} cannot be sent to the Liaison team`,
        400,
        "ATTACHMENT_NOT_FORWARDABLE",
      )
    }
    const bytes = decode(args.form.attachments?.[index]?.bytesBase64 ?? "")
    chosen.push({
      index,
      filename: listed.filename,
      mimeType: listed.mimeType,
      sizeBytes: listed.sizeBytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }

  const logs = args.snapshot.clientLogs
    .slice(-MAX_LOG_LINES)
    .map((line) => replaceHost(scrubText(line)).slice(0, MAX_LOG_LINE_CHARS))
  const serverErrors = args.snapshot.serverErrors?.slice(0, MAX_SERVER_ERRORS).map((s) => ({
    signature: replaceHost(scrubText(s.signature)).slice(0, MAX_SERVER_ERROR_CHARS),
    count1h: s.count1h,
  }))

  const report = {
    description: replaceHost(args.form.description).slice(0, MAX_DESCRIPTION_CHARS),
    page: replaceHost(scrubText(pageOf(args.form.context?.url))).slice(0, MAX_PAGE_CHARS),
    userAgent: replaceHost(args.form.context?.userAgent ?? "").slice(0, MAX_USER_AGENT_CHARS),
    logs,
    logsTruncated: args.snapshot.clientLogs.length > logs.length,
    ...(serverErrors ? { serverErrors } : {}),
    attachments: chosen,
  }
  const data: BugReportForwardData = {
    version: env.LIAISON_VERSION,
    edition: edition(),
    report,
    ...(args.includeEmail ? { reporter: { email: args.reporterEmail } } : {}),
  }
  fitEnvelope(data)
  const parsed = bugReportForwardSchema.parse(data)
  return { data: parsed, attachments, chosen, digest: digest(parsed) }
}

/** Bytes of the serialized envelope around `data` (ids and timestamp at their fixed widths). */
function envelopeBytes(data: BugReportForwardData): number {
  return Buffer.byteLength(
    JSON.stringify({
      v: CONTRACT_VERSION,
      type: "bug-report",
      messageId: "00000000-0000-4000-8000-000000000000",
      instanceId: "00000000-0000-4000-8000-000000000000",
      ts: "2000-01-01T00:00:00.000Z",
      data,
    }),
  )
}

/** Drop the oldest log lines until the envelope fits (in place). */
function fitEnvelope(data: BugReportForwardData): void {
  const report = data.report
  let size = envelopeBytes(data)
  if (size <= MAX_BUG_REPORT_ENVELOPE_BYTES) return
  // Each line costs its JSON encoding plus a comma; subtract from the oldest.
  const costs = report.logs.map((l) => Buffer.byteLength(JSON.stringify(l)) + 1)
  let drop = 0
  while (drop < costs.length && size > MAX_BUG_REPORT_ENVELOPE_BYTES) {
    size -= costs[drop] ?? 0
    drop++
  }
  report.logs = report.logs.slice(drop)
  report.logsTruncated = true
  while (report.logs.length > 0 && envelopeBytes(data) > MAX_BUG_REPORT_ENVELOPE_BYTES) {
    report.logs = report.logs.slice(1)
  }
  if (envelopeBytes(data) > MAX_BUG_REPORT_ENVELOPE_BYTES) {
    throw new BugReportForwardError(
      "This report is too large to send to the Liaison team, even without its logs",
      400,
      "FORWARD_TOO_LARGE",
    )
  }
}

type Db = Pick<PrivilegedDb, "execute" | "select" | "insert" | "delete">

/** Forwarding is on, the server is registered, and an endpoint is set. */
async function availableIn(db: Db): Promise<boolean> {
  if (!liaisonTeamEndpoint()) return false
  const sharing = await readSharing(db)
  if (!sharing.forwardBugReports) return false
  const identity = await readIdentity(db)
  return identity?.state === "registered"
}

export async function isForwardingAvailable(): Promise<boolean> {
  if (!liaisonTeamEndpoint()) return false
  return withSystemDb("liaison-team:forwarding-available", (tx) => availableIn(tx))
}

/** Forwarding is available and the operator sends bug reports only to the Liaison team. */
async function teamOnlyIn(db: Db): Promise<boolean> {
  if (!(await availableIn(db))) return false
  return (await readSharing(db)).bugReportsTeamOnly
}

/**
 * Whether a report filed by a member of `orgId` goes only to the Liaison team,
 * with no local ticket. The switch is the operator's, so it applies to the
 * operator org's reporters only, on any instance (a self-host with several
 * orgs, demo, managed): every other org keeps its own local bug inbox.
 */
export async function isBugReportTeamOnlyFor(orgId: string): Promise<boolean> {
  if (!liaisonTeamEndpoint()) return false
  if (!(await isInstanceOperatorOrg(orgId))) return false
  return withSystemDb("liaison-team:team-only", (tx) => teamOnlyIn(tx))
}

/**
 * The local-only part of a team-only `bug-report` row (`data.local`): never
 * sent (outbox.ts strips it), read by the team-only sweep (team-only.ts) to
 * tell the org when the report could not be delivered.
 */
export interface TeamOnlyLocal {
  teamOnly: true
  orgId: string
  /** Set once the undelivered notice was raised. */
  noticedAt?: string
}

/** One ticked file as the local report stored it. */
export interface StoredForwardFile extends ChosenAttachment {
  fileId: string
}

export type EnqueueBugReportResult =
  | { status: "queued"; messageId: string }
  | { status: "unavailable" }

/**
 * Queue the report and one attachment row per stored file (each depending on
 * the report row), under the lock the switches take, re-checking availability
 * there: a switch-off that committed first wins and nothing is queued. A
 * team-only report (`teamOnly`) also needs the team-only switch still on.
 */
export async function enqueueBugReportForward(
  data: BugReportForwardData,
  files: StoredForwardFile[],
  now: Date = new Date(),
  opts: { teamOnly?: { orgId: string } } = {},
): Promise<EnqueueBugReportResult> {
  return withSystemDb("liaison-team:forward-bug-report", async (tx) => {
    await lockLiaisonTeam(tx)
    const ok = opts.teamOnly ? await teamOnlyIn(tx) : await availableIn(tx)
    if (!ok) return { status: "unavailable" as const }
    const local: TeamOnlyLocal | undefined = opts.teamOnly
      ? { teamOnly: true, orgId: opts.teamOnly.orgId }
      : undefined
    const report = await enqueue(tx, "bug-report", local ? { ...data, local } : data, { now })
    for (const file of files) {
      await enqueue(
        tx,
        "bug-report-attachment",
        {
          reportMessageId: report.messageId,
          index: file.index,
          fileId: file.fileId,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
        },
        { now, dependsOn: report.id },
      )
    }
    log.info(
      { messageId: report.messageId, attachments: files.length, teamOnly: local !== undefined },
      "Bug report queued for the Liaison team",
    )
    return { status: "queued" as const, messageId: report.messageId }
  })
}
