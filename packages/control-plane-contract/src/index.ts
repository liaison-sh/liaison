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

/**
 * Contract version, sent as the envelope's `v` and in the registration reply.
 * Version 2 adds the signed Control→cell API (`./c2c.ts`) and the router host
 * lookup; every version-1 message is still a valid version-2 message, so the
 * schemas accept any of `SUPPORTED_CONTRACT_VERSIONS`.
 */
export const CONTRACT_VERSION = 2 as const

/**
 * Envelope `v` an instance stamps on the instance→control messages that exist in
 * version 1 (register, heartbeat, bug reports, leads, deregister). A control plane
 * that predates version 2 rejects any other value, so these stay at 1 until every
 * control plane accepts 2; only message types introduced in version 2 carry 2.
 */
export const INSTANCE_ENVELOPE_VERSION = 1 as const

/**
 * Instance→control message types introduced in version 2: their envelope `v`
 * is 2 (a control plane that predates them refuses the type either way).
 */
export const INSTANCE_V2_MESSAGE_TYPES: ReadonlySet<string> = new Set(["performance"])

/** Versions a receiver accepts in an envelope's `v` and a registration reply's `contract`. */
export const SUPPORTED_CONTRACT_VERSIONS = [1, CONTRACT_VERSION] as const

export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number]

const contractVersionSchema = z.union([z.literal(1), z.literal(CONTRACT_VERSION)])

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
  performance: "performance",
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

// ── Performance (app-run health, aggregate only) ─────────────────────────────

/** An app name as reported: a catalog app's own name, or `(custom)` for an org's custom app. */
const perfAppSchema = z.string().regex(/^(?:[a-z0-9][a-z0-9_-]{0,62}|\(custom\)|\(other\))$/)
const perfKindSchema = z.string().regex(/^[a-z0-9_]{1,40}$/)
const msSchema = z.number().int().nonnegative().max(86_400_000)
const countSchema = z.number().int().nonnegative()
const rateSchema = z.number().min(0).max(1)
export const PERFORMANCE_LANES = ["interactive", "background", "nested"] as const
const laneSchema = z.enum(PERFORMANCE_LANES)

/** One (app, lane) series, a lane or the total, over one window. */
export const performanceSummarySchema = z
  .object({
    runs: countSchema,
    errors: countSchema,
    timeouts: countSchema,
    errorRate: rateSchema,
    timeoutRate: rateSchema,
    /** Failures per error kind (`timeout`, `queue_timeout`, `handler`, ...). */
    errorKinds: z.record(perfKindSchema, countSchema),
    p50Ms: msSchema.nullable(),
    p95Ms: msSchema.nullable(),
    p99Ms: msSchema.nullable(),
    meanMs: msSchema.nullable(),
    queuedRuns: countSchema,
    queueP95Ms: msSchema.nullable(),
    bridgeShare: rateSchema.nullable(),
    bridgeCalls: countSchema,
  })
  .strict()

export const performanceWindowSchema = z
  .object({
    windowS: z.union([z.literal(900), z.literal(86_400)]),
    total: performanceSummarySchema,
    lanes: z
      .object({
        interactive: performanceSummarySchema,
        background: performanceSummarySchema,
        nested: performanceSummarySchema,
      })
      .strict(),
    apps: z
      .array(performanceSummarySchema.extend({ app: perfAppSchema, lane: laneSchema }).strict())
      .max(50),
    /** The slowest runs: app, entry kind (`tool`, `job`, ...), lane, time. Never the entry's arguments. */
    slowest: z
      .array(
        z
          .object({
            app: perfAppSchema,
            entryKind: perfKindSchema,
            lane: laneSchema,
            ms: msSchema,
            queueMs: msSchema.optional(),
            ok: z.boolean(),
            errorKind: perfKindSchema.optional(),
          })
          .strict(),
      )
      .max(10),
    /** Per sandbox pool: seconds saturated (summed over processes) and mean occupancy. */
    pools: z.record(
      perfKindSchema,
      z.object({ saturatedSec: countSchema, occupancy: rateSchema.nullable() }).strict(),
    ),
  })
  .strict()

/**
 * The `performance` data: app-run health as numbers per catalog app name and
 * lane, nothing else. No org, user, content, entry argument or custom app
 * name: an org's custom app is reported as `(custom)`. Sent hourly by a
 * server that opted in (self-hosted) and by every managed cell.
 */
export const performanceDataSchema = z
  .object({
    version: versionSchema,
    edition: editionSchema,
    windows: z.object({ "15m": performanceWindowSchema, "24h": performanceWindowSchema }).strict(),
    /** The app-run checks failing when it was built (no subjects). */
    alerts: z
      .array(
        z
          .object({
            check: perfKindSchema,
            severity: z.enum(["warning", "critical"]),
            value: z.number().nonnegative(),
            threshold: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()

/** The `data` schema of each message type. */
export const messageDataSchemas = {
  register: registerDataSchema,
  heartbeat: heartbeatDataSchema,
  "bug-report": bugReportForwardSchema,
  "bug-report-attachment": bugReportAttachmentDataSchema,
  lead: leadDataSchema,
  "lead-update": leadUpdateDataSchema,
  deregister: deregisterDataSchema,
  performance: performanceDataSchema,
} as const satisfies Record<MessageType, z.ZodType>

export type MessageData<T extends MessageType> = z.infer<(typeof messageDataSchemas)[T]>

// ── Envelope ─────────────────────────────────────────────────────────────────

/** `{v, type, messageId, instanceId, ts, data}`, strict, for one message type. */
export function envelopeSchema<T extends MessageType, D extends z.ZodType>(type: T, data: D) {
  return z
    .object({
      v: contractVersionSchema,
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
  performance: envelopeSchema("performance", performanceDataSchema),
} as const satisfies Record<MessageType, z.ZodType>

export type Message<T extends MessageType = MessageType> = {
  [K in MessageType]: z.infer<(typeof messageSchemas)[K]>
}[T]

// ── Replies (the object under the kernel's `{data: ...}` success envelope) ──

export const registeredReply = z
  .object({
    type: z.literal("registered"),
    instanceKey: z.string().regex(HEX_64),
    contract: contractVersionSchema,
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

export * from "./c2c"
export * from "./money"
export * from "./moves"
export { contractVectors, moneyVectors } from "./vectors"
