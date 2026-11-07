// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { routines, skills } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import {
  type OpenRecord,
  type OpenTab,
  type OpenView,
  openViewsOf,
  readScopeOf,
  runHasNoViewer,
  tabForId,
} from "~/modules/agent/tools/open-targets"
import {
  externalOnlyDetail,
  getDetailExternalLink,
  resolveConnectionTemplateVars,
} from "~/modules/apps/detail-external-link"
import { hasScope } from "~/modules/permissions/permissions"
import { lookupEntityDecl, resolveEntityNaming } from "~/modules/threads/reference-display"

const log = rootLogger.child({ module: "navigation-tool" })

/** An id that can sit in a tab's route. A detail panel's id is encoded, so it may be wider. */
const TAB_ID = /^[\w:.@-]{1,200}$/
const PANEL_ID = /^[\w:/.@%=+-]{1,200}$/
const LABEL_MAX = 120
/** A reference fit for the model to read: one generated token, never a sentence. */
const REFERENCE = /^[\w.-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface OpenAppContext {
  userId: string
  orgId: string
  /** The actor's RLS transaction. A failed read inside it runs under a savepoint here. */
  db?: any
  scopes?: string[]
  /** The conversation the turn is answering: the requester's screen is reached through it. */
  agentExecutionThreadId?: string
}

type Refused = { ok: false; code: string; message: string; valid?: string[]; url?: string }
type Opened = {
  ok: true
  app: string
  view?: string
  id?: string
  /** What opened: its kind and a generated reference. Never a record's own words. */
  opened?: string
  note?: string
}

function refuse(code: string, message: string, valid?: string[], url?: string): Refused {
  return {
    ok: false,
    code,
    message: `${message} No tab opened.`,
    ...(valid ? { valid } : {}),
    ...(url ? { url } : {}),
  }
}

function describeViews(views: OpenView[]): string {
  return views.map((v) => `${v.view} (${v.label}${v.needsId ? ", takes an id" : ""})`).join(", ")
}

function unknownView(app: string, view: string | undefined, views: OpenView[]): Refused {
  const asked = view ? `${app} has no view "${view}".` : `${app} needs a view for that id.`
  return refuse(
    "UNKNOWN_VIEW",
    `${asked} Its views: ${describeViews(views)}.`,
    views.map((v) => v.view),
  )
}

/** Whether the actor holds the record's reading scope; an undeclared one asks for any of the app's. */
function holdsReadScope(orgId: string, record: OpenRecord, scopes: string[] | undefined): boolean {
  if (!scopes) return false
  const scope = readScopeOf(orgId, record)
  if (scope) return hasScope(scope, scopes)
  if (record.app === "kernel") return true
  return scopes.some((s) => s === "*" || s.startsWith(`${record.app}:`))
}

/** Whether this record can be read here at all: an external one may have no local table. */
async function hasLocalRow(ctx: OpenAppContext, record: OpenRecord): Promise<boolean> {
  if (record.app === "kernel") return true
  const decl = lookupEntityDecl(ctx.orgId, record.app, record.entityType)
  if (!decl?.tableName) return false
  if (!decl.external) return true
  const found = await ctx.db.execute(
    sql`SELECT to_regclass(${`"app_${record.app}"."${decl.tableName}"`}) IS NOT NULL AS present`,
  )
  return extractRows<{ present: boolean }>(found)[0]?.present === true
}

/**
 * The record's naming under the actor's RLS, or null when it is gone or hidden. A savepoint holds
 * the read: an id of the wrong shape fails its query, and that must not abort the whole turn's
 * transaction.
 */
async function readNaming(
  ctx: OpenAppContext,
  record: OpenRecord,
  id: string,
): Promise<Naming | null> {
  try {
    return await ctx.db.transaction((tx: any) =>
      resolveEntityNaming(tx, {
        orgId: ctx.orgId,
        app: record.app,
        entityType: record.entityType,
        entityId: id,
      }),
    )
  } catch (err) {
    log.warn({ err, app: record.app, entityType: record.entityType }, "open_app label read failed")
    return null
  }
}

type Naming = { label: string; handle: string | null }

/** The column holding a kind's generated handle (a ticket's `ticket-106`, an invoice's number). */
function handleColumn(orgId: string, record: OpenRecord): { table: string; column: string } | null {
  if (record.app === "kernel") return null
  const decl = lookupEntityDecl(orgId, record.app, record.entityType)
  const column = decl?.indexFields?.handle
  if (!decl?.tableName || decl.external || !column) return null
  if (![record.app, decl.tableName, column].every((part) => SAFE_IDENT.test(part))) return null
  return { table: `"app_${record.app}"."${decl.tableName}"`, column }
}

/**
 * The row whose handle is exactly `handle`, under the actor's RLS, and when none is, the visible
 * handles that end in the same digits. A row the person cannot see is never among either.
 */
async function lookupHandle(
  ctx: OpenAppContext,
  where: { table: string; column: string },
  handle: string,
): Promise<{ id: string | null; close: string[] }> {
  const table = sql.raw(where.table)
  const column = sql.raw(`"${where.column}"`)
  try {
    return await ctx.db.transaction(async (tx: any) => {
      const hit = extractRows<{ id: string }>(
        await tx.execute(sql`
          SELECT id::text AS id FROM ${table}
          WHERE lower(${column}::text) = lower(${handle}) AND org_id = ${ctx.orgId} LIMIT 2`),
      )
      if (hit.length === 1 && hit[0]) return { id: hit[0].id, close: [] }
      const digits = handle.match(/(\d+)\D*$/)?.[1]
      if (!digits) return { id: null, close: [] }
      const near = extractRows<{ handle: string }>(
        await tx.execute(sql`
          SELECT ${column}::text AS handle FROM ${table}
          WHERE ${column}::text LIKE ${`%${digits}`} AND org_id = ${ctx.orgId}
          ORDER BY 1 LIMIT 5`),
      )
      return {
        id: null,
        close: near.map((r) => r.handle).filter((h) => typeof h === "string" && REFERENCE.test(h)),
      }
    })
  } catch (err) {
    log.warn({ err, table: where.table }, "open_app handle lookup failed")
    return { id: null, close: [] }
  }
}

type Found =
  | { found: true; id: string; naming: Naming | null; readable: boolean }
  | { found: false; refusal: Refused }

/**
 * The record `id` names in this view: by its id, or by its handle when the kind has one. What a
 * miss says depends only on what was asked, never on rows the person cannot see.
 */
async function findRecord(ctx: OpenAppContext, view: OpenView, id: string): Promise<Found> {
  const record = view.record as OpenRecord
  const readable = await hasLocalRow(ctx, record)
  if (!readable) return { found: true, id, naming: null, readable: false }
  const byHandle = UUID.test(id) ? null : handleColumn(ctx.orgId, record)
  const hit = byHandle ? await lookupHandle(ctx, byHandle, id) : null
  const rowId = hit?.id ?? id
  // A handle that matched no row leaves nothing to read: the id it would be read by is the handle.
  const naming = hit && !hit.id ? null : await readNaming(ctx, record, rowId)
  if (naming) return { found: true, id: rowId, naming, readable: true }

  const label = view.label
  if (byHandle) {
    const none = `No ${label} visible to this person has the ${byHandle.column} "${id}".`
    const close = hit?.close ?? []
    return {
      found: false,
      refusal: refuse(
        "NOT_FOUND",
        close.length > 0
          ? `${none} Visible ones close to it: ${close.join(", ")}. None of them is "${id}": ask the person which one they mean.`
          : none,
      ),
    }
  }
  const external =
    record.app !== "kernel" && lookupEntityDecl(ctx.orgId, record.app, record.entityType)?.external
  if (!UUID.test(id) && !external) {
    return {
      found: false,
      refusal: refuse(
        "NOT_FOUND",
        `"${id}" is not a ${label} id: an id is the uuid a search or list result gives.`,
      ),
    }
  }
  return {
    found: false,
    refusal: refuse("NOT_FOUND", `No ${label} with id ${id} is visible to this person.`),
  }
}

/**
 * The view to use when the one asked for does not exist, or none was given for an id: the one
 * record view of this app whose row the id names, read under the actor's RLS. When several views
 * show that row, the one a mention of it opens. Null when that is not exactly one view.
 */
async function viewHoldingId(
  ctx: OpenAppContext,
  app: string,
  views: OpenView[],
  id: string,
): Promise<OpenView | null> {
  const holding: OpenView[] = []
  for (const v of views) {
    if (!v.needsId || !v.record || v.record.app !== app || v.target.kind === "outside") continue
    if (!(v.target.kind === "detail" ? PANEL_ID : TAB_ID).test(id)) continue
    if (!holdsReadScope(ctx.orgId, v.record, ctx.scopes)) continue
    const found = await findRecord(ctx, v, id)
    if (found.found && found.readable) holding.push(v)
  }
  if (holding.length === 1) return holding[0] ?? null
  const primary = holding.filter((v) => v.primary)
  return primary.length === 1 ? (primary[0] ?? null) : null
}

/** The tab of a record that opens inside another page. Null when the row cannot be read. */
async function tabOfInnerRecord(
  ctx: OpenAppContext,
  target: OpenView["target"],
  id: string,
): Promise<OpenTab | null> {
  if (target.kind === "agent-item") {
    const table = target.pane === "routines" ? routines : skills
    const rows = await ctx.db.transaction((tx: any) =>
      tx
        .select({ owner: table.ownerAgentId })
        .from(table)
        .where(and(eq(table.id, id), eq(table.orgId, ctx.orgId)))
        .limit(1),
    )
    if (rows.length === 0) return null
    // A record no agent owns lives on the person's own agent page.
    const agent = (rows[0] as { owner: string | null }).owner ?? "self"
    return {
      type: "agents:agent",
      entityId: agent,
      routePath: `/agents/${agent}/${target.pane}?selected=${encodeURIComponent(id)}`,
    }
  }
  if (target.kind === "calendar-event") {
    const found = await ctx.db.transaction((tx: any) =>
      tx.execute(sql`
        SELECT start FROM app_calendar.events WHERE id = ${id} AND org_id = ${ctx.orgId} LIMIT 1`),
    )
    const start = extractRows<{ start: { dateTime?: string; date?: string } | null }>(found)[0]
      ?.start
    const day = (start?.dateTime ?? start?.date ?? "").slice(0, 10)
    return { type: "calendar:month", entityId: `event-${id}@${day}` }
  }
  return null
}

async function outsideLink(ctx: OpenAppContext, app: string, entity: string, id: string) {
  if (!externalOnlyDetail(ctx.orgId, app, entity)) return null
  try {
    const vars = await withPrivilegedDb(ctx.orgId, "open-app-connection-load", (ptx) =>
      resolveConnectionTemplateVars(ptx, ctx.orgId, app),
    )
    return vars ? getDetailExternalLink(ctx.orgId, app, entity, id, vars) : null
  } catch (err) {
    // The refusal says no link could be built; the person still learns where the record lives.
    log.warn({ err, app, entity }, "open_app could not build the outside link")
    return null
  }
}

/**
 * Opens the tab on the requester's own connections (`REQUESTER_ONLY_ACTIONS`, websocket.ts). The
 * title travels here and nowhere else, since a record's name can be outside text: not in the tool's
 * result, so no model reads it and no later turn replays it, and not on the room's stream.
 */
async function showTab(ctx: OpenAppContext, tab: OpenTab, label: string): Promise<boolean> {
  const threadId = ctx.agentExecutionThreadId
  if (!threadId) return false
  try {
    await broadcastEphemeral({
      app: "kernel",
      entity: "agent_stream",
      action: "open_tab",
      entityId: threadId,
      orgId: ctx.orgId,
      actorId: ctx.userId,
      actorType: "agent",
      data: { threadId, requesterId: ctx.userId, tab, label: label.slice(0, LABEL_MAX) },
    })
    return true
  } catch (err) {
    log.warn({ err, threadId }, "open_app could not reach the requester's screen")
    return false
  }
}

const NO_SCREEN = () => refuse("NO_VIEWER", "The person's screen could not be reached.")

/**
 * `open_app`: let the agent move the requester's UI to an app, a view or one record. The EFFECT is
 * client-side: the web app reads this call off the `agent_stream` channel, for the person who
 * asked only (`message-store.ts`). With only `app` it opens that app, by the name the web app
 * resolves. With a view or an id, this handler decides: the row is read under the actor's RLS,
 * so a record the person cannot see answers NOT_FOUND exactly as one that does not exist, and the
 * tab is the server's rather than the model's words. The result names what opened by its kind and
 * a generated reference, so the model never reads a record's own words through this tool.
 */
export async function handleOpenApp(
  params: { app: string; view?: string; id?: string },
  ctx: OpenAppContext,
): Promise<Opened | Refused> {
  const app = String(params.app ?? "").trim()
  const view = params.view ? String(params.view).trim() : undefined
  const id = params.id ? String(params.id).trim() : undefined
  log.info({ app, view, hasId: Boolean(id) }, "open_app requested")

  if (runHasNoViewer()) return refuse("NO_VIEWER", "This run has no person watching it.")
  if (!view && !id) return { ok: true, app }

  const views = openViewsOf(ctx.orgId, app)
  if (!views) {
    if (!id) return view ? { ok: true, app, view } : { ok: true, app }
    return refuse("UNKNOWN_APP", `There is no app "${app}" to open a record in.`)
  }

  const records = views.filter((v) => v.needsId)
  const chosen =
    (view ? views.find((v) => v.view === view) : records.length === 1 ? records[0] : undefined) ??
    (id ? await viewHoldingId(ctx, app, views, id) : null)
  if (!chosen) return unknownView(app, view, views)

  if (!id) {
    if (chosen.needsId) {
      return refuse(
        "ID_REQUIRED",
        `${app} view "${chosen.view}" opens one record and needs its id.`,
      )
    }
    const tab = tabForId(chosen.target, chosen.view)
    if (!tab || !(await showTab(ctx, tab, chosen.label))) return NO_SCREEN()
    return { ok: true, app, view: chosen.view, opened: chosen.label }
  }
  if (!chosen.needsId) {
    return refuse("ID_NOT_TAKEN", `${app} view "${chosen.view}" is not a record: it takes no id.`)
  }

  const shape = chosen.target.kind === "detail" ? PANEL_ID : TAB_ID
  const notFound = () =>
    refuse("NOT_FOUND", `No ${chosen.label} with id ${id} is visible to this person.`)
  if (!shape.test(id)) return notFound()

  // A page that is only a name (a work queue, a list's filter): nothing to read, nothing hidden.
  if (!chosen.record) {
    const tab = tabForId(chosen.target, id)
    const named = `${chosen.label}: ${id}`
    if (!tab || !(await showTab(ctx, tab, named))) return NO_SCREEN()
    return { ok: true, app, view: chosen.view, id, opened: named }
  }

  if (!holdsReadScope(ctx.orgId, chosen.record, ctx.scopes)) return notFound()

  const found = await findRecord(ctx, chosen, id)
  if (!found.found) return found.refusal
  const { naming, readable } = found
  const rowId = found.id

  if (chosen.target.kind === "outside") {
    const link = await outsideLink(ctx, app, chosen.target.entity, rowId)
    return refuse(
      "OPENS_OUTSIDE",
      link
        ? `A ${chosen.label} has no tab in Liaison: its page is ${link.url}. Give the person this link.`
        : `A ${chosen.label} has no tab in Liaison, and no link to it can be built here.`,
      undefined,
      link?.url,
    )
  }

  const tab = tabForId(chosen.target, rowId) ?? (await tabOfInnerRecord(ctx, chosen.target, rowId))
  if (!tab) return notFound()

  const reference = naming?.handle && REFERENCE.test(naming.handle) ? naming.handle : rowId
  const opened = `${chosen.label.toLowerCase()} ${reference}`
  if (!(await showTab(ctx, tab, naming?.label ?? opened))) return NO_SCREEN()

  return {
    ok: true,
    app,
    view: chosen.view,
    id: rowId,
    opened,
    ...(readable
      ? {}
      : {
          note: "This record lives in another system: its id was not checked. The page says if it is gone.",
        }),
  }
}
