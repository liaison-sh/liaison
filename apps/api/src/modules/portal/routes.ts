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
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import {
  type PortalClient,
  PortalContextRefusedError,
  PortalUnavailableError,
  withPortalContext,
} from "~/db/portal-rls"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { streamPortalFile } from "~/modules/portal/file-stream"
import { PORTAL_ROUTES, routerPath } from "~/modules/portal/routes-list"

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
const PROJECTS = drizzleSql`SELECT id, name, owner_name FROM portal.projects ORDER BY name, id`
const INVOICES = drizzleSql`SELECT id, type, number, status, payment_status, currency,
  subtotal_minor::text AS subtotal_minor, tax_total_minor::text AS tax_total_minor,
  grand_total_minor::text AS grand_total_minor, issued_at, due_at, paid_at, original_document_id,
  label, pdf_file_id IS NOT NULL AS has_pdf
  FROM portal.invoices ORDER BY issued_at DESC, id`
const UPCOMING = drizzleSql`SELECT label, amount_minor::text AS amount_minor, currency, due_on
  FROM portal.billing_upcoming ORDER BY due_on NULLS LAST, label`
const TICKETS = drizzleSql`SELECT id, subject, status, channel, created_at, last_message_at
  FROM portal.tickets ORDER BY COALESCE(last_message_at, created_at) DESC, id LIMIT 100`

/** The routes this file serves; the rest of PORTAL_ROUTES answer 404 until built. */
const BUILT = new Set([
  "GET /me",
  "GET /home",
  "GET /projects",
  "GET /projects/:id",
  "GET /invoices",
  "GET /invoices/:id/pdf",
  "GET /requests",
  "GET /files/:id",
])

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
  .get("/me", async (c) => {
    const me = await portalRead(c, async (tx) =>
      extractRows<Record<string, unknown>>(await tx.execute(ME)),
    )
    if (me instanceof Response) return me
    const [row] = me
    if (!row) return c.json({ error: { message: "Unauthorized" } }, 401)
    return success(c, camel(row))
  })
  .get("/home", async (c) => {
    const home = await portalRead(c, async (tx) => {
      const [me] = extractRows<Record<string, unknown>>(await tx.execute(ME))
      const projects = rows(await part(tx, "projects", PROJECTS))
      const invoices = rows(await part(tx, "invoices", INVOICES))
      const upcoming = rows(await part(tx, "billing_upcoming", UPCOMING))
      const requests = await ticketsWithMessages(tx)
      const unavailable = [
        projects === null && "projects",
        invoices === null && "invoices",
        upcoming === null && "upcoming",
        requests === null && "requests",
      ].filter((x): x is string => typeof x === "string")
      return {
        me: me ? camel(me) : null,
        projects,
        invoices,
        upcoming,
        requests,
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
      return {
        ...camel(p),
        steps,
        hours: hours === UNAVAILABLE ? null : hours[0] ? camel(hours[0]) : null,
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
      return (await streamPortalFile(ctx, pdf)) ?? notFound(c)
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
  .get("/files/:id", async (c) => {
    const id = c.req.param("id")
    try {
      return (await streamPortalFile(portalOf(c), id)) ?? notFound(c)
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
