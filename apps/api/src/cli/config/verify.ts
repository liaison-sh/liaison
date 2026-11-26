// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `config verify` driver: proves a connector's STORED credential still works
 * by one real authenticated call, read-only. Companion to `config apply`
 * (same file/command idiom, `~/cli/config/apply.ts`): it never writes a row
 * and never creates the org.
 *
 * Real incident this guards against (2026-09-10): a revoked GitLab PAT was
 * rotated in the environment and "verified" with a raw `curl` against the
 * token STRING, which proved nothing about the ENCRYPTED row the connector
 * reads at request time. The check is the app's own `provisioning.verify`
 * handler (`~/cli/provisioners/verify-probes.ts`), run as the app, its call
 * carrying the stored credential host-side (`ctx.fetch` auth): the CLI never
 * decrypts it. An app that declares no verify handler is reported
 * `SKIPPED (no verify probe)` and never fails the run.
 *
 * I/O discipline mirrors `config apply`: human progress → the injected `log`
 * (stderr by default); the CLI entry point writes the machine-readable
 * report to stdout. NEVER print, log, or include a secret value anywhere in
 * the report or a log line, only the probe's non-secret `identity`.
 *
 * App-held secrets a person gives (a webhook signing secret): for each app whose
 * connection declares settable ones, one line per secret, `set` or `not set`
 * (never the value), and the address(es) its webhooks are reached at. A secret
 * not set is a warning, not a FAIL: the app still works on its catch-up.
 *
 * `resolveOrgId` / `probe` are injectable so the unit suite exercises
 * PASS/FAIL/SKIPPED without a live database or network call.
 */

import { eq } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { resolveAppSecretsConnection } from "~/cli/provisioners/app-secrets"
import { appVerifyProbe, type VerifyProbe } from "~/cli/provisioners/verify-probes"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { canonicalJson, readAppConfig } from "~/modules/apps/app-config"
import {
  type AppSecretStatus,
  appSecretStatus,
  appWebhookAddresses,
} from "~/modules/apps/connections/app-secrets"

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

/** One app-held secret: whether it is set (never the value). NOT_SET is a warning. */
export interface VerifyAppSecretResult {
  app: string
  connection: string
  key: string
  status: "SET" | "NOT_SET"
  /** A replaced value still verifying until then (ISO). */
  previousUntil?: string
}

/** Where one of an app's webhook endpoints is reached. */
export interface VerifyWebhookAddress {
  app: string
  endpoint: string
  url: string
}

/** What the app-secret check found for one app; null: no settable secret. */
export interface AppSecretCheckResult {
  connection: string
  secrets: AppSecretStatus[]
  webhooks: Array<{ endpoint: string; url: string }>
}

export interface VerifyReport {
  ok: boolean
  results: VerifyAppResult[]
  /** Present when the config declares any `apps[].config`. */
  config?: VerifyConfigResult[]
  /** Present when the config declares any `apps[].provision`. */
  provision?: VerifyProvisionResult[]
  /** Present when an app's connection declares secrets a person sets. */
  appSecrets?: VerifyAppSecretResult[]
  /** The webhook addresses of those apps. */
  webhooks?: VerifyWebhookAddress[]
}

export interface RunConfigVerifyOptions {
  config: ProvisioningConfig
  /** Restrict the run to a single app name (`--app`). */
  appFilter?: string
  /** Where human progress goes — defaults to stderr (I/O discipline). */
  log?: (msg: string) => void
  /** Resolve the org id from its slug, read-only. Injectable for tests. */
  resolveOrgId?: (slug: string) => Promise<string | undefined>
  /** Check one app's connection. Defaults to the app's `provisioning.verify`
   *  handler (`~/cli/provisioners/verify-probes.ts`); injectable for tests. */
  probe?: VerifyProbe
  /** Read an app's stored `kernel.apps.config`. Injectable for tests. */
  readAppConfig?: (orgId: string, appName: string) => Promise<Record<string, unknown>>
  /** Check one `apps[].provision` block. Injectable for tests; defaults to the
   *  app's own handlers (dry run, then `verify`). */
  provisionCheck?: (
    orgId: string,
    appName: string,
    provision: Record<string, unknown>,
  ) => Promise<VerifyProvisionResult>
  /** Read one app's settable secrets (set or not) and webhook addresses.
   *  Injectable for tests; defaults to the kernel's app-secret status. */
  appSecretCheck?: (
    orgId: string,
    appName: string,
    connection: string | undefined,
  ) => Promise<AppSecretCheckResult | null>
}

/** The kernel's status of the app's settable secrets; null when it has none. */
async function defaultAppSecretCheck(
  orgId: string,
  appName: string,
  connection: string | undefined,
): Promise<AppSecretCheckResult | null> {
  let resolved: ReturnType<typeof resolveAppSecretsConnection>
  try {
    resolved = resolveAppSecretsConnection(orgId, appName, connection)
  } catch (err) {
    if (err instanceof ConfigError) return null
    throw err
  }
  if (!resolved) return null
  const secrets = await appSecretStatus(orgId, appName, resolved.connectionName)
  if (secrets.length === 0) return null
  return {
    connection: resolved.connectionName,
    secrets,
    webhooks: await appWebhookAddresses(orgId, appName),
  }
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
  const probe = opts.probe ?? appVerifyProbe
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
  // Apps whose connection may declare secrets a person sets.
  const secretApps = (opts.config.apps ?? []).filter(
    (a) =>
      a.enable &&
      (a.connection !== undefined || a.appSecrets !== undefined) &&
      (opts.appFilter === undefined || a.name === opts.appFilter),
  )
  const declaresSecrets = secretApps.some((a) => a.appSecrets !== undefined)

  const connectorApps = (opts.config.apps ?? []).filter(
    (a) =>
      a.connection !== undefined && (opts.appFilter === undefined || a.name === opts.appFilter),
  )

  if (
    opts.appFilter !== undefined &&
    connectorApps.length === 0 &&
    configApps.length === 0 &&
    provisionApps.length === 0 &&
    !declaresSecrets
  ) {
    log(`config verify: app '${opts.appFilter}' has no connection or config declared in config`)
    return { exitCode: 2, report: { ok: false, results: [] } }
  }
  if (
    connectorApps.length === 0 &&
    configApps.length === 0 &&
    provisionApps.length === 0 &&
    !declaresSecrets
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
    try {
      const probed = await probe({
        orgId,
        appName: app.name,
        ...(app.provision ? { provision: app.provision as Record<string, unknown> } : {}),
      })
      if (!probed) {
        log(`app '${app.name}': SKIPPED (no verify probe)`)
        results.push({
          app: app.name,
          connection: connName,
          status: "SKIPPED",
          error: "the app declares no verify check",
        })
        continue
      }
      const { identity } = probed
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

  // The default connection probe registers the org's apps; an app declaring
  // `appSecrets` without one needs them registered here.
  if (!opts.appSecretCheck && declaresSecrets) {
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(orgId)
  }
  const secretCheck = opts.appSecretCheck ?? defaultAppSecretCheck
  const appSecrets: VerifyAppSecretResult[] = []
  const webhooks: VerifyWebhookAddress[] = []
  for (const app of secretApps) {
    const checked = await secretCheck(orgId, app.name, app.connection?.name)
    if (!checked) continue
    for (const s of checked.secrets) {
      const status = s.set ? "SET" : "NOT_SET"
      const previous = s.previousUntil ? `, previous still verifies until ${s.previousUntil}` : ""
      log(
        s.set
          ? `app '${app.name}': secret '${s.key}' set${previous}`
          : `app '${app.name}': secret '${s.key}' not set (warning: set it on the app's settings page or with apps[].appSecrets; until then the app relies on its catch-up)${previous}`,
      )
      appSecrets.push({
        app: app.name,
        connection: checked.connection,
        key: s.key,
        status,
        ...(s.previousUntil ? { previousUntil: s.previousUntil } : {}),
      })
    }
    for (const w of checked.webhooks) {
      log(`app '${app.name}': webhook '${w.endpoint}' address ${w.url}`)
      webhooks.push({ app: app.name, ...w })
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
      ...(appSecrets.length > 0 ? { appSecrets } : {}),
      ...(webhooks.length > 0 ? { webhooks } : {}),
    },
  }
}
