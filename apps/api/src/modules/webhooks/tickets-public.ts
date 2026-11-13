// SPDX-License-Identifier: FSL-1.1-ALv2

import { createHash, randomUUID } from "node:crypto"
import { APP_DISABLED_CODE, APP_DISABLED_MESSAGE, htmlToText } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { displayHandleOfRow, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { recordInboundOnTicket } from "~/apps/tickets/inbound-record"
import {
  isTicketParty,
  loadTicketParties,
  recordRelatedTicketNote,
} from "~/apps/tickets/participants"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { putObject, sanitizeFilename } from "~/infra/storage/object-storage"
import { sanitizeCustomerHtml } from "~/lib/email/sanitize"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { RequestBodyTooLargeError, readRequestTextWithLimit } from "~/lib/request-body"
import { getClientIp } from "~/lib/request-context"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { APP_STATE_UNAVAILABLE_CODE, pathOrgAppState } from "~/modules/apps/org-apps"
import { assertOrgTakesPublicWrites } from "~/modules/cloud/suspension"
import { resolveContact } from "~/modules/contacts/service"
import { ORG_DELETED_CODE, OrgDeletedError } from "~/modules/org/purge/deleting"

const MAX_BODY_BYTES = 51_200
// One staged attachment. This is the cap the route has ALWAYS enforced in
// practice (the 10 MiB /webhooks/* body limit sat in front of it); it is now
// stated here and mounted explicitly in app.ts, because `formData()` buffers
// the whole part and a larger figure would only be a number nothing honoured.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** The request cap for the staging route: the file plus multipart framing. */
export const ATTACHMENT_REQUEST_MAX_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024
const MAX_ATTACHMENT_COUNT = 8
const MAX_ATTACHMENTS_TOTAL_BYTES = 250 * 1024 * 1024
const ANON_REPLAY_TTL_SECONDS = 60
const APIKEY_REPLAY_TTL_SECONDS = 60
const log = rootLogger.child({ module: "tickets-public-webhook" })

export const ticketsPublicRoutes = new Hono<AppEnv>()

// Tickets turned Off (or removed) for the org (S19), or the managed org
// suspended or closed (403, below): its first-party
// public endpoints (ticket create, attachments, CSAT) answer 503 app_disabled,
// so a form embedding them shows a clear failure instead of a silent drop.
// Fail-closed: an unreadable state answers 503 as well.
//
// Scoped to the tickets paths: this router is mounted at `/webhooks` beside
// the generic per-app webhook router, and Hono merges a sub-router's
// middleware into the parent, so a `/:orgId/*` pattern here would gate every
// app's webhooks on the tickets state.
async function refuseWhenTicketsOff(c: Context<AppEnv>, next: () => Promise<void>) {
  let state: Awaited<ReturnType<typeof pathOrgAppState>>
  try {
    state = await pathOrgAppState(c.req.param("orgId") ?? "", "tickets")
  } catch {
    return c.json(
      { error: { message: "Temporarily unavailable", code: APP_STATE_UNAVAILABLE_CODE } },
      503,
    )
  }
  if (state === "deleting") {
    // The org's deletion has started: nothing more is served for it (S2.5).
    return c.json(
      { error: { message: new OrgDeletedError().message, code: ORG_DELETED_CODE } },
      410,
    )
  }
  // A managed org suspended or closed for billing (cloud/suspension.ts) takes
  // no new tickets, attachments or survey answers from the public: 403
  // `org_suspended`, the shape the authenticated routes answer. Provider
  // webhooks keep their 200-and-drop (webhooks/routes.ts); these are a form's
  // own calls, and a form can show the refusal. A no-op, without a query, on a
  // self-hosted instance.
  await assertOrgTakesPublicWrites(c.req.param("orgId") ?? "")
  if (state === "off") {
    return c.json({ error: { message: APP_DISABLED_MESSAGE, code: APP_DISABLED_CODE } }, 503)
  }
  await next()
}
ticketsPublicRoutes.use("/:orgId/tickets/*", refuseWhenTicketsOff)
ticketsPublicRoutes.use("/:orgId/inboxes/:inboxId/tickets/*", refuseWhenTicketsOff)

type AnonymousPayload = {
  subject?: string
  fromEmail?: string
  fromName?: string
  textBody?: string
  htmlBody?: string
  honeypot?: unknown
}

type ApiKeyedPayload = AnonymousPayload & {
  externalRef?: string
  priority?: "low" | "normal" | "high" | "urgent"
  team?: string
  assignedTo?: string
  sourceInboxId?: string
  contactId?: string
  categoryId?: string
  categoryPath?: string
  attachmentFileIds?: string[]
  sensitivity?: "internal" | "confidential" | "restricted"
  /**
   * When set with `externalRef`, an existing ticket lookup that finds a match
   * appends a new inbound message instead of returning the idempotent ticket.
   * Used by external systems pushing customer follow-ups on a thread they
   * created earlier (mirrors the IMAP "In-Reply-To" path in `inbound.ts`).
   */
  appendIfExisting?: boolean
  /**
   * Restrict-only: a server key that relays submissions it cannot vouch for (a
   * public form behind a server-side relay) declares its submitter unverified,
   * so the create is treated like a browser-key submission (no contact
   * linking, per-source buckets, fixed-subject acknowledgement).
   */
  unverifiedSubmitter?: true
}

const nonEmptyBody = (v: string | undefined): boolean => typeof v === "string" && v.length > 0

const ticketCreateBase = z
  .object({
    subject: z.string().trim().min(1).max(200),
    fromEmail: z.string().email().max(320),
    fromName: z.string().trim().max(120).optional(),
    textBody: z.string().max(40_000).optional(),
    htmlBody: z.string().max(40_000).optional(),
    honeypot: z.string().max(200).optional(),
  })
  .refine((v) => nonEmptyBody(v.textBody) || nonEmptyBody(v.htmlBody), {
    message: "textBody or htmlBody required",
  })

const ticketCreateApiKeyed = ticketCreateBase.extend({
  externalRef: z.string().trim().max(120).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  categoryId: z.string().uuid().optional(),
  categoryPath: z.string().trim().min(1).max(200).optional(),
  attachmentFileIds: z.array(z.string().uuid()).max(MAX_ATTACHMENT_COUNT).optional(),
  assignedTo: z.string().uuid().optional(),
  team: z.string().trim().max(120).optional(),
  sensitivity: z.enum(["internal", "confidential", "restricted"]).optional(),
  sourceInboxId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  appendIfExisting: z.boolean().optional(),
  // Only `true` is meaningful: the flag can narrow trust, never widen it, so
  // `false` is refused rather than read as "trust me".
  unverifiedSubmitter: z.literal(true).optional(),
})

function stripApiOnlyFields(payload: unknown): AnonymousPayload {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}
  const { subject, fromEmail, fromName, textBody, htmlBody, honeypot } = p as AnonymousPayload
  return { subject, fromEmail, fromName, textBody, htmlBody, honeypot }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
}

async function findTicketByExternalRef(
  orgId: string,
  externalRef: string,
): Promise<{
  ticketId: string
  ticketHandle: string
  team: string | null
  sensitivity: string | null
  mergedIntoTicketId: string | null
} | null> {
  const rows = await withPrivilegedDb(orgId, "tickets-public-external-ref-lookup", async (db) =>
    db.execute(drizzleSql`
      SELECT id, handle, team, sensitivity, merged_into_ticket_id, audience,
             category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
      FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId} AND external_ref = ${externalRef}
      LIMIT 1
    `),
  )
  const row = extractRows<{
    id: string
    handle: string
    team: string | null
    sensitivity: string | null
    merged_into_ticket_id: string | null
  }>(rows)[0]
  return row
    ? {
        ticketId: row.id,
        // The display handle (`ticket-B2B-12`), what the caller shows its user.
        ticketHandle: displayHandleOfRow(row, await loadSegmentConfig(orgId)),
        team: row.team,
        sensitivity: row.sensitivity,
        mergedIntoTicketId: row.merged_into_ticket_id,
      }
    : null
}

/**
 * A source ticket that was merged away still carries the old external_ref, so
 * a customer follow up on the original thread must land on the merge leaf,
 * not the dead source (mirrors resolveLeaf in apps/tickets/inbound.ts).
 * Returns null when the recorded target no longer exists (409 merged_ticket).
 */
async function resolveExternalRefLeaf(
  orgId: string,
  candidate: {
    ticketId: string
    ticketHandle: string
    team: string | null
    sensitivity: string | null
    mergedIntoTicketId: string | null
  },
): Promise<{
  ticketId: string
  ticketHandle: string
  team: string | null
  sensitivity: string | null
} | null> {
  if (!candidate.mergedIntoTicketId) return candidate
  const rows = await withPrivilegedDb(
    orgId,
    "tickets-public-external-ref-leaf-lookup",
    async (db) =>
      db.execute(drizzleSql`
      SELECT id, handle, team, sensitivity, audience,
             category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
      FROM ${ticketsRel("tickets")}
      WHERE id = ${candidate.mergedIntoTicketId} AND org_id = ${orgId}
      LIMIT 1
    `),
  )
  const leaf = extractRows<{
    id: string
    handle: string
    team: string | null
    sensitivity: string | null
  }>(rows)[0]
  if (!leaf) return null
  return {
    ticketId: leaf.id,
    ticketHandle: displayHandleOfRow(leaf, await loadSegmentConfig(orgId)),
    team: leaf.team,
    sensitivity: leaf.sensitivity,
  }
}

ticketsPublicRoutes.options("/:orgId/tickets/create", (c) => {
  const origin = c.req.header("origin") ?? null
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
})

// --- BL-194: tokenized CSAT rating-capture ingest ----------------------------
//
// The customer-facing counterpart to the agent-side `csatRequest` dispatch
// (apps/tickets/admin.ts). A post-resolution survey is dispatched with an
// opaque per-survey `survey_token` (16 random bytes / 128 bits, base32); the
// customer follows a link carrying that token and submits a 1-5 rating
// (+ optional free-text comment) or declines. This endpoint is the INGEST that
// records that response.
//
// Trust model: UNAUTHENTICATED — the customer is not a logged-in user. The
// only credential is the unguessable token, scoped to the `:orgId` in the
// path. An unknown (token, org) pair is an undifferentiated 404 (no oracle for
// "valid token, wrong org" vs "no such token"). Capture is ONCE: a survey only
// transitions pending → responded|declined, never the reverse and never twice,
// so a re-submission against an already-captured survey is 409 (no double-count
// of an already-recorded rating). Runs privileged (bypasses RLS) because the
// anonymous client holds no scope/team grants, exactly like `tickets/create`.
const CSAT_MAX_BODY_BYTES = 8_192

const csatCaptureSchema = z
  .object({
    score: z.number().int().min(1).max(5).optional(),
    comment: z.string().trim().max(2_000).optional(),
    declined: z.boolean().optional(),
  })
  .refine((v) => v.declined === true || typeof v.score === "number", {
    message: "score (1-5) or declined:true required",
  })
  .refine((v) => !(v.declined === true && typeof v.score === "number"), {
    message: "cannot both decline and provide a score",
  })

ticketsPublicRoutes.options("/:orgId/tickets/csat/:token", (c) => {
  const origin = c.req.header("origin") ?? null
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
})

ticketsPublicRoutes.post("/:orgId/tickets/csat/:token", async (c) => {
  const orgId = c.req.param("orgId")
  const token = c.req.param("token")
  const origin = c.req.header("origin") ?? null
  const cors = corsHeaders(origin)
  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...cors },
    })

  let rawBody: string
  try {
    rawBody = await readRequestTextWithLimit(c.req.raw, CSAT_MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return json(413, { error: { code: "payload_too_large", message: "body too large" } })
    }
    throw err
  }

  // Rate-limit by IP and by token to blunt brute-forcing the token space. The
  // token bucket also caps repeated probes against one (guessed) token.
  const ip = getClientIp(c)
  const rl = await checkRateLimit(redis, [
    { identifier: `webhook:tickets:csat:ip:${ip}:minute`, limit: 30, windowSeconds: 60 },
    { identifier: `webhook:tickets:csat:ip:${ip}:hour`, limit: 300, windowSeconds: 3600 },
    { identifier: `webhook:tickets:csat:token:${token}:hour`, limit: 20, windowSeconds: 3600 },
  ])
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: { code: "rate_limited", message: "rate limited" } }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": String(rl.failed.retryAfterSeconds),
          ...cors,
        },
      },
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json(400, { error: { code: "invalid_json", message: "invalid JSON body" } })
  }

  const parsed = csatCaptureSchema.safeParse(payload)
  if (!parsed.success) {
    return json(400, {
      error: { code: "validation_failed", message: "invalid CSAT capture payload" },
      details: parsed.error.flatten(),
    })
  }
  const input = parsed.data
  const declined = input.declined === true

  // Token + org are the only authorization. Look the survey up, then perform a
  // guarded conditional UPDATE so the pending→captured transition is atomic:
  // the WHERE status = 'pending' clause makes a concurrent double-submit a
  // no-op (rowCount 0) for the loser, which we map to 409.
  let outcome:
    | { ok: true; status: "responded" | "declined"; score: number | null; surveyId: string }
    | { error: { status: number; code: string; message: string } }
  try {
    outcome = await withPrivilegedDb(orgId, "tickets-public-csat-capture", async (tx) => {
      const found = extractRows<{ id: string; status: string }>(
        await tx.execute(drizzleSql`
          SELECT id, status FROM ${ticketsRel("ticket_csat")}
          WHERE org_id = ${orgId} AND survey_token = ${token}
          LIMIT 1
        `),
      )[0]
      if (!found) {
        return { error: { status: 404, code: "not_found", message: "survey not found" } }
      }
      if (found.status !== "pending") {
        return {
          error: { status: 409, code: "already_captured", message: "survey already captured" },
        }
      }
      const newStatus = declined ? "declined" : "responded"
      const score = declined ? null : (input.score ?? null)
      const comment = input.comment && input.comment.length > 0 ? input.comment : null
      const updated = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${ticketsRel("ticket_csat")}
          SET status = ${newStatus}, score = ${score}, comment = ${comment}, responded_at = now()
          WHERE id = ${found.id}::uuid AND status = 'pending'
          RETURNING id
        `),
      )
      if (updated.length === 0) {
        // Lost a concurrent race — another request captured it first.
        return {
          error: { status: 409, code: "already_captured", message: "survey already captured" },
        }
      }
      await tx.queueEvent({
        app: "tickets",
        entity: "csat_survey",
        action: declined ? "decline" : "respond",
        entityId: found.id,
        data: { surveyId: found.id, status: newStatus, score },
        actorId: "00000000-0000-0000-0000-000000000000",
        actorType: "system",
        orgId,
      })
      return { ok: true, status: newStatus, score, surveyId: found.id }
    })
  } catch (err) {
    log.error({ err }, "tickets csat capture failed")
    return json(500, { error: { code: "internal_error", message: "Unable to record rating" } })
  }

  if ("error" in outcome) {
    return json(outcome.error.status, {
      error: { code: outcome.error.code, message: outcome.error.message },
    })
  }
  return json(200, {
    data: { recorded: true, status: outcome.status, score: outcome.score },
  })
})

async function classifyTier(
  c: { req: { header: (n: string) => string | undefined } },
  orgId: string,
): Promise<
  | { tier: "anonymous" }
  | { tier: "api_keyed"; keyId: string; allowedOrigins: string[]; inboxId: string | null }
  | { error: { status: number; code: string; message: string } }
> {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization")
  if (!auth) return { tier: "anonymous" }
  const match = /^(?:Bearer|ApiKey)\s+(\S+)$/i.exec(auth.trim())
  if (!match) {
    return { error: { status: 401, code: "invalid_api_key", message: "invalid auth" } }
  }
  const plaintext = match[1]
  const keyHash = createHash("sha256").update(plaintext).digest("hex")

  const rows = await withPrivilegedDb(orgId, "tickets-public-key-lookup", async (db) => {
    return db.execute(drizzleSql`
      SELECT id, allowed_origins, revoked_at, inbox_id FROM ${ticketsRel("api_keys")}
      WHERE org_id = ${orgId} AND key_hash = ${keyHash}
      LIMIT 1
    `)
  })
  const row = extractRows<{
    id: string
    allowed_origins: unknown
    revoked_at: Date | null
    inbox_id: string | null
  }>(rows)[0]
  if (!row) {
    return { error: { status: 401, code: "invalid_api_key", message: "key not found" } }
  }
  if (row.revoked_at) {
    return { error: { status: 401, code: "invalid_api_key", message: "key revoked" } }
  }
  const raw = row.allowed_origins
  let origins: string[] = []
  if (Array.isArray(raw)) {
    origins = raw as string[]
  } else if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) origins = parsed as string[]
    } catch {
      origins = []
    }
  }
  return {
    tier: "api_keyed",
    keyId: row.id,
    allowedOrigins: origins,
    inboxId: row.inbox_id ?? null,
  }
}

// --- attachment staging upload ----------------------------------------------
//
// External systems (a companion hub service, relaying a customer-submitted
// attachment) upload bytes here BEFORE the ticket exists, then reference the
// returned `fileId` in `attachmentFileIds` on `tickets/create`. Staged files
// are parked under `kernel.files` with `entity_type = 'webhook_staged'` and
// `entity_id` = the file's own id (there is no ticket/message yet to parent
// them to); `tickets/create` reparents them onto the created message.
const ATTACHMENT_UPLOAD_MAX_BYTES = MAX_ATTACHMENT_BYTES

// --- pre-authentication throttle ---------------------------------------------
//
// The generic /webhooks/* limiter is skipped for these paths (they limit per
// key / per org in the handler, which needs the key lookup first). That left
// the lookup itself unthrottled: a flood of junk `Authorization` headers cost
// one privileged query each and never reached a bucket. So, before ANY parsing
// or lookup: every request spends from a generous per-IP budget, and a caller
// that keeps presenting credentials that fail is cut off after a handful of
// misses (failures are counted per IP, successes cost nothing here).
const PREAUTH_IP_PER_MINUTE = 300
const AUTH_FAILURES_PER_MINUTE = 20
const AUTH_FAILURE_WINDOW_SECONDS = 60

function authFailureKey(ip: string): string {
  return `tickets-public:authfail:${ip}`
}

async function preAuthThrottle(ip: string, cors: Record<string, string>): Promise<Response | null> {
  const limited = (retryAfter: number) =>
    new Response(JSON.stringify({ error: { code: "rate_limited", message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json", "Retry-After": String(retryAfter), ...cors },
    })
  const rl = await checkRateLimit(redis, [
    {
      identifier: `webhook:tickets:preauth:ip:${ip}`,
      limit: PREAUTH_IP_PER_MINUTE,
      windowSeconds: 60,
    },
  ])
  if (!rl.allowed) return limited(rl.failed.retryAfterSeconds)
  const failures = Number((await redis.get(authFailureKey(ip))) ?? 0)
  if (failures >= AUTH_FAILURES_PER_MINUTE) return limited(AUTH_FAILURE_WINDOW_SECONDS)
  return null
}

async function recordAuthFailure(ip: string): Promise<void> {
  const key = authFailureKey(ip)
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, AUTH_FAILURE_WINDOW_SECONDS)
}

async function handleAttachmentUpload(c: Context<AppEnv>) {
  const orgId = c.req.param("orgId") as string
  const origin = c.req.header("origin") ?? null
  const cors = corsHeaders(origin)
  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...cors },
    })

  const preIp = getClientIp(c)
  const throttled = await preAuthThrottle(preIp, cors)
  if (throttled) return throttled

  const tierResult = await classifyTier(c, orgId)
  if ("error" in tierResult) {
    await recordAuthFailure(preIp)
    return json(tierResult.error.status, {
      error: { code: tierResult.error.code, message: tierResult.error.message },
    })
  }
  if (tierResult.tier === "anonymous") {
    return json(401, {
      error: { code: "invalid_api_key", message: "an API key is required to upload attachments" },
    })
  }

  if (tierResult.allowedOrigins.length > 0) {
    if (!origin || !tierResult.allowedOrigins.includes(origin)) {
      return json(403, { error: { code: "origin_disallowed", message: "origin not allowed" } })
    }
    // A key meant for a public web page (it lists allowed origins) cannot stage
    // files: the key is visible to every visitor and the Origin header is not a
    // control. Use a server key (no allowed origins) for uploads.
    return json(403, {
      error: {
        code: "browser_key_cannot_upload",
        message: "keys with allowed origins cannot upload attachments",
      },
    })
  }

  const ip = getClientIp(c)
  const rl = await checkRateLimit(redis, [
    {
      identifier: `webhook:tickets:attachments:key:${tierResult.keyId}:minute`,
      limit: 100,
      windowSeconds: 60,
    },
    {
      identifier: `webhook:tickets:attachments:key:${tierResult.keyId}:hour`,
      limit: 2000,
      windowSeconds: 3600,
    },
    { identifier: `webhook:tickets:attachments:ip:${ip}:minute`, limit: 30, windowSeconds: 60 },
  ])
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: { code: "rate_limited", message: "rate limited" } }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": String(rl.failed.retryAfterSeconds),
          ...cors,
        },
      },
    )
  }

  // Reject oversized bodies up front when Content-Length is present, before buffering.
  const declaredLength = Number(c.req.header("content-length") ?? "0")
  if (declaredLength > 0 && declaredLength > ATTACHMENT_UPLOAD_MAX_BYTES) {
    return json(413, { error: { code: "payload_too_large", message: "attachment too large" } })
  }

  let form: Awaited<ReturnType<typeof c.req.formData>>
  try {
    form = await c.req.formData()
  } catch {
    return json(400, { error: { code: "invalid_multipart", message: "invalid multipart body" } })
  }
  const part = form.get("file")
  if (!(part instanceof Blob)) {
    return json(400, {
      error: { code: "missing_file", message: "multipart field 'file' required" },
    })
  }
  if (part.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
    return json(413, { error: { code: "payload_too_large", message: "attachment too large" } })
  }

  const bytes = new Uint8Array(await part.arrayBuffer())
  if (bytes.byteLength > ATTACHMENT_UPLOAD_MAX_BYTES) {
    return json(413, { error: { code: "payload_too_large", message: "attachment too large" } })
  }

  const partName = (part as Blob & { name?: string }).name
  const filename = sanitizeFilename(typeof partName === "string" ? partName : "attachment")
  const mimeType = part.type && part.type.length > 0 ? part.type : "application/octet-stream"
  const fileId = randomUUID()
  // The uploading key's id is part of the storage path: a ticket create may only
  // claim files its own key staged (see the attachmentFileIds check).
  const storageKey = `orgs/${orgId}/tickets/staged/${tierResult.keyId}/${fileId}/${filename}`

  try {
    await putObject({ key: storageKey, body: bytes, contentType: mimeType })
  } catch (err) {
    log.error({ err, orgId }, "tickets-public attachment upload: object storage failed")
    return json(503, { error: { code: "storage_unavailable", message: "storage unavailable" } })
  }

  const KS = drizzleSql.raw(schemaRef("kernel"))
  await withPrivilegedDb(orgId, "tickets-public-attachment-upload", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO ${KS}.files
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
         storage_key, uploaded_by, disposition, ordinal)
      VALUES (
        ${fileId}, ${orgId}, 'tickets', 'webhook_staged', ${fileId},
        ${filename}, ${mimeType}, ${bytes.byteLength},
        ${storageKey}, NULL, 'attachment', 0
      )
    `)
    // Emit the standard kernel `file:create` event (same shape as the upload
    // path in files/service.ts) via the transactional outbox so the thumbnail
    // pipeline fires for webhook-staged image attachments.
    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "create",
      entityId: fileId,
      orgId,
      actorId: "00000000-0000-0000-0000-000000000000",
      actorType: "system",
      data: {
        id: fileId,
        app: "tickets",
        entityType: "webhook_staged",
        entityId: fileId,
        filename,
        mimeType,
        sizeBytes: bytes.byteLength,
        storageKey,
      },
    })
  })

  return json(200, {
    data: { fileId, filename, mimeType, sizeBytes: bytes.byteLength },
  })
}

ticketsPublicRoutes.options("/:orgId/tickets/attachments", (c) => {
  const origin = c.req.header("origin") ?? null
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
})
ticketsPublicRoutes.post("/:orgId/tickets/attachments", (c) => handleAttachmentUpload(c))

ticketsPublicRoutes.options("/:orgId/inboxes/:inboxId/tickets/attachments", (c) => {
  const origin = c.req.header("origin") ?? null
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
})
ticketsPublicRoutes.post("/:orgId/inboxes/:inboxId/tickets/attachments", (c) =>
  handleAttachmentUpload(c),
)

// Shared handler for BOTH the generic `/:orgId/tickets/create` endpoint and the
// per-inbox `/:orgId/inboxes/:inboxId/tickets/create` endpoint. `forcedInboxId`
// is the inbox from the URL path (null for the generic route); it -- together
// with an inbox-scoped API key -- determines which inbox the new ticket lands in.
async function handleTicketCreate(c: Context<AppEnv>, forcedInboxId: string | null) {
  // Both routes pin `:orgId` in the path, so it is always present here (the
  // shared-handler extraction loses Hono's route-literal param inference).
  const orgId = c.req.param("orgId") as string
  const origin = c.req.header("origin") ?? null
  const cors = corsHeaders(origin)
  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...cors },
    })

  const preIp = getClientIp(c)
  const throttled = await preAuthThrottle(preIp, cors)
  if (throttled) return throttled

  let rawBody: string
  try {
    rawBody = await readRequestTextWithLimit(c.req.raw, MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return new Response(
        JSON.stringify({ error: { code: "payload_too_large", message: "body too large" } }),
        {
          status: 413,
          headers: { "content-type": "application/json", ...cors },
        },
      )
    }
    throw err
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response(
      JSON.stringify({ error: { code: "invalid_json", message: "invalid JSON body" } }),
      { status: 400, headers: { "content-type": "application/json", ...cors } },
    )
  }

  const tierResult = await classifyTier(c, orgId)
  if ("error" in tierResult) {
    await recordAuthFailure(preIp)
    return new Response(
      JSON.stringify({
        error: { code: tierResult.error.code, message: tierResult.error.message },
      }),
      {
        status: tierResult.error.status,
        headers: { "content-type": "application/json", ...cors },
      },
    )
  }

  if (tierResult.tier === "api_keyed" && tierResult.allowedOrigins.length > 0) {
    if (!origin || !tierResult.allowedOrigins.includes(origin)) {
      return new Response(
        JSON.stringify({ error: { code: "origin_disallowed", message: "origin not allowed" } }),
        { status: 403, headers: { "content-type": "application/json", ...cors } },
      )
    }
  }

  const parsed =
    tierResult.tier === "api_keyed"
      ? ticketCreateApiKeyed.safeParse(payload)
      : ticketCreateBase.safeParse(stripApiOnlyFields(payload))
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: { code: "validation_failed", message: "invalid ticket create payload" },
        details: parsed.error.flatten(),
      }),
      { status: 400, headers: { "content-type": "application/json", ...cors } },
    )
  }
  const input = parsed.data as ApiKeyedPayload & { subject: string; fromEmail: string }

  // A key that lists allowed origins is meant to sit in a public web page, so
  // every visitor can read it and the Origin header (client-chosen) is not a
  // control. Such a key may do exactly one thing: create a ticket in its fixed
  // desk, from the form fields an anonymous visitor could send. Server-to-server
  // powers (team, sensitivity, assignee, contact binding, staged files, append,
  // external reference, priority) need a server key (no allowed origins).
  const browserKey = tierResult.tier === "api_keyed" && tierResult.allowedOrigins.length > 0
  if (browserKey) {
    const forbidden = (
      [
        "team",
        "sensitivity",
        "assignedTo",
        "contactId",
        "attachmentFileIds",
        "appendIfExisting",
        "sourceInboxId",
        "externalRef",
        "priority",
      ] as const
    ).filter((f) => input[f] !== undefined)
    if (forbidden.length > 0) {
      return json(403, {
        error: {
          code: "browser_key_field_not_allowed",
          message: `keys with allowed origins cannot set: ${forbidden.join(", ")}`,
        },
      })
    }
    if (forcedInboxId && tierResult.tier === "api_keyed" && tierResult.inboxId !== forcedInboxId) {
      return json(403, {
        error: {
          code: "inbox_scope_violation",
          message: "a key with allowed origins is bound to its own desk",
        },
      })
    }
  }

  // Who vouches for the submitter. Anonymous and browser-key submissions name
  // any address they like. A server key is a trusted backend, unless it says it
  // relays anonymous visitors (`unverifiedSubmitter`): the flag only narrows
  // trust, so it changes nothing for the other tiers. This one boolean drives
  // every per-submitter control below: contact linking, the per-source create
  // buckets and the acknowledgement.
  const serverKeyUnverified =
    tierResult.tier === "api_keyed" && !browserKey && input.unverifiedSubmitter === true
  const unverified = tierResult.tier === "anonymous" || browserKey || serverKeyUnverified
  // `contactId` and `appendIfExisting` are both claims about who the submitter
  // is, which a caller that cannot vouch for its submitter has no basis for.
  // Refused before any rate-limit spend or side effect.
  if (
    serverKeyUnverified &&
    (input.contactId !== undefined || input.appendIfExisting !== undefined)
  ) {
    return json(400, {
      error: {
        code: "unverified_submitter_conflict",
        message: "unverifiedSubmitter cannot be combined with contactId or appendIfExisting",
      },
    })
  }

  // --- inbox targeting: per-inbox URL + inbox-scoped API keys ----------------
  // The generic endpoint keeps taking `sourceInboxId` in the body. The per-inbox
  // endpoint pins the inbox from the URL (`forcedInboxId`). An API key may also
  // be scoped to a single inbox (`inbox_id`), in which case it can ONLY write
  // there. Resolve the single effective target and reject disagreements.
  const bodyInboxId = tierResult.tier === "api_keyed" ? (input.sourceInboxId ?? null) : null
  const keyInboxScope = tierResult.tier === "api_keyed" ? tierResult.inboxId : null
  if (forcedInboxId && tierResult.tier !== "api_keyed") {
    return json(401, {
      error: { code: "invalid_api_key", message: "the per-inbox endpoint requires an API key" },
    })
  }
  if (forcedInboxId && bodyInboxId && bodyInboxId !== forcedInboxId) {
    return json(400, {
      error: {
        code: "inbox_conflict",
        message: "sourceInboxId in the body conflicts with the inbox in the URL path",
      },
    })
  }
  const requestedInbox = forcedInboxId ?? bodyInboxId
  if (keyInboxScope && requestedInbox && requestedInbox !== keyInboxScope) {
    return json(403, {
      error: {
        code: "inbox_scope_violation",
        message: "this API key is scoped to a different inbox",
      },
    })
  }
  const targetInboxId = forcedInboxId ?? keyInboxScope ?? bodyInboxId ?? null

  // Honeypot drop for anonymous
  if (tierResult.tier === "anonymous" && input.honeypot) {
    return new Response(JSON.stringify({ data: { received: true } }), {
      status: 200,
      headers: { "content-type": "application/json", ...cors },
    })
  }

  // Rate limit
  const ip = getClientIp(c)
  const buckets =
    tierResult.tier === "api_keyed"
      ? [
          {
            identifier: `webhook:tickets:create:key:${tierResult.keyId}:minute`,
            limit: 100,
            windowSeconds: 60,
          },
          {
            identifier: `webhook:tickets:create:key:${tierResult.keyId}:hour`,
            limit: 10_000,
            windowSeconds: 3600,
          },
          // A browser key is public, and a relay of anonymous visitors forwards
          // each visitor's address: also cap each source, so one visitor cannot
          // spend the key's whole budget.
          ...(unverified
            ? [
                {
                  identifier: `webhook:tickets:create:ip:${ip}:minute`,
                  limit: 5,
                  windowSeconds: 60,
                },
                {
                  identifier: `webhook:tickets:create:ip:${ip}:hour`,
                  limit: 100,
                  windowSeconds: 3600,
                },
              ]
            : []),
        ]
      : [
          {
            identifier: `webhook:tickets:create:ip:${ip}:minute`,
            limit: 5,
            windowSeconds: 60,
          },
          {
            identifier: `webhook:tickets:create:ip:${ip}:hour`,
            limit: 100,
            windowSeconds: 3600,
          },
          {
            identifier: `webhook:tickets:create:org:${orgId}:hour`,
            limit: 1000,
            windowSeconds: 3600,
          },
        ]
  const rl = await checkRateLimit(redis, buckets)
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: { code: "rate_limited", message: "rate limited" } }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": String(rl.failed.retryAfterSeconds),
          ...cors,
        },
      },
    )
  }

  // A follow-up from a sender who is not on the ticket's thread opens a NEW
  // ticket linked to the old one (set below), instead of joining it.
  let relatedTicketId: string | null = null
  let relatedTicketHandle = "an earlier ticket"
  // Idempotency / replay guards (and appendIfExisting follow-up path)
  if (tierResult.tier === "api_keyed" && input.externalRef) {
    const idemKey = `tickets-public:idem:${orgId}:${input.externalRef}`
    if (!input.appendIfExisting) {
      const existingRaw = await redis.get(idemKey)
      if (existingRaw) {
        try {
          const cached = JSON.parse(existingRaw) as { ticketId: string; ticketHandle: string }
          return new Response(JSON.stringify({ data: { ...cached, idempotent: true } }), {
            status: 200,
            headers: { "content-type": "application/json", ...cors },
          })
        } catch {
          // Fall through to the durable external_ref lookup below.
        }
      }
    }
    const existing = await findTicketByExternalRef(orgId, input.externalRef)
    if (existing) {
      if (input.appendIfExisting) {
        // Customer follow-up on an existing thread — append a new inbound
        // message instead of returning the idempotent ticket. Mirrors the
        // IMAP "In-Reply-To" path so external systems can push reply rounds.
        //
        // Trust model: this branch only runs in the `api_keyed` tier (the
        // anonymous tier short-circuits before idempotency lookup). Any
        // active org-scoped API key is allowed to append on any ticket whose
        // `external_ref` it presents — by design for "external CRM pushes a
        // customer reply on a thread it created earlier". The attack surface
        // is therefore bounded to: an org member who already holds a write
        // API key, who could append `kind="inbound"` content to an existing
        // ticket they could already create. We strip HTML from the snippet
        // (list previews are plain text) and let the body fields flow as-is
        // — the renderer sanitises HTML at display time, matching the
        // IMAP/Gmail inbound path. We do NOT widen this to allow setting
        // `kind` or other agent-only fields.
        // A source ticket that was merged away keeps its old external_ref —
        // follow ups must land on the merge leaf, not the dead source.
        const leaf = await resolveExternalRefLeaf(orgId, existing)
        if (!leaf) {
          return new Response(
            JSON.stringify({
              error: { code: "merged_ticket", message: "merge target ticket not found" },
            }),
            { status: 409, headers: { "content-type": "application/json", ...cors } },
          )
        }
        const parties = await withPrivilegedDb(orgId, "tickets-public-parties", (db) =>
          loadTicketParties(db, orgId, leaf.ticketId),
        )
        if (!isTicketParty(parties, input.fromEmail)) {
          // The external reference is a hint, not a credential. A sender who is
          // not the requester or a participant gets a new ticket pointing back.
          relatedTicketId = leaf.ticketId
          relatedTicketHandle = leaf.ticketHandle
        }
      }
      if (input.appendIfExisting && !relatedTicketId) {
        const leaf = (await resolveExternalRefLeaf(orgId, existing))!
        const sentAt = new Date().toISOString()
        const snippetSource =
          input.textBody ?? (input.htmlBody ? htmlToText(input.htmlBody, { singleLine: true }) : "")
        const snippet = snippetSource.slice(0, 200)
        const appendedMessageId = await withPrivilegedDb(
          orgId,
          "tickets-public-append-message",
          async (tx) => {
            const r = await tx.execute(drizzleSql`
              INSERT INTO ${ticketsRel("messages")} (
                id, org_id, ticket_id, kind,
                from_email, from_name, to_emails, cc_emails,
                subject, html_body, text_body, snippet,
                sent_at, external_message_id, in_reply_to, header_references,
                created_at, updated_at
              ) VALUES (
                gen_random_uuid(), ${orgId}, ${leaf.ticketId}, 'inbound',
                ${input.fromEmail}, ${input.fromName ?? null},
                '[]'::jsonb, '[]'::jsonb,
                ${input.subject}, ${input.htmlBody ? sanitizeCustomerHtml(input.htmlBody) : null},
                ${input.textBody ?? null}, ${snippet},
                ${sentAt}::timestamptz, null, null, '[]'::jsonb,
                now(), now()
              )
              RETURNING id
            `)
            const inserted = extractRows<{ id: string }>(r)[0]!
            await recordInboundOnTicket(tx, {
              orgId,
              ticketId: leaf.ticketId,
              sentAt,
              actor: {
                actorType: "system",
                userId: "00000000-0000-0000-0000-000000000000",
                orgId,
              },
              // Its settings read runs on this transaction, not a second one.
              privilegedTx: tx,
            })
            // Live-update any open ticket detail UIs by emitting the same
            // WS event the agent runtime uses for ticket-side message inserts.
            await tx.queueEvent({
              app: "tickets",
              entity: "message",
              action: "create",
              entityId: inserted.id,
              data: {
                id: inserted.id,
                ticketId: leaf.ticketId,
                kind: "inbound",
                textBody: input.textBody ?? null,
                htmlBody: input.htmlBody ? sanitizeCustomerHtml(input.htmlBody) : null,
                fromEmail: input.fromEmail,
                fromName: input.fromName ?? null,
                sentAt,
                orgId,
                // Carry the parent ticket's dimension values under their grant
                // keys (tickets:team / tickets:sensitivity) so the WS-side
                // hasDimensionAccess filter enforces team/sensitivity isolation
                // on this inbound-message frame, matching RLS. Mirrors the
                // agent outbound emit in apps/tickets/tools.ts.
                "tickets:team": leaf.team,
                "tickets:sensitivity": leaf.sensitivity,
              },
              actorId: "00000000-0000-0000-0000-000000000000",
              actorType: "system",
              orgId,
            })
            return inserted.id
          },
        )
        return new Response(
          JSON.stringify({
            // Only echo the public identifiers — team/sensitivity now live on
            // `leaf` for the WS dimension gate but must not reach the
            // unauthenticated caller.
            data: {
              ticketId: leaf.ticketId,
              ticketHandle: leaf.ticketHandle,
              appended: true,
              messageId: appendedMessageId,
            },
          }),
          { status: 200, headers: { "content-type": "application/json", ...cors } },
        )
      }
      if (!relatedTicketId) {
        const publicExisting = {
          ticketId: existing.ticketId,
          ticketHandle: existing.ticketHandle,
        }
        await redis.set(idemKey, JSON.stringify(publicExisting), "EX", 24 * 60 * 60)
        return new Response(JSON.stringify({ data: { ...publicExisting, idempotent: true } }), {
          status: 200,
          headers: { "content-type": "application/json", ...cors },
        })
      }
    }
  }

  // Resolve inbox after persistent idempotency so externalRef replays remain stable
  // even if default-inbox configuration changed after the first successful delivery.
  const sourceInboxId = targetInboxId ?? undefined
  let resolvedInboxId: string | undefined = sourceInboxId
  if (!resolvedInboxId) {
    const rows = await withPrivilegedDb(orgId, "tickets-public-default-inbox", async (db) =>
      db.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("inboxes")}
        WHERE org_id = ${orgId} AND is_default_for_create = true AND archived_at IS NULL
        LIMIT 1
      `),
    )
    const row = extractRows<{ id: string }>(rows)[0]
    if (!row) {
      const status = tierResult.tier === "api_keyed" ? 422 : 503
      const code = tierResult.tier === "api_keyed" ? "inbox_required" : "no_default_inbox"
      return new Response(
        JSON.stringify({ error: { code, message: "no default inbox configured" } }),
        { status, headers: { "content-type": "application/json", ...cors } },
      )
    }
    resolvedInboxId = row.id
  }

  const bodyHash = createHash("sha256").update(rawBody).digest("hex")
  if (tierResult.tier === "anonymous") {
    const replayKey = `tickets-public:anon:${orgId}:${ip}:${bodyHash}`
    const isNew = await redis.set(replayKey, "1", "EX", ANON_REPLAY_TTL_SECONDS, "NX")
    if (!isNew) {
      return new Response(JSON.stringify({ data: { received: true, duplicate: true } }), {
        status: 200,
        headers: { "content-type": "application/json", ...cors },
      })
    }
  } else {
    if (!input.externalRef) {
      const replayKey = `tickets-public:apikey:${tierResult.keyId}:${bodyHash}`
      const isNew = await redis.set(replayKey, "1", "EX", APIKEY_REPLAY_TTL_SECONDS, "NX")
      if (!isNew) {
        return new Response(
          JSON.stringify({ error: { code: "duplicate_delivery", message: "duplicate" } }),
          { status: 409, headers: { "content-type": "application/json", ...cors } },
        )
      }
    }
  }

  // --- categoryId / categoryPath resolution -----------------------------
  // categoryId (a direct UUID) wins when both are given. categoryPath is
  // resolved case-insensitively by walking the parent_id chain from the
  // root, so external systems can address categories by name instead of
  // first looking up the id.
  let resolvedCategoryId: string | undefined =
    tierResult.tier === "api_keyed" ? input.categoryId : undefined
  if (tierResult.tier === "api_keyed" && !resolvedCategoryId && input.categoryPath) {
    const { resolveCategoryPath } = await import("~/apps/tickets/create")
    const catResult = await resolveCategoryPath(orgId, input.categoryPath)
    if ("error" in catResult) {
      return json(422, { error: catResult.error })
    }
    resolvedCategoryId = catResult.categoryId
  }

  // --- attachmentFileIds validation --------------------------------------
  // Every id must resolve to an org-matching `webhook_staged` kernel.files
  // row that hasn't already been consumed by an earlier ticket create.
  // Unknown/foreign/consumed → 422 unknown_attachment before any side effect.
  type StagedFile = { id: string; filename: string; mime_type: string; size_bytes: number }
  let stagedFiles: StagedFile[] = []
  if (tierResult.tier === "api_keyed" && input.attachmentFileIds?.length) {
    const ids = input.attachmentFileIds
    const KS = drizzleSql.raw(schemaRef("kernel"))
    const idList = drizzleSql.join(
      ids.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    const rows = await withPrivilegedDb(orgId, "tickets-public-attachments-lookup", async (tx) =>
      extractRows<StagedFile>(
        await tx.execute(drizzleSql`
          SELECT id, filename, mime_type, size_bytes FROM ${KS}.files
          WHERE org_id = ${orgId}::uuid
            AND entity_type = 'webhook_staged'
            AND storage_key LIKE ${`orgs/${orgId}/tickets/staged/${tierResult.keyId}/%`}
            AND id IN (${idList})
        `),
      ),
    )
    const foundById = new Map(rows.map((r) => [r.id, r]))
    const totalBytes = rows.reduce((sum, r) => sum + Number(r.size_bytes), 0)
    if (
      rows.length !== ids.length ||
      totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES ||
      ids.length > MAX_ATTACHMENT_COUNT
    ) {
      return json(422, {
        error: { code: "unknown_attachment", message: "one or more attachmentFileIds are invalid" },
      })
    }
    // Preserve caller-specified array order for message ordinal assignment.
    stagedFiles = ids.map((id) => foundById.get(id)!)
  }

  // Create ticket
  const channel: "web_form" | "api" = tierResult.tier === "anonymous" ? "web_form" : "api"
  let result:
    | {
        ticketId: string
        ticketHandle: string
        replyToken: string
        initialMessageId: string | null
      }
    | { error: { code: string; message: string; retryable: boolean } }

  try {
    // Public webhook runs as a privileged system actor (admin role) — bypasses RLS
    // because anonymous/API-key clients have no team or scope grants. Inputs are
    // already restricted to the documented ticket-create surface.
    result = await withPrivilegedDb(orgId, "tickets-public-create", async (tx) => {
      const { createTicket } = await import("~/apps/tickets/create")
      // A public form never adds its sender to the organisation's contacts
      // (that is a person's choice): it links an org contact that already
      // exists for the address, or none.
      // The address on an anonymous, browser-key or unverified-submitter form is
      // whatever the visitor typed, so it links no contact (the contact's
      // profile would sit beside attacker-written text). A server key that
      // vouches for its submitter is a trusted caller. (An explicit contactId
      // never comes with the flag: refused above as a conflict.)
      const resolvedContactId =
        tierResult.tier === "api_keyed" && input.contactId
          ? input.contactId
          : tierResult.tier === "api_keyed" && !unverified
            ? ((
                await resolveContact(
                  tx as never,
                  orgId,
                  "00000000-0000-0000-0000-000000000000",
                  { email: input.fromEmail, name: input.fromName },
                  { audience: "none" },
                )
              ).contact?.id ?? null)
            : null
      return createTicket(
        tx,
        orgId,
        {
          subject: input.subject,
          channel,
          team: tierResult.tier === "api_keyed" ? input.team : undefined,
          sensitivity: tierResult.tier === "api_keyed" ? input.sensitivity : undefined,
          assignedTo: tierResult.tier === "api_keyed" ? input.assignedTo : undefined,
          contactId: resolvedContactId,
          categoryId: resolvedCategoryId,
          sourceInboxId: resolvedInboxId,
          externalRef:
            tierResult.tier === "api_keyed" && !relatedTicketId ? input.externalRef : undefined,
          priority: tierResult.tier === "api_keyed" ? input.priority : undefined,
          requesterEmail: input.fromEmail,
          relatedTicketId,
          initialMessage: {
            kind: "inbound",
            fromEmail: input.fromEmail,
            fromName: input.fromName ?? null,
            subject: input.subject,
            htmlBody: input.htmlBody ? sanitizeCustomerHtml(input.htmlBody) : null,
            textBody: input.textBody ?? null,
          },
        },
        { actorType: "system", userId: "00000000-0000-0000-0000-000000000000" } as never,
        { privilegedTx: tx },
      )
    })
  } catch (err) {
    const code =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
    if (tierResult.tier === "api_keyed" && input.externalRef && code === "23505") {
      const existing = await findTicketByExternalRef(orgId, input.externalRef)
      if (existing) {
        return new Response(
          JSON.stringify({
            data: {
              ticketId: existing.ticketId,
              ticketHandle: existing.ticketHandle,
              idempotent: true,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", ...cors },
          },
        )
      }
    }
    log.error({ err }, "tickets public create failed")
    return new Response(
      JSON.stringify({
        error: { code: "internal_error", message: "Unable to create ticket" },
      }),
      { status: 500, headers: { "content-type": "application/json", ...cors } },
    )
  }

  if ("error" in result) {
    const status = result.error.code === "not_found" ? 404 : 400
    return new Response(JSON.stringify({ error: result.error }), {
      status,
      headers: { "content-type": "application/json", ...cors },
    })
  }

  // Reparent staged attachments onto the initial message: entity_type moves
  // from 'webhook_staged' to 'message', entity_id to the message id, ordinal
  // by the caller's array order. The storage key is left as-is — only the
  // DB parent changes.
  if (stagedFiles.length > 0 && result.initialMessageId) {
    const KS = drizzleSql.raw(schemaRef("kernel"))
    const messageId = result.initialMessageId
    await withPrivilegedDb(orgId, "tickets-public-attachments-reparent", async (tx) => {
      for (let i = 0; i < stagedFiles.length; i += 1) {
        await tx.execute(drizzleSql`
          UPDATE ${KS}.files
          SET entity_type = 'message', entity_id = ${messageId}, ordinal = ${i}
          WHERE id = ${stagedFiles[i]!.id}::uuid AND org_id = ${orgId}::uuid
        `)
      }
    })
  }

  if (relatedTicketId) {
    await withPrivilegedDb(orgId, "tickets-public-related-note", (tx) =>
      recordRelatedTicketNote(tx, orgId, result.ticketId, relatedTicketHandle),
    )
  }

  if (tierResult.tier === "api_keyed" && input.externalRef && !relatedTicketId) {
    const idemKey = `tickets-public:idem:${orgId}:${input.externalRef}`
    await redis.set(
      idemKey,
      JSON.stringify({ ticketId: result.ticketId, ticketHandle: result.ticketHandle }),
      "EX",
      24 * 60 * 60,
    )
  }

  // Post-commit acknowledgement (Task 2): this branch is reached only for a
  // FRESH createTicket call (the idempotent-replay and appendIfExisting
  // branches above return earlier and never reach here), so it never
  // double-acks an existing ticket. Gated per-inbox (ack_enabled) and
  // send-once (ack_sent_at) inside the helper; best-effort — a failed ack
  // must never fail the webhook response for an already-created ticket.
  try {
    const { sendTicketAcknowledgement } = await import("~/apps/tickets/tools")
    // A server key is a trusted backend that vouches for its customer (and
    // relays every customer from one address); an anonymous, browser-key or
    // unverified-submitter submission names any address it likes, so it gets
    // the fixed-subject ack and a per-source cap (`unverified`, above).
    const ack = await sendTicketAcknowledgement(result.ticketId, orgId, {
      sourceIp: unverified ? ip : null,
      unverifiedRecipient: unverified,
    })
    if ("error" in ack) {
      log.error({ ticketId: result.ticketId, err: ack.error }, "ticket acknowledgement send failed")
    }
  } catch (err) {
    log.error({ ticketId: result.ticketId, err }, "ticket acknowledgement send threw")
  }

  return new Response(
    JSON.stringify({
      data: {
        ticketId: result.ticketId,
        ticketHandle: result.ticketHandle,
        // Echoed only when a server key declared the flag, so a relay can tell
        // a Liaison that honoured it from one that silently dropped the unknown
        // field (zod strips unknown keys). Other tiers answer as before.
        ...(serverKeyUnverified ? { submitter: "unverified" as const } : {}),
      },
    }),
    { status: 200, headers: { "content-type": "application/json", ...cors } },
  )
}

// Generic ingest (inbox chosen by body `sourceInboxId` / the org default).
ticketsPublicRoutes.post("/:orgId/tickets/create", (c) => handleTicketCreate(c, null))

// Per-inbox ingest: a copyable, self-contained endpoint per API inbox. The
// inbox is pinned from the URL, so the caller needs only its org API key.
ticketsPublicRoutes.options("/:orgId/inboxes/:inboxId/tickets/create", (c) => {
  const origin = c.req.header("origin") ?? null
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
})
ticketsPublicRoutes.post("/:orgId/inboxes/:inboxId/tickets/create", (c) =>
  handleTicketCreate(c, c.req.param("inboxId") ?? null),
)
