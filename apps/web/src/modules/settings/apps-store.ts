// SPDX-License-Identifier: FSL-1.1-ALv2
// The server's apps (`/api/apps`): its registry, the App store catalog, the
// install permission and each app's connections, shared by the App store, the
// install dialog, the Connectors page and the connect dialog.
import type { AppKind, AppListing } from "@liaison/app-sdk"
import { createSignal } from "solid-js"
import type { createApiClient } from "~/lib/api-client"
import type { AppManifestPreview, UpgradePreview } from "./InstallAppDialog"

type ApiClient = ReturnType<typeof createApiClient>

export interface AppEntry {
  name: string
  version: string
  displayName?: string
  /** An installed app's publisher as its manifest names it. */
  author?: string
  source: "in-tree" | "installed"
  status: "active" | "shadowed-by-bundled" | "error"
  statusMessage?: string
  trusted?: boolean
  grantedScopes?: string[]
  grantedCapabilities?: string[]
  grantedCrossAppCalls?: string[]
  /** The package ships an interface (ui.js). */
  hasUiBundle?: boolean
  /** Why the interface may load (null/absent: it may not). */
  uiTrust?: "first-party" | "publisher-signed" | "admin-approved" | null
  uiFullAccessApproved?: boolean
  uiFullAccessApprovedAt?: string
  updateUrl?: string
  installedAt?: string
  /** The workspace's state of the app (S18): On (`active`), Off, or removed. */
  orgStatus?: "active" | "disabled" | "error" | "removed"
  /** The version a rollback returns to, while it is kept on the server (S9). */
  previousVersion?: string
  /** The running version is a security release: no rollback below it. */
  noRollback?: boolean
}

/** One App store entry (`GET /api/apps/catalog`). `source: "baked"` apps ship in the
 *  image and install in one click; `source: "registry"` apps come from the configured
 *  registry and install through "Install from URL" (`packageUrl`) with the consent screen. */
export interface CatalogEntry {
  name: string
  displayName?: string
  description?: string
  version: string
  kind?: AppKind
  license?: string
  author?: string
  listing?: AppListing
  scopes?: string[]
  source?: "baked" | "registry"
  packageUrl?: string
  /** Whether this app is already installed on the instance. */
  installed: boolean
  installedVersion?: string
}

/** `GET /api/apps/catalog`: the merged listings, and a notice when the registry is down. */
export interface CatalogResponse {
  apps: CatalogEntry[]
  notice?: "registry_unreachable"
}

/** One declared credential input on a `type:"credentials"` connection. */
export interface AppCredentialField {
  name: string
  label: string
  type: string
  required?: boolean
}

/** Operator-facing "how to connect" guide co-located in the app manifest. */
export interface AppSetupGuide {
  summary?: string
  steps?: string[]
  docsUrl?: string
}

/** Public-safe connection config returned by `GET /api/apps/:appName/connections`
 *  (T2) — exactly what the connect form + `?` setup popover need. No secrets. */
export interface AppConnectionConfig {
  name: string
  type: "oauth2" | "credentials"
  description?: string
  credentialFields?: AppCredentialField[]
  setupGuide?: AppSetupGuide
  /** Per-store OAuth template vars the connect form must collect (e.g. ["shop"]). */
  templateVars?: string[]
  /** The app works without it; Settings > Apps offers it as a secondary link. */
  optional?: boolean
  /** A few words naming what it connects (manifest English; catalog may translate). */
  purpose?: string
  /** Several org accounts, each named by an identifier the app defines (not the generic form). */
  multiInstance?: boolean
  /** The scope that administers it for the organization (share, disconnect an org account),
   *  resolved by the server: the manifest's or `<app>:accounts:admin`. */
  adminScope?: string
  /** Accounts backing it: the org's and the caller's own (counts only). */
  accounts?: { active: number; error: number }
}

/** Status of the per-connection OAuth client (`GET .../oauth-client`). */
export interface OAuthClientStatus {
  configured: boolean
  /** The org's own client, the deployment's, or the app's own configuration. */
  source?: "org" | "deployment" | "app"
  /** A client stored for this connection (set from this dialog). */
  clientId?: string
  /** The end of a client the app resolves itself. */
  clientIdHint?: string
  /** Why the app refuses to provide a client (e.g. the provider is turned off). */
  reason?: string
  /** The app supplies its client itself: the dialog must not ask for one. */
  appManaged?: boolean
}

export type ConnectionState = "connected" | "attention" | "missing"

export function connectionState(conn: AppConnectionConfig): ConnectionState {
  if ((conn.accounts?.active ?? 0) > 0) return "connected"
  if ((conn.accounts?.error ?? 0) > 0) return "attention"
  return "missing"
}

/**
 * The one connection the row offers as its primary "Connect", or null.
 *
 * Only a REQUIRED connection can be primary, and only while the app has no
 * required connection working: required connections are alternatives (Mail
 * runs on Gmail OR IMAP), so one connected is enough. An app whose only
 * connections are optional (Projects' CI webhook) never shows a primary
 * Connect: it is installed and working without one.
 */
export function primaryConnection(connections: AppConnectionConfig[]): string | null {
  const required = connections.filter((c) => !c.optional)
  if (required.some((c) => connectionState(c) === "connected")) return null
  return required[0]?.name ?? null
}

/** `/upgrade/preview` response — either up-to-date or a previewed upgrade. */
export type UpgradePreviewResponse =
  | { upToDate: true; version: string }
  | {
      upToDate: false
      version: string
      manifest: AppManifestPreview
      newScopes: string[]
      newCapabilities?: string[]
      newCrossAppCalls?: string[]
      removedScopes: string[]
      previouslyGranted: string[]
    }

const [apps, setAppsSignal] = createSignal<AppEntry[]>([])
const [connections, setConnectionsSignal] = createSignal<Record<string, AppConnectionConfig[]>>({})
const [catalog, setCatalogSignal] = createSignal<CatalogEntry[]>([])
const [catalogNotice, setCatalogNotice] = createSignal<CatalogResponse["notice"]>(undefined)
// The catalog has been read in this session: until then an empty catalog is unknown, not empty.
const [catalogLoaded, setCatalogLoaded] = createSignal(false)
// Whether this org may install, upgrade and remove apps (GET /apps/install-permission). On a
// multi-tenant instance only the operator's org may; the page offers those controls only then.
// True until known, the single-org self-host case.
const [canManageInstalls, setCanManageInstalls] = createSignal(true)

export const appsStore = {
  /** Reactive accessor for the current app list. */
  apps,
  /** Reactive accessor for the per-app connection-config map. */
  connections,
  /** Reactive accessor for the App store catalog (baked and registry apps). */
  catalog,
  /** Reactive: "registry_unreachable" when the last catalog load could not read the registry. */
  catalogNotice,
  /** Reactive: has the catalog been read in this session. */
  catalogLoaded,
  /** Reactive: may this org install, upgrade and remove apps on this instance. */
  canManageInstalls,
  setCanManageInstalls(next: boolean): void {
    setCanManageInstalls(next)
  },
  /** Replace the app list (used by `load` and tests). */
  setApps(next: AppEntry[]): void {
    setAppsSignal(next)
  },
  /** Replace the connection-config map (used by `loadConnections` and tests). */
  setConnections(next: Record<string, AppConnectionConfig[]>): void {
    setConnectionsSignal(next)
  },
  /** Replace the catalog list (used by `loadCatalog` and tests). */
  setCatalog(next: CatalogEntry[]): void {
    setCatalogSignal(next)
    setCatalogLoaded(true)
  },
  /** The declared connections for one app (empty when none / not yet loaded). */
  connectionsFor(appName: string): AppConnectionConfig[] {
    return connections()[appName] ?? []
  },
  /** Clear the store — test helper. */
  reset(): void {
    setAppsSignal([])
    setConnectionsSignal({})
    setCatalogSignal([])
    setCatalogNotice(undefined)
    setCatalogLoaded(false)
    setCanManageInstalls(true)
  },

  // NOTE: the api-client prepends `env.API_BASE` ("/api") to every path, so all
  // calls here use the BARE `/apps...` form (→ `/api/apps...` on the wire),
  // matching every other api-client caller (threads, agent, mcp-manager). The
  // earlier `/api/apps...` paths double-prefixed to `/api/api/apps` (404), which
  // silently broke the whole apps settings page without an error on screen.

  /** Fetch the registry listing and refresh the store. */
  async load(api: ApiClient): Promise<void> {
    appsStore.setApps(await api.get<AppEntry[]>("/apps"))
  },

  /** Fetch one app's public-safe connection config (T2) and merge it into the
   *  map. Errors are suppressed: apps with no connection endpoint just
   *  contribute an empty list. */
  /** Every app's connections in ONE request (`GET /apps/connections`). */
  async loadAllConnections(api: ApiClient): Promise<void> {
    try {
      const map = await api.get<Record<string, AppConnectionConfig[]>>("/apps/connections", {
        suppressGlobalError: true,
      })
      setConnectionsSignal(map ?? {})
    } catch {
      setConnectionsSignal({})
    }
  },

  async loadConnections(api: ApiClient, appName: string): Promise<void> {
    try {
      const list = await api.get<AppConnectionConfig[]>(`/apps/${appName}/connections`, {
        suppressGlobalError: true,
      })
      setConnectionsSignal((m) => ({ ...m, [appName]: list ?? [] }))
    } catch {
      setConnectionsSignal((m) => ({ ...m, [appName]: [] }))
    }
  },

  /** Download + verify a package and return its manifest (no install). */
  async preflight(api: ApiClient, url: string): Promise<AppManifestPreview> {
    return api.post<AppManifestPreview>("/apps/preflight", { url })
  },

  /** Whether the per-connection OAuth client (id/secret) is configured. */
  async oauthClientStatus(
    api: ApiClient,
    appName: string,
    connectionName: string,
  ): Promise<OAuthClientStatus> {
    return api.get<OAuthClientStatus>(`/connections/${appName}/${connectionName}/oauth-client`, {
      suppressGlobalError: true,
    })
  },

  /** Set/replace the per-connection OAuth client (id/secret). Admin-only. */
  async setOAuthClient(
    api: ApiClient,
    appName: string,
    connectionName: string,
    client: { clientId: string; clientSecret: string },
  ): Promise<void> {
    await api.put(`/connections/${appName}/${connectionName}/oauth-client`, client)
  },

  /** Install a package with admin-granted scopes, then refresh. */
  async installApp(
    api: ApiClient,
    args: {
      url: string
      grantedScopes: string[]
      grantedCapabilities: string[]
      grantedCrossAppCalls: string[]
      approveUiFullAccess: boolean
    },
  ): Promise<void> {
    await api.post("/apps/install", args)
    await appsStore.load(api)
  },

  /** Uninstall an externally-installed (sideloaded) app, then refresh. */
  async uninstallApp(api: ApiClient, name: string): Promise<void> {
    await api.delete(`/apps/${name}`)
    await appsStore.load(api)
  },

  /** Ask the server whether this org may change the instance's app installs. */
  async loadInstallPermission(api: ApiClient): Promise<void> {
    const res = await api.get<{ canManageInstalls: boolean }>("/apps/install-permission")
    setCanManageInstalls(res?.canManageInstalls !== false)
  },

  /** Fetch the first-party app catalog and refresh the store. */
  async loadCatalog(api: ApiClient): Promise<void> {
    const res = await api.get<CatalogResponse>("/apps/catalog")
    appsStore.setCatalog(res?.apps ?? [])
    setCatalogNotice(res?.notice)
  },

  /** Install a first-party catalog app with one click, then refresh both the
   *  registry listing (the new app appears under "installed") and the catalog
   *  (its entry flips to `installed: true`). */
  async installCatalogApp(api: ApiClient, name: string): Promise<void> {
    await api.post(`/apps/catalog/${name}/install`)
    await Promise.all([appsStore.load(api), appsStore.loadCatalog(api)])
  },

  /** Preview an upgrade against the app's update channel. */
  async upgradePreview(api: ApiClient, name: string): Promise<UpgradePreviewResponse> {
    return api.post<UpgradePreviewResponse>(`/apps/${name}/upgrade/preview`)
  },

  /** Apply a previewed upgrade with the admin-granted scopes, then refresh. */
  async upgradeApp(
    api: ApiClient,
    name: string,
    grants: {
      grantedScopes: string[]
      grantedCapabilities: string[]
      grantedCrossAppCalls: string[]
      approveUiFullAccess: boolean
    },
  ): Promise<void> {
    await api.post(`/apps/${name}/upgrade/apply`, grants)
    await appsStore.load(api)
  },

  /** Make the app's previous version the active one again (instance operator only), then refresh. */
  async rollbackApp(api: ApiClient, name: string): Promise<{ version: string }> {
    const res = await api.post<{ version: string }>(`/apps/${encodeURIComponent(name)}/rollback`)
    await appsStore.load(api)
    return res
  },

  /** Approve or withdraw "this app's interface runs with full access to your session". */
  async setUiApproval(api: ApiClient, name: string, approved: boolean): Promise<void> {
    await api.post(`/apps/${name}/ui-approval`, { approved })
    await appsStore.load(api)
  },
}

/** Build the `UpgradePreview` the dialog consumes from a non-up-to-date response. */
export function toUpgradePreview(
  res: Extract<UpgradePreviewResponse, { upToDate: false }>,
): UpgradePreview {
  return {
    manifest: res.manifest,
    newScopes: res.newScopes,
    newCapabilities: res.newCapabilities,
    newCrossAppCalls: res.newCrossAppCalls,
    removedScopes: res.removedScopes,
    previouslyGranted: res.previouslyGranted,
  }
}
