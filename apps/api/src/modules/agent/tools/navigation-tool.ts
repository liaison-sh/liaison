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
): Promise<{ label: string; handle: string | null } | null> {
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
  const chosen = view
    ? views.find((v) => v.view === view)
    : records.length === 1
      ? records[0]
      : undefined
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

  const readable = await hasLocalRow(ctx, chosen.record)
  const naming = readable ? await readNaming(ctx, chosen.record, id) : null
  if (readable && naming === null) return notFound()

  if (chosen.target.kind === "outside") {
    const link = await outsideLink(ctx, app, chosen.target.entity, id)
    return refuse(
      "OPENS_OUTSIDE",
      link
        ? `A ${chosen.label} has no tab in Liaison: its page is ${link.url}. Give the person this link.`
        : `A ${chosen.label} has no tab in Liaison, and no link to it can be built here.`,
      undefined,
      link?.url,
    )
  }

  const tab = tabForId(chosen.target, id) ?? (await tabOfInnerRecord(ctx, chosen.target, id))
  if (!tab) return notFound()

  const reference = naming?.handle && REFERENCE.test(naming.handle) ? naming.handle : id
  const opened = `${chosen.label.toLowerCase()} ${reference}`
  if (!(await showTab(ctx, tab, naming?.label ?? opened))) return NO_SCREEN()

  return {
    ok: true,
    app,
    view: chosen.view,
    id,
    opened,
    ...(readable
      ? {}
      : {
          note: "This record lives in another system: its id was not checked. The page says if it is gone.",
        }),
  }
}
