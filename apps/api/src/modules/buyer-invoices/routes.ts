// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The buyer invoices API (v1): a shop's own website, server to server, lists the invoices and
// credit notes of its signed-in buyer and mints a 5-minute download link for one of them.
//
//   POST /api/buyer-invoices/list   {buyer, limit?, cursor?}       Authorization: Bearer linv_...
//   POST /api/buyer-invoices/link   {buyer, documentId}            Authorization: Bearer linv_...
//   GET  /api/buyer-invoices/pdf/:token                             (the token is the credential)
//
// A key reads one issuer profile's documents and nothing else. The buyer identity is the
// website's own record of its user; which sales it reaches is the matching rule (match.ts).
// Every answer is `Cache-Control: no-store`; every authenticated call is rate limited per key
// (120 a minute) and audit-logged without the buyer's email.

import type { Context } from "hono"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { getOrgAppState } from "~/modules/apps/org-apps"
import { writeAuditLog } from "~/modules/audit/service"
import { orgAccess } from "~/modules/cloud/suspension"
import { readBuyerFile } from "./file"
import { type BuyerIdentity, hasIdentity, normaliseIdentity } from "./match"
import {
  authenticateBuyerKey,
  type BuyerKey,
  buyerDocumentFile,
  listBuyerDocuments,
  lookupBuyerLink,
  mintBuyerLink,
  touchBuyerKey,
} from "./store"

const log = rootLogger.child({ module: "buyer-invoices" })

export const BUYER_INVOICES_PREFIX = "/api/buyer-invoices"
export const PER_KEY_PER_MINUTE = 120
/** Before any key is known: bounds guessing from one address. */
const PER_ADDRESS_PER_MINUTE = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const buyerSchema = z
  .object({
    email: z.string().max(320).nullable().optional(),
    shopifyCustomerId: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .nullable()
      .optional(),
    hubUserId: z.string().uuid().nullable().optional(),
  })
  .strict()

const listSchema = z
  .object({
    buyer: buyerSchema,
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().max(64).nullable().optional(),
  })
  .strict()

const linkSchema = z.object({ buyer: buyerSchema, documentId: z.string().max(64) }).strict()

type ErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_KEY"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "LINK_EXPIRED"

function fail(
  c: Context<AppEnv>,
  status: 400 | 401 | 404 | 410 | 429 | 503,
  code: ErrorCode,
  message: string,
) {
  c.header("Cache-Control", "no-store")
  return c.json({ error: { code, message } }, status)
}

function limitsOn(): boolean {
  return !(env.NODE_ENV === "test" && !envFlag("RATE_LIMIT_FORCE_ENABLED"))
}

async function overBudget(identifier: string, limit: number) {
  if (!limitsOn()) return null
  const result = await checkRateLimit(redis, [{ identifier, limit, windowSeconds: 60 }])
  return result.allowed ? null : result.failed.retryAfterSeconds
}

/** The org is served (not suspended or closed) and its invoicing app is on. */
async function servesInvoicing(orgId: string): Promise<boolean> {
  if ((await orgAccess(orgId)) !== "served") return false
  const app = await getOrgAppState(orgId, "invoicing")
  return !app || app.status === "active"
}

/** A failed query's error without its parameters (they hold the buyer's email). */
function safeErr(err: unknown): { code?: unknown; message: string } {
  const e = err as { code?: unknown; message?: unknown } | null
  return { code: e?.code, message: typeof e?.message === "string" ? e.message : String(err) }
}

/** The key the request carries, or the error to answer with. */
async function authenticate(
  c: Context<AppEnv>,
): Promise<{ key: BuyerKey } | { response: Response }> {
  try {
    const retry = await overBudget(`buyer-invoices:ip:${getClientIp(c)}`, PER_ADDRESS_PER_MINUTE)
    if (retry !== null) {
      c.header("Retry-After", String(retry))
      return { response: fail(c, 429, "RATE_LIMITED", "Too many requests.") }
    }
  } catch (err) {
    log.error({ err }, "buyer invoices address limiter failed, refusing (fail closed)")
    return { response: fail(c, 503, "UNAVAILABLE", "Temporarily unavailable.") }
  }
  const header = c.req.header("authorization") ?? ""
  const match = /^Bearer ([^\s]+)$/.exec(header.trim())
  const key = match ? await authenticateBuyerKey(match[1] as string) : null
  if (!key) return { response: fail(c, 401, "INVALID_KEY", "Missing, unknown or revoked key.") }
  try {
    const retry = await overBudget(`buyer-invoices:key:${key.id}`, PER_KEY_PER_MINUTE)
    if (retry !== null) {
      c.header("Retry-After", String(retry))
      return { response: fail(c, 429, "RATE_LIMITED", "Over 120 requests a minute for this key.") }
    }
  } catch (err) {
    log.error({ err, keyId: key.id }, "buyer invoices key limiter failed, refusing (fail closed)")
    return { response: fail(c, 503, "UNAVAILABLE", "Temporarily unavailable.") }
  }
  if (!(await servesInvoicing(key.orgId))) {
    return {
      response: fail(c, 503, "UNAVAILABLE", "Invoicing is not available for this organization."),
    }
  }
  await touchBuyerKey(key)
  return { key }
}

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | null> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return null
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Who asked and what, never the buyer's email: the strong ids and whether an email was sent. */
async function audit(
  key: BuyerKey,
  action: string,
  who: BuyerIdentity,
  extra: Record<string, unknown> = {},
) {
  try {
    await withPrivilegedDb(key.orgId, "buyer-invoices-audit", (tx) =>
      writeAuditLog(tx, {
        orgId: key.orgId,
        actorId: null,
        actorType: "system",
        app: "invoicing",
        entityType: "buyer_invoice_key",
        entityId: key.id,
        action,
        metadata: {
          issuer_profile_id: key.issuerProfileId,
          with_email: who.email !== null,
          shopify_customer_id: who.shopifyCustomerId,
          hub_user_id: who.hubUserId,
          ...extra,
        },
      }),
    )
  } catch (err) {
    log.error({ err: safeErr(err), keyId: key.id, action }, "buyer invoices audit write failed")
  }
}

export const buyerInvoicesRoutes = new Hono<AppEnv>()
  .use("*", bodyLimit({ maxSize: 16 * 1024 }))
  .post("/list", async (c) => {
    const auth = await authenticate(c)
    if ("response" in auth) return auth.response
    const req = await body(c, listSchema)
    const who = req ? normaliseIdentity(req.buyer) : null
    if (!req || !who || !hasIdentity(who)) {
      return fail(
        c,
        400,
        "INVALID_REQUEST",
        "Send a JSON body with a buyer that has an identity field.",
      )
    }
    const limit = req.limit ?? 200
    const offset = req.cursor ? Number.parseInt(req.cursor, 10) : 0
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (req.cursor && String(offset) !== req.cursor)
    ) {
      return fail(c, 400, "INVALID_REQUEST", "Unknown cursor.")
    }
    try {
      const all = await listBuyerDocuments(auth.key, who)
      const page = all.slice(offset, offset + limit)
      const next = offset + limit < all.length ? String(offset + limit) : null
      await audit(auth.key, "buyer_documents.listed", who, { count: page.length })
      c.header("Cache-Control", "no-store")
      return c.json({ documents: page, nextCursor: next }, 200)
    } catch (err) {
      log.error({ err: safeErr(err), keyId: auth.key.id }, "buyer invoices list failed")
      return fail(c, 503, "UNAVAILABLE", "Temporarily unavailable.")
    }
  })
  .post("/link", async (c) => {
    const auth = await authenticate(c)
    if ("response" in auth) return auth.response
    const req = await body(c, linkSchema)
    const who = req ? normaliseIdentity(req.buyer) : null
    if (!req || !who || !hasIdentity(who) || !UUID.test(req.documentId)) {
      return fail(
        c,
        400,
        "INVALID_REQUEST",
        "Send a buyer with an identity field and a document id.",
      )
    }
    try {
      const link = await mintBuyerLink(auth.key, who, req.documentId.toLowerCase())
      if (!link) {
        await audit(auth.key, "buyer_documents.link_refused", who, { document_id: req.documentId })
        return fail(c, 404, "NOT_FOUND", "No such document for this buyer.")
      }
      await audit(auth.key, "buyer_documents.link_minted", who, { document_id: req.documentId })
      const origin = env.BASE_URL.replace(/\/+$/, "")
      c.header("Cache-Control", "no-store")
      return c.json(
        {
          url: `${origin}${BUYER_INVOICES_PREFIX}/pdf/${link.token}`,
          expiresAt: link.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
        200,
      )
    } catch (err) {
      log.error({ err: safeErr(err), keyId: auth.key.id }, "buyer invoices link failed")
      return fail(c, 503, "UNAVAILABLE", "Temporarily unavailable.")
    }
  })
  .get("/pdf/:token", async (c) => {
    try {
      const retry = await overBudget(`buyer-invoices:pdf:${getClientIp(c)}`, PER_ADDRESS_PER_MINUTE)
      if (retry !== null) {
        c.header("Retry-After", String(retry))
        return fail(c, 429, "RATE_LIMITED", "Too many requests.")
      }
    } catch (err) {
      log.error({ err }, "buyer invoices pdf limiter failed, refusing (fail closed)")
      return fail(c, 503, "UNAVAILABLE", "Temporarily unavailable.")
    }
    const found = await lookupBuyerLink(c.req.param("token"))
    if (found.status === "expired") return fail(c, 410, "LINK_EXPIRED", "This link has expired.")
    if (found.status !== "ok") return fail(c, 404, "NOT_FOUND", "Unknown link.")
    if (!(await servesInvoicing(found.orgId))) {
      return fail(c, 503, "UNAVAILABLE", "Invoicing is not available for this organization.")
    }
    const file = await buyerDocumentFile(found)
    if (!file) return fail(c, 404, "NOT_FOUND", "Unknown link.")
    const response = await readBuyerFile(found.orgId, file.fileId, `${file.number}.pdf`)
    if (!response) return fail(c, 404, "NOT_FOUND", "Unknown link.")
    const key = { id: found.keyId, orgId: found.orgId, issuerProfileId: found.issuerProfileId }
    await audit(key, "buyer_documents.downloaded", normaliseIdentity({}), {
      document_id: found.documentId,
    })
    return response
  })
