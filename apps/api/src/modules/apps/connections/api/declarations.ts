// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which apps hold platform-held HTTP API connections, read from their
 * manifests: an app that declares ONE connection with an `api` block gets the
 * `ctx.api.*` bridge methods, the adapter save and restore tools, and its
 * adapters and credentials keyed by (org, app, connection, identifier). No app
 * is named here or anywhere in the kernel: features that read API connections
 * (customer context, imports, setup state, config export, tours, secret
 * requests) go through the contract the `api` block declares:
 *
 *  - `customerContext` names the app's own tools that answer a customer (list,
 *    read, write): the agent's customer block and the customer card read the
 *    connections of the apps that declare it;
 *  - `importSource: true`: an import transform may pull from its connections.
 */
import { appBridgeManifest, listInstalledAppNames } from "~/modules/apps/app-registries"
import type { AdapterRow } from "./store"

export interface ApiCustomerContextDecl {
  /** The app's tool that lists a connection's operations. */
  listTool: string
  /** The app's tool that runs a read operation. */
  readTool: string
  /** The app's tool that runs a write operation. */
  writeTool: string
}

export interface ApiConnectionDeclaration {
  readScope: string
  writeScope: string
  adminScope: string
  customerContext?: ApiCustomerContextDecl
  importSource?: boolean
  /** The `provisioning` field that takes `[{ identifier, adapter }]` (config export). */
  provisionKey?: string
}

/** One app's API connection in one org: what the store, caches and limiter are keyed by. */
export interface ApiConn {
  orgId: string
  app: string
  connection: string
}

export interface ApiConnDecl extends ApiConn {
  decl: ApiConnectionDeclaration
}

interface ManifestWithConnections {
  connections?: Record<string, { api?: Partial<ApiConnectionDeclaration> } | undefined>
}

/** The manifest's API connection (the one connection carrying an `api` block), or null. */
export function apiConnectionOf(
  manifest: ManifestWithConnections | undefined | null,
): { connection: string; decl: ApiConnectionDeclaration } | null {
  for (const [connection, conn] of Object.entries(manifest?.connections ?? {})) {
    const block = conn?.api
    if (
      block &&
      typeof block.readScope === "string" &&
      typeof block.writeScope === "string" &&
      typeof block.adminScope === "string"
    ) {
      return { connection, decl: block as ApiConnectionDeclaration }
    }
  }
  return null
}

/** `app`'s API connection in `orgId` (registered for the org), or null. */
export function apiConnFor(orgId: string, app: string): ApiConnDecl | null {
  const found = apiConnectionOf(appBridgeManifest(orgId, app) as ManifestWithConnections)
  if (!found) return null
  return { orgId, app, connection: found.connection, decl: found.decl }
}

/** Every app of the org that declares an API connection, by app name. */
export function apiConnectionsOf(orgId: string): ApiConnDecl[] {
  return [...listInstalledAppNames(orgId)].sort().flatMap((app) => {
    const c = apiConnFor(orgId, app)
    return c ? [c] : []
  })
}

/** The apps whose API connection answers customer questions (`customerContext`). */
export function customerContextConnections(
  orgId: string,
): Array<ApiConnDecl & { customer: ApiCustomerContextDecl }> {
  return apiConnectionsOf(orgId).flatMap((c) =>
    c.decl.customerContext ? [{ ...c, customer: c.decl.customerContext }] : [],
  )
}

/** The apps whose API connection an import may pull from (`importSource`). */
export function importSourceConnections(orgId: string): ApiConnDecl[] {
  return apiConnectionsOf(orgId).filter((c) => c.decl.importSource === true)
}

/**
 * The import-source connection (`importSource`) that holds the adapter
 * `identifier`, with that row; when none holds it, the first import-source
 * connection (where a new one is saved) and no row. Null when no app of the
 * org declares an import source.
 */
export async function importSourceConnection(
  orgId: string,
  identifier: string,
): Promise<{ conn: ApiConnDecl; row: AdapterRow | null } | null> {
  const all = importSourceConnections(orgId)
  const { getAdapterRow } = await import("./store")
  for (const conn of all) {
    const row = await getAdapterRow(conn, identifier)
    if (row) return { conn, row }
  }
  const first = all[0]
  return first ? { conn: first, row: null } : null
}
