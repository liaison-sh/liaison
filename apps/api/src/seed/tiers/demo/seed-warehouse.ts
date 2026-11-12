// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ORACLE LAYER: the demo org's read-only window onto a real SQL warehouse.
//
// The single most convincing thing an agent-native product can do is answer a
// question nobody wrote a screen for: "what were returns by month for the Kestrel
// 10", "which dealers are past their credit terms", "did 2.0.0 return worse
// than 1.4.0". That is the `database` connector's job, and on the demo box it
// did nothing at all: the app was enabled, no connection existed, and all five
// tools answered `not_connected`.
//
// This layer fixes that in three steps, all idempotent:
//
//   1. BUILD the warehouse. One schema (`demo_warehouse`) on the deployment's
//      own Postgres, holding two and a half years of Resonant Audio Labs books
//      generated from `world.ts`, plus a dedicated read-only LOGIN role that can see
//      that schema and nothing else. Shared by every demo org on the box, so a
//      visitor signup does not pay to rebuild it.
//   2. ENABLE the `database` app for the org.
//   3. CONNECT it, with a sentinel in place of a DSN. A demo org may not hold a
//      real credential, and it does not: the handle is resolved at call time
//      from the process's own configuration. See
//      `apps/api/src/modules/demo/warehouse/resolve.ts`.
//
// OPT-IN, AND THEN AN ERROR WHEN IT FAILS. The layer runs only on a deployment
// that turns it on (`LIAISON_DEMO_WAREHOUSE`, see `DemoSeedPlanOptions`): it
// needs the warehouse's own login (`LIAISON_DEMO_WAREHOUSE_DATABASE_URL`) and,
// to build, a privileged DSN (`MIGRATION_DATABASE_URL`). The deploy-time seed
// has both; the serving process has no privileged DSN (the entrypoint drops
// it), so a signup there connects to the warehouse the deploy built. Turned on
// without the login, or failing in any other way, the layer throws and the
// caller records the seed as failed, exactly like the other layers.

import { runAppProvisioning } from "~/modules/apps/app-provisioning"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  DEMO_WAREHOUSE_DSN_ENV,
  DEMO_WAREHOUSE_SCHEMA,
  DemoWarehouseProvisionError,
  installDemoWarehouseConnection,
  provisionDemoWarehouse,
} from "~/modules/demo/warehouse"
import { installApps } from "~/seed/factories/org/apps"
import { demoDomainAccessProvision, type SeedDemoOrgResult } from "./seed-org"

export interface SeedDemoWarehouseResult {
  /** Row counts per warehouse table, as generated. */
  counts: Record<string, number>
  /** False when the warehouse was already current for today and reused. */
  rebuilt: boolean
  /** The connection row the org's database tools resolve. */
  connectionId: string
}

export interface SeedDemoWarehouseOptions {
  /** Anchor for the generated history. Defaults to now. */
  baseTime?: Date
  /** Rebuild the dataset even when the build stamp says it is current. */
  force?: boolean
  log?: (message: string) => void
}

/**
 * Give `org` a working oracle. Throws on any failure; `seedDemoWorld` catches
 * it per layer.
 */
export async function seedDemoWarehouse(
  org: Pick<SeedDemoOrgResult, "orgId" | "orgSlug" | "adminUserId">,
  opts: SeedDemoWarehouseOptions = {},
): Promise<SeedDemoWarehouseResult> {
  const log = opts.log ?? (() => {})

  // Checked first, on every path: the connect-only path below would otherwise
  // hand the org a connection whose every call is refused at run time.
  if (!process.env[DEMO_WAREHOUSE_DSN_ENV]?.trim()) {
    throw new DemoWarehouseProvisionError(
      `the warehouse part is on but ${DEMO_WAREHOUSE_DSN_ENV} is not set: set it, or turn LIAISON_DEMO_WAREHOUSE off`,
    )
  }

  // The serving process runs WITHOUT the privileged DSN (the image entrypoint
  // drops it), so a visitor signup cannot build the warehouse: it connects the
  // org to the one the deploy-time seed (run with `docker compose exec`, which
  // does carry it) built. Any other provisioning failure still throws.
  let built: { schema: string; role: string; counts: Record<string, number>; rebuilt: boolean }
  try {
    built = await provisionDemoWarehouse({
      ...(opts.baseTime ? { now: opts.baseTime } : {}),
      ...(opts.force === true ? { force: true } : {}),
      log,
    })
  } catch (err) {
    if (!(err instanceof DemoWarehouseProvisionError) || err.code !== "no_admin_dsn") throw err
    log(`warehouse: ${err.message} Connecting to the warehouse the deploy seed built.`)
    built = { schema: DEMO_WAREHOUSE_SCHEMA, role: "(deploy-built)", counts: {}, rebuilt: false }
  }

  // The `database` app, from the catalog. It is not in `DEMO_APPS` (that list
  // is the tabbed surface); the oracle is headless and reaches the org through
  // its tools. Its confidential domains run for the roles the world names,
  // through the app's own provisioning (desired state: a re-seed puts back what
  // a visitor changed).
  const [app] = await installApps(org.orgId, org.adminUserId, ["database"], log)
  if (!app?.enabled) throw new Error(`the database app did not install: ${app?.error ?? "unknown"}`)
  await ensureAppsForOrg(org.orgId)
  const access = await runAppProvisioning({
    orgId: org.orgId,
    appName: "database",
    config: demoDomainAccessProvision(),
    dryRun: false,
  })
  if (access.changed.length > 0) log(`warehouse: ${access.changed.join("; ")}`)

  const { connectionId } = await installDemoWarehouseConnection({
    orgId: org.orgId,
    createdByUserId: org.adminUserId,
  })
  log(
    `warehouse: org '${org.orgSlug}' connected to ${built.schema} as ${built.role} (${built.rebuilt ? "rebuilt" : "reused"})`,
  )

  return { counts: built.counts, rebuilt: built.rebuilt, connectionId }
}
