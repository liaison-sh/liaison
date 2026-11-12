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
// 1. A link is minted for ONE person, only in that person's signed-in browser:
//    `POST /api/apps/:app/pages/:page/link` (no params), or, from a handler acting
//    for the person, `ctx.pages.link(page, params)`, which answers an opaque
//    HANDLE, never a URL: the app's code cannot open its own page as the person
//    from its server. The person's app exchanges the handle for the link
//    (`POST /api/apps/:app/pages/open`, signed in as that very person). A link is
//    a random ticket in Redis bound to the org, the person, the app, the page and
//    the app's `params`, valid 5 minutes, used once. Minting is rate-limited per
//    person and app.
// 2. Opening it renders the page: the ticket is taken (getdel), the person is
//    checked again (active, still holds the page's scope, the app still on for
//    them), and a page session is minted (20 minutes) with a session key. The
//    document is fixed: a nonce'd bootstrap that defines `window.liaisonPage`
//    ({ params, call }), keeps the key in its closure (never in the DOM: it
//    removes its own script element, and it holds its own `fetch`), then the
//    app's `pages/<name>.js`. Its policy allows only the page's declared hosts.
// 3. `liaisonPage.call(route, body)` posts to the session's route URL with the
//    key; the platform checks it, runs the route's handler as that person (a
//    sandboxed run for a sandboxed app, their own scopes and RLS), with
//    `{ body, params, page }`, and answers `{ data }` or `{ error }`. Route calls
//    are rate-limited per session and audited with the person.
//
// Where it is served: with app frame origins (LIAISON_APP_FRAME_ORIGIN_TEMPLATE)
// on the app's own frame host, `https://<app>--<org>.<domain>/page/...`, a real
// origin of the app's own. Without, on the org's origin under `/api/app-pages/`,
// with a `sandbox` policy (no `allow-same-origin`): the page runs in an opaque
// origin, so it reaches neither the org's storage nor its cookies, and its calls
// are cross-origin requests carrying only the session id.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
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
import { bindingAllowsOrg, type HostBinding, requestHostBinding } from "~/lib/org-host"
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
import {
  grantBeyondWidget,
  type PageWidgetConfig,
  widgetKind,
  widgetParams,
  widgetScript,
} from "~/modules/apps/page-widgets"
import { runLimits } from "~/modules/apps/run-limits"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

const TICKET_TTL_SECONDS = 5 * 60
const HANDLE_TTL_SECONDS = 5 * 60
const SESSION_TTL_SECONDS = 20 * 60
/** Links one person may mint for one app per window (handles and direct links). */
export const PAGE_LINKS_PER_WINDOW = 20
const LINK_WINDOW_SECONDS = 10 * 60
/** Route calls one page session may make per minute. */
export const PAGE_CALLS_PER_MINUTE = 60
const ticketKey = (id: string) => `app-page:ticket:${id}`
const handleKey = (id: string) => `app-page:handle:${id}`
const sessionKey = (id: string) => `app-page:session:${id}`
const mintCountKey = (orgId: string, userId: string, app: string) =>
  `app-page:mints:${orgId}:${userId}:${app}`
const callCountKey = (session: string) => `app-page:calls:${session}`
/** The header a page's route call carries its session key in. */
export const PAGE_KEY_HEADER = "x-liaison-page-key"
/** What `ctx.pages.link` answers: opaque, opened only by the person's own app. */
const HANDLE_PREFIX = "lpg_"
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
  /** A page session only: the sha256 of its key (base64url). */
  keyHash?: string
}

export class AppPageError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 410 | 413 | 429,
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

/**
 * Where the app's pages are served: its frame host, else the org's own origin.
 * A widget page (page-widgets.ts) always on the org's origin: an app frame host
 * is an origin the app's own code runs on too.
 */
async function pageBase(
  orgId: string,
  app: string,
  page: string,
): Promise<{ base: string; framed: boolean }> {
  const slug = await orgSlugById(orgId)
  const widget = !!surfaceOf(orgId, app)?.pages[page]?.widget
  const host = slug && !widget ? appFrameHostFor(app, slug) : null
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

/** Count one more link minted by the person for the app; refused over the cap. */
async function countMint(orgId: string, userId: string, app: string): Promise<void> {
  const key = mintCountKey(orgId, userId, app)
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, LINK_WINDOW_SECONDS)
  if (n > PAGE_LINKS_PER_WINDOW) {
    throw new AppPageError(
      429,
      "page_links_rate_limited",
      "Too many page links: wait a few minutes",
    )
  }
}

/** The person may open the page now: the app on for them, the page's scope held. */
async function checkedBinding(input: {
  orgId: string
  userId: string
  app: string
  page: string
  params?: unknown
}): Promise<AppPageBinding> {
  await awaitOrgApps(input.orgId)
  const decl = pageOf(input.orgId, input.app, input.page)
  const params = checkedParams(input.params)
  await assertAppUsable(input.orgId, input.app, input.userId)
  const actor = await personActor(input.orgId, input.userId)
  if (!hasScope(decl.scope, actor.scopes ?? [])) {
    throw new AppPageError(403, "forbidden", `This page needs ${decl.scope}`)
  }
  return {
    orgId: input.orgId,
    userId: input.userId,
    app: input.app,
    page: input.page,
    params,
  }
}

async function mintTicket(
  binding: AppPageBinding,
): Promise<{ url: string; expiresInSeconds: number }> {
  const ticket = newId()
  await redis.set(ticketKey(ticket), JSON.stringify(binding), "EX", TICKET_TTL_SECONDS)
  const { base } = await pageBase(binding.orgId, binding.app, binding.page)
  return { url: `${base}/${ticket}`, expiresInSeconds: TICKET_TTL_SECONDS }
}

/**
 * A one-time link to `app`'s page `page` for one person, asked by that person's
 * signed-in browser. It carries no params: what a route may trust comes from the
 * app's own code (`createAppPageHandle`), never from the opener's request.
 */
export async function createAppPageLink(input: {
  orgId: string
  userId: string
  app: string
  page: string
}): Promise<{ url: string; expiresInSeconds: number }> {
  const binding = await checkedBinding(input)
  await countMint(input.orgId, input.userId, input.app)
  return mintTicket(binding)
}

/**
 * `ctx.pages.link`: a handle to `app`'s page for the person the run acts for,
 * with the app's `params`. The handle is not a link: only that person, signed in,
 * turns it into one (`openAppPageHandle`), so the app's code (and its server)
 * never holds a URL it could open as the person.
 */
export async function createAppPageHandle(input: {
  orgId: string
  userId: string
  app: string
  page: string
  params?: unknown
}): Promise<{ handle: string; app: string; page: string; expiresInSeconds: number }> {
  const binding = await checkedBinding(input)
  await countMint(input.orgId, input.userId, input.app)
  const handle = `${HANDLE_PREFIX}${newId()}`
  await redis.set(handleKey(handle), JSON.stringify(binding), "EX", HANDLE_TTL_SECONDS)
  return { handle, app: input.app, page: input.page, expiresInSeconds: HANDLE_TTL_SECONDS }
}

/**
 * The person's signed-in app opens a handle: taken once, for that very person
 * and app only, re-checked as they are now, then a one-time link.
 */
export async function openAppPageHandle(input: {
  orgId: string
  userId: string
  app: string
  handle: unknown
}): Promise<{ url: string; expiresInSeconds: number }> {
  const handle = typeof input.handle === "string" ? input.handle : ""
  if (!handle.startsWith(HANDLE_PREFIX) || !ID_RE.test(handle.slice(HANDLE_PREFIX.length))) {
    throw new AppPageError(404, "page_handle_invalid", "This page link is not valid")
  }
  // Peek first: someone else's attempt must not burn the person's handle.
  const binding = parseBinding(await redis.get(handleKey(handle)))
  if (
    !binding ||
    binding.orgId !== input.orgId ||
    binding.userId !== input.userId ||
    binding.app !== input.app
  ) {
    throw new AppPageError(404, "page_handle_invalid", "This page link has expired or is not yours")
  }
  if (!(await redis.getdel(handleKey(handle)))) {
    throw new AppPageError(404, "page_handle_invalid", "This page link was already used")
  }
  // The org, person and app are the signed-in caller's own (equal to the handle's).
  const fresh = await checkedBinding({
    orgId: input.orgId,
    userId: input.userId,
    app: input.app,
    page: binding.page,
    params: binding.params,
  })
  return mintTicket(fresh)
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
export type PageHost =
  | { kind: "org"; binding: HostBinding }
  | { kind: "frame"; app: string; orgId: string }

/** The request's host may serve this ticket or session: its own org's origin, or the app's frame host. */
async function hostMatches(binding: AppPageBinding, host: PageHost): Promise<boolean> {
  if (host.kind === "org") return bindingAllowsOrg(host.binding, binding.orgId)
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
  // A widget page's hosts are the platform's own list for that widget.
  const hosts = decl.widget ? widgetKind(decl.widget.kind).hosts : decl.hosts
  const https = async (list: readonly string[] | undefined) =>
    (decl.widget ? [...(list ?? [])] : await grantedHosts(app, list))
      .map((h) => `https://${h}`)
      .join(" ")
  const script = await https(hosts?.script)
  const frame = await https(hosts?.frame)
  const connect = await https(hosts?.connect)
  const image = await https(hosts?.image)
  const style = await https(hosts?.style)
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
  // A widget page runs only the platform's script and the provider's, which
  // needs a real origin to answer (Google's Picker posts to it): no sandbox.
  if (!framed && !decl.widget)
    directives.push("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox")
  return directives.join("; ")
}

/**
 * What a widget page runs with (page-widgets.ts): the account its link names
 * (`params.account`), the person's own, or the organization's when they hold
 * the connection's admin scope, never another member's; and only when the
 * account's recorded grant is inside the widget's `tokenScopes` (a broader or
 * unknown grant never reaches a browser). Each issuance is audited.
 */
async function pageWidgetConfig(
  binding: AppPageBinding,
  decl: AppPageDecl,
  actor: ActorContext,
): Promise<PageWidgetConfig | null> {
  const widget = decl.widget
  if (!widget) return null
  const accountId = binding.params.account
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
    throw new AppPageError(400, "page_account_missing", "This page needs the account it opens for")
  }
  const params = widgetParams(widget, binding.params)
  if (!params) {
    throw new AppPageError(400, "page_widget_params", "This page's link is missing its settings")
  }
  const [{ resolveConnectionAccount }, { connectionAdminScope }, { recordedGrant }] =
    await Promise.all([
      import("~/modules/apps/connections/service"),
      import("~/modules/apps/connections/admin-scope"),
      import("~/modules/apps/connections/protected-scopes"),
    ])
  const account = await withPrivilegedDb(binding.orgId, "app-page-widget-account", (tx) =>
    resolveConnectionAccount(
      tx,
      binding.orgId,
      binding.userId,
      binding.app,
      widget.connection,
      undefined,
      { actorType: "system", accountId },
    ).catch(() => null),
  )
  const mayUse =
    account &&
    (account.ownerType === "user"
      ? account.ownerId === binding.userId
      : hasScope(
          connectionAdminScope(binding.orgId, binding.app, widget.connection),
          actor.scopes ?? [],
        ))
  if (!account || !mayUse) {
    throw new AppPageError(403, "page_account_forbidden", "This page's account is not yours")
  }
  const beyond = grantBeyondWidget(widget, recordedGrant(account.metadata))
  if (beyond === "unknown" || beyond.length > 0) {
    throw new AppPageError(
      403,
      "page_token_too_broad",
      "This account's access is broader than this page may use: nothing to pick here",
    )
  }
  const { writeAuditLog } = await import("~/modules/audit/service")
  await withPrivilegedDb(binding.orgId, "app-page-widget-audit", (tx) =>
    writeAuditLog(tx, {
      orgId: binding.orgId,
      actorId: binding.userId,
      actorType: "user",
      app: binding.app,
      entityType: "app_page",
      entityId: binding.page,
      action: `${binding.app}.page_widget.token_issued`,
      metadata: { page: binding.page, widget: widget.kind, account: account.id },
    }),
  )
  return { token: account.token, identifier: account.identifier, route: widget.route, params }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function bootstrapScript(
  base: string,
  session: string,
  key: string,
  params: Record<string, unknown>,
): string {
  // JSON in a script: `<` escaped so a param can never close the tag.
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")
  // The session key stays in this closure: the element is removed before the
  // app's script runs, and `fetch`, `JSON.stringify` and `encodeURIComponent`
  // are held here, so the app's code can neither read the key nor intercept the
  // call that carries it.
  return (
    "(function(){var d=document.currentScript;if(d&&d.parentNode)d.parentNode.removeChild(d);" +
    "var f=window.fetch.bind(window),s=JSON.stringify,e=encodeURIComponent;" +
    `var u=${json(`${base}/s/${session}/routes/`)},k=${json(key)},h=${json(PAGE_KEY_HEADER)};` +
    `window.liaisonPage=Object.freeze({params:Object.freeze(${json(params)}),` +
    "call:function(route,body){var o={'content-type':'text/plain'};o[h]=k;" +
    "return f(u+e(route),{method:'POST',headers:o,body:s(body===undefined?null:body)})" +
    ".then(function(r){return r.json().then(function(j){if(!r.ok)" +
    "{var x=new Error(j&&j.error&&j.error.message||('HTTP '+r.status));x.code=j&&j.error&&j.error.code;throw x}" +
    "return j.data})})}})})()"
  )
}

const keyHashOf = (key: string) => createHash("sha256").update(key).digest("base64url")

/** The page document for a ticket: taken once, a page session minted. */
export async function renderAppPage(
  ticket: string,
  host: PageHost,
  requestOrigin: string,
): Promise<{ html: string; policy: string }> {
  if (!ID_RE.test(ticket))
    throw new AppPageError(404, "page_link_invalid", "This link is not valid")
  // Peek, then take: a ticket asked on the wrong host is not burnt.
  const peeked = parseBinding(await redis.get(ticketKey(ticket)))
  if (!peeked || !(await hostMatches(peeked, host))) {
    throw new AppPageError(404, "page_link_invalid", "This link has expired or was already used")
  }
  const binding = parseBinding(await redis.getdel(ticketKey(ticket)))
  if (!binding) {
    throw new AppPageError(404, "page_link_invalid", "This link has expired or was already used")
  }
  await awaitOrgApps(binding.orgId)
  const decl = pageOf(binding.orgId, binding.app, binding.page)
  await assertAppUsable(binding.orgId, binding.app, binding.userId)
  const actor = await personActor(binding.orgId, binding.userId)
  if (!hasScope(decl.scope, actor.scopes ?? [])) {
    throw new AppPageError(403, "forbidden", `This page needs ${decl.scope}`)
  }
  const framed = host.kind === "frame"
  // A widget page is served on the org's origin only (pageBase).
  if (decl.widget && framed) {
    throw new AppPageError(404, "page_link_invalid", "This link is not valid here")
  }
  const widget = await pageWidgetConfig(binding, decl, actor)
  const session = newId()
  const key = newId()
  const record: AppPageBinding = { ...binding, keyHash: keyHashOf(key) }
  await redis.set(sessionKey(session), JSON.stringify(record), "EX", SESSION_TTL_SECONDS)
  // The org's own public origin, never the request's (a proxy may have rewritten it).
  const origin = framed ? requestOrigin : new URL(await orgPublicBaseUrl(binding.orgId)).origin
  const base = framed ? `${origin}/page` : `${origin}/api/app-pages`
  const nonce = randomBytes(18).toString("base64")
  const title = escapeHtml(decl.title ?? binding.page)
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>${title}</title>` +
    `<script nonce="${nonce}">${bootstrapScript(base, session, key, binding.params)}</script>` +
    // A widget page: the platform's script, its config in its closure only.
    // An app's page script is deferred: it runs once its root element exists.
    (widget && decl.widget
      ? `<script nonce="${nonce}">${widgetScript(decl.widget, widget)}</script>`
      : `<script nonce="${nonce}" defer src="${escapeHtml(`${base}/s/${session}/page.js`)}"></script>`) +
    `</head><body><div id="root"></div></body></html>`
  return { html, policy: await appPagePolicy(binding.app, decl, nonce, origin, framed) }
}

async function sessionBinding(session: string, host: PageHost): Promise<AppPageBinding> {
  if (!ID_RE.test(session)) throw new AppPageError(404, "page_session_invalid", "Page expired")
  const binding = parseBinding(await redis.get(sessionKey(session)))
  if (!binding || !(await hostMatches(binding, host))) {
    throw new AppPageError(404, "page_session_invalid", "This page has expired: open it again")
  }
  return binding
}

const builtPages = new Map<string, { mtimeMs: number; code: string }>()

/** `pages/<name>.js` from the package, or (in-tree source, tests) built from its `.ts`. */
async function pageScript(surface: AppSurface, page: string, decl: AppPageDecl): Promise<string> {
  if (!decl.source) throw new AppPageError(404, "page_not_found", "No page script")
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
  /**
   * What the app's own code bound into the page (`ctx.pages.link`), never what
   * the browser sent. The route still acts as the person: it re-checks every id
   * in it (and in `body`) against what that person may read or change.
   */
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

/** One audit row per route call, with the person the page acts for. */
async function auditRouteCall(binding: AppPageBinding, route: string): Promise<void> {
  const { writeAuditLog } = await import("~/modules/audit/service")
  await withPrivilegedDb(binding.orgId, "app-page-route-audit", (tx) =>
    writeAuditLog(tx, {
      orgId: binding.orgId,
      actorId: binding.userId,
      actorType: "user",
      app: binding.app,
      entityType: "app_page",
      entityId: binding.page,
      action: `${binding.app}.page_route.called`,
      metadata: { page: binding.page, route },
    }),
  )
}

/** Run one of the page's routes as the page's person. */
export async function callAppPageRoute(
  session: string,
  host: PageHost,
  route: string,
  body: unknown,
  key: string | null | undefined,
): Promise<unknown> {
  const binding = await sessionBinding(session, host)
  // The session's key, from the page's bootstrap: a session id alone (read from
  // the document, or sent out by the app's script) calls nothing.
  const given = Buffer.from(keyHashOf(typeof key === "string" ? key : ""))
  const want = Buffer.from(binding.keyHash ?? "")
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new AppPageError(403, "page_key_invalid", "This page call is not from its page")
  }
  const calls = await redis.incr(callCountKey(session))
  if (calls === 1) await redis.expire(callCountKey(session), 60)
  if (calls > PAGE_CALLS_PER_MINUTE) {
    throw new AppPageError(
      429,
      "page_calls_rate_limited",
      "Too many calls from this page: wait a minute",
    )
  }
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
  await auditRouteCall(binding, route)
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
  "Access-Control-Allow-Headers": `content-type, ${PAGE_KEY_HEADER}`,
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
        c.req.header(PAGE_KEY_HEADER),
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
  return serveAppPageRequest(
    c,
    rest,
    { kind: "org", binding: requestHostBinding(c) },
    new URL(c.req.url).origin,
  )
})

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text()
  if (!text) return {}
  const body = JSON.parse(text) as unknown
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

/**
 * `POST /api/apps/:app/pages/open` (signed in): the person's app turns a handle
 * from `ctx.pages.link` into a one-time link. `POST /api/apps/:app/pages/:page/link`
 * (signed in): a one-time link for the caller, without params.
 */
export const appPageLinkRoutes = new Hono<{
  Variables: { orgId: string; userId: string }
}>()
  .post("/:app/pages/open", async (c) => {
    try {
      const body = await jsonBody(c)
      const link = await openAppPageHandle({
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        app: c.req.param("app"),
        handle: body.handle,
      })
      return c.json({ data: link })
    } catch (err) {
      if (err instanceof SyntaxError) {
        return c.json({ error: { message: "The body is not JSON", code: "invalid_body" } }, 400)
      }
      return errorResponse(err)
    }
  })
  .post("/:app/pages/:page/link", async (c) => {
    try {
      const body = await jsonBody(c)
      if (body.params !== undefined && body.params !== null) {
        // What a route trusts comes from the app's own code, never the opener's
        // request: params ride on a handle from `ctx.pages.link` only.
        throw new AppPageError(
          400,
          "params_not_accepted",
          "A page link asked here takes no params: the app binds them with ctx.pages.link",
        )
      }
      const link = await createAppPageLink({
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        app: c.req.param("app"),
        page: c.req.param("page"),
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
