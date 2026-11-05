// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deep-week-sim finance harness — test-only Pennylane install route + mock-control
// route. Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES).
// Mounted at `/api/_test/pennylane`. Drives the full server-side install dance for
// the bundled Pennylane app from a single HTTP call (so the test/Playwright worker
// can install + wire the app without restarting the server). Modeled on
// boxtal-install-routes.ts; Pennylane has NO webhooks (no webhook-secret mint).
//
// `POST /install-for-test`:
//   1. Resolve installer = first real user in the org (FK to kernel.users).
//   2. Clean-slate reset: drop the pennylane apps_installed row, TRUNCATE its
//      app_pennylane tables, clear its connected_accounts + approvals.
//   3. installAppFromTarball + reloadInstalledApps (same flow a 3rd-party app uses).
//   4. createCredentialConnection — inserts the {apiToken, scope} map and queues
//      the connected_account:create event → onConnectionEstablished runs the
//      connect probe THROUGH THE MOCK (full/invoice_only/blocked_finance).
//
// The mock-control sub-routes seed the per-server-process Pennylane mock mode and
// expose the recorder (see pennylane-mock-fetch.ts).

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import {
  type PennylaneMockMode,
  pennylaneMockAllRequests,
  pennylaneMockClearRequests,
  resetPennylaneMockMode,
  setPennylaneMockMode,
} from "./pennylane-mock-fetch"

/**
 * Resolve the install-time Pennylane credentials. Mock mode uses inert literals
 * (the external-API mock ignores auth). Live mode (PENNYLANE_E2E_LIVE=1) pulls
 * the real token from env. A half-configured live run throws a named error.
 */
export type PennylaneInstallCredentials = {
  apiToken: string
  scope: "company" | "firm"
}

export function resolvePennylaneInstallCredentials(
  env: Record<string, string | undefined> = process.env,
  override?: PennylaneInstallCredentials,
): PennylaneInstallCredentials {
  if (override) return override
  if (env.PENNYLANE_E2E_LIVE !== "1") {
    return { apiToken: "mock-token", scope: "company" }
  }
  const apiToken = env.PENNYLANE_API_TOKEN
  if (!apiToken) {
    throw new Error(
      "pennylane install: PENNYLANE_E2E_LIVE=1 but missing creds: PENNYLANE_API_TOKEN",
    )
  }
  const scope = env.PENNYLANE_SCOPE === "firm" ? "firm" : "company"
  return { apiToken, scope }
}

export const pennylaneTestInstallRoutes = new Hono<AppEnv>()

const credentialsSchema = z.object({
  apiToken: z.string(),
  scope: z.enum(["company", "firm"]).default("company"),
})

const installBodySchema = z.object({
  orgId: z.string().uuid(),
  bundlePath: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
  credentials: credentialsSchema.optional(),
  // Per-scenario connect-probe mode. The mock mode is a per-server-process global, so the
  // install route ALWAYS sets it explicitly (default "full") right before the credential
  // connection — i.e. before the connect probe runs — making every scenario's install
  // deterministic regardless of a prior scenario's mode. `invoice_only` descopes the bank
  // (bank-403 → cash_status:"unavailable"), which is the board-deck-quarter-narrative
  // honesty branch: revenue/margin live, cash/runway honestly unavailable.
  mode: z.enum(["full", "invoice_only", "blocked_finance"]).optional(),
})

pennylaneTestInstallRoutes.post(
  "/install-for-test",
  zValidator("json", installBodySchema),
  async (c) => {
    if (!qaSeedRoutesEnabled) {
      throw new HTTPException(404, { message: "Not found" })
    }
    const body = c.req.valid("json")
    const bundlePath = body.bundlePath ?? resolveDefaultBundlePath()
    const manifest = peekManifestFromTarball(bundlePath)
    const grantedScopes = body.grantedScopes ?? manifest.scopes

    // 1. Resolve installer — first real org user.
    const installedBy = await withSystemDb(
      "pennylane-test-install:resolve-installer",
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
            message: `pennylane install-for-test: org ${body.orgId} has no users; seed the org first`,
          })
        }
        return userId
      },
    )

    // 2. Clean-slate reset.
    {
      const pnlSchema = schemaRef("app_pennylane")
      const kerSchema = schemaRef("kernel")
      await withSystemDb("pennylane-test-install:reset", async (db) => {
        await db.execute(
          sql.raw(
            `DELETE FROM ${kerSchema}.connected_accounts WHERE org_id = '${body.orgId}' AND app_name = 'pennylane'`,
          ),
        )
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchema}.apps_installed WHERE name = 'pennylane'`),
        )
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchema}.approved_handler_executions
                   WHERE approval_request_id IN (
                     SELECT id FROM ${kerSchema}.approval_requests
                     WHERE tool_name LIKE 'pennylane:%')`),
        )
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchema}.approval_requests WHERE tool_name LIKE 'pennylane:%'`),
        )
        await db.execute(
          sql.raw(`DO $$
            DECLARE r RECORD;
            BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${pnlSchema}') THEN
                FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${pnlSchema}' LOOP
                  EXECUTE 'TRUNCATE TABLE ${pnlSchema}.' || quote_ident(r.tablename) || ' CASCADE';
                END LOOP;
              END IF;
            END $$;`),
        )
      })
    }

    // 3. Install on disk + reload the in-process runtime registry.
    await installAppFromTarball({
      // Test harness: stands in for the admin approving the interface at install.
      approveUiFullAccess: true,
      tarballPath: bakeIntoTestCatalog(bundlePath),
      installedBy,
      grantedScopes,
      grantedConnections: ["pennylane"],
    })
    await reloadInstalledApps(body.orgId)

    // 3.5. Set the connect-probe mock mode DETERMINISTICALLY before the probe runs.
    //      The mode is a per-process global; always pinning it here (default "full")
    //      means a prior scenario's invoice_only/blocked_finance can never leak into
    //      this install's probe. invoice_only → bank-403 → cash_status:"unavailable".
    setPennylaneMockMode(body.mode ?? "full")

    // 4. Create the credentials connection — queues the connected_account:create
    //    event (which the outbox worker delivers to onConnectionEstablished → the
    //    connect probe runs through the mock).
    const credentials = resolvePennylaneInstallCredentials(process.env, body.credentials)
    const connection = await withPrivilegedDb(
      body.orgId,
      "pennylane-test-install:create-credential-connection",
      (tx) =>
        // Privileged (BYPASSRLS) tx — mirrors the production org-connection path.
        // biome-ignore lint/suspicious/noExplicitAny: privileged-tx bridge (prod parity)
        createCredentialConnection(tx as any, body.orgId, installedBy, "pennylane", "pennylane", {
          identifier: "pennylane-sandbox",
          credentials,
          displayName: "Pennylane (sandbox)",
          ownerType: "org",
        }),
    )

    return c.json({
      appName: "pennylane",
      connectionId: connection.id,
    })
  },
)

// — mock-control sub-routes —

const mockModeSchema = z.object({
  mode: z.enum(["full", "invoice_only", "blocked_finance"]),
  rateLimitOnce: z.boolean().optional(),
  firm403: z.boolean().optional(),
})

pennylaneTestInstallRoutes.post("/mock/mode", zValidator("json", mockModeSchema), (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  const body = c.req.valid("json")
  setPennylaneMockMode(body.mode as PennylaneMockMode, {
    rateLimitOnce: body.rateLimitOnce,
    firm403: body.firm403,
  })
  return c.json({ ok: true })
})

pennylaneTestInstallRoutes.post("/mock/reset", (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  resetPennylaneMockMode()
  pennylaneMockClearRequests()
  return c.json({ ok: true })
})

pennylaneTestInstallRoutes.get("/mock/requests", (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  return c.json({ requests: pennylaneMockAllRequests() })
})

// — helpers —

function resolveDefaultBundlePath(): string {
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  // The version comes from the manifest, never a literal: build-bundled-app.sh
  // emits `pennylane-<manifest version>.liaisonapp`, so a hardcoded 0.1.0 resolved to a
  // nonexistent tarball the moment the app was bumped (what social-install-routes
  // already does).
  const manifestPath = join(liaisonRoot, "bundled-apps", "pennylane", "app.manifest.json")
  const { version } = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }
  return join(liaisonRoot, "bundled-apps", "pennylane", "dist", `pennylane-${version}.liaisonapp`)
}

function peekManifestFromTarball(tarballPath: string): {
  name: string
  version: string
  scopes: string[]
} {
  const dir = mkdtempSync(join(tmpdir(), "pennylane-bundle-peek-"))
  try {
    const r = spawnSync("tar", ["-xzf", tarballPath, "-C", dir, "app.manifest.json"], {
      stdio: "pipe",
    })
    if (r.status !== 0) {
      throw new Error(`tar -xzf failed: ${r.stderr?.toString() ?? "<no stderr>"}`)
    }
    const raw = readFileSync(join(dir, "app.manifest.json"), "utf8")
    return JSON.parse(raw) as { name: string; version: string; scopes: string[] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
