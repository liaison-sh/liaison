// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's data routes, behind portalAuthMiddleware. Every read runs
// under withPortalContext on the portal's own login, so what a client sees is
// what the views of schema `portal` give the portal role, never a filter a route
// remembers. A route of PORTAL_ROUTES whose part is not built yet answers 404.
//
// Any id the views do not answer for (another company's, a draft's, a closed
// share's, a random one) gets the one 404 body. A part whose view is absent or
// fails answers as unavailable, and the other parts still answer.
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import {
  type PortalClient,
  PortalContextRefusedError,
  PortalUnavailableError,
  withPortalContext,
} from "~/db/portal-rls"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { AuthServiceError } from "~/modules/auth/auth"
import { wordsFor } from "~/modules/client-actions/code-attempt"
import { decideClientAction } from "~/modules/client-actions/decide"
import { sendPortalActionCode } from "~/modules/client-actions/portal-code"
import { recordPortalAccess } from "~/modules/portal/access"
import { portalSignedIn } from "~/modules/portal/auth-routes"
import {
  ackPortalNotice,
  beginPortalTotpSetup,
  confirmPortalTotp,
} from "~/modules/portal/auth-service"
import { streamPortalFile } from "~/modules/portal/file-stream"
import { portalWriteRateLimit } from "~/modules/portal/rate-limits"
import { PORTAL_ROUTES, routerPath } from "~/modules/portal/routes-list"
import {
  appendPortalReply,
  defaultCreateInboxId,
  ingestTicket,
  PORTAL_ATTACHMENT_MAX_BYTES,
  PORTAL_ATTACHMENT_MAX_COUNT,
  portalStagedFilesOk,
  reparentPortalStagedFiles,
  stagePortalAttachment,
} from "~/modules/tickets/ingest-core"

const log = rootLogger.child({ module: "portal-routes" })

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The caller's portal context, set by portalAuthMiddleware. */
function portalOf(c: Context<AppEnv>) {
  const ctx = c.get("portal")
  if (!ctx) throw new PortalContextRefusedError()
  return ctx
}

const notFound = (c: Context<AppEnv>) => c.json({ error: { message: "Not found" } }, 404)

function refusal(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof PortalContextRefusedError) {
    return c.json({ error: { message: "Unauthorized" } }, 401)
  }
  if (err instanceof PortalUnavailableError) {
    return c.json({ error: { message: "The client portal is not available" } }, 503)
  }
  return null
}

/** Runs a portal read; a refused context is the 401, an absent portal login the 503. */
export async function portalRead<T>(
  c: Context<AppEnv>,
  fn: Parameters<typeof withPortalContext<T>>[1],
): Promise<T | Response> {
  try {
    return await withPortalContext(portalOf(c), fn)
  } catch (err) {
    const refused = refusal(c, err)
    if (refused) return refused
    throw err
  }
}

/** A part that could not be read (its view is absent or failed). */
const UNAVAILABLE = Symbol("unavailable")
type Part<T> = T | typeof UNAVAILABLE

/** Reads one part in a savepoint, so a failed part leaves the transaction usable. */
async function part<T extends Record<string, unknown>>(
  tx: PortalClient,
  name: string,
  query: SQL,
): Promise<Part<T[]>> {
  try {
    return await tx.transaction(async (sp) => extractRows<T>(await sp.execute(query)))
  } catch (err) {
    log.warn({ err, part: name }, "Portal part unavailable")
    return UNAVAILABLE
  }
}

function camel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] =
      typeof v === "bigint" ? v.toString() : v
  }
  return out
}

function rows(p: Part<Record<string, unknown>[]>): Record<string, unknown>[] | null {
  return p === UNAVAILABLE ? null : p.map(camel)
}

const ME = drizzleSql`SELECT id, name, email, locale, timezone, contact_name FROM portal.me`
/** The notice version the caller acknowledged (their own row only), or none. */
const NOTICE_ACK = drizzleSql`SELECT notice_version FROM portal.people_me`

/** The caller with the notice version they acknowledged; a failed read reads as none. */
async function meWithNotice(
  tx: PortalClient,
  me: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | null> {
  if (!me) return null
  const ack = await part<{ notice_version: number | null }>(tx, "people_me", NOTICE_ACK)
  const version = ack === UNAVAILABLE ? null : (ack[0]?.notice_version ?? null)
  return { ...camel(me), noticeVersion: version }
}

const PROJECTS = drizzleSql`SELECT id, name, owner_name FROM portal.projects ORDER BY name, id`
const INVOICES = drizzleSql`SELECT id, type, number, status, payment_status, currency,
  subtotal_minor::text AS subtotal_minor, tax_total_minor::text AS tax_total_minor,
  grand_total_minor::text AS grand_total_minor, issued_at, due_at, paid_at, original_document_id,
  label, pdf_file_id IS NOT NULL AS has_pdf
  FROM portal.invoices ORDER BY issued_at DESC, id`
// Coming up means ahead: a step whose date has passed unbilled is not offered as coming up.
const UPCOMING = drizzleSql`SELECT id, label, amount_minor::text AS amount_minor, currency, due_on
  FROM portal.billing_upcoming WHERE due_on IS NULL OR due_on >= current_date
  ORDER BY due_on NULLS LAST, label, id`
const TICKETS = drizzleSql`SELECT id, subject, status, channel, created_at, last_message_at
  FROM portal.tickets ORDER BY COALESCE(last_message_at, created_at) DESC, id LIMIT 100`

/** The portal's own home reads, by part: staff's preview (admin-routes.ts) runs these same ones. */
export const PORTAL_HOME_READS = {
  me: ME,
  projects: PROJECTS,
  invoices: INVOICES,
  upcoming: UPCOMING,
  requests: TICKETS,
} as const

/** The routes this file serves; the rest of PORTAL_ROUTES answer 404 until built. */
const BUILT = new Set([
  "GET /me",
  "POST /me/notice-ack",
  "POST /me/totp/setup",
  "POST /me/totp/confirm",
  "GET /home",
  "GET /projects",
  "GET /projects/:id",
  "GET /invoices",
  "GET /invoices/:id/pdf",
  "GET /requests",
  "POST /requests",
  "POST /requests/:id/reply",
  "POST /requests/attachments",
  "GET /files/:id",
  "GET /documents",
  "GET /documents/:id",
  "GET /documents/:id/pages/:n",
  "POST /actions/:id/code",
  "POST /actions/:id/decide",
])

/** Each decision is logged by its own name: a decline never reads as an approval. */
const DECISION_LOG_ACTION = {
  sign: "portal.sign",
  accept: "portal.accept",
  approve: "portal.approve",
  decline: "portal.decline",
} as const

const decideSchema = z.object({
  decision: z.enum(["sign", "accept", "approve", "decline"]),
  code: z.string().max(12).optional(),
  typed_name: z.string().max(400).optional(),
  typed_phrase: z.string().max(400).optional(),
  capacity: z.string().max(400).optional(),
  reason: z.string().max(4000).optional(),
  lang: z.string().max(16).optional(),
})

const AGREEMENTS = drizzleSql`SELECT id, number, kind, title, status, signed_at,
  price_minor::text AS price_minor, currency FROM portal.agreements`

/** The links of the caller's company on these targets: who each waits on, and whether it is theirs. */
const actionsOn = (
  targetIds: string[],
) => drizzleSql`SELECT a.id, a.kind, a.target_id, a.invited_name,
    a.expires_at, a.decided_at, a.decision, a.revoked_at,
    (a.invited_email = (SELECT lower(m.email) FROM portal.me m)) AS mine
  FROM portal.client_actions a
 WHERE a.target_id = ANY(${`{${targetIds.join(",")}}`}::uuid[])
 ORDER BY a.created_at, a.id`

/** Whether the app's view is there: without it there is nothing to list. */
async function viewPresent(tx: PortalClient, name: string): Promise<boolean> {
  const [view] = extractRows<{ present: boolean }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${`portal.${name}`}) IS NOT NULL AS present`),
  )
  return view?.present === true
}

const requestSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
  attachmentFileIds: z.array(z.string().uuid()).max(PORTAL_ATTACHMENT_MAX_COUNT).optional(),
})
const noticeAckSchema = z.object({ version: z.number().int().min(1).max(1_000_000) })
const totpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) })

/** An auth service refusal as the portal answers it. */
function authRefusal(c: Context<AppEnv>, err: unknown): Response | null {
  if (!(err instanceof AuthServiceError)) return null
  const status = err.status === 409 || err.status === 400 || err.status === 429 ? err.status : 401
  return c.json({ error: { message: err.message } }, status)
}

const replySchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  attachmentFileIds: z.array(z.string().uuid()).max(PORTAL_ATTACHMENT_MAX_COUNT).optional(),
})

interface Requester {
  email: string
  name: string
  company_id: string
  contact_id: string | null
  open: boolean
}

/** Who writes, and whether their company's requests are open: read as the portal role. */
async function requesterOf(tx: PortalClient): Promise<Requester | null> {
  const [row] = extractRows<Requester>(
    await tx.execute(drizzleSql`SELECT m.email, m.name, m.company_id,
      (SELECT portal.contact_id()) AS contact_id,
      EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'requests' AND s.object_id IS NULL) AS open
      FROM portal.me m`),
  )
  return row ?? null
}

const refuse = (
  c: Context<AppEnv>,
  status: 400 | 404 | 409 | 413 | 422 | 503,
  code: string,
  message: string,
) => c.json({ error: { code, message } }, status)

async function ticketsWithMessages(tx: PortalClient) {
  const tickets = await part<Record<string, unknown>>(tx, "requests", TICKETS)
  if (tickets === UNAVAILABLE) return null
  const ids = tickets.map((t) => String(t.id))
  const messages =
    ids.length === 0
      ? []
      : await part<Record<string, unknown>>(
          tx,
          "request_messages",
          drizzleSql`SELECT id, ticket_id, kind, from_name, author_label, text_body, sent_at
            FROM portal.ticket_messages
           WHERE ticket_id = ANY(${`{${ids.join(",")}}`}::uuid[])
           ORDER BY sent_at, id`,
        )
  const byTicket = new Map<string, Record<string, unknown>[]>()
  if (messages !== UNAVAILABLE) {
    for (const m of messages) {
      const key = String(m.ticket_id)
      const { ticket_id: _t, ...rest } = m
      byTicket.set(key, [...(byTicket.get(key) ?? []), camel(rest)])
    }
  }
  return tickets.map((t) => ({
    ...camel(t),
    messages: messages === UNAVAILABLE ? null : (byTicket.get(String(t.id)) ?? []),
  }))
}

export const portalRoutes = new Hono<AppEnv>()
  // Every write has its budget, counted before its body is read (rate-limits.ts).
  .use("*", portalWriteRateLimit(redis))
  .get("/me", async (c) => {
    const me = await portalRead(c, async (tx) =>
      meWithNotice(tx, extractRows<Record<string, unknown>>(await tx.execute(ME))[0]),
    )
    if (me instanceof Response) return me
    if (!me) return c.json({ error: { message: "Unauthorized" } }, 401)
    return success(c, me)
  })
  .get("/home", async (c) => {
    const viewer = portalOf(c)
    recordPortalAccess({
      orgId: viewer.orgId,
      userId: viewer.userId,
      action: "portal.view",
      entityType: "home",
      userAgent: c.req.header("user-agent") ?? null,
    })
    const home = await portalRead(c, async (tx) => {
      const me = await meWithNotice(
        tx,
        extractRows<Record<string, unknown>>(await tx.execute(ME))[0],
      )
      const projects = rows(await part(tx, "projects", PROJECTS))
      const invoices = rows(await part(tx, "invoices", INVOICES))
      const upcoming = rows(await part(tx, "billing_upcoming", UPCOMING))
      const requests = await ticketsWithMessages(tx)
      // Whether the company may send requests here: the page offers a new request only then.
      const who = await tx.transaction((sp) => requesterOf(sp)).catch(() => null)
      const unavailable = [
        projects === null && "projects",
        invoices === null && "invoices",
        upcoming === null && "upcoming",
        requests === null && "requests",
      ].filter((x): x is string => typeof x === "string")
      return {
        me,
        projects,
        invoices,
        upcoming,
        requests,
        requestsOpen: who?.open === true && who.contact_id !== null,
        unavailable,
      }
    })
    if (home instanceof Response) return home
    return success(c, home)
  })
  .get("/projects", async (c) => {
    const list = await portalRead(c, async (tx) => rows(await part(tx, "projects", PROJECTS)))
    if (list instanceof Response) return list
    if (list === null) return c.json({ error: { message: "This part is not available" } }, 503)
    return success(c, list)
  })
  .get("/projects/:id", async (c) => {
    const id = c.req.param("id")
    if (!UUID.test(id)) return notFound(c)
    const project = await portalRead(c, async (tx) => {
      const [p] = extractRows<Record<string, unknown>>(
        await tx.execute(
          drizzleSql`SELECT id, name, owner_name FROM portal.projects WHERE id = ${id}::uuid`,
        ),
      )
      if (!p) return null
      // Listed behind any of its progress, reports or hours shares: the steps show only with
      // its progress open. A failed read of that leaves the steps part as it answers.
      const progress = await part<{ open: boolean }>(
        tx,
        "project_progress",
        drizzleSql`SELECT EXISTS (SELECT 1 FROM portal.shares
          WHERE kind = 'project_progress' AND object_id = ${id}::uuid) AS open`,
      )
      const stepsShown = progress === UNAVAILABLE || progress[0]?.open === true
      const steps = rows(
        await part(
          tx,
          "project_steps",
          drizzleSql`SELECT id, title, state, done_share, due_on FROM portal.project_steps
            WHERE project_id = ${id}::uuid ORDER BY due_on NULLS LAST, title, id`,
        ),
      )
      const hours = await part<Record<string, unknown>>(
        tx,
        "project_hours",
        drizzleSql`SELECT kind, used_minutes::int AS used_minutes, of_minutes::int AS of_minutes, period
          FROM portal.project_hours(${id}::uuid)`,
      )
      const shown = hours === UNAVAILABLE ? null : hours[0] ? camel(hours[0]) : null
      // No hours row: say why only when the project bills by milestone. A closed hours share
      // answers nothing at all, the same as a project with no hours.
      const basis = shown
        ? []
        : await part<{ note: string | null }>(
            tx,
            "project_hours",
            drizzleSql`SELECT portal.project_hours_basis(${id}::uuid) AS note`,
          )
      const note = basis === UNAVAILABLE ? null : (basis[0]?.note ?? null)
      return {
        ...camel(p),
        steps,
        stepsShown,
        hours: shown,
        hoursNote: note === "by_milestone" ? "by_milestone" : null,
      }
    })
    if (project instanceof Response) return project
    if (!project) return notFound(c)
    return success(c, project)
  })
  .get("/invoices", async (c) => {
    const list = await portalRead(c, async (tx) => {
      // The view comes with the invoicing app: without it there is nothing to list.
      const [view] = extractRows<{ present: boolean }>(
        await tx.execute(drizzleSql`SELECT to_regclass('portal.invoices') IS NOT NULL AS present`),
      )
      if (!view?.present) return []
      return rows(await part(tx, "invoices", INVOICES))
    })
    if (list instanceof Response) return list
    if (list === null) return c.json({ error: { message: "This part is not available" } }, 503)
    return success(c, list)
  })
  .get("/invoices/:id/pdf", async (c) => {
    const id = c.req.param("id")
    if (!UUID.test(id)) return notFound(c)
    const ctx = portalOf(c)
    try {
      const pdf = await withPortalContext(ctx, async (tx) => {
        const found = await part<{ pdf_file_id: string | null }>(
          tx,
          "invoice_pdf",
          drizzleSql`SELECT pdf_file_id FROM portal.invoices WHERE id = ${id}::uuid`,
        )
        return found === UNAVAILABLE ? null : (found[0]?.pdf_file_id ?? null)
      })
      if (!pdf) return notFound(c)
      const streamed = await streamPortalFile(ctx, pdf)
      if (!streamed) return notFound(c)
      recordPortalAccess({
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: "portal.download",
        entityType: "invoice",
        entityId: id,
        userAgent: c.req.header("user-agent") ?? null,
      })
      return streamed
    } catch (err) {
      const refused = refusal(c, err)
      if (refused) return refused
      throw err
    }
  })
  .get("/requests", async (c) => {
    const list = await portalRead(c, (tx) => ticketsWithMessages(tx))
    if (list instanceof Response) return list
    if (list === null) return c.json({ error: { message: "This part is not available" } }, 503)
    return success(c, list)
  })
  .post("/me/notice-ack", zValidator("json", noticeAckSchema), async (c) => {
    const ctx = portalOf(c)
    const me = await portalRead(c, async (tx) => extractRows(await tx.execute(ME)))
    if (me instanceof Response) return me
    try {
      return success(c, await ackPortalNotice(ctx.userId, ctx.orgId, c.req.valid("json").version))
    } catch (err) {
      if (err instanceof AuthServiceError && err.status === 409)
        return c.json({ error: { code: "NOTICE_CHANGED", message: err.message } }, 409)
      throw err
    }
  })
  .post("/me/totp/setup", async (c) => {
    const ctx = portalOf(c)
    try {
      return success(c, await beginPortalTotpSetup(ctx.userId, ctx.orgId))
    } catch (err) {
      const refused = authRefusal(c, err)
      if (refused) return refused
      throw err
    }
  })
  .post("/me/totp/confirm", zValidator("json", totpConfirmSchema), async (c) => {
    const ctx = portalOf(c)
    try {
      const tokens = await confirmPortalTotp({
        userId: ctx.userId,
        orgId: ctx.orgId,
        code: c.req.valid("json").code,
        ip: getClientIp(c),
      })
      return portalSignedIn(c, tokens)
    } catch (err) {
      const refused = authRefusal(c, err)
      if (refused) return refused
      throw err
    }
  })
  .post("/requests", zValidator("json", requestSchema), async (c) => {
    const body = c.req.valid("json")
    const ctx = portalOf(c)
    const who = await portalRead(c, requesterOf)
    if (who instanceof Response) return who
    if (!who?.open || !who.contact_id) return notFound(c)
    const files = body.attachmentFileIds ?? []
    if (!(await portalStagedFilesOk(ctx.orgId, ctx.userId, files))) {
      return refuse(
        c,
        422,
        "unknown_attachment",
        "One or more attachments are not yours or were already sent.",
      )
    }
    // The org's inbox for new tickets from outside, when it has one; a request is a
    // ticket either way.
    const inboxId = (await defaultCreateInboxId(ctx.orgId)) ?? undefined
    // An ordinary ticket: internal, no assignee, stamped with the client's company.
    const created = await ingestTicket(
      ctx.orgId,
      {
        subject: body.subject,
        channel: "web_form",
        sensitivity: "internal",
        sourceInboxId: inboxId,
        requesterEmail: who.email,
        relatedTicketId: null,
        message: { fromEmail: who.email, fromName: who.name, htmlBody: null, textBody: body.text },
        portalRequest: { companyId: who.company_id },
      },
      async () => who.contact_id,
      "portal-request-create",
    )
    if ("error" in created) {
      log.error({ err: created.error, orgId: ctx.orgId }, "Portal request was not created")
      return refuse(c, 422, created.error.code, "Your request was not sent.")
    }
    const attached =
      created.initialMessageId !== undefined &&
      created.initialMessageId !== null &&
      (await reparentPortalStagedFiles(
        ctx.orgId,
        ctx.userId,
        created.initialMessageId,
        files,
        "portal-request-files",
      ))
    return success(c, {
      id: created.ticketId,
      subject: body.subject,
      attachments: attached ? files.length : 0,
    })
  })
  .post("/requests/attachments", async (c) => {
    const ctx = portalOf(c)
    const who = await portalRead(c, requesterOf)
    if (who instanceof Response) return who
    if (!who?.open) return notFound(c)
    const declared = Number(c.req.header("content-length") ?? "0")
    if (declared > PORTAL_ATTACHMENT_MAX_BYTES + 64 * 1024) {
      return refuse(c, 413, "payload_too_large", "A file may be 10 MB at most.")
    }
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return refuse(c, 400, "invalid_multipart", "Send the file as multipart field 'file'.")
    }
    const part = form.get("file")
    if (!(part instanceof Blob))
      return refuse(c, 400, "missing_file", "Send the file as multipart field 'file'.")
    if (part.size > PORTAL_ATTACHMENT_MAX_BYTES) {
      return refuse(c, 413, "payload_too_large", "A file may be 10 MB at most.")
    }
    const name = (part as Blob & { name?: string }).name
    const staged = await stagePortalAttachment(ctx.orgId, ctx.userId, {
      filename: typeof name === "string" ? name : "attachment",
      mimeType: part.type || "application/octet-stream",
      bytes: new Uint8Array(await part.arrayBuffer()),
    })
    if ("error" in staged) {
      if (staged.error === "too_many") {
        return refuse(c, 422, "too_many_attachments", "Eight files at most wait to be sent.")
      }
      if (staged.error === "storage_quota_exceeded") {
        return refuse(
          c,
          409,
          "storage_quota_exceeded",
          "The organization's storage is full; the file was not kept.",
        )
      }
      if (staged.error === "malware_quarantined") {
        return refuse(c, 422, "malware_quarantined", "The virus scanner refused this file.")
      }
      return refuse(c, 503, "storage_unavailable", "The file could not be kept; try again.")
    }
    return success(c, staged)
  })
  .post("/requests/:id/reply", zValidator("json", replySchema), async (c) => {
    const id = c.req.param("id")
    if (!UUID.test(id)) return notFound(c)
    const body = c.req.valid("json")
    const ctx = portalOf(c)
    const found = await portalRead(c, async (tx) => {
      const who = await requesterOf(tx)
      const [ticket] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`SELECT id FROM portal.tickets WHERE id = ${id}::uuid`),
      )
      return who && ticket ? who : null
    })
    if (found instanceof Response) return found
    if (!found) return notFound(c)
    const files = body.attachmentFileIds ?? []
    if (!(await portalStagedFilesOk(ctx.orgId, ctx.userId, files))) {
      return refuse(
        c,
        422,
        "unknown_attachment",
        "One or more attachments are not yours or were already sent.",
      )
    }
    const messageId = await appendPortalReply(ctx.orgId, {
      ticketId: id,
      fromEmail: found.email,
      fromName: found.name,
      textBody: body.text,
    })
    const attached = await reparentPortalStagedFiles(
      ctx.orgId,
      ctx.userId,
      messageId,
      files,
      "portal-reply-files",
    )
    return success(c, { id: messageId, requestId: id, attachments: attached ? files.length : 0 })
  })
  .get("/documents", async (c) => {
    const list = await portalRead(c, async (tx) => {
      if (!(await viewPresent(tx, "agreements"))) return []
      return rows(
        await part(
          tx,
          "agreements",
          drizzleSql`${AGREEMENTS} ORDER BY signed_at DESC NULLS FIRST, number, id`,
        ),
      )
    })
    if (list instanceof Response) return list
    if (list === null) return c.json({ error: { message: "This part is not available" } }, 503)
    return success(c, list)
  })
  .get("/documents/:id", async (c) => {
    const id = c.req.param("id")
    if (!UUID.test(id)) return notFound(c)
    const viewer = portalOf(c)
    const doc = await portalRead(c, async (tx) => {
      if (!(await viewPresent(tx, "agreements"))) return null
      const found = await part<Record<string, unknown>>(
        tx,
        "agreements",
        drizzleSql`${AGREEMENTS} WHERE id = ${id}::uuid`,
      )
      if (found === UNAVAILABLE) return UNAVAILABLE
      const [a] = found
      if (!a) return null
      const versions = await part<Record<string, unknown>>(
        tx,
        "agreement_versions",
        drizzleSql`SELECT id, number, source, sha256, file_id IS NOT NULL AS has_file,
            COALESCE(jsonb_array_length(pages), 0) AS page_count
          FROM portal.agreement_versions WHERE agreement_id = ${id}::uuid ORDER BY number DESC`,
      )
      const versionIds = versions === UNAVAILABLE ? [] : versions.map((v) => String(v.id))
      // The sealed files the caller is given: the signed PDF and their own copy (the
      // stamped one once the timestamp arrived), each downloaded through GET /files/:id.
      const evidence =
        versionIds.length === 0 || !(await viewPresent(tx, "evidence"))
          ? []
          : await part<Record<string, unknown>>(
              tx,
              "evidence",
              drizzleSql`SELECT version_id, signed_pdf_file_id,
                  COALESCE(stamped_signer_copy_file_id, signer_copy_file_id) AS copy_file_id, sealed_at
                FROM portal.evidence
               WHERE version_id IN (${drizzleSql.join(
                 versionIds.map((v) => drizzleSql`${v}::uuid`),
                 drizzleSql`, `,
               )})
               ORDER BY sealed_at DESC`,
            )
      const actions =
        versionIds.length === 0
          ? []
          : await part<Record<string, unknown>>(tx, "client_actions", actionsOn(versionIds))
      const title = `${a.number} ${a.title}`
      return {
        ...camel(a),
        versions: rows(versions),
        evidence: rows(evidence),
        // The consent words come with the caller's own open link: the ones a decision records.
        actions:
          actions === UNAVAILABLE
            ? null
            : actions.map((x) => {
                const { mine, ...rest } = x
                const open = !x.decided_at && !x.revoked_at
                return {
                  ...camel(rest),
                  mine: mine === true,
                  ...(mine === true && open && x.kind !== "approve"
                    ? {
                        words: wordsFor(
                          { kind: x.kind as "sign" | "accept", sender_locale: null },
                          title,
                          c.req.query("lang") ?? undefined,
                        ).words,
                      }
                    : {}),
                }
              }),
      }
    })
    if (doc instanceof Response) return doc
    if (doc === UNAVAILABLE)
      return c.json({ error: { message: "This part is not available" } }, 503)
    if (!doc) return notFound(c)
    recordPortalAccess({
      orgId: viewer.orgId,
      userId: viewer.userId,
      action: "portal.view",
      entityType: "agreement",
      entityId: id,
      userAgent: c.req.header("user-agent") ?? null,
    })
    return success(c, doc)
  })
  // One page picture of a version the caller reads (`:id` the version, or the agreement
  // for its latest readable version). Another company's, an infected file's or an unknown
  // page answers as an unknown id does.
  .get("/documents/:id/pages/:n", async (c) => {
    const id = c.req.param("id")
    const n = Number(c.req.param("n"))
    if (!UUID.test(id) || !Number.isInteger(n) || n < 1 || n > 10_000) return notFound(c)
    const ctx = portalOf(c)
    try {
      const picture = await withPortalContext(ctx, async (tx) => {
        if (!(await viewPresent(tx, "agreement_versions"))) return null
        const found = await part<{ file_id: string | null }>(
          tx,
          "agreement_pages",
          drizzleSql`SELECT p.value->>'file_id' AS file_id
            FROM portal.agreement_versions v, jsonb_array_elements(COALESCE(v.pages, '[]'::jsonb)) p
           WHERE (v.id = ${id}::uuid OR v.agreement_id = ${id}::uuid)
             AND p.value->>'n' = ${String(n)}
           ORDER BY (v.id = ${id}::uuid) DESC, v.number DESC LIMIT 1`,
        )
        return found === UNAVAILABLE ? null : (found[0]?.file_id ?? null)
      })
      if (!picture) return notFound(c)
      const streamed = await streamPortalFile(ctx, picture)
      if (!streamed) return notFound(c)
      return streamed
    } catch (err) {
      const refused = refusal(c, err)
      if (refused) return refused
      throw err
    }
  })
  .post("/actions/:id/code", async (c) => {
    const id = c.req.param("id")
    if (!UUID.test(id)) return notFound(c)
    const ctx = portalOf(c)
    const out = await sendPortalActionCode({
      portal: ctx,
      actionId: id,
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
    })
    if (out.status === 404) return notFound(c)
    return c.json(out.body, out.status as 202)
  })
  .post("/actions/:id/decide", zValidator("json", decideSchema), async (c) => {
    const id = c.req.param("id")
    if (!UUID.test(id)) return notFound(c)
    const ctx = portalOf(c)
    const body = c.req.valid("json")
    const userAgent = c.req.header("user-agent") ?? null
    const out = await decideClientAction({
      via: "portal",
      actionId: id,
      portal: ctx,
      decision: body.decision,
      code: body.code ?? null,
      typedName: body.typed_name ?? null,
      typedPhrase: body.typed_phrase ?? null,
      capacity: body.capacity ?? null,
      reason: body.reason ?? null,
      lang: body.lang ?? null,
      ip: getClientIp(c),
      userAgent,
    })
    if (!out.ok) {
      if (out.status === 404) return notFound(c)
      return c.json(out.body, out.status as 400)
    }
    // The decision is on the person's portal log, as a sign-in or a download is.
    recordPortalAccess({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: DECISION_LOG_ACTION[body.decision],
      entityType: "client_action",
      entityId: id,
      userAgent,
    })
    return success(c, { state: out.state, copyTo: out.copyTo })
  })
  .get("/files/:id", async (c) => {
    const id = c.req.param("id")
    try {
      const ctx = portalOf(c)
      const streamed = await streamPortalFile(ctx, id)
      if (!streamed) return notFound(c)
      recordPortalAccess({
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: "portal.download",
        entityType: "file",
        entityId: id,
        userAgent: c.req.header("user-agent") ?? null,
      })
      return streamed
    } catch (err) {
      const refused = refusal(c, err)
      if (refused) return refused
      throw err
    }
  })

// The rest of the list exists from now on, so the route table under the prefix is
// exactly PORTAL_ROUTES; each answers 404 until its part lands.
for (const route of PORTAL_ROUTES) {
  if (route.access !== "token" || BUILT.has(`${route.method} ${routerPath(route)}`)) continue
  if (route.method === "GET") portalRoutes.get(routerPath(route), notFound)
  else portalRoutes.post(routerPath(route), notFound)
}
