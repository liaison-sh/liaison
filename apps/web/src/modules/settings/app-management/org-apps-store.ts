// SPDX-License-Identifier: FSL-1.1-ALv2
// The workspace's apps as an apps admin manages them (S24, A4, A7): every app
// added here, Off and restricted ones included, from `GET /api/org/apps`. It
// drives the management header, the admin's Apps rows ("Off" badge), the Off
// page, the App store's Added / Off states and "Apps this role can use".
// Members never load it: the server answers it to `kernel:apps:admin` only,
// and what a member may use comes from the manifests feed alone.
import type { AppListing } from "@liaison/app-sdk"
import { createSignal } from "solid-js"
import { noteAppsChanged } from "~/framework/unavailable-apps"
import type { createApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

type ApiClient = ReturnType<typeof createApiClient>

export type OrgAppStatus = "active" | "disabled" | "error" | "removed"
export type OrgAppAccessMode = "everyone" | "restricted"

/** One row of `GET /api/org/apps`. */
export interface OrgApp {
  name: string
  displayName: string | null
  version: string | null
  kind: string
  status: OrgAppStatus
  accessMode: OrgAppAccessMode
  principals: { roleIds: string[]; userIds: string[] }
  /** The app owns at least one scope: only then can it be restricted. */
  hasOwnScopes: boolean
  /**
   * False for an app the workspace depends on (kernel, knowledge, contacts):
   * it can be neither turned Off nor removed. Absent reads as true.
   */
  canDisable?: boolean
  /** On apps of the workspace that require this one. */
  dependents: string[]
  installSource: "in-tree" | "installed"
  listing: AppListing | null
  /** The manifest's SPDX licence. */
  license?: string | null
  settings: { sections: unknown[] } | null
  /**
   * Its package is gone from the server (an app retired in favour of another):
   * no page, only a "no longer available" row in the App store to remove it.
   */
  retired?: boolean
}

/** What the POST/PUT routes answer: the app's new state. */
interface OrgAppStateView {
  name: string
  status: OrgAppStatus
  accessMode: OrgAppAccessMode
  principals: { roleIds: string[]; userIds: string[] }
}

/** `PUT /api/org/apps/:app/access`. */
export interface OrgAppAccessBody {
  mode: OrgAppAccessMode
  roleIds: string[]
  userIds: string[]
}

/** The `kernel:org_app:update` WebSocket payload. */
export interface OrgAppUpdateEvent {
  app?: unknown
  status?: unknown
  accessMode?: unknown
}

const [orgApps, setOrgAppsSignal] = createSignal<OrgApp[]>([])
const [loaded, setLoaded] = createSignal(false)
// The first load finished, with the list or with an error: until then a
// settings path of an Off app is not known to be anything.
const [settled, setSettled] = createSignal(false)
// The last load failed: the list is unknown, not empty.
const [failed, setFailed] = createSignal(false)
// The client of the last load, so a WebSocket event can refresh the list.
let lastApi: ApiClient | null = null
let inFlight: Promise<void> | null = null

const STATUSES: readonly OrgAppStatus[] = ["active", "disabled", "error", "removed"]

function merge(view: OrgAppStateView): void {
  setOrgAppsSignal((list) =>
    list.map((a) =>
      a.name === view.name
        ? { ...a, status: view.status, accessMode: view.accessMode, principals: view.principals }
        : a,
    ),
  )
}

export const orgAppsStore = {
  /** Reactive: every app of the workspace (empty until an admin's load). */
  apps: orgApps,
  /** Reactive: has the list been loaded in this session. */
  loaded,
  /** Reactive: has a load finished, loaded or failed. */
  settled,
  /** Reactive: did the last load fail (the list is unknown, not empty). */
  failed,
  /** Reactive: one app, or undefined. */
  app(name: string): OrgApp | undefined {
    return orgApps().find((a) => a.name === name)
  },
  /** Replace the list (loads and tests). */
  set(next: OrgApp[]): void {
    setOrgAppsSignal(next)
    setLoaded(true)
    setSettled(true)
  },
  reset(): void {
    setOrgAppsSignal([])
    setLoaded(false)
    setSettled(false)
    setFailed(false)
    lastApi = null
    inFlight = null
  },

  /** `GET /org/apps`. Concurrent callers share one request. */
  async load(api: ApiClient): Promise<void> {
    lastApi = api
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const list = await api.get<OrgApp[]>("/org/apps", { suppressGlobalError: true })
        orgAppsStore.set(Array.isArray(list) ? list : [])
        setFailed(false)
      } catch (err) {
        setFailed(true)
        throw err
      } finally {
        inFlight = null
        setSettled(true)
      }
    })()
    return inFlight
  },

  /** Load once per session (later changes arrive over the WebSocket). */
  async ensureLoaded(api: ApiClient): Promise<void> {
    if (loaded()) return
    await orgAppsStore.load(api)
  },

  /** Turn the app On or Off for the workspace. */
  async setEnabled(api: ApiClient, name: string, enabled: boolean): Promise<void> {
    merge(await api.post<OrgAppStateView>(`/org/apps/${name}/${enabled ? "enable" : "disable"}`))
    noteAppsChanged()
  },

  /** Who can use the app. */
  async setAccess(api: ApiClient, name: string, body: OrgAppAccessBody): Promise<void> {
    merge(await api.put<OrgAppStateView>(`/org/apps/${name}/access`, body))
  },

  /** Add a server-installed app to the workspace (On). */
  async add(api: ApiClient, name: string): Promise<void> {
    await api.post<OrgAppStateView>(`/org/apps/${name}/add`)
    // The main sidebar lists the app again (MGT-14), not at the next reload.
    noteAppsChanged()
    await orgAppsStore.load(api)
  },

  /** Remove the app from this workspace; its data is kept. */
  async remove(api: ApiClient, name: string): Promise<void> {
    merge(await api.post<OrgAppStateView>(`/org/apps/${name}/remove`))
    noteAppsChanged()
  },

  /**
   * A `kernel:org_app:update` event: apply the new state at once (badge, page),
   * then reload the list in the background for what the event does not carry.
   */
  applyUpdate(event: OrgAppUpdateEvent | undefined): void {
    if (!event || typeof event.app !== "string") return
    const name = event.app
    const status = STATUSES.find((s) => s === event.status)
    const accessMode =
      event.accessMode === "restricted" || event.accessMode === "everyone"
        ? event.accessMode
        : undefined
    setOrgAppsSignal((list) =>
      list.map((a) =>
        a.name === name
          ? { ...a, ...(status ? { status } : {}), ...(accessMode ? { accessMode } : {}) }
          : a,
      ),
    )
    if (loaded() && lastApi) void orgAppsStore.load(lastApi).catch(() => {})
  },
}

/** Can the workspace turn the app Off or remove it? */
export function canDisableOrgApp(app: Pick<OrgApp, "canDisable"> | undefined): boolean {
  return app?.canDisable !== false
}

/** Is the app Off (or removed) for the workspace? */
export function isOrgAppOff(app: Pick<OrgApp, "status"> | undefined): boolean {
  return app?.status === "disabled" || app?.status === "removed"
}

onSessionTeardown(() => orgAppsStore.reset())
