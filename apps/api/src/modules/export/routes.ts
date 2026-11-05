// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext } from "~/lib/request-rls"
import { zValidator } from "~/lib/validate"
import { exportRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { exportApps, exportAppsWithManifest } from "~/modules/export/orchestrator"

export const exportRoutes = new Hono<AppEnv>()

// Apps that have a registered export handler for this org. The Admin Data
// Export view MUST source its list from here — NOT the enabled-app surface set
// — so an admin who skipped the apps setup step can still export their data
// (enablement is surface curation, not a capability gate; spec WS3).
exportRoutes.get("/apps", async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  const apps: string[] = []
  for (const [[regOrgId, appName]] of exportRegistry.entriesOf(orgId)) {
    if (regOrgId === orgId) apps.push(appName)
  }
  apps.sort()
  return c.json({ data: { apps } })
})

const bodySchema = z.object({
  appNames: z.array(z.string()).min(1).max(200),
  format: z.enum(["json", "csv"]).default("json"),
  dateRange: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
})

// Admin-scoped (mounted behind requireScope in app.ts). Returns the zip as a
// direct download. The Admin "Data Export" view and the kernel.export agent
// tool both reach the same orchestrator.
exportRoutes.post("/", zValidator("json", bodySchema), async (c) => {
  const { appNames, format, dateRange } = c.req.valid("json")
  const { zip, manifest } = await exportAppsWithManifest({
    orgId: c.get("orgId"),
    actor: extractRlsContext(c),
    appNames,
    format,
    dateRange,
  })
  // The Data Export view renders the partial-skip list without unzipping —
  // mirror manifest.json's `skipped` into a response header.
  return new Response(zip, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="liaison-export.zip"',
      "X-Export-Skipped": JSON.stringify(manifest.skipped),
    },
  })
})

// Retrievable GET variant — the reference the kernel.export agent tool hands
// back. Same orchestrator, same admin scope, same RLS actor.
exportRoutes.get("/", async (c) => {
  const appNames = (c.req.query("apps") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const formatRaw = c.req.query("format") ?? "json"
  const format = formatRaw === "csv" ? "csv" : "json"
  if (appNames.length === 0) {
    return c.json({ error: { message: "apps query param is required" } }, 400)
  }
  const from = c.req.query("from")
  const to = c.req.query("to")
  const dateRange = from || to ? { from, to } : undefined
  const buf = await exportApps({
    orgId: c.get("orgId"),
    actor: extractRlsContext(c),
    appNames,
    format,
    dateRange,
  })
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="liaison-export.zip"',
    },
  })
})
