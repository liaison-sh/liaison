// SPDX-License-Identifier: FSL-1.1-ALv2
// Which organizations may see and run an app: the tenant boundary of org-private
// custom apps (every edition).
//
// Apps are instance-wide: every org on a server runs the same installed code.
// An org admin may also install a custom app for their own org only (managed
// and self-hosted alike: a multi-org self-hosted server has the same boundary). Its package name carries the org's key (`<base>-o<orgKey>`, orgKey
// = the first 8 hex of sha256(org id)), so every registry, schema, scope, route
// and webhook that keys on the app name stays unique without re-keying the
// kernel, and its `kernel.apps_installed` rows carry the org (`org_id`, 0267).
//
// ONE predicate, `appVisibleToOrg(name, orgId)`, decides whether `orgId` may see
// or run app `name`: an instance app (no owner) is visible to every org, an
// org-private app only to its owner. Every dispatch path consults it before
// serving an org-private app, and refuses as not found:
//   - registration (`registerApps`): another org's private app never enters an
//     org's registries, so its tools, views, routes, webhooks, MCP tools,
//     schedulers and event subscriptions do not exist there;
//   - the persisted app gate (`isAppActiveForOrgAsync`, org-apps.ts), which the
//     tool dispatch, job dispatch, webhook routes and retry worker, event
//     subscribers, PDF rendering and connection callbacks all read;
//   - explicitly at the entry points that serve by name without an org's
//     registry: tool calls (execute-tool.ts), webhooks (webhooks/routes.ts),
//     the cron fan-out (fanout-runtime.ts), event delivery (runtime.ts),
//     MCP listings (mcp/tool-call.ts), the `ui.js` bundle, its frame and
//     statement files (ui-bundle-routes.ts: only on the owner's own host), the
//     app listings and the org-level enable (install-routes.ts,
//     enabled-apps.ts, org-app-routes.ts).
// On top of the owner rows, a name shaped like a custom app (`-o<8 hex>`)
// whose key is not the org's own is never visible, on any edition, even
// before the owner rows are read: a stale cache in another process cannot open
// it to a second tenant.
//
// What such an app may declare is bounded at install (`assertCustomAppManifest
// Allowed`): org-level capabilities only, no private-host test flag, no raised
// sandbox limits, nothing the instance-operator gate exists for.
import { createHash } from "node:crypto"
import { isNotNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { withSystemDb } from "~/db/privileged"
import { appsInstalled } from "~/db/schema/kernel/apps-installed"
import { appsLogger as log } from "~/lib/logger"
import { onCatalogGenerationBump } from "~/modules/apps/catalog-generation"
import { customAppBase, customAppNameKey } from "~/modules/apps/custom-app-name"

export { customAppBase, customAppNameKey }

/** The org's key in its custom app names: the first 8 hex of sha256(org id). */
export function customAppOrgKey(orgId: string): string {
  return createHash("sha256").update(orgId).digest("hex").slice(0, 8)
}

/** The name an org's custom app of base `base` must carry. */
export function expectedCustomAppName(base: string, orgId: string): string {
  return `${base}-o${customAppOrgKey(orgId)}`
}

// --- Owners -------------------------------------------------------------------

const OWNERS_TTL_MS = 10_000
/** name → owning org of every org-private app, and the ones the operator disabled. */
interface OrgScope {
  map: Map<string, string>
  disabled: Set<string>
}

let owners: ({ at: number } & OrgScope) | null = null
let loading: Promise<OrgScope> | null = null

/** Forget the owner rows (an install, uninstall or purge changed them). */
export function invalidateAppOrgScope(): void {
  owners = null
  loading = null
}

// Another process's install reaches this one as a catalog generation bump
// (activation.ts syncActiveVersionsFromDb): the owners are read again with it.
onCatalogGenerationBump(invalidateAppOrgScope)

async function loadOwners(): Promise<OrgScope> {
  const rows = await withSystemDb("app-org-scope", (db) =>
    db
      .selectDistinct({
        name: appsInstalled.name,
        orgId: appsInstalled.orgId,
        disabled: isNotNull(appsInstalled.disabledAt),
      })
      .from(appsInstalled)
      .where(isNotNull(appsInstalled.orgId)),
  )
  const map = new Map<string, string>()
  const disabled = new Set<string>()
  for (const r of rows) {
    if (r.orgId) map.set(r.name, r.orgId)
    if (r.disabled) disabled.add(r.name)
  }
  return { map, disabled }
}

/** The owner rows (and disabled names) of every org-private app. Fail-closed: throws when never read. */
async function orgScope(): Promise<OrgScope> {
  if (owners && Date.now() - owners.at < OWNERS_TTL_MS) return owners
  if (!loading) {
    const started = loadOwners()
    loading = started
    started.then(
      (scope) => {
        if (loading === started) {
          owners = { at: Date.now(), ...scope }
          loading = null
        }
      },
      () => {
        if (loading === started) loading = null
      },
    )
  }
  try {
    return await loading
  } catch (err) {
    // A stale answer is still an answer (owners change only on install and
    // uninstall); with none, the caller fails closed.
    if (owners) {
      log.warn({ err }, "app owner rows unreadable; keeping the last answer")
      return owners
    }
    throw err
  }
}

/** The org an org-private app belongs to; null for an instance app (or none installed). */
export async function appOwnerOrg(name: string): Promise<string | null> {
  return (await orgScope()).map.get(name) ?? null
}

/** Whether the operator disabled this org-private app (0268). */
export async function isCustomAppDisabled(name: string): Promise<boolean> {
  return (await orgScope()).disabled.has(name)
}

/**
 * THE predicate: may `orgId` see and run app `name`? An instance app: yes. An
 * org-private app: only its owner. A custom-app-shaped name of another org's
 * key: never. A custom app the operator disabled: never, its owner included.
 * Fail-closed (throws) when the owner rows were never readable. The same on
 * every edition: ownership is the owner row, never the edition.
 */
export async function appVisibleToOrg(name: string, orgId: string): Promise<boolean> {
  if (name === "kernel") return true
  const key = customAppNameKey(name)
  if (key !== null && key !== customAppOrgKey(orgId)) return false
  const scope = await orgScope()
  if (scope.disabled.has(name)) return false
  const owner = scope.map.get(name) ?? null
  return owner === null || owner === orgId
}

/** `appVisibleToOrg` over a list, keeping the order. */
export async function filterAppsVisibleToOrg<T>(
  items: readonly T[],
  orgId: string,
  nameOf: (item: T) => string,
): Promise<T[]> {
  const out: T[] = []
  for (const item of items) if (await appVisibleToOrg(nameOf(item), orgId)) out.push(item)
  return out
}

/** 404 unless `orgId` may see app `name` (the answer an unknown app gets). */
export async function assertAppVisibleToOrg(name: string, orgId: string): Promise<void> {
  if (!(await appVisibleToOrg(name, orgId))) {
    throw new HTTPException(404, { message: `App '${name}' is not installed` })
  }
}

/** Whether `name` is an org-private app (or carries a custom app's name shape). */
export async function isOrgPrivateApp(name: string): Promise<boolean> {
  if (customAppNameKey(name) !== null) return true
  return (await appOwnerOrg(name)) !== null
}

// --- What a custom app may declare ------------------------------

/**
 * The platform capabilities an org-private app may hold: the org-level grants
 * of an ordinary app (each acts inside the org through the bridge, under the
 * app's own scopes). Everything else (`agent.spawn`, `grants.setUserScopes`,
 * any capability added later) is refused until it is judged org-level and
 * listed here.
 */
export const CUSTOM_APP_ALLOWED_CAPABILITIES = [
  "agent.run",
  "realtime.publish",
  "bulk.fetch",
  "messages.post",
  "pdf.render",
  "sequences.allocate",
  "contacts.addToOrganisation",
] as const

/** The sandbox limits a custom app may not raise (production defaults). */
export const CUSTOM_APP_LIMITS = {
  toolTimeoutMs: 5_000,
  searchTimeoutMs: 5_000,
  jobTimeoutMs: 60_000,
  webhookBodyLimitBytes: 1024 * 1024,
} as const

export const CUSTOM_APP_CAPABILITY_CODE = "custom_app_capability"
export const CUSTOM_APP_NAME_CODE = "custom_app_name"

/** 422: the custom app declares something an org-level app may not hold. */
export class CustomAppCapabilityError extends HTTPException {
  readonly code = CUSTOM_APP_CAPABILITY_CODE
  readonly errorFields: { capability: string }
  constructor(capability: string) {
    super(422, {
      message: `A custom app may not declare '${capability}': it is reserved to apps the instance operator installs.`,
    })
    this.errorFields = { capability }
  }
}

export const CUSTOM_APP_DISABLED_CODE = "custom_app_disabled"

/** 409: the operator disabled this custom app; its owner cannot replace or remove it. */
export class CustomAppDisabledError extends HTTPException {
  readonly code = CUSTOM_APP_DISABLED_CODE
  constructor(name: string) {
    super(409, {
      message: `The custom app '${name}' was disabled by the operator of this server. Contact support to have it enabled again.`,
    })
  }
}

/** 422: the custom app's name is not `<base>-o<orgKey>` (or its base is taken). */
export class CustomAppNameError extends HTTPException {
  readonly code = CUSTOM_APP_NAME_CODE
  readonly errorFields: { expectedName: string }
  constructor(message: string, expectedName: string) {
    super(422, { message })
    this.errorFields = { expectedName }
  }
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v)

function overLimit(value: unknown, limit: number): boolean {
  return typeof value === "number" && value > limit
}

/**
 * The first declaration of `manifest` an org-private app may not carry, or
 * null. Pure; `assertCustomAppManifestAllowed` throws it as a 422.
 */
export function forbiddenCustomAppDeclaration(manifest: Rec): string | null {
  const allowed = new Set<string>(CUSTOM_APP_ALLOWED_CAPABILITIES)
  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
  for (const cap of caps) if (typeof cap !== "string" || !allowed.has(cap)) return String(cap)
  if (manifest.trusted === true) return "trusted"
  if (manifest.rlsManagedBy !== undefined) return "rlsManagedBy"
  if (Array.isArray(manifest.routes) && manifest.routes.length > 0) return "routes"
  const network = isRec(manifest.network) ? manifest.network : {}
  if (network.allowPrivateHostsInTest === true) return "network.allowPrivateHostsInTest"
  // a custom app's credentials go only to hosts its connection names, so a
  // connection that names none (any reachable host) is refused.
  for (const [name, conn] of Object.entries(
    isRec(manifest.connections) ? manifest.connections : {},
  )) {
    const domains = isRec(conn) ? conn.allowedDomains : undefined
    if (!Array.isArray(domains) || domains.length === 0) {
      return `connections.${name}.allowedDomains (empty)`
    }
  }
  for (const [name, tool] of Object.entries(isRec(manifest.tools) ? manifest.tools : {})) {
    if (isRec(tool) && overLimit(tool.timeoutMs, CUSTOM_APP_LIMITS.toolTimeoutMs)) {
      return `tools.${name}.timeoutMs`
    }
  }
  for (const [name, job] of Object.entries(isRec(manifest.jobs) ? manifest.jobs : {})) {
    if (isRec(job) && overLimit(job.timeoutMs, CUSTOM_APP_LIMITS.jobTimeoutMs)) {
      return `jobs.${name}.timeoutMs`
    }
  }
  if (
    isRec(manifest.search) &&
    overLimit(manifest.search.timeoutMs, CUSTOM_APP_LIMITS.searchTimeoutMs)
  ) {
    return "search.timeoutMs"
  }
  for (const [name, hook] of Object.entries(isRec(manifest.webhooks) ? manifest.webhooks : {})) {
    if (isRec(hook) && overLimit(hook.timeoutMs, CUSTOM_APP_LIMITS.toolTimeoutMs)) {
      return `webhooks.${name}.timeoutMs`
    }
    if (isRec(hook) && overLimit(hook.bodyLimitBytes, CUSTOM_APP_LIMITS.webhookBodyLimitBytes)) {
      return `webhooks.${name}.bodyLimitBytes`
    }
  }
  return forbiddenCustomAppSchemaDeclaration(manifest.schema)
}

/**
 * The tables of an org-private app stay inside its own schema. A foreign key
 * names another schema (`references.schema`: the kernel, another app, another
 * tenant's custom app): the registration DDL runs privileged and Postgres
 * checks a foreign key without RLS, so it would let the app pin, block the
 * deletion of and probe for rows of any org. Only a reference to one of its
 * own tables (no `schema`) is allowed. Triggers are free-form SQL running in
 * other writers' transactions: refused too, whoever signed the package.
 */
function forbiddenCustomAppSchemaDeclaration(schema: unknown): string | null {
  if (!isRec(schema)) return null
  for (const [table, def] of Object.entries(schema)) {
    if (!isRec(def)) continue
    for (const [field, fieldDef] of Object.entries(isRec(def.fields) ? def.fields : {})) {
      if (!isRec(fieldDef) || fieldDef.references === undefined) continue
      const ref = fieldDef.references
      if (!isRec(ref) || (ref.schema !== undefined && ref.schema !== "")) {
        return `schema.${table}.fields.${field}.references`
      }
    }
    if (def.triggers !== undefined) return `schema.${table}.triggers`
  }
  return null
}

/** 422 `custom_app_capability` naming the first forbidden declaration. */
export function assertCustomAppManifestAllowed(manifest: Rec): void {
  const forbidden = forbiddenCustomAppDeclaration(manifest)
  if (forbidden !== null) throw new CustomAppCapabilityError(forbidden)
}

/**
 * The name rule of a custom app: `<base>-o<orgKey>` with the installing org's
 * key, and a base that is no catalog or in-tree app and no installed instance
 * app (`takenBases`). Refused with the expected name.
 */
export function assertCustomAppName(
  name: string,
  orgId: string,
  takenBases: ReadonlySet<string>,
): void {
  const key = customAppNameKey(name)
  const base = key === null ? name : customAppBase(name)
  const expected = expectedCustomAppName(base, orgId)
  if (key !== customAppOrgKey(orgId)) {
    throw new CustomAppNameError(
      `A custom app of this organization is named '<name>-o${customAppOrgKey(orgId)}': rename '${name}' to '${expected}'.`,
      expected,
    )
  }
  if (takenBases.has(base)) {
    throw new CustomAppNameError(
      `'${base}' is the name of an app this server provides: choose another name for the custom app.`,
      expected,
    )
  }
}

/**
 * The status of an app's first row for an org. In the managed edition an instance app the
 * operator installed from the catalog is only offered to the other workspaces of the cell:
 * it stays out of them (tools, routes, sidebar, listings) until their admin adds it (S33).
 * The in-tree apps, an org's own custom app and the operator's org start On, as everywhere.
 */
export function firstAppStatus(input: {
  managed: boolean
  isOperatorOrg: boolean
  instanceInstalled: boolean
}): "active" | "removed" {
  return input.managed && input.instanceInstalled && !input.isOperatorOrg ? "removed" : "active"
}
