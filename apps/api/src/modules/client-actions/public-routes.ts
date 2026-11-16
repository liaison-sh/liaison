// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public token protocol: seven POST routes under /api/public/client-actions,
// mounted before any auth. JSON bodies of at most 16 KB carry the token; it is
// never in a path, a query or a header, so no log line holds it (the link is
// `/a#t=<token>`, a fragment). Every answer is `no-store`.
//
// Limits are keyed on the token's hash, never the token: per address 30 a minute
// and 300 an hour, per token 60 an hour (1,000 for page pictures), and 20 misses
// an hour per address. A token that matches nothing gets one body, one status,
// padded to one time, however close it is to a real one. Redis down: 503 `down`.

import { toShippedLocale } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { hashToken } from "~/lib/crypto"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { RequestBodyTooLargeError, readRequestTextWithLimit } from "~/lib/request-body"
import { getClientIp } from "~/lib/request-context"
import { padToResponseFloor } from "~/lib/response-timing"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { serverT } from "~/modules/i18n/server-i18n"
import {
  checkCode,
  issueCode,
  issueProof,
  PAUSES_TO_TELL,
  pausedUntil,
  takeCodeSend,
  WRONG_PER_CODE,
  WRONG_TOTAL_LOCK,
} from "./codes"
import {
  type ActionRow,
  cleanTyped,
  deadFrameBody,
  decideClientAction,
  findByTokenHash,
  frameOf,
  openFrameBody,
  viewOf,
} from "./decide"
import { readTargetFile } from "./document-files"
import { writeClientActionEvent } from "./events"
import { maskEmail, newActionMailId, sendCodeMail, sendCopyMail } from "./mail"
import { remailClientAction, SYSTEM_ACTOR_ID } from "./mint"

const log = rootLogger.child({ module: "client-actions" })

export const CLIENT_ACTIONS_PUBLIC_PREFIX = "/api/public/client-actions"
export const CLIENT_ACTION_BODY_MAX_BYTES = 16 * 1024
const COPY_PER_DAY = 3
const RESEND_PER_DAY = 3
const ACTIVE_WINDOW_MINUTES = 30

const K = () => sql.raw(schemaRef("kernel"))

const NOT_FOUND_BODY = JSON.stringify({ error: { code: "not_found" } })

function caJson(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

const tokenSchema = z.string().min(16).max(128)

type Ctx = {
  ip: string
  userAgent: string | null
  started: number
  body: Record<string, unknown>
  hash: string
  match: { row: ActionRow; via: "current" | "prior" }
}

class Answer {
  constructor(public readonly res: Response) {}
}

async function takeClientActionBudget(
  buckets: Array<{ identifier: string; limit: number; windowSeconds: number }>,
): Promise<void> {
  let r: Awaited<ReturnType<typeof checkRateLimit>>
  try {
    r = await checkRateLimit(redis, buckets)
  } catch (err) {
    log.error({ err }, "client action limiter failed: refusing (fail closed)")
    throw new Answer(caJson(503, { state: "down" }))
  }
  if (!r.allowed) {
    const res = caJson(429, { error: { code: "rate_limited" } })
    res.headers.set("Retry-After", String(r.failed.retryAfterSeconds))
    throw new Answer(res)
  }
}

/** One answer for every token that names nothing: same body, status and time. */
async function clientActionNotFound(ip: string, started: number): Promise<never> {
  await takeClientActionBudget([
    { identifier: `ca:miss:${ip}:hour`, limit: 20, windowSeconds: 3600 },
  ])
  await padToResponseFloor(started)
  throw new Answer(
    new Response(NOT_FOUND_BODY, {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  )
}

/** Reads the body and the token, takes the budgets, finds the action. */
async function enterClientAction(
  c: { req: { raw: Request; header(n: string): string | undefined } },
  ip: string,
  opts: { page?: boolean } = {},
): Promise<Ctx> {
  const started = performance.now()
  let raw: string
  try {
    raw = await readRequestTextWithLimit(c.req.raw, CLIENT_ACTION_BODY_MAX_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      throw new Answer(caJson(413, { error: { code: "payload_too_large" } }))
    }
    throw err
  }
  let body: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    // A body that is not JSON names no token: the one not-found answer below.
  }
  await takeClientActionBudget([
    { identifier: `ca:ip:${ip}:minute`, limit: 30, windowSeconds: 60 },
    { identifier: `ca:ip:${ip}:hour`, limit: 300, windowSeconds: 3600 },
  ])
  const t = tokenSchema.safeParse(body.t)
  if (!t.success) return clientActionNotFound(ip, started)
  const hash = hashToken(t.data)
  await takeClientActionBudget([
    opts.page
      ? { identifier: `ca:tok:${hash}:page:hour`, limit: 1000, windowSeconds: 3600 }
      : { identifier: `ca:tok:${hash}:hour`, limit: 60, windowSeconds: 3600 },
  ])
  let found: Awaited<ReturnType<typeof findByTokenHash>>
  try {
    found = await findByTokenHash(hash)
  } catch (err) {
    log.error({ err }, "client action lookup failed")
    throw new Answer(caJson(503, { state: "down" }))
  }
  if (!found) return clientActionNotFound(ip, started)
  const match = found
  return { ip, userAgent: c.req.header("user-agent") ?? null, started, body, hash, match }
}

/**
 * A write or read in the org of the action the posted token named, and only
 * about that action: every statement through here names `row.id`.
 */
function inClientActionOrg<T>(
  row: ActionRow,
  reason: string,
  fn: (tx: Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]) => Promise<T>,
): Promise<T> {
  return withPrivilegedDb(row.org_id, reason, fn)
}

/** The page of a holder whose action is no longer open, with its status. */
function deadAnswer(ctx: Ctx, status = 410): Answer | null {
  const frame = frameOf(ctx.match.row, ctx.match.via)
  if (frame === "open") return null
  return new Answer(caJson(status, deadFrameBody(ctx.match.row, frame)))
}

/** A staff signer acts only in their own signed-in session (bearer access token). */
async function staffSessionHolds(
  row: ActionRow,
  authorization: string | undefined,
): Promise<boolean> {
  if (!row.signer_user_id) return true
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null
  if (!bearer) return false
  try {
    const p = await verifyAccessToken(bearer, env.JWT_SECRET)
    return p.userId === row.signer_user_id && p.orgId === row.org_id && p.restricted !== true
  } catch {
    return false
  }
}

async function recordHolderEvent(
  row: ActionRow,
  name: Parameters<typeof writeClientActionEvent>[1]["event"],
  ctx: Pick<Ctx, "ip" | "userAgent">,
  extra: { meta?: Record<string, unknown>; mailId?: string } = {},
  then?: (tx: Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]) => Promise<void>,
): Promise<void> {
  await inClientActionOrg(row, "client-action-event", async (tx) => {
    await writeClientActionEvent(tx, {
      orgId: row.org_id,
      actionId: row.id,
      event: name,
      actorKind: "holder",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      ...extra,
    })
    if (then) await then(tx)
  })
}

function queueClientActionEvent(
  tx: Parameters<Parameters<typeof withPrivilegedDb>[2]>[0],
  row: ActionRow,
  action: "opened" | "requested" | "code_locked",
  data: Record<string, unknown>,
) {
  return tx.queueEvent({
    app: "kernel",
    entity: "client_action",
    action,
    entityId: row.id,
    data: {
      id: row.id,
      kind: row.kind,
      companyId: row.company_id,
      invitedName: row.invited_name,
      senderUserIds: row.created_by_user_id ? [row.created_by_user_id] : [],
      ...data,
    },
    actorId: SYSTEM_ACTOR_ID,
    actorType: "system",
    orgId: row.org_id,
  })
}

function wordsFor(row: ActionRow, title: string, pageLang?: string) {
  const lang =
    toShippedLocale(pageLang ?? undefined) ??
    toShippedLocale(row.sender_locale ?? undefined) ??
    "en"
  const words_key = `client-action.words.${row.kind}`
  return { words: serverT(lang, words_key, { title }), words_key, lang }
}

type Handler = (
  ctx: Ctx,
  c: { req: { header(n: string): string | undefined } },
) => Promise<Response>

function clientActionRouteHandler(
  clientActionStep: Handler,
  opts: { page?: (body: unknown) => boolean } = {},
) {
  return async (c: Context<AppEnv>) => {
    const ip = getClientIp(c)
    try {
      // The page bucket is chosen from the body, so peek it through a clone.
      let page = false
      if (opts.page) {
        try {
          page = opts.page(JSON.parse(await c.req.raw.clone().text()))
        } catch {
          page = false
        }
      }
      const ctx = await enterClientAction(c, ip, { page })
      return await clientActionStep(ctx, c)
    } catch (err) {
      if (err instanceof Answer) return err.res
      log.error({ err, path: c.req.path }, "client action route failed")
      return caJson(503, { state: "down" })
    }
  }
}

export const clientActionPublicRoutes = new Hono<AppEnv>()

clientActionPublicRoutes.post(
  "/open",
  clientActionRouteHandler(async (ctx) => {
    const { row } = ctx.match
    const dead = deadAnswer(ctx, 200)
    if (dead) return dead.res
    if (env.LIAISON_DEMO_MODE) return caJson(503, { state: "down" })
    const view = await viewOf(row)
    if (view === "down") return caJson(503, { state: "down" })
    await recordHolderEvent(row, "link_loaded", ctx)
    return caJson(200, openFrameBody(row, view))
  }),
)

/** The distinct page pictures served to one action: the server's own count for `reached_end`. */
const pagesServedKey = (actionId: string) => `ca:pages:${actionId}`
const PAGES_SERVED_TTL_SECONDS = 60 * 24 * 3600

const seenSchema = z.object({ reached_end: z.boolean().optional() })

// A person's gesture on the page: only this marks the link opened. A scanner's
// POST to `open` changes nothing. With `reached_end`, the page says the last part
// of the document is in view: recorded once, after the document was shown, with
// the number of page pictures the server itself served to this action.
clientActionPublicRoutes.post(
  "/seen",
  clientActionRouteHandler(async (ctx) => {
    const { row } = ctx.match
    const dead = deadAnswer(ctx)
    if (dead) return dead.res
    const reachedEnd = seenSchema.safeParse(ctx.body).data?.reached_end === true
    if (reachedEnd && row.document_shown_at) {
      let pagesServed: number | null = null
      try {
        pagesServed = await redis.scard(pagesServedKey(row.id))
      } catch (err) {
        log.warn({ err, actionId: row.id }, "pages served count unavailable")
      }
      await inClientActionOrg(row, "client-action-reached-end", async (tx) => {
        // One per action: the advisory lock keeps two tabs from writing it twice.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ca-end:${row.id}`}))`)
        const [had] = extractRows<{ n: number }>(
          await tx.execute(sql`
            SELECT count(*)::int AS n FROM ${K()}.client_action_events
             WHERE action_id = ${row.id} AND event = 'reached_end'
          `),
        )
        if ((had?.n ?? 0) > 0) return
        const [at] = extractRows<{ now: string }>(await tx.execute(sql`SELECT now()::text AS now`))
        await writeClientActionEvent(tx, {
          orgId: row.org_id,
          actionId: row.id,
          event: "reached_end",
          actorKind: "holder",
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          meta: {
            reached_end_at: at ? new Date(at.now).toISOString() : null,
            pages_served: pagesServed,
          },
        })
      })
    }
    if (!row.first_opened_at) {
      await inClientActionOrg(row, "client-action-seen", async (tx) => {
        const first = extractRows<{ id: string }>(
          await tx.execute(sql`
            UPDATE ${K()}.client_actions SET first_opened_at = now()
             WHERE id = ${row.id} AND first_opened_at IS NULL RETURNING id
          `),
        )
        if (first.length === 0) return
        await writeClientActionEvent(tx, {
          orgId: row.org_id,
          actionId: row.id,
          event: "opened",
          actorKind: "holder",
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        })
        await queueClientActionEvent(tx, row, "opened", {})
      })
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
  }),
)

const documentSchema = z.object({
  format: z.enum(["blocks", "pdf", "pages", "page", "text"]),
  n: z.number().int().min(1).max(10_000).optional(),
})

clientActionPublicRoutes.post(
  "/document",
  clientActionRouteHandler(
    async (ctx) => {
      const { row } = ctx.match
      const dead = deadAnswer(ctx)
      if (dead) return dead.res
      const parsed = documentSchema.safeParse(ctx.body)
      if (!parsed.success) return caJson(400, { error: { code: "invalid_format" } })
      const view = await viewOf(row)
      if (view === "down") return caJson(503, { state: "down" })
      const format = parsed.data.format
      // The frozen file itself, one tap away: a download, not a proof it was shown.
      if (format === "pdf" || format === "page") {
        const fileId =
          format === "pdf"
            ? view.pdfFileId
            : (view.pages?.find((p) => p.n === parsed.data.n)?.pictureFileId ?? null)
        if (!fileId) return caJson(404, { error: { code: "not_found" } })
        const file = await readTargetFile(row.org_id, row.id, fileId)
        // A picture made at freeze that is gone now is never rebuilt for an open action.
        if (!file) return caJson(503, { state: "down" })
        if (format === "page" && parsed.data.n !== undefined) {
          try {
            await redis.sadd(pagesServedKey(row.id), String(parsed.data.n))
            await redis.expire(pagesServedKey(row.id), PAGES_SERVED_TTL_SECONDS)
          } catch (err) {
            log.warn({ err, actionId: row.id }, "pages served count not kept")
          }
        }
        if (format === "pdf") {
          await recordHolderEvent(row, "document_downloaded", ctx, { meta: { format } })
        }
        return new Response(new Uint8Array(file.bytes), {
          status: 200,
          headers: {
            "content-type": format === "pdf" ? "application/pdf" : "image/webp",
            "content-disposition": format === "pdf" ? "attachment" : "inline",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        })
      }
      const content =
        format === "blocks"
          ? view.sourceBlocks
          : format === "text"
            ? view.text
            : view.pages
              ? view.pages.map((p) => ({ n: p.n, sha256: p.sha256, text: p.text }))
              : null
      if (content === null) return caJson(404, { error: { code: "not_found" } })
      // Only the frozen source or the page list shows the document; the text alone does not.
      if (format === "text") return caJson(200, { format, content })
      if (!row.document_shown_at) {
        await inClientActionOrg(row, "client-action-shown", async (tx) => {
          const first = extractRows<{ id: string }>(
            await tx.execute(sql`
              UPDATE ${K()}.client_actions SET document_shown_at = now()
               WHERE id = ${row.id} AND document_shown_at IS NULL RETURNING id
            `),
          )
          if (first.length === 0) return
          await writeClientActionEvent(tx, {
            orgId: row.org_id,
            actionId: row.id,
            event: "document_shown",
            actorKind: "holder",
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            meta: {
              format,
              ...(format === "pages" && view.pagesSha256 ? { pages_sha256: view.pagesSha256 } : {}),
            },
          })
        })
      }
      return caJson(200, {
        format,
        content,
        ...(format === "pages" && view.pagesSha256 ? { pages_sha256: view.pagesSha256 } : {}),
      })
    },
    { page: (b) => (b as { format?: unknown })?.format === "page" },
  ),
)

clientActionPublicRoutes.post(
  "/code",
  clientActionRouteHandler(async (ctx) => {
    const { row } = ctx.match
    const dead = deadAnswer(ctx)
    if (dead) return dead.res
    if (!row.document_shown_at) return caJson(409, { error: { code: "DOCUMENT_NOT_SHOWN" } })
    if (env.LIAISON_DEMO_MODE) return caJson(403, { error: { code: "NO_MAIL_ON_DEMO" } })
    const until = await pausedUntil(row.id)
    if (until) return caJson(423, { error: { code: "paused", retry_at: until.toISOString() } })
    const budget = await takeCodeSend(row.id)
    if (!budget.ok) {
      return caJson(429, {
        error: { code: "rate_limited", retry_at: budget.retryAt.toISOString() },
      })
    }
    const view = await viewOf(row)
    if (view === "down") return caJson(503, { state: "down" })
    const code = await issueCode(row.id)
    const mailId = newActionMailId()
    try {
      await sendCodeMail({
        orgId: row.org_id,
        to: row.invited_email,
        mailId,
        title: view.title,
        kind: row.kind,
        code,
        orgName: row.org_name,
        locale: row.sender_locale,
      })
    } catch (err) {
      log.error({ err, actionId: row.id }, "client action code mail failed")
      return caJson(502, { error: { code: "send_failed" } })
    }
    await recordHolderEvent(row, "code_sent", ctx, { mailId })
    return caJson(202, {
      sent_to: maskEmail(row.invited_email),
      next_at: new Date(Date.now() + 60_000).toISOString(),
    })
  }),
)

const verifySchema = z.object({
  code: z.string().max(12),
  name: z.string().max(400),
  capacity: z.string().max(400).optional(),
  /** The language the page is shown in: the consent words are given and stored in it. */
  lang: z.string().max(16).optional(),
})

clientActionPublicRoutes.post(
  "/verify",
  clientActionRouteHandler(async (ctx, c) => {
    const { row } = ctx.match
    const dead = deadAnswer(ctx)
    if (dead) return dead.res
    if (!(await staffSessionHolds(row, c.req.header("authorization")))) {
      return caJson(401, { error: { code: "session_required" } })
    }
    const parsed = verifySchema.safeParse(ctx.body)
    if (!parsed.success) return caJson(400, { error: { code: "invalid_body" } })
    const name = cleanTyped(parsed.data.name)
    const capacity = cleanTyped(parsed.data.capacity)
    if (!name || name === "invalid" || capacity === "invalid") {
      return caJson(400, { error: { code: "invalid_text" } })
    }
    const check = await checkCode(row.id, parsed.data.code.trim())
    if (!check.ok) {
      if (check.reason === "paused") {
        return caJson(423, { error: { code: "paused", retry_at: check.until.toISOString() } })
      }
      if (check.reason === "no_code") return caJson(401, { error: { code: "code_ended" } })
      // Wrong: the total lives on the row, so neither a new code nor a new address resets it.
      const total = await inClientActionOrg(row, "client-action-code-wrong", async (tx) => {
        const [r] = extractRows<{ code_wrong_total: number; locked: boolean }>(
          await tx.execute(sql`
            UPDATE ${K()}.client_actions
               SET code_wrong_total = code_wrong_total + 1,
                   code_locked_at = CASE WHEN code_wrong_total + 1 >= ${WRONG_TOTAL_LOCK}
                                         THEN coalesce(code_locked_at, now()) ELSE code_locked_at END
             WHERE id = ${row.id}
             RETURNING code_wrong_total, (code_locked_at IS NOT NULL) AS locked
          `),
        )
        await writeClientActionEvent(tx, {
          orgId: row.org_id,
          actionId: row.id,
          event: r?.locked ? "locked" : check.pausedNow ? "paused" : "code_wrong",
          actorKind: "holder",
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        })
        if (r?.locked || check.pausesInARow >= PAUSES_TO_TELL) {
          await queueClientActionEvent(tx, row, "code_locked", { locked: r?.locked === true })
        }
        return r
      })
      if (total?.locked) return caJson(410, deadFrameBody(row, "attempts"))
      if (check.pausedNow) {
        const until2 = await pausedUntil(row.id)
        return caJson(423, { error: { code: "paused", retry_at: until2?.toISOString() ?? null } })
      }
      return caJson(401, {
        error: { code: "wrong_code", left: WRONG_PER_CODE - check.wrongForCode },
      })
    }
    const view = await viewOf(row)
    if (view === "down") return caJson(503, { state: "down" })
    const words = wordsFor(row, view.title, parsed.data.lang)
    await inClientActionOrg(row, "client-action-code-ok", async (tx) => {
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET code_verified_at = now(), words_shown = ${words.words}, words_key = ${words.words_key},
               words_lang = ${words.lang}
         WHERE id = ${row.id} AND decided_at IS NULL AND revoked_at IS NULL
      `)
      await writeClientActionEvent(tx, {
        orgId: row.org_id,
        actionId: row.id,
        event: "code_ok",
        actorKind: "holder",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
    })
    const proof = await issueProof(row.id, ctx.userAgent, name, capacity)
    return caJson(200, { proof, words: words.words, words_key: words.words_key })
  }),
)

const decideSchema = z.object({
  proof: z.string().max(128).optional(),
  decision: z.enum(["sign", "accept", "approve", "decline"]),
  typed_name: z.string().max(400).optional(),
  typed_phrase: z.string().max(400).optional(),
  reason: z.string().max(4000).optional(),
})

clientActionPublicRoutes.post(
  "/decide",
  clientActionRouteHandler(async (ctx, c) => {
    const { row } = ctx.match
    const parsed = decideSchema.safeParse(ctx.body)
    if (!parsed.success) return caJson(400, { error: { code: "invalid_body" } })
    if (ctx.match.via === "prior") return caJson(410, deadFrameBody(row, "replaced"))
    if (!(await staffSessionHolds(row, c.req.header("authorization")))) {
      return caJson(401, { error: { code: "session_required" } })
    }
    const out = await decideClientAction({
      via: "link",
      tokenHash: ctx.hash,
      proof: parsed.data.proof,
      decision: parsed.data.decision,
      typedName: parsed.data.typed_name,
      typedPhrase: parsed.data.typed_phrase,
      reason: parsed.data.reason,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    })
    if (!out.ok) return caJson(out.status, out.body)
    return caJson(200, { state: out.state, copy_to: out.copyTo })
  }),
)

const requestSchema = z.object({
  type: z.enum(["new_link", "resend_link", "copy", "not_me", "invite_asked", "question"]),
  email: z.string().max(320).optional(),
  text: z.string().max(4000).optional(),
})

/** Takes one of `max` a day for this action and kind of request. */
async function takeDaily(kind: string, actionId: string, max: number): Promise<boolean> {
  const key = `ca:req:${kind}:${actionId}`
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, 86_400)
  return n <= max
}

// Every request answers the same 202: what was asked is never confirmed to the
// page, and nothing is ever mailed to an address the holder typed.
clientActionPublicRoutes.post(
  "/request",
  clientActionRouteHandler(async (ctx) => {
    const { row, via } = ctx.match
    const parsed = requestSchema.safeParse(ctx.body)
    if (!parsed.success) return caJson(400, { error: { code: "invalid_body" } })
    const accepted = () => caJson(202, { accepted: true })
    const type = parsed.data.type
    if (type === "resend_link") {
      // Only from the replaced page, and never over a link in use in the last 30 minutes.
      if (via !== "prior" || row.decided_at || row.revoked_at) return accepted()
      const [active] = await inClientActionOrg(row, "client-action-active", async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(sql`
            SELECT count(*)::int AS n FROM ${K()}.client_action_events
             WHERE action_id = ${row.id} AND actor_kind = 'holder'
               AND at > now() - make_interval(mins => ${ACTIVE_WINDOW_MINUTES})
          `),
        ),
      )
      if ((active?.n ?? 0) > 0) return accepted()
      if (!(await takeDaily("resend", row.id, RESEND_PER_DAY))) return accepted()
      await remailClientAction(row.org_id, row.id, { resend: true })
      return accepted()
    }
    if (type === "copy") {
      if (!row.decided_at || !row.decision) return accepted()
      if (!(await takeDaily("copy", row.id, COPY_PER_DAY))) return accepted()
      const view = await viewOf(row)
      const mailId = newActionMailId()
      void sendCopyMail({
        orgId: row.org_id,
        to: row.invited_email,
        mailId,
        title: view === "down" ? row.org_name : view.title,
        kind: row.kind,
        orgName: row.org_name,
        decision: row.decision,
        decidedAt: row.decided_at,
        senderEmail: row.sender_email,
        locale: row.sender_locale,
      }).catch(() => {})
      await recordHolderEvent(row, "copy_resent", ctx, { mailId })
      return accepted()
    }
    const eventName =
      type === "new_link"
        ? "new_link_asked"
        : type === "not_me"
          ? "not_me"
          : type === "invite_asked"
            ? "invite_asked"
            : "question_asked"
    const text = type === "question" ? cleanTyped(parsed.data.text, 2000) : null
    await recordHolderEvent(
      row,
      eventName,
      ctx,
      { meta: text && text !== "invalid" ? { text } : {} },
      async (tx) => {
        await queueClientActionEvent(tx, row, "requested", { what: type })
      },
    )
    return accepted()
  }),
)
