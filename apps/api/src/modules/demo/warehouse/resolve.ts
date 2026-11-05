// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The runtime half: turning the stored sentinel into a handle on the warehouse.
//
// Two gates, the same pair the demo Shopify provider and the credential and
// mail doors use:
//
//   * the PROCESS (`isDemoModeEnabled()`), one boolean read of a module local,
//     so a normal deployment pays nothing and never loads this path,
//   * the ORG (the demo marker), so the mechanism is keyed on data rather than
//     on a global that would have to be right for every tenant at once.
//
// For an org that passes both, the sentinel resolves to the warehouse's own
// DSN (a dedicated read-only LOGIN role). Nothing about that handle came from
// the org's data: the DSN is process configuration, so a demo org's stored
// bytes remain worthless to anybody who reads them.
//
// For an org that passes both gates and has a `database` connection carrying
// something OTHER than the sentinel, this REFUSES rather than dialling it. A
// demo org is not allowed to hold a real credential, and the enforcement is
// here as well as at the door that would have to have been bypassed to write
// one.
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoMarker } from "~/modules/demo/demo-org"
import { demoWarehouseCatalog } from "./catalog"
import { DEMO_WAREHOUSE_DSN_ENV, isDemoWarehouseSentinel } from "./sentinel"

export class DemoWarehouseRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DemoWarehouseRefused"
  }
}

/** The handle a demo org's database tools run through. */
export interface DemoWarehouseHandle {
  connectionString: string
  /** Marks the shared pool: one dedicated login serves every demo org. */
  sharedPool: string
}

/** Does this process serve `orgId` as a demo org? Both gates, in order. */
export async function isDemoWarehouseOrg(orgId: string): Promise<boolean> {
  if (!isDemoModeEnabled()) return false
  return (await loadDemoMarker(orgId)) !== null
}

/**
 * The warehouse handle for a demo org, or null when this box / this org is none
 * of the demo's business and the stored credentials should be used as they are.
 *
 * `stored` is what the connections store handed back. A demo org must carry the
 * sentinel and nothing else; anything else is refused loudly.
 */
export async function resolveDemoWarehouseHandle(
  orgId: string,
  stored: { connectionString?: string; gateUrl?: string; gateToken?: string },
): Promise<DemoWarehouseHandle | null> {
  if (!(await isDemoWarehouseOrg(orgId))) {
    // Not a demo org. A sentinel here would mean a row seeded onto an org that
    // has since lost its marker: refuse it rather than trying to parse it as a
    // DSN, which is the only other thing that could happen to it.
    if (isDemoWarehouseSentinel(stored.connectionString)) {
      throw new DemoWarehouseRefused(
        "This organization carries the demo warehouse sentinel but is not a demo organization. Reconnect the database app with a real connection.",
      )
    }
    return null
  }
  if (stored.gateUrl || stored.gateToken) {
    throw new DemoWarehouseRefused(
      "A demo organization cannot hold database gate credentials. Only the demo warehouse is reachable here.",
    )
  }
  if (!isDemoWarehouseSentinel(stored.connectionString)) {
    throw new DemoWarehouseRefused(
      "A demo organization cannot hold a database connection string. Only the demo warehouse is reachable here.",
    )
  }
  // The warehouse has its OWN login (a role in no Liaison role, SELECT on the
  // warehouse schema only). It is never served over the application's own
  // connection: that login can reach the privileged roles, and a query that
  // slipped past the read-only guard would then reach every tenant.
  const dsn = process.env[DEMO_WAREHOUSE_DSN_ENV]?.trim()
  if (!dsn) {
    throw new DemoWarehouseRefused(
      `The demo warehouse is unavailable: this deployment has no ${DEMO_WAREHOUSE_DSN_ENV}.`,
    )
  }
  return { connectionString: dsn, sharedPool: "warehouse" }
}

/** The catalog a demo org sees: the warehouse's, never the liaison-self one. */
export function demoWarehouseReadCatalog() {
  return demoWarehouseCatalog
}
