// SPDX-License-Identifier: FSL-1.1-ALv2
// The wire contract between a Liaison instance and the Liaison team's control
// plane: message envelopes, reply shapes, header names, endpoint names and the
// canonical JSON used for digests. Both sides import it, so a field renamed on
// one side breaks the other side's tests.
//
// No `node:*` import in this file or anything it imports: the control plane
// side bundles it into a sandboxed app. Node-only helpers (HMAC, sha256) live
// in `./node.ts` (`@liaison/control-plane-contract/node`).
import { z } from "zod"

/** Contract version, sent as the envelope's `v` and in the registration reply. */
export const CONTRACT_VERSION = 1 as const

/** Request header carrying the sender's instance id. */
export const INSTANCE_HEADER = "x-liaison-instance"
/** Request header carrying base64 HMAC-SHA256(instanceKey, raw body); absent on `register`. */
export const SIGNATURE_HEADER = "x-liaison-signature"

/**
 * Endpoint names. Each is both the last URL segment
 * (`<endpoint base>/<name>`) and the envelope `type` of the message sent there.
 * Hyphens only: app webhook names must match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
 */
export const ENDPOINTS = {
  register: "register",
  heartbeat: "heartbeat",
  bugReport: "bug-report",
  bugReportAttachment: "bug-report-attachment",
  lead: "lead",
  leadUpdate: "lead-update",
  deregister: "deregister",
} as const

export type MessageType = (typeof ENDPOINTS)[keyof typeof ENDPOINTS]

export const MESSAGE_TYPES: readonly MessageType[] = Object.values(ENDPOINTS)

/** The GitHub issues webhook endpoint (GitHub's own payload, no envelope). */
export const GITHUB_ENDPOINT = "github" as const

/** Largest file (raw bytes) an instance forwards; base64 plus envelope stays under 10 MiB. */
export const MAX_FORWARD_ATTACHMENT_BYTES = 7 * 1024 * 1024
/** Largest serialized `bug-report` envelope; the builder drops the oldest log lines to fit. */
export const MAX_BUG_REPORT_ENVELOPE_BYTES = 256 * 1024

/** `instanceKey = hex(HMAC-SHA256(masterSecret, INSTANCE_KEY_LABEL + instanceId))`. */
export const INSTANCE_KEY_LABEL = "liaison-instance-key:v1:"

/**
 * Bare codes a control plane handler answers as its 4xx body; the caller reads
 * them from `error.message` of the reply.
 */
export const REJECTION_CODES = {
  invalidMessage: "invalid_message",
  unknownInstance: "unknown_instance",
  alreadyRegistered: "already_registered",
  notADemoInstance: "not_a_demo_instance",
  unknownReport: "unknown_report",
} as const

export type RejectionCode = (typeof REJECTION_CODES)[keyof typeof REJECTION_CODES]

const REJECTION_CODE_VALUES = Object.values(REJECTION_CODES) as [RejectionCode, ...RejectionCode[]]

// ── Field schemas ────────────────────────────────────────────────────────────

const HEX_64 = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
/** 32 random bytes, base64url without padding. */
const NONCE = /^[A-Za-z0-9_-]{43}$/

const MAX_FORWARD_ATTACHMENT_B64_CHARS = Math.ceil(MAX_FORWARD_ATTACHMENT_BYTES / 3) * 4

export const editionSchema = z.enum(["self_hosted", "managed"])
const versionSchema = z.string().min(1).max(64)
const activeUsersSchema = z.number().int().nonnegative()
const sha256Schema = z.string().regex(HEX_64)
const filenameSchema = z.string().min(1).max(255)
const mimeTypeSchema = z.string().min(1).max(200)
const attachmentIndexSchema = z.number().int().min(0).max(4)
const sizeBytesSchema = z.number().int().positive().max(MAX_FORWARD_ATTACHMENT_BYTES)

// ── Message data, one schema per Protocol row ────────────────────────────────

export const registerDataSchema = z
  .object({
    version: versionSchema,
    edition: editionSchema,
    activeUsers: activeUsersSchema,
    nonce: z.string().regex(NONCE),
  })
  .strict()

export const heartbeatDataSchema = z
  .object({
    version: versionSchema,
    edition: editionSchema,
    activeUsers: activeUsersSchema,
  })
  .strict()

/** One forwarded attachment's metadata inside a `bug-report` (bytes travel separately). */
export const forwardAttachmentSchema = z
  .object({
    index: attachmentIndexSchema,
    filename: filenameSchema,
    mimeType: mimeTypeSchema,
    sizeBytes: sizeBytesSchema,
    sha256: sha256Schema,
  })
  .strict()

/**
 * The `bug-report` data: exactly the fields the reporter sees in the preview.
 * `reporter` is present only when the reporter ticked "include my email";
 * `serverErrors` only when the reporter's org is the operator org.
 */
export const bugReportForwardSchema = z
  .object({
    version: versionSchema,
    edition: editionSchema,
    report: z
      .object({
        description: z.string().min(1).max(40_000),
        page: z.string().max(2_048),
        userAgent: z.string().max(1_024),
        logs: z.array(z.string().max(4_000)).max(400),
        logsTruncated: z.boolean(),
        serverErrors: z
          .array(
            z
              .object({
                signature: z.string().max(2_000),
                count1h: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .max(50)
          .optional(),
        attachments: z.array(forwardAttachmentSchema).max(5),
      })
      .strict(),
    reporter: z.object({ email: z.email() }).strict().optional(),
  })
  .strict()

export const bugReportAttachmentDataSchema = z
  .object({
    reportMessageId: z.uuid(),
    index: attachmentIndexSchema,
    filename: filenameSchema,
    mimeType: mimeTypeSchema,
    sizeBytes: sizeBytesSchema,
    sha256: sha256Schema,
    bytesBase64: z.string().min(1).max(MAX_FORWARD_ATTACHMENT_B64_CHARS).regex(BASE64),
  })
  .strict()

export const leadDataSchema = z
  .object({
    leadId: z.uuid(),
    email: z.email(),
    name: z.string().min(1).max(200),
    needs: z.array(z.string().min(1).max(100)).max(20),
    verified: z.boolean(),
    notifyManaged: z.boolean(),
    noticeVersion: z.string().min(1).max(64),
    signedUpAt: z.iso.datetime(),
  })
  .strict()

export const leadUpdateDataSchema = z
  .object({
    leadId: z.uuid(),
    verified: z.boolean().optional(),
    notifyManaged: z.boolean().optional(),
    optedOut: z.boolean().optional(),
    scenarios: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 1, { message: "lead-update carries no change" })

export const deregisterDataSchema = z.object({}).strict()

/** The `data` schema of each message type. */
export const messageDataSchemas = {
  register: registerDataSchema,
  heartbeat: heartbeatDataSchema,
  "bug-report": bugReportForwardSchema,
  "bug-report-attachment": bugReportAttachmentDataSchema,
  lead: leadDataSchema,
  "lead-update": leadUpdateDataSchema,
  deregister: deregisterDataSchema,
} as const satisfies Record<MessageType, z.ZodType>

export type MessageData<T extends MessageType> = z.infer<(typeof messageDataSchemas)[T]>

// ── Envelope ─────────────────────────────────────────────────────────────────

/** `{v, type, messageId, instanceId, ts, data}`, strict, for one message type. */
export function envelopeSchema<T extends MessageType, D extends z.ZodType>(type: T, data: D) {
  return z
    .object({
      v: z.literal(CONTRACT_VERSION),
      type: z.literal(type),
      messageId: z.uuid(),
      instanceId: z.uuid(),
      ts: z.iso.datetime(),
      data,
    })
    .strict()
}

/** Envelope schema per message type. */
export const messageSchemas = {
  register: envelopeSchema("register", registerDataSchema),
  heartbeat: envelopeSchema("heartbeat", heartbeatDataSchema),
  "bug-report": envelopeSchema("bug-report", bugReportForwardSchema),
  "bug-report-attachment": envelopeSchema("bug-report-attachment", bugReportAttachmentDataSchema),
  lead: envelopeSchema("lead", leadDataSchema),
  "lead-update": envelopeSchema("lead-update", leadUpdateDataSchema),
  deregister: envelopeSchema("deregister", deregisterDataSchema),
} as const satisfies Record<MessageType, z.ZodType>

export type Message<T extends MessageType = MessageType> = {
  [K in MessageType]: z.infer<(typeof messageSchemas)[K]>
}[T]

// ── Replies (the object under the kernel's `{data: ...}` success envelope) ──

export const registeredReply = z
  .object({
    type: z.literal("registered"),
    instanceKey: z.string().regex(HEX_64),
    contract: z.literal(CONTRACT_VERSION),
  })
  .strict()

export const ackReply = z.object({ type: z.literal("ack"), messageId: z.uuid() }).strict()

/** What the kernel answers itself for a replayed (already accepted) request. */
export const duplicateReply = z
  .object({ received: z.literal(true), duplicate: z.literal(true) })
  .strict()

/** A handler that cannot act now (not configured, tool unavailable, over quota). */
export const retryLaterReplySchema = z
  .object({
    type: z.literal("retry_later"),
    reason: z.string().min(1).max(200),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  .strict()

/** A 4xx body carrying a rejection code (the kernel's error envelope). */
export const rejectionReplySchema = z.object({
  error: z.object({ message: z.enum(REJECTION_CODE_VALUES) }),
})

/** Wraps a reply schema in the kernel's success envelope `{data: <reply>}`. */
export function dataReply<S extends z.ZodType>(reply: S) {
  return z.object({ data: reply })
}

export type RegisteredReply = z.infer<typeof registeredReply>
export type AckReply = z.infer<typeof ackReply>
export type RetryLaterReply = z.infer<typeof retryLaterReplySchema>
export type RejectionReply = z.infer<typeof rejectionReplySchema>

// ── Billing state (managed edition, `GET <CONTROL_PLANE_URL>/v1/orgs/:orgId/billing-state`) ──

export const billingStateReplySchema = z.object({
  tier: z.string(),
  status: z.string(),
  billingPortalUrl: z.string(),
  checkoutUrl: z.string(),
  includedCredits: z.string(),
  periodEnd: z.string(),
})

export type BillingStateReply = z.infer<typeof billingStateReplySchema>

// ── Canonical JSON ───────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted (recursively) and no whitespace. Undefined
 * object members are dropped and array order is kept, as `JSON.stringify` does.
 * Digests are taken over this form so key order never changes a digest.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null"
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export { contractVectors } from "./vectors"
