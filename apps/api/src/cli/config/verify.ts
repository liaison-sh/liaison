// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `config verify` driver — proves a connector's STORED credential still
 * works by driving one real authenticated call through the app's own
 * adapter. Companion to `config apply` (same file/command idiom,
 * `~/cli/config/apply.ts`), but READ-ONLY: it never writes a row, never
 * creates the org, and resolves credentials the SAME way the app's tools do
 * (`getCredentialsForConnection`, AES-256-GCM decrypt under the hood, see
 * `~/modules/apps/connections/service.ts`) — it never reads `process.env`
 * for the secret and never re-implements the decrypt.
 *
 * Real incident this guards against (2026-09-10): a revoked GitLab PAT was
 * rotated in the environment and "verified" with a raw `curl` against the
 * token STRING — which proved nothing about the ENCRYPTED DB ROW the
 * connector actually reads at request time (`kernel.connected_accounts`,
 * `credentials_encrypted`). `config verify` drives the request through that
 * same row, through the same adapter the connector's tools use.
 *
 * Per-app probes live in `~/cli/provisioners/verify-probes.ts` — a sparse
 * registry, not a switch statement. An app with no probe is reported
 * `SKIPPED (no verify probe)` and never fails the run.
 *
 * I/O discipline mirrors `config apply`: human progress → the injected `log`
 * (stderr by default); the CLI entry point writes the machine-readable
 * report to stdout. NEVER print, log, or include a secret value anywhere in
 * the report or a log line — only the probe's non-secret `identity`.
 *
 * `resolveOrgId` / `getCredentials` are injectable (default to the real DB
 * seams below) so the unit suite exercises PASS/FAIL/SKIPPED without a live
 * database or network call — mirroring the `registry`/`seams` injection
 * points in `~/cli/config/apply.ts` and `~/cli/provisioners/types.ts`.
 */

import { eq } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import {
  verifyProbeRegistry as defaultVerifyProbeRegistry,
  type VerifyProbe,
  type VerifyProbeResult,
} from "~/cli/provisioners/verify-probes"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { canonicalJson, readAppConfig } from "~/modules/apps/app-config"
import { getCredentialsForConnection } from "~/modules/apps/connections/service"

export type VerifyStatus = "PASS" | "FAIL" | "SKIPPED"

export interface VerifyAppResult {
  app: string
  connection: string
  status: VerifyStatus
  /** Non-secret identity the probe's remote call returned (PASS only). */
  identity?: string
  /** Present for FAIL/SKIPPED — safe to print, never a credential value. */
  error?: string
  /** HTTP status the probe's underlying call failed with, when available. */
  httpStatus?: number
}

/** Drift of one `apps[].config` key: the stored value against the config file. */
export interface VerifyConfigResult {
  app: string
  key: string
  status: "PASS" | "DRIFT"
}

/**
 * One `apps[].provision` block: DRIFT when the app's provisioning handler, run
 * dry, would change something; FAIL when its `verify` handler says the setup does
 * not work (or a run failed).
 */
export interface VerifyProvisionResult {
  app: string
  status: "PASS" | "DRIFT" | "FAIL"
  /** What a `config apply` would change (DRIFT). */
  changes?: string[]
  /** What the app's verify handler found wrong, or the error (FAIL). */
  problems?: string[]
  /** Non-secret identity the verify handler reported (PASS). */
  identity?: string
}

export interface VerifyReport {
  ok: boolean
  results: VerifyAppResult[]
  /** Present when the config declares any `apps[].config`. */
  config?: VerifyConfigResult[]
  /** Present when the config declares any `apps[].provision`. */
  provision?: VerifyProvisionResult[]
}

export interface RunConfigVerifyOptions {
  config: ProvisioningConfig
  /** Restrict the run to a single app name (`--app`). */
  appFilter?: string
  /** Where human progress goes — defaults to stderr (I/O discipline). */
  log?: (msg: string) => void
  /** Resolve the org id from its slug, read-only. Injectable for tests. */
  resolveOrgId?: (slug: string) => Promise<string | undefined>
  /** Resolve the STORED, decrypted credential map for one connection.
   *  Injectable for tests; defaults to the real service call — never
   *  re-implemented here. */
  getCredentials?: (
    orgId: string,
    appName: string,
    connectionName: string,
    identifier: string | undefined,
  ) => Promise<Record<string, string>>
  /** Per-app probe registry. Defaults to the production registry
   *  (`~/cli/provisioners/verify-probes.ts`); injectable for tests. */
  probes?: Partial<Record<string, VerifyProbe>>
  /** Read an app's stored `kernel.apps.config`. Injectable for tests. */
  readAppConfig?: (orgId: string, appName: string) => Promise<Record<string, unknown>>
  /** Check one `apps[].provision` block. Injectable for tests; defaults to the
   *  app's own handlers (dry run, then `verify`). */
  provisionCheck?: (
    orgId: string,
    appName: string,
    provision: Record<string, unknown>,
  ) => Promise<VerifyProvisionResult>
}

/** The app's provisioning handler, dry, then its verify handler when declared. */
async function defaultProvisionCheck(
  orgId: string,
  appName: string,
  provision: Record<string, unknown>,
): Promise<VerifyProvisionResult> {
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  const { runAppProvisioning, runAppProvisioningVerify } = await import(
    "~/modules/apps/app-provisioning"
  )
  await ensureAppsForOrg(orgId)
  const { changed } = await runAppProvisioning({ orgId, appName, config: provision, dryRun: true })
  if (changed.length > 0) return { app: appName, status: "DRIFT", changes: changed }
  const verified = await runAppProvisioningVerify({ orgId, appName, config: provision })
  if (verified && !verified.ok) {
    return { app: appName, status: "FAIL", problems: verified.problems }
  }
  return {
    app: appName,
    status: "PASS",
    ...(verified?.identity ? { identity: verified.identity } : {}),
  }
}

export interface RunConfigVerifyResult {
  exitCode: number
  report: VerifyReport
}

/** Duck-typed HTTP status extraction — works for any thrown Error that
 *  carries a numeric `.status` (e.g. `GitlabHttpError`), without the driver
 *  importing a single connector's error type. */
function extractHttpStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined
  const status = (err as unknown as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Default `resolveOrgId` — a read-only lookup by slug (system, org-less DB). */
async function defaultResolveOrgId(slug: string): Promise<string | undefined> {
  const [row] = await withSystemDb("cli-verify-org", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1),
  )
  return row?.id
}

/**
 * Default `getCredentials` — the SAME service call the app's tools use
 * (see `connector.ts`'s own read-back), under a privileged, org-scoped
 * transaction with `actorType: 'system'` (a CLI verify run acts on behalf
 * of the org, not any particular user — matching the connector's own
 * privileged credential read, not a raw env/DB read).
 */
async function defaultGetCredentials(
  orgId: string,
  appName: string,
  connectionName: string,
  identifier: string | undefined,
): Promise<Record<string, string>> {
  return withPrivilegedDb(orgId, "cli-verify-read-creds", (tx) =>
    getCredentialsForConnection(tx, orgId, "", appName, connectionName, identifier, {
      actorType: "system",
    }),
  )
}

async function defaultReadAppConfig(
  orgId: string,
  appName: string,
): Promise<Record<string, unknown>> {
  return withPrivilegedDb(orgId, "cli-verify-read-app-config", (tx) =>
    readAppConfig(tx, orgId, appName),
  )
}

/**
 * Compare every `apps[].config` key with what is stored. Values are not
 * printed: only the key and PASS / DRIFT.
 */
async function verifyAppConfig(
  orgId: string,
  apps: ProvisioningConfig["apps"],
  read: (orgId: string, appName: string) => Promise<Record<string, unknown>>,
  log: (msg: string) => void,
): Promise<VerifyConfigResult[]> {
  const out: VerifyConfigResult[] = []
  for (const app of apps ?? []) {
    if (!app.config) continue
    const stored = await read(orgId, app.name)
    for (const [key, expected] of Object.entries(app.config)) {
      const same = canonicalJson(stored[key] ?? null) === canonicalJson(expected)
      log(`app '${app.name}': config '${key}' ${same ? "PASS" : "DRIFT (stored value differs)"}`)
      out.push({ app: app.name, key, status: same ? "PASS" : "DRIFT" })
    }
  }
  return out
}

export async function runConfigVerify(
  opts: RunConfigVerifyOptions,
): Promise<RunConfigVerifyResult> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const resolveOrgId = opts.resolveOrgId ?? defaultResolveOrgId
  const getCredentials = opts.getCredentials ?? defaultGetCredentials
  const probes = opts.probes ?? defaultVerifyProbeRegistry
  const readConfig = opts.readAppConfig ?? defaultReadAppConfig
  const configApps = (opts.config.apps ?? []).filter(
    (a) => a.config !== undefined && (opts.appFilter === undefined || a.name === opts.appFilter),
  )
  const provisionApps = (opts.config.apps ?? []).filter(
    (a) =>
      a.provision !== undefined &&
      a.enable &&
      (opts.appFilter === undefined || a.name === opts.appFilter),
  )
  const provisionCheck = opts.provisionCheck ?? defaultProvisionCheck

  const connectorApps = (opts.config.apps ?? []).filter(
    (a) =>
      a.connection !== undefined && (opts.appFilter === undefined || a.name === opts.appFilter),
  )

  if (
    opts.appFilter !== undefined &&
    connectorApps.length === 0 &&
    configApps.length === 0 &&
    provisionApps.length === 0
  ) {
    log(`config verify: app '${opts.appFilter}' has no connection or config declared in config`)
    return { exitCode: 2, report: { ok: false, results: [] } }
  }
  if (
    connectorApps.length === 0 &&
    configApps.length === 0 &&
    provisionApps.length === 0
  ) {
    log("config verify: no connector apps with a connection declared in config")
    return { exitCode: 0, report: { ok: true, results: [] } }
  }

  const orgId = await resolveOrgId(opts.config.org.slug)
  if (orgId === undefined) {
    log(`config verify: org '${opts.config.org.slug}' does not exist — run 'config apply' first`)
    return { exitCode: 1, report: { ok: false, results: [] } }
  }

  const results: VerifyAppResult[] = []

  for (const app of connectorApps) {
    const connName = app.connection?.name ?? ""
    const identifier = app.connection?.identifier
    const probe = probes[app.name]

    if (!probe) {
      log(`app '${app.name}': SKIPPED (no verify probe)`)
      results.push({
        app: app.name,
        connection: connName,
        status: "SKIPPED",
        error: "no verify probe registered for this app",
      })
      continue
    }

    try {
      const credentials = await getCredentials(orgId, app.name, connName, identifier)
      const { identity } = await probe(credentials)
      log(`app '${app.name}': PASS (identity: ${identity})`)
      results.push({ app: app.name, connection: connName, status: "PASS", identity })
    } catch (err) {
      const message = errorMessage(err)
      const httpStatus = extractHttpStatus(err)
      log(
        `app '${app.name}': FAIL${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ""} — ${message}`,
      )
      results.push({
        app: app.name,
        connection: connName,
        status: "FAIL",
        error: message,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      })
    }
  }


  const config =
    configApps.length > 0 ? await verifyAppConfig(orgId, configApps, readConfig, log) : undefined
  const provision: VerifyProvisionResult[] = []
  for (const app of provisionApps) {
    let r: VerifyProvisionResult
    try {
      r = await provisionCheck(orgId, app.name, app.provision as Record<string, unknown>)
    } catch (err) {
      r = { app: app.name, status: "FAIL", problems: [errorMessage(err)] }
    }
    const detail =
      r.status === "DRIFT"
        ? ` (would change: ${(r.changes ?? []).join(", ")})`
        : r.status === "FAIL"
          ? ` — ${(r.problems ?? []).join("; ")}`
          : r.identity
            ? ` (identity: ${r.identity})`
            : ""
    log(`app '${app.name}': provision ${r.status}${detail}`)
    provision.push(r)
  }
  const ok =
    results.every((r) => r.status !== "FAIL") &&
    (config ?? []).every((r) => r.status !== "DRIFT") &&
    provision.every((r) => r.status === "PASS")
  return {
    exitCode: ok ? 0 : 1,
    report: {
      ok,
      results,
      ...(config ? { config } : {}),
      ...(provisionApps.length > 0 ? { provision } : {}),
    },
  }
}
