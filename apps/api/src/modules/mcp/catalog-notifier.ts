// SPDX-License-Identifier: FSL-1.1-ALv2
import { appsLogger as log } from "~/lib/logger"

// In-process registry of active MCP server instances + a debounced
// list_changed emitter. When the tool catalog could have changed for a
// connection's owner (app install/uninstall or a permission change), active
// connections get one coalesced notifications/tools/list_changed.
//
// Reconnect is the guaranteed correctness fallback: a fresh tools/list always
// recomputes from the live registry regardless of notifications (see test).

interface ActiveServer {
  connectionId: string
  orgId: string
  ownerId: string
  sendListChanged: () => void | Promise<void>
}

const DEBOUNCE_MS = 250

const active = new Map<string, ActiveServer>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Entity types whose change can alter the owner's effective tool catalog.
const PERMISSION_ENTITIES = new Set([
  "role_assignment",
  "user_scope",
  "user_dimension",
  "role_scope",
  "role_dimension",
])

export function registerActiveServer(s: ActiveServer): void {
  active.set(s.connectionId, s)
}

export function unregisterActiveServer(connectionId: string): void {
  active.delete(connectionId)
  const t = pendingTimers.get(connectionId)
  if (t) {
    clearTimeout(t)
    pendingTimers.delete(connectionId)
  }
}

function scheduleListChanged(server: ActiveServer): void {
  if (pendingTimers.has(server.connectionId)) return // already coalescing
  const timer = setTimeout(async () => {
    pendingTimers.delete(server.connectionId)
    if (!active.has(server.connectionId)) return // closed mid-debounce
    try {
      await server.sendListChanged()
    } catch (err) {
      log.warn({ err, connectionId: server.connectionId }, "MCP list_changed send failed")
    }
  }, DEBOUNCE_MS)
  pendingTimers.set(server.connectionId, timer)
}

interface CatalogEvent {
  orgId?: string
  entity: string
  action: string
  // User-scoped permission events (role_assignment, user_scope,
  // user_dimension) carry the affected user in data.targetUserId (see
  // permissions/roles.ts). Role-level events (role_scope, role_dimension)
  // carry only roleId — they affect every user holding that role, so we do
  // NOT per-user filter them (notify all org connections, fail-safe).
  data?: unknown
}

export function onCatalogEvent(evt: CatalogEvent): void {
  if (!evt.orgId) return

  const isPermissionChange = PERMISSION_ENTITIES.has(evt.entity)
  // App lifecycle: Phase 12 emits NO `entity:"app"` install/uninstall event
  // (app registration is registry/startup-based — see apps/runtime.ts). This
  // branch is forward-looking: it becomes live the moment such an event is
  // added, with zero further wiring. Until then, app-set changes are reflected
  // via the reconnect correctness boundary (spec C5 fallback / Amendment).
  const isAppLifecycle = evt.entity === "app"
  if (!isPermissionChange && !isAppLifecycle) return

  const affectedUserId =
    isPermissionChange && evt.data && typeof evt.data === "object"
      ? ((evt.data as { targetUserId?: string }).targetUserId ?? null)
      : null

  for (const server of active.values()) {
    if (server.orgId !== evt.orgId) continue
    // App lifecycle affects every connection in the org; a permission change
    // targets a specific user when the event names one.
    if (isPermissionChange && affectedUserId && server.ownerId !== affectedUserId) continue
    scheduleListChanged(server)
  }
}

// Test-only: drains pending debounce timers deterministically.
export function __resetCatalogNotifier(): void {
  for (const t of pendingTimers.values()) clearTimeout(t)
  pendingTimers.clear()
  active.clear()
}
