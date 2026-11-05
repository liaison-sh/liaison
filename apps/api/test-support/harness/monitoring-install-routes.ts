// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Monitoring E2E harness — test-only install + incident seed routes.
//
// Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES).
// Mounted at `/api/_test/monitoring`. Monitoring had no browser coverage at
// all: its incident board went through the shared CardTable with nothing
// driving it, so the phone story was unproven. Modelled on
// social-install-routes.ts, minus the connection (monitoring has none: alerts
// arrive on a signed webhook, so there is no account to attach).
//
//   POST /install-for-test  — install the frozen `.liaisonapp` + reload the
//                             in-process registry for the org.
//   POST /seed-incident     — insert one incident row directly, the shape the
//                             webhook handler writes.

import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"

// apps/api/test-support/harness → liaison
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const MANIFEST_PATH = join(REPO_ROOT, "bundled-apps", "monitoring", "app.manifest.json")

/** The tarball name carries the manifest version, so never hardcode one. */
function monitoringBundlePath(): string {
  const { version } = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { version: string }
  return join(REPO_ROOT, "bundled-apps", "monitoring", "dist", `monitoring-${version}.liaisonapp`)
}

function monitoringScopes(): string[] {
  const { scopes } = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { scopes: string[] }
  return scopes
}

function assertTestEnv(): void {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
}

export const monitoringTestInstallRoutes = new Hono<AppEnv>()

const installBody = z.object({
  orgId: z.string().uuid(),
  bundlePath: z.string().optional(),
})

monitoringTestInstallRoutes.post(
  "/install-for-test",
  zValidator("json", installBody),
  async (c) => {
    assertTestEnv()
    const body = c.req.valid("json")
    const bundlePath = body.bundlePath ?? monitoringBundlePath()
    if (!existsSync(bundlePath)) {
      throw new HTTPException(500, {
        message: `monitoring install-for-test: bundle missing at ${bundlePath} — run \`bash scripts/build-bundled-app.sh monitoring --skip-sign\``,
      })
    }

    // Seeded rows and the install are attributed to a real org user: the
    // installed-by column is a NOT NULL FK to kernel.users.
    const installedBy = await withSystemDb(
      "monitoring-test-install:resolve-installer",
      async (db) => {
        const r = await db.execute(
          sql.raw(
            `SELECT id FROM ${schemaRef("kernel")}.users WHERE org_id = '${body.orgId}' ORDER BY created_at ASC LIMIT 1`,
          ),
        )
        const rows =
          (r as unknown as { rows?: Array<{ id: string }> }).rows ??
          (r as unknown as Array<{ id: string }>)
        const userId = rows?.[0]?.id
        if (!userId) {
          throw new HTTPException(500, {
            message: `monitoring install-for-test: org ${body.orgId} has no users; seed the org first`,
          })
        }
        return userId
      },
    )

    // `apps_installed` is a global registry keyed by app name, so a second
    // install in the same worker would hit the primary key. Install once, then
    // reconcile for the requesting org on every call.
    const alreadyInstalled = await withSystemDb(
      "monitoring-test-install:check-installed",
      async (db) => {
        const r = await db.execute(
          sql.raw(
            `SELECT 1 FROM ${schemaRef("kernel")}.apps_installed WHERE name = 'monitoring' LIMIT 1`,
          ),
        )
        const rows = (r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])
        return Array.isArray(rows) && rows.length > 0
      },
    )
    if (!alreadyInstalled) {
      await installAppFromTarball({
        // Test harness: stands in for the admin approving the interface at install.
        approveUiFullAccess: true,
        tarballPath: bakeIntoTestCatalog(bundlePath),
        installedBy,
        grantedScopes: monitoringScopes(),
        grantedConnections: [],
      })
    }
    await reloadInstalledApps(body.orgId)

    return c.json({ appName: "monitoring", installedBy })
  },
)

const seedIncidentBody = z.object({
  orgId: z.string().uuid(),
  source: z.string().default("watchdog"),
  severity: z.enum(["info", "warning", "critical"]).default("critical"),
  title: z.string().default("Disk usage above 90 percent on node-a"),
  body: z.string().default("The data volume crossed its warning mark."),
  status: z.enum(["open", "acknowledged", "resolved"]).default("open"),
  count: z.number().int().min(1).default(3),
})

monitoringTestInstallRoutes.post(
  "/seed-incident",
  zValidator("json", seedIncidentBody),
  async (c) => {
    assertTestEnv()
    const p = c.req.valid("json")
    const appSchema = schemaRef("app_monitoring")
    const quote = (s: string) => s.replace(/'/g, "''")
    const dedupKey = `e2e-${randomBytes(4).toString("hex")}`
    const id = await withSystemDb("monitoring-test-install:seed-incident", async (db) => {
      const incidentId = randomUUID()
      await db.execute(
        sql.raw(
          `INSERT INTO ${appSchema}.incidents
            (id, org_id, source, severity, title, body, dedup_key, status, count,
             first_seen_at, last_seen_at, alert_ts)
           VALUES ('${incidentId}', '${p.orgId}', '${quote(p.source)}', '${p.severity}',
                   '${quote(p.title)}', '${quote(p.body)}', '${dedupKey}', '${p.status}', ${p.count},
                   now(), now(), now())`,
        ),
      )
      return incidentId
    })
    return c.json({ incidentId: id, dedupKey })
  },
)
