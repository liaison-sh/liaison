// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Virus scanning of inbound attachments through a clamd daemon over TCP
// (`CLAMAV_HOST`, `host` or `host:port`, port 3310 by default). Unset: nothing
// is scanned and nothing changes. Set: each inbound attachment is streamed to
// clamd (INSTREAM) before it is stored; one clamd reports infected is not stored
// where people open it. Its bytes go to a quarantine key in object storage for
// the operator, and the message carries a short text file in its place saying
// what was removed and why.
//
// A scan that cannot complete (clamd down, a timeout, a clamd error) stores the
// attachment as before and logs an error: mail is never lost to a scanner outage.
// When clamd cannot be reached at all (refused, unresolvable, timed out) that is
// an outage, raised as the `clamav_unavailable` security signal: counted on
// /diag on every failure, and an alert to the org's admins at most once an hour
// per org and process. A clamd that answers with an error is reachable, so no
// outage (it is still logged).

import { connect } from "node:net"
import { rootLogger } from "~/lib/logger"
import { emitSecurityEvent } from "~/modules/security/security-events"

const log = rootLogger.child({ module: "clamav" })

const DEFAULT_PORT = 3310
const CHUNK_BYTES = 64 * 1024
const SCAN_TIMEOUT_MS = 30_000
/** The outage alert reaches an org's admins at most this often (per process). */
const OUTAGE_ALERT_EVERY_MS = 60 * 60 * 1000

export type ScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "not_scanned"; reason: string; unreachable?: true }

/** The clamd address from `CLAMAV_HOST`, or null when scanning is off. */
export function clamavTarget(): { host: string; port: number } | null {
  const raw = (process.env.CLAMAV_HOST ?? "").trim()
  if (!raw) return null
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : DEFAULT_PORT }
  const m = /^([^:]+)(?::(\d+))?$/.exec(raw)
  if (!m) return { host: raw, port: DEFAULT_PORT }
  return { host: m[1], port: m[2] ? Number(m[2]) : DEFAULT_PORT }
}

/** Parse one clamd INSTREAM reply (`stream: OK`, `stream: <sig> FOUND`, `... ERROR`). */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0+$/, "").trim()
  if (/:\s*OK$/.test(text)) return { status: "clean" }
  const found = /:\s*(.+)\s+FOUND$/.exec(text)
  if (found) return { status: "infected", signature: found[1].trim() }
  return { status: "not_scanned", reason: text || "empty reply" }
}

/** Stream these bytes to clamd and answer its verdict. */
export async function scanBytes(bytes: Uint8Array): Promise<ScanResult> {
  const target = clamavTarget()
  if (!target) return { status: "not_scanned", reason: "scanning is off" }
  return new Promise<ScanResult>((resolve) => {
    let settled = false
    let reply = ""
    const done = (r: ScanResult) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(r)
    }
    const socket = connect({ host: target.host, port: target.port })
    socket.setTimeout(SCAN_TIMEOUT_MS, () =>
      done({ status: "not_scanned", reason: "timeout", unreachable: true }),
    )
    socket.on("error", (err) =>
      done({ status: "not_scanned", reason: err.message, unreachable: true }),
    )
    socket.on("data", (chunk) => {
      reply += chunk.toString("utf8")
      if (reply.includes("\0")) done(parseClamdReply(reply))
    })
    socket.on("end", () => done(parseClamdReply(reply)))
    socket.on("connect", () => {
      socket.write("zINSTREAM\0")
      for (let off = 0; off < bytes.byteLength; off += CHUNK_BYTES) {
        const part = bytes.subarray(off, Math.min(off + CHUNK_BYTES, bytes.byteLength))
        const len = Buffer.alloc(4)
        len.writeUInt32BE(part.byteLength, 0)
        socket.write(len)
        socket.write(part)
      }
      socket.write(Buffer.alloc(4))
    })
  })
}

export interface InboundAttachment {
  filename: string
  mimeType: string
  bytes: Uint8Array
}

export type InboundScanOutcome =
  | { quarantined: false; attachment: InboundAttachment }
  | {
      quarantined: true
      signature: string
      /** The original, for the quarantine store. */
      original: InboundAttachment
      /** What the message carries instead. */
      attachment: InboundAttachment
    }

/**
 * Scan one inbound attachment. Clean, unscanned or scanning off: the attachment
 * unchanged. Infected: a short text notice in its place, and the original for
 * the caller to keep under a quarantine key.
 */
export async function scanInboundAttachment(
  att: InboundAttachment,
  context: { orgId: string; where: string },
): Promise<InboundScanOutcome> {
  if (!clamavTarget()) return { quarantined: false, attachment: att }
  const result = await scanBytes(att.bytes)
  if (result.status === "clean") return { quarantined: false, attachment: att }
  if (result.status === "not_scanned") {
    log.error(
      {
        orgId: context.orgId,
        where: context.where,
        reason: result.reason,
        size: att.bytes.byteLength,
      },
      "inbound attachment could not be scanned; stored unscanned",
    )
    if (result.unreachable) {
      await emitSecurityEvent({
        kind: "clamav_unavailable",
        orgId: context.orgId,
        orgAlertEveryMs: OUTAGE_ALERT_EVERY_MS,
        detail: { where: context.where, reason: result.reason },
      })
    }
    return { quarantined: false, attachment: att }
  }
  const notice = [
    `The attachment "${att.filename}" was removed by Liaison's virus scanner.`,
    `Detected: ${result.signature}`,
    "It was kept aside where only your administrator can reach it. Do not ask the sender to resend it unless you expected this file.",
    "",
  ].join("\n")
  return {
    quarantined: true,
    signature: result.signature,
    original: att,
    attachment: {
      filename: `${att.filename}.quarantined.txt`,
      mimeType: "text/plain",
      bytes: Buffer.from(notice, "utf8"),
    },
  }
}

/** The object-storage key an infected original is kept under. Never parented to a record. */
export function quarantineStorageKey(orgId: string, fileId: string, safeName: string): string {
  return `orgs/${orgId}/quarantine/${fileId}/${safeName}`
}
