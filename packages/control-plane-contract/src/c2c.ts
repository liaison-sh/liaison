// SPDX-License-Identifier: FSL-1.1-ALv2
// Contract version 2: the signed Control→cell API (`/api/cloud/*`) and the
// router's signed host lookup to Control. This file holds the pure parts
// (header names, canonical strings, timestamp windows, header parsing, body
// and reply schemas); the HMAC itself lives in `./node.ts` (node:crypto) and
// `./web.ts` (Web Crypto). A runtime with neither reproduces the same bytes
// with its own HMAC, proven on `vectors/c2c.json` and `vectors/router-lookup.json`.
//
// No `node:*` import and no import of `./index` (it re-exports this file).
import { z } from "zod"

/**
 * The per-org caps: kind → largest value (every cap is a whole number of at
 * least 1; null or absent = unlimited). The ONE bounds table: the contract's
 * `cloudCapsSchema` and the cell's `orgCapsSchema` (`@liaison/shared`, which
 * re-exports this table) are both built from it, and Control reads it through
 * this package, so a bound cannot drift between the three. Key order is the
 * order the kinds are listed in.
 *  - `mailboxes`: org-owned mailboxes in the managed edition (the usage block
 *    of `billing.change_plan` calls the same count `sharedMailboxes`);
 *  - `customApps`: org-private custom apps installed;
 *  - `auditDays`: the most days of audit log the org keeps.
 */
export const CLOUD_CAP_BOUNDS = {
  seats: 1_000_000,
  mailboxes: 1_000_000,
  storageGb: 1_000_000,
  jobsPerHour: 100_000_000,
  customApps: 10_000,
  auditDays: 3650,
} as const

export type CloudCapKind = keyof typeof CLOUD_CAP_BOUNDS

/** The cap kinds, in the order the table lists them. */
export const CLOUD_CAP_KINDS = Object.keys(CLOUD_CAP_BOUNDS) as readonly CloudCapKind[]

const capValue = (max: number) => z.number().int().min(1).max(max).nullable().optional()
type CapValueSchema = ReturnType<typeof capValue>

/**
 * Plan caps, exactly the cell's `organizations.caps` kinds (the cell refuses any
 * other key), bounds from `CLOUD_CAP_BOUNDS`.
 */
export const cloudCapsSchema = z.strictObject(
  Object.fromEntries(CLOUD_CAP_KINDS.map((k) => [k, capValue(CLOUD_CAP_BOUNDS[k])])) as {
    [K in CloudCapKind]: CapValueSchema
  },
)

export type CloudCaps = z.infer<typeof cloudCapsSchema>

// ── Control→cell key ─────────────────────────────────────────────────────────

/**
 * `controlKey = hex(HMAC-SHA256(instanceKey, CONTROL_TO_CELL_KEY_LABEL))`, keyed by
 * the instance key's 64-hex string as UTF-8 (as `signBody` is). The result is
 * 64 lowercase hex chars and is itself used as an HMAC key the same way: its
 * hex string as UTF-8.
 */
export const CONTROL_TO_CELL_KEY_LABEL = "liaison-control-to-cell:v1"

// ── Control→cell request signing ─────────────────────────────────────────────

/** Path prefix of every Control→cell endpoint on a cell. */
export const CLOUD_API_BASE = "/api/cloud"

/** base64 HMAC-SHA256(controlKey, canonical string). */
export const CONTROL_SIGNATURE_HEADER = "x-control-signature"
/** Unix seconds, decimal digits, as signed. */
export const CONTROL_TS_HEADER = "x-control-ts"
/** UUID; a retry reuses it with a fresh ts. */
export const CONTROL_MESSAGE_ID_HEADER = "x-control-message-id"

/** A Control→cell request is accepted when |now - ts| <= this many seconds. */
export const CONTROL_REQUEST_WINDOW_SECONDS = 300

/** The fields a Control→cell signature covers. */
export interface ControlCanonicalFields {
  /** Unix seconds as the decimal string sent in `x-control-ts`. */
  ts: string
  messageId: string
  /** HTTP method; upper-cased in the canonical string. */
  method: string
  /** The request URL's pathname as received by the cell, e.g. `/api/cloud/orgs`; no query. */
  path: string
  /** sha256 hex (lowercase) of the raw body bytes; the empty body's digest for no body. */
  bodySha256: string
}

/** `<ts>.<messageId>.<METHOD>.<path>.<sha256 hex of raw body>`. */
export function controlCanonicalString(f: ControlCanonicalFields): string {
  return `${f.ts}.${f.messageId}.${f.method.toUpperCase()}.${f.path}.${f.bodySha256}`
}

/** The replay key of one delivery attempt: `messageId:ts`. */
export function controlReplayKey(messageId: string, ts: string): string {
  return `${messageId}:${ts}`
}

// ── Router host lookup signing ───────────────────────────────────────────────

/** Control webhook name the router posts `{slug}` to (`/webhooks/<org>/control/host-lookup`). */
export const ROUTER_LOOKUP_ENDPOINT = "host-lookup" as const
/** Unix seconds, decimal digits, as signed. */
export const ROUTER_TS_HEADER = "x-router-ts"
/** base64 HMAC-SHA256(routerSecret, `<ts>.POST.<slug>`), keyed by the secret as UTF-8. */
export const ROUTER_SIGNATURE_HEADER = "x-router-signature"
/** A lookup is accepted when |now - ts| <= this many seconds. */
export const ROUTER_LOOKUP_WINDOW_SECONDS = 60

/** `<ts>.POST.<slug>`. */
export function routerLookupCanonicalString(ts: string, slug: string): string {
  return `${ts}.POST.${slug}`
}

// ── Header parsing and the timestamp window (shared by every verifier) ──────

/** Why a signed request was refused. Every reason maps to a 401 with no side effect. */
export type SignedRequestFailure =
  | "missing_header"
  | "malformed_header"
  | "stale"
  | "bad_signature"
  | "invalid_slug"

/** A `Headers` object, or a plain record of lower-case header names. */
export type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | null | undefined>

export function readHeader(headers: HeaderSource, name: string): string | undefined {
  const value =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get(name)
      : (headers as Record<string, string | null | undefined>)[name]
  return value == null ? undefined : value
}

const TS_PATTERN = /^[0-9]{1,15}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A base64 HMAC-SHA256: 32 bytes, 44 chars with one `=`. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{43}=$/
const HEX_64 = /^[0-9a-f]{64}$/

/** Unix seconds now. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** True when |now - ts| <= window (both ends inclusive). */
export function withinWindow(ts: number, now: number, windowSeconds: number): boolean {
  return Math.abs(now - ts) <= windowSeconds
}

export type ParsedControlHeaders =
  | { ok: true; ts: string; messageId: string; signature: string }
  | { ok: false; reason: SignedRequestFailure }

/** Reads and checks the three `x-control-*` headers and the window; the HMAC is the caller's. */
export function parseControlHeaders(headers: HeaderSource, now: number): ParsedControlHeaders {
  const signature = readHeader(headers, CONTROL_SIGNATURE_HEADER)
  const ts = readHeader(headers, CONTROL_TS_HEADER)
  const messageId = readHeader(headers, CONTROL_MESSAGE_ID_HEADER)
  if (!signature || !ts || !messageId) return { ok: false, reason: "missing_header" }
  if (!TS_PATTERN.test(ts) || !UUID_PATTERN.test(messageId) || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: "malformed_header" }
  }
  if (!withinWindow(Number(ts), now, CONTROL_REQUEST_WINDOW_SECONDS)) {
    return { ok: false, reason: "stale" }
  }
  return { ok: true, ts, messageId, signature }
}

export type ParsedRouterHeaders =
  | { ok: true; ts: string; signature: string }
  | { ok: false; reason: SignedRequestFailure }

/** Reads and checks the `x-router-*` headers, the slug and the window; the HMAC is the caller's. */
export function parseRouterHeaders(
  headers: HeaderSource,
  slug: string,
  now: number,
): ParsedRouterHeaders {
  const signature = readHeader(headers, ROUTER_SIGNATURE_HEADER)
  const ts = readHeader(headers, ROUTER_TS_HEADER)
  if (!signature || !ts) return { ok: false, reason: "missing_header" }
  if (!TS_PATTERN.test(ts) || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: "malformed_header" }
  }
  if (!SLUG_PATTERN.test(slug)) return { ok: false, reason: "invalid_slug" }
  if (!withinWindow(Number(ts), now, ROUTER_LOOKUP_WINDOW_SECONDS)) {
    return { ok: false, reason: "stale" }
  }
  return { ok: true, ts, signature }
}

/** Throws on a path a signer must never sign (no leading slash, a query or fragment). */
export function assertSignablePath(path: string): void {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error(`control request path must be a bare pathname, got ${JSON.stringify(path)}`)
  }
}

/** True when `value` is a lowercase sha256 hex digest. */
export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value)
}

// ── Body and reply schemas (spec §3.4, phase 1 rows) ────────────────────────

/** Lowercase `[a-z0-9-]{3,40}`, no leading or trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export const slugSchema = z.string().regex(SLUG_PATTERN)

export const cloudPlanSchema = z.enum(["preview", "base", "pro"])

/** A BCP 47-shaped tag such as `en` or `fr-FR`. */
const localeSchema = z
  .string()
  .max(35)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)

/** `POST /api/cloud/orgs`; idempotent on (slug, ownerEmail). */
export const cloudCreateOrgRequestSchema = z
  .object({
    orgId: z.uuid().optional(),
    slug: slugSchema,
    name: z.string().trim().min(1).max(200),
    ownerEmail: z.email().max(320),
    ownerName: z.string().trim().min(1).max(200),
    plan: cloudPlanSchema,
    locale: localeSchema,
    /**
     * The plan's included credits for the first period, a decimal string. Absent:
     * the org starts at 0 and gets them with its first billing push.
     */
    includedCredits: z
      .string()
      .regex(/^[0-9]{1,12}(\.[0-9]{1,8})?$/)
      .optional(),
    /**
     * The plan's caps (`organizations.caps` keys, validated by the cell). Absent:
     * none until the first billing push.
     */
    caps: cloudCapsSchema.optional(),
  })
  .strict()

/** 200 reply of `POST /api/cloud/orgs`; a repeat returns the first reply. */
export const cloudCreateOrgReplySchema = z
  .object({ ok: z.literal(true), orgId: z.uuid(), slug: slugSchema })
  .strict()

/** `POST /api/cloud/orgs/:id/handoff`; `orgId` must equal the path's `:id`. */
export const cloudHandoffRequestSchema = z.object({ orgId: z.uuid() }).strict()

/**
 * An absolute http(s) URL, checked without the `URL` global: Control parses
 * these replies inside the app sandbox, which has no `URL`, so `z.url()`
 * (which needs it) would reject every value there.
 */
const absoluteUrl = (schemes: readonly ("http" | "https")[]) =>
  z
    .string()
    .max(4096)
    .regex(
      new RegExp(`^(?:${schemes.join("|")}):\\/\\/[A-Za-z0-9.-]+(?::\\d{1,5})?(?:[/?#][^\\s]*)?$`),
    )

/** 200 reply: the one-time sign-in URL on the org's host and when it expires. */
export const cloudHandoffReplySchema = z
  .object({
    ok: z.literal(true),
    url: absoluteUrl(["http", "https"]),
    expiresAt: z.iso.datetime(),
  })
  .strict()

/** Codes of a Control→cell `{ok:false, code}` body. */
export const CLOUD_ERROR_CODES = {
  unauthorized: "unauthorized",
  invalidRequest: "invalid_request",
  orgMismatch: "org_mismatch",
  slugTaken: "slug_taken",
  notFound: "not_found",
  /** The cell's budget of Control requests is spent for this minute; retry later. */
  rateLimited: "rate_limited",
  /** The same idempotency key is being processed by another attempt; retry later. */
  busy: "busy",
  /** A credit grant id already applied with another amount or kind; nothing credited. */
  grantConflict: "grant_conflict",
  /** `DELETE /orgs/:id`: the org is not closed. */
  notClosed: "not_closed",
  /** `DELETE /orgs/:id`: the org was closed less than the deletion delay ago. */
  closedTooRecently: "closed_too_recently",
  /** `DELETE /orgs/:id`: the cell's operator org is never deleted this way. */
  operatorOrg: "operator_org",
  /** `DELETE /orgs/:id`: a data export is running; retry later. */
  exportRunning: "export_running",
} as const

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES]

export const cloudErrorReplySchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(Object.values(CLOUD_ERROR_CODES) as [CloudErrorCode, ...CloudErrorCode[]]),
  })
  .strict()

/** Router → Control host lookup body. */
export const routerLookupRequestSchema = z.object({ slug: slugSchema }).strict()

/**
 * Host lookup reply, the object under the kernel's `{data: ...}` envelope
 * (wrap with `dataReply`): the cell origin serving the slug, or null.
 */
export const routerLookupReplySchema = z
  .object({ cellOrigin: absoluteUrl(["https"]).nullable() })
  .strict()

export type CloudCreateOrgRequest = z.infer<typeof cloudCreateOrgRequestSchema>
export type CloudCreateOrgReply = z.infer<typeof cloudCreateOrgReplySchema>
export type CloudHandoffRequest = z.infer<typeof cloudHandoffRequestSchema>
export type CloudHandoffReply = z.infer<typeof cloudHandoffReplySchema>
export type CloudErrorReply = z.infer<typeof cloudErrorReplySchema>
export type RouterLookupRequest = z.infer<typeof routerLookupRequestSchema>
export type RouterLookupReply = z.infer<typeof routerLookupReplySchema>
