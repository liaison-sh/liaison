// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Single source of truth for the `kernel/connected_account:create` payload that
// re-drives an app's post-connect initialization. Shared by the reconcile
// SERVICE (`reconcileConnection`, in-process) and the reconcile CLI
// (`scripts/reconcile-connection.ts`, ops) so both replay the EXACT shape
// `handleOAuthCallback` emits — no drift between the two surfaces.
//
// Type-only import: this module has NO runtime imports, so the CLI can import
// the builder without dragging in the env validator / DB layer.
import type { AppEvent } from "~/infra/events/event-bus"

/** The `connected_accounts` columns the connect event is built from. */
export interface ConnectedAccountRow {
  id: string
  appName: string
  connectionName: string
  ownerType: string
  ownerId: string | null
  providerType: string
  identifier: string
}

/**
 * Build the connect event. `actorId` is the operator's user id (UI/route) or
 * `null` for an unattended CLI/system run — `actorType` follows. `reconcile:true`
 * marks the event as a replayed initialization for observability; the app
 * handler treats it identically to a first connect (idempotent existing-row
 * branch).
 */
export function buildConnectedAccountCreateEvent(
  row: ConnectedAccountRow,
  orgId: string,
  actorId: string | null,
  kernelPublicBaseUrl: string,
): AppEvent {
  return {
    app: "kernel",
    entity: "connected_account",
    action: "create",
    entityId: row.id,
    data: {
      id: row.id,
      orgId,
      appName: row.appName,
      connectionName: row.connectionName,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      providerType: row.providerType,
      identifier: row.identifier,
      status: "active",
      kernelPublicBaseUrl,
      reconcile: true,
    },
    actorId,
    actorType: actorId ? "user" : "system",
    orgId,
    timestamp: new Date().toISOString(),
  }
}
