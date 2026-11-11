// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APP PAGES: a document an app serves outside the web app, and the routes it calls.
//
// Some screens cannot live in the web app or its app frame: a provider's picker
// that needs the provider's own scripts and frames, a page opened in a popup or
// the system browser from a phone or desktop shell. An app declares such a page
// in its manifest (`pages.<name>`: its script, the scope a person needs, the hosts
// its scripts, frames and calls reach, the routes it may call) and the platform
// serves it. No app ships host code for it.
//
// 1. A link is minted for ONE person (`POST /api/apps/:app/pages/:page/link`, or
//    `ctx.pages.link(page, params)` from a handler acting for a person): a random
//    ticket in Redis bound to the org, the person, the app, the page and the
//    opener's `params`, valid 15 minutes, used once.
// 2. Opening it renders the page: the ticket is taken (getdel), the person is
//    checked again (active, still holds the page's scope, the app still on for
//    them), and a page session is minted (30 minutes). The document is fixed: a
//    nonce'd bootstrap that defines `window.liaisonPage` ({ params, call }) and
//    the app's `pages/<name>.js`. Its policy allows only the page's declared hosts.
// 3. `liaisonPage.call(route, body)` posts to the session's route URL; the platform
//    runs the route's handler as that person (a sandboxed run for a sandboxed app,
//    their own scopes and RLS), with `{ body, params, page }`, and answers
//    `{ data }` or `{ error }`.
//
// Where it is served: with app frame origins (LIAISON_APP_FRAME_ORIGIN_TEMPLATE)
// on the app's own frame host, `https://<app>--<org>.<domain>/page/...`, a real
// origin of the app's own. Without, on the org's origin under `/api/app-pages/`,
// with a `sandbox` policy (no `allow-same-origin`): the page runs in an opaque
// origin, so it reaches neither the org's storage nor its cookies, and its calls
// are cross-origin requests carrying only the session id.

import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type ActorContext, createRlsSession } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { appFrameHostFor, appFrameOriginOf } from "~/lib/app-frame-host"
import { escapeHtml } from "~/lib/html-page"
import { appsLogger as log } from "~/lib/logger"
import { orgPublicBaseUrl, orgSlugById } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { appBridgeManifest } from "~/modules/apps/app-registries"
import { type AppPageDecl, type AppSurface, appSurfaceRegistry } from "~/modules/apps/app-surface"
import { grantedSubset } from "~/modules/apps/egress-grants"
import { awaitOrgApps } from "~/modules/apps/init"
import { getInstallTrust } from "~/modules/apps/install-trust"
import {
  isAppRestrictedAway,
  isOffStatus,
  peekOrgAppState,
  primeOrgApps,
} from "~/modules/apps/org-apps"
import { runLimits } from "~/modules/apps/run-limits"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

const TICKET_TTL_SECONDS = 15 * 60
const SESSION_TTL_SECONDS = 30 * 60
const ticketKey = (id: string) => `app-page:ticket:${id}`
const sessionKey = (id: string) => `app-page:session:${id}`
const ID_RE = /^[A-Za-z0-9_-]{32,64}$/
/** A route call's body and answer cap. */
export const PAGE_CALL_MAX_BYTES = 1024 * 1024
/** The opener's params cap (they ride in the ticket and the page). */
const PARAMS_MAX_BYTES = 16 * 1024

/** What a ticket (then a page session) is bound to. */
export interface AppPageBinding {
  orgId: string
  userId: string
  app: string
  page: string
  params: Record<string, unknown>
}

export class AppPageError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 410 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "AppPageError"
  }
}

const newId = () => randomBytes(32).toString("base64url")

function surfaceOf(orgId: string, app: string): AppSurface | null {
  return appSurfaceRegistry.get([orgId, app]) ?? null
}

function pageOf(orgId: string, app: string, page: string): AppPageDecl {
  const decl = surfaceOf(orgId, app)?.pages[page]
  if (!decl) throw new AppPageError(404, "page_not_found", `App "${app}" has no page "${page}"`)
  return decl
}

/**
 * The person as they are now: active, their current scopes. A page acts for
 * them with exactly these, never with what they held when the link was minted.
 */
async function personActor(orgId: string, userId: string): Promise<ActorContext> {
  const [row] = await withSystemDb("app-page-person", (db) =>
    db
      .select({ status: users.status, orgId: users.orgId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row || row.orgId !== orgId || row.status !== "active") {
    throw new AppPageError(403, "person_inactive", "This person cannot use this page")
  }
  const perms = await withPrivilegedDb(orgId, "app-page-permissions", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  } as ActorContext
}

/** The app is on for the org and not restricted away from the person. */
async function assertAppUsable(orgId: string, app: string, userId: string): Promise<void> {
  await primeOrgApps(orgId)
  // Like the route gate (middleware/app-state-gate.ts): an app with no state row
  // is registered for the org without one (in-tree), and is on.
  const state = peekOrgAppState(orgId, app)
  if (!state) return
  if (isOffStatus(state.status)) {
    throw new AppPageError(410, "app_disabled", `App "${app}" is not on for this workspace`)
  }
  if (isAppRestrictedAway(state, userId)) {
    throw new AppPageError(403, "app_restricted", `App "${app}" is restricted`)
  }
}

/** Where the app's pages are served: its frame host, else the org's own origin. */
async function pageBase(orgId: string, app: string): Promise<{ base: string; framed: boolean }> {
  const slug = await orgSlugById(orgId)
  const host = slug ? appFrameHostFor(app, slug) : null
  if (host) return { base: `${appFrameOriginOf(host)}/page`, framed: true }
  return {
    base: `${(await orgPublicBaseUrl(orgId)).replace(/\/+$/, "")}/api/app-pages`,
    framed: false,
  }
}

function checkedParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new AppPageError(400, "invalid_params", "Page params must be an object")
  }
  const text = JSON.stringify(params)
  if (Buffer.byteLength(text, "utf8") > PARAMS_MAX_BYTES) {
    throw new AppPageError(413, "params_too_large", "Page params are over 16 KiB")
  }
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * A one-time link to `app`'s page `page` for one person. The person must hold the
 * page's scope and the app must be on for them now.
 */
export async function createAppPageLink(input: {
  orgId: string
  userId: string
  app: string
  page: string
  params?: unknown
}): Promise<{ url: string; expiresInSeconds: number }> {
  await awaitOrgApps(input.orgId)
  const decl = pageOf(input.orgId, input.app, input.page)
  const params = checkedParams(input.params)
  await assertAppUsable(input.orgId, input.app, input.userId)
  const actor = await personActor(input.orgId, input.userId)
  if (!hasScope(decl.scope, actor.scopes ?? [])) {
    throw new AppPageError(403, "forbidden", `This page needs ${decl.scope}`)
  }
  const ticket = newId()
  const binding: AppPageBinding = {
    orgId: input.orgId,
    userId: input.userId,
    app: input.app,
    page: input.page,
    params,
  }
  await redis.set(ticketKey(ticket), JSON.stringify(binding), "EX", TICKET_TTL_SECONDS)
  const { base } = await pageBase(input.orgId, input.app)
  return { url: `${base}/${ticket}`, expiresInSeconds: TICKET_TTL_SECONDS }
}

function parseBinding(raw: string | null): AppPageBinding | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as AppPageBinding
  } catch {
    return null
  }
}

/** Where the request came in: the org's origin, or an app's frame host. */
export type PageHost = { kind: "org" } | { kind: "frame"; app: string; orgId: string }

function hostMatches(binding: AppPageBinding, host: PageHost): boolean {
  if (host.kind === "org") return true
  return host.app === binding.app && host.orgId === binding.orgId
}

/** A host list narrowed to the install's domain grant (null grant: every declared host). */
async function grantedHosts(app: string, hosts: readonly string[] | undefined): Promise<string[]> {
  const list = [...(hosts ?? [])]
  if (list.length === 0) return []
  const { grantedDomains } = await getInstallTrust(app)
  return grantedDomains === null ? list : grantedSubset(list, grantedDomains)
}

/** The page's Content-Security-Policy. `selfOrigin` is where its script and calls live. */
export async function appPagePolicy(
  app: string,
  decl: AppPageDecl,
  nonce: string,
  selfOrigin: string,
  framed: boolean,
): Promise<string> {
  const https = async (list: readonly string[] | undefined) =>
    (await grantedHosts(app, list)).map((h) => `https://${h}`).join(" ")
  const script = await https(decl.hosts?.script)
  const frame = await https(decl.hosts?.frame)
  const connect = await https(decl.hosts?.connect)
  const image = await https(decl.hosts?.image)
  const style = await https(decl.hosts?.style)
  const directives = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${script ? ` ${script}` : ""}`,
    `style-src 'unsafe-inline'${style ? ` ${style}` : ""}`,
    `img-src data:${image ? ` ${image}` : ""}`,
    `connect-src ${selfOrigin}${connect ? ` ${connect}` : ""}`,
    `frame-src ${frame || "'none'"}`,
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]
  // Not on the app's own origin: an opaque origin, so the app's code reaches
  // nothing of the org's (storage, cookies). Popups stay possible (a provider's
  // sign-in), escaping the sandbox so they behave as normal pages.
  if (!framed) directives.push("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox")
  return directives.join("; ")
}

function bootstrapScript(base: string, session: string, params: Record<string, unknown>): string {
  // JSON in a script: `<` escaped so a param can never close the tag.
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")
  return (
    `(function(){var u=${json(`${base}/s/${session}/routes/`)};` +
    `window.liaisonPage=Object.freeze({params:Object.freeze(${json(params)}),` +
    "call:function(route,body){return fetch(u+encodeURIComponent(route),{method:'POST'," +
    "headers:{'content-type':'text/plain'},body:JSON.stringify(body===undefined?null:body)})" +
    ".then(function(r){return r.json().then(function(j){if(!r.ok)" +
    "{var e=new Error(j&&j.error&&j.error.message||('HTTP '+r.status));e.code=j&&j.error&&j.error.code;throw e}" +
    "return j.data})})}})})()"
  )
}

/** The page document for a ticket: taken once, a page session minted. */
export async function renderAppPage(
  ticket: string,
  host: PageHost,
  requestOrigin: string,
): Promise<{ html: string; policy: string }> {
  if (!ID_RE.test(ticket))
    throw new AppPageError(404, "page_link_invalid", "This link is not valid")
  const binding = parseBinding(await redis.getdel(ticketKey(ticket)))
  if (!binding || !hostMatches(binding, host)) {
    throw new AppPageError(404, "page_link_invalid", "This link has expired or was already used")
  }
  await awaitOrgApps(binding.orgId)
  const decl = pageOf(binding.orgId, binding.app, binding.page)
  await assertAppUsable(binding.orgId, binding.app, binding.userId)
  const actor = await personActor(binding.orgId, binding.userId)
  if (!hasScope(decl.scope, actor.scopes ?? [])) {
    throw new AppPageError(403, "forbidden", `This page needs ${decl.scope}`)
  }
  const session = newId()
  await redis.set(sessionKey(session), JSON.stringify(binding), "EX", SESSION_TTL_SECONDS)
  const framed = host.kind === "frame"
  // The org's own public origin, never the request's (a proxy may have rewritten it).
  const origin = framed ? requestOrigin : new URL(await orgPublicBaseUrl(binding.orgId)).origin
  const base = framed ? `${origin}/page` : `${origin}/api/app-pages`
  const nonce = randomBytes(18).toString("base64")
  const title = escapeHtml(decl.title ?? binding.page)
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>${title}</title>` +
    `<script nonce="${nonce}">${bootstrapScript(base, session, binding.params)}</script>` +
    `<script nonce="${nonce}" src="${escapeHtml(`${base}/s/${session}/page.js`)}"></script>` +
    `</head><body><div id="root"></div></body></html>`
  return { html, policy: await appPagePolicy(binding.app, decl, nonce, origin, framed) }
}

async function sessionBinding(session: string, host: PageHost): Promise<AppPageBinding> {
  if (!ID_RE.test(session)) throw new AppPageError(404, "page_session_invalid", "Page expired")
  const binding = parseBinding(await redis.get(sessionKey(session)))
  if (!binding || !hostMatches(binding, host)) {
    throw new AppPageError(404, "page_session_invalid", "This page has expired: open it again")
  }
  return binding
}

const builtPages = new Map<string, { mtimeMs: number; code: string }>()

/** `pages/<name>.js` from the package, or (in-tree source, tests) built from its `.ts`. */
async function pageScript(surface: AppSurface, page: string, decl: AppPageDecl): Promise<string> {
  const root = resolve(surface.packageDir)
  const built = resolve(root, "pages", `${page}.js`)
  const source = resolve(root, decl.source)
  for (const file of [built, source]) {
    if (!file.startsWith(root + sep))
      throw new AppPageError(404, "page_not_found", "No page script")
  }
  if (existsSync(built)) return readFileSync(built, "utf8")
  if (!existsSync(source)) throw new AppPageError(404, "page_not_found", "No page script")
  const mtimeMs = statSync(source).mtimeMs
  const hit = builtPages.get(source)
  if (hit && hit.mtimeMs === mtimeMs) return hit.code
  const out = await Bun.build({ entrypoints: [source], target: "browser", minify: true })
  if (!out.success || !out.outputs[0]) {
    throw new Error(
      `page ${surface.appName}/${page}: build failed: ${out.logs.map((l) => l.message).join("; ")}`,
    )
  }
  const code = await out.outputs[0].text()
  builtPages.set(source, { mtimeMs, code })
  return code
}

export async function appPageScript(session: string, host: PageHost): Promise<string> {
  const binding = await sessionBinding(session, host)
  await awaitOrgApps(binding.orgId)
  const surface = surfaceOf(binding.orgId, binding.app)
  const decl = surface?.pages[binding.page]
  if (!surface || !decl) throw new AppPageError(404, "page_not_found", "No such page")
  return pageScript(surface, binding.page, decl)
}

// ─── Route runs ─────────────────────────────────────────────────────────────

/** What a route handler receives as its params. */
export interface AppRouteParams {
  /** What the page sent (untrusted: the browser's). */
  body: unknown
  /** What the opener bound into the link (trusted: minted by the platform). */
  params: Record<string, unknown>
  page: string
}

/** Test seam: replaces the sandbox run. */
export type AppRouteExecutor = (args: {
  surface: AppSurface
  exportName: string
  actor: ActorContext
  params: AppRouteParams
}) => Promise<unknown>

const defaultRouteExecutor: AppRouteExecutor = async ({ surface, exportName, actor, params }) => {
  const { createSessionRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
  const { runApp } = await import("~/modules/apps/sandbox/run-app")
  const orgId = actor.orgId as string
  const aliased = withAppDimensionAliases(actor, surface.appName)
  const manifest = appBridgeManifest(orgId, surface.appName) ?? { name: surface.appName }
  const userId = aliased.actorType === "user" ? (aliased.userId as string) : "system"
  // Bridge-owned transactions: one short transaction per bridge call, none held
  // across the run.
  const bridge = createSessionRpcBridge(
    surface.appName,
    userId,
    orgId,
    createRlsSession(aliased),
    manifest as Parameters<typeof createSessionRpcBridge>[4],
    aliased.scopes,
    aliased.actorType,
    undefined,
    { actor: aliased },
  )
  return runApp({
    trusted: surface.trusted,
    appName: surface.appName,
    orgId,
    bundlePath: surface.bundlePath,
    exportName,
    entry: `route:${exportName}`,
    params,
    bridge,
    holdsTx: false,
    appId: surface.appName,
    timeoutMs: runLimits("route").wallMs,
  })
}

let routeExecutor: AppRouteExecutor = defaultRouteExecutor

export const AppPagesTestAccess = {
  setRouteExecutor(fn: AppRouteExecutor | null): void {
    routeExecutor = fn ?? defaultRouteExecutor
  },
}

/** Run one of the page's routes as the page's person. */
export async function callAppPageRoute(
  session: string,
  host: PageHost,
  route: string,
  body: unknown,
): Promise<unknown> {
  const binding = await sessionBinding(session, host)
  await awaitOrgApps(binding.orgId)
  const surface = surfaceOf(binding.orgId, binding.app)
  const decl = surface?.pages[binding.page]
  if (!surface || !decl) throw new AppPageError(404, "page_not_found", "No such page")
  const routeDecl = (decl.routes ?? []).includes(route) ? surface.routes[route] : undefined
  if (!routeDecl) {
    throw new AppPageError(404, "route_not_found", `Page "${binding.page}" has no route "${route}"`)
  }
  await assertAppUsable(binding.orgId, binding.app, binding.userId)
  const actor = await personActor(binding.orgId, binding.userId)
  for (const scope of [decl.scope, routeDecl.scope]) {
    if (scope && !hasScope(scope, actor.scopes ?? [])) {
      throw new AppPageError(403, "forbidden", `This needs ${scope}`)
    }
  }
  const result = await routeExecutor({
    surface,
    exportName: routeDecl.handler,
    actor,
    params: { body, params: binding.params, page: binding.page },
  })
  const text = JSON.stringify(result ?? null)
  if (Buffer.byteLength(text, "utf8") > PAGE_CALL_MAX_BYTES) {
    throw new AppPageError(413, "answer_too_large", "The route's answer is over 1 MiB")
  }
  return JSON.parse(text)
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
/** The page's calls come from its own (possibly opaque) origin, carrying only the session id. */
const CALL_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600",
}

function errorResponse(err: unknown, extra: Record<string, string> = {}): Response {
  const known = err instanceof AppPageError
  if (!known) log.error({ err }, "app page request failed")
  const status = known ? err.status : 500
  const body = known
    ? { error: { message: err.message, code: err.code } }
    : { error: { message: "The page request failed", code: "app_page_failed" } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...extra },
  })
}

async function readCallBody(c: Context): Promise<unknown> {
  const text = await c.req.text()
  if (Buffer.byteLength(text, "utf8") > PAGE_CALL_MAX_BYTES) {
    throw new AppPageError(413, "body_too_large", "The page's call is over 1 MiB")
  }
  if (text === "") return null
  try {
    return JSON.parse(text)
  } catch {
    throw new AppPageError(400, "invalid_body", "The page's call is not JSON")
  }
}

/**
 * Answer a page request: `GET /<ticket>`, `GET /s/<session>/page.js`,
 * `POST|OPTIONS /s/<session>/routes/<route>` (path relative to the page base).
 */
export async function serveAppPageRequest(
  c: Context,
  rest: string,
  host: PageHost,
  requestOrigin: string,
): Promise<Response> {
  const method = c.req.method
  try {
    const call = /^s\/([^/]+)\/routes\/([^/]+)$/.exec(rest)
    if (call) {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: CALL_CORS })
      if (method !== "POST") throw new AppPageError(404, "not_found", "Not found")
      const data = await callAppPageRoute(
        call[1] as string,
        host,
        decodeURIComponent(call[2] as string),
        await readCallBody(c),
      )
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...CALL_CORS },
      })
    }
    if (method !== "GET" && method !== "HEAD") throw new AppPageError(404, "not_found", "Not found")
    const script = /^s\/([^/]+)\/page\.js$/.exec(rest)
    if (script) {
      const code = await appPageScript(script[1] as string, host)
      return new Response(code, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cross-Origin-Resource-Policy": "cross-origin",
          ...NO_STORE,
        },
      })
    }
    const ticket = /^([^/]+)$/.exec(rest)
    if (!ticket) throw new AppPageError(404, "not_found", "Not found")
    const { html, policy } = await renderAppPage(ticket[1] as string, host, requestOrigin)
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": policy,
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        ...NO_STORE,
      },
    })
  } catch (err) {
    return errorResponse(err, rest.includes("/routes/") ? CALL_CORS : {})
  }
}

/** `/api/app-pages/*` on the org's origin: public, the ticket or session is the credential. */
export const appPageRoutes = new Hono().all("/*", (c) => {
  const rest = c.req.path.replace(/^\/api\/app-pages\/?/, "")
  return serveAppPageRequest(c, rest, { kind: "org" }, new URL(c.req.url).origin)
})

/** `POST /api/apps/:app/pages/:page/link` (signed in): a one-time link for the caller. */
export const appPageLinkRoutes = new Hono<{
  Variables: { orgId: string; userId: string }
}>().post("/:app/pages/:page/link", async (c) => {
  try {
    const text = await c.req.text()
    const body = text ? (JSON.parse(text) as { params?: unknown }) : {}
    const link = await createAppPageLink({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      app: c.req.param("app"),
      page: c.req.param("page"),
      params: body.params,
    })
    return c.json({ data: link })
  } catch (err) {
    if (err instanceof SyntaxError) {
      return c.json({ error: { message: "The body is not JSON", code: "invalid_body" } }, 400)
    }
    return errorResponse(err)
  }
})

/** For page requests that reach an app's frame host (`/page/...`). */
export function frameHostPageRest(path: string): string | null {
  return path.startsWith("/page/") ? path.slice("/page/".length) : null
}
