// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `config apply` driver. Runs the registered provisioners in the canonical
 * runtime order, aggregating a report. Plan-time validation errors
 * (`ConfigError`, exit 2) abort BEFORE any write; `--dry-run` runs `plan` only.
 *
 * The provisioner registry is INJECTABLE (default below) so later tasks add
 * real provisioners without touching the driver, and the driver tests inject
 * stubs. The runtime order is FIXED in code (correction #20):
 *
 *   org → admin → roles → email → byok → apiKeys → users → mail → tickets → apps → knowledge → agents → invoicing
 *
 * `org` runs first (yields orgId → `ctx.orgId`); `admin` runs next (yields the
 * actor userId → `ctx.actor`). Everything after the admin can therefore use the
 * `rls`/`priv` seams scoped to the right org + actor. `invoicing` runs LAST,
 * after `apps` — it needs the `invoicing` app already installed (its
 * `app_invoicing` schema created) and, for `shopifyShop: "auto"`, a `shopify`
 * connection already provisioned earlier in the SAME `apps[]` list.
 */

import {
  type AppliedRecord,
  type DriftEntry,
  decideField,
  type FieldDecision,
  getAt,
  hashValue,
  inScope,
  keepServerValue,
  NO_SERVER,
  normalize,
  type PreferSpec,
  preferFor,
  pruneConfig,
  type TrackedField,
  trackedFields,
} from "~/cli/config/drift"
import { loadAppliedRecords, readServerConfig, saveAppliedRecords } from "~/cli/config/drift-state"
import { ConfigError } from "~/cli/config/parse"
import { type ProvisioningConfig, validateConfig } from "~/cli/config/schema"
import {
  buildProvisionContext,
  type ProvisionContext,
  type ProvisionDbSeams,
  resolvePlanOrgId,
} from "~/cli/provisioners/types"
import { appVerifyProbe, type VerifyProbe } from "~/cli/provisioners/verify-probes"
import {
  applySections,
  CANONICAL_ORDER,
  type ConfigReport,
  defaultRegistry,
  type ProvisionerRegistry,
  planSections,
} from "~/modules/provisioning/config-sections"

export {
  CANONICAL_ORDER,
  type ConfigReport,
  type ProvisionerKey,
  type ProvisionerRegistry,
} from "~/modules/provisioning/config-sections"

/** Exit code of an apply (or a dry run) that left a conflicting path unwritten. */
export const CONFLICT_EXIT_CODE = 3

/** Where drift safety reads the server and keeps the last-applied record.
 *  Injectable for tests; `null` turns drift checks off. */
export interface DriftBackend {
  readServer(ctx: ProvisionContext, config: unknown): Promise<Record<string, unknown>>
  loadRecords(ctx: ProvisionContext): Promise<Map<string, AppliedRecord>>
  saveRecords(
    ctx: ProvisionContext,
    rows: Array<{ path: string; hash: string }>,
    appliedBy: string,
  ): Promise<void>
}

export const defaultDriftBackend: DriftBackend = {
  readServer: readServerConfig,
  loadRecords: loadAppliedRecords,
  saveRecords: saveAppliedRecords,
}

export interface RunConfigApplyOptions {
  config: ProvisioningConfig
  format: "json" | "env"
  dryRun: boolean
  validateByok: boolean
  echoSupplied: boolean
  /** Injectable provisioner registry (defaults to the production registry). */
  registry?: ProvisionerRegistry
  /** Injectable DB seams (defaults to the real handles); for unit tests. */
  seams?: ProvisionDbSeams
  /** Where human progress goes — defaults to stderr (I/O discipline §3). */
  log?: (msg: string) => void
  /** Config-file directory — relative `contentFile` refs resolve here (Task 12). */
  configDir?: string
  /** Post-apply connection health check; defaults to the `config verify`
   *  one (the app's `provisioning.verify`). `null` turns it off. */
  connectionProbe?: VerifyProbe | null
  /** `--only` paths: apply (and check) just these; empty or absent: everything. */
  only?: string[]
  /** `--prefer` resolutions for conflicting paths. */
  prefer?: PreferSpec
  /** Who applies, stored on the last-applied record. */
  appliedBy?: string
  /** Drift backend; defaults to the real one, and to none when `seams` is
   *  injected (a driver test without a database). */
  drift?: DriftBackend | null
}

export interface RunConfigApplyResult {
  exitCode: number
  report: ConfigReport
  /** Per tracked path: the plan (dry run) or what the apply did. */
  drift: DriftEntry[]
}

interface PreparedDrift {
  config: ProvisioningConfig
  /** The `--only` part of the file, before any server value was kept. */
  scoped: Record<string, unknown>
  decisions: FieldDecision[]
}

/**
 * Narrow the config to `--only`, compare every tracked path in scope with the
 * server and the last-applied record, and keep the server's value for each
 * conflict, each `--prefer server` path and each tracked path out of scope.
 */
async function prepareDrift(
  ctx: ProvisionContext,
  opts: RunConfigApplyOptions,
  backend: DriftBackend | null,
): Promise<PreparedDrift> {
  const only = opts.only ?? []
  const scoped = pruneConfig(opts.config, only)
  const work = structuredClone(scoped)
  const decisions: FieldDecision[] = []
  if (backend) {
    const orgId = await resolvePlanOrgId(ctx, opts.config.org.slug, "cli-config-drift-org")
    let server: Record<string, unknown> | typeof NO_SERVER = NO_SERVER
    let records = new Map<string, AppliedRecord>()
    if (orgId) {
      ctx.orgId = orgId
      server = await backend.readServer(ctx, scoped)
      records = await backend.loadRecords(ctx)
    }
    const keep: Array<{ field: TrackedField; value: unknown }> = []
    for (const field of trackedFields(scoped)) {
      const serverValue = server === NO_SERVER ? NO_SERVER : getAt(server, field.loc)
      if (!inScope(field.path, only)) {
        // Named only to identify an entry (org, an entry's required keys):
        // keep the server's value, when the server has the entry at all.
        if (server !== NO_SERVER && getAt(server, field.loc.slice(0, -1)) !== undefined) {
          keep.push({ field, value: serverValue })
        }
        continue
      }
      const d = decideField({
        field,
        fileValue: getAt(scoped, field.loc),
        server: serverValue,
        record: records.get(field.path),
        prefer: preferFor(opts.prefer, field.path),
      })
      decisions.push(d)
      if (d.entry.action === "conflict" || d.entry.action === "keep") {
        keep.push({ field, value: serverValue })
      }
    }
    for (const k of keep) keepServerValue(work, k.field, k.value)
  }
  const validated = validateConfig(work)
  if (!validated.ok) {
    throw new ConfigError(`the config narrowed by --only no longer validates: ${validated.message}`)
  }
  return { config: validated.config, scoped, decisions }
}

/** Record, for each path the apply wrote or kept, the hash of the value now stored. */
async function recordDrift(
  ctx: ProvisionContext,
  prepared: PreparedDrift,
  backend: DriftBackend,
  appliedBy: string,
): Promise<void> {
  if (!ctx.orgId) return
  const after = await backend.readServer(ctx, prepared.scoped)
  const rows: Array<{ path: string; hash: string }> = []
  for (const d of prepared.decisions) {
    if (d.entry.action === "conflict") continue
    // A path of an app entry dropped because the server has the app off was
    // not written: leave its record as it was.
    if (
      d.entry.action !== "keep" &&
      getAt(prepared.config, d.field.loc.slice(0, -1)) === undefined
    ) {
      continue
    }
    rows.push({
      path: d.field.path,
      hash: hashValue(normalize(d.field, getAt(after, d.field.loc), d.fileValue)),
    })
  }
  await backend.saveRecords(ctx, rows, appliedBy)
}

export async function runConfigApply(opts: RunConfigApplyOptions): Promise<RunConfigApplyResult> {
  const registry = opts.registry ?? defaultRegistry
  const log = opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const ctx = buildProvisionContext({
    log,
    validateByok: opts.validateByok,
    seams: opts.seams,
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    ...(opts.connectionProbe === null
      ? {}
      : { connectionProbe: opts.connectionProbe ?? appVerifyProbe }),
  })

  const report: ConfigReport = { ok: true, sections: {}, pending: [], changed: [], unchanged: [] }
  const backend = opts.drift !== undefined ? opts.drift : opts.seams ? null : defaultDriftBackend
  let drift: DriftEntry[] = []

  try {
    const useDrift = backend !== null || (opts.only?.length ?? 0) > 0
    const prepared = useDrift ? await prepareDrift(ctx, opts, backend) : null
    const config = prepared?.config ?? opts.config
    drift = prepared?.decisions.map((d) => d.entry) ?? []
    const conflicts = drift.filter((e) => e.action === "conflict")
    for (const c of conflicts) {
      const last = c.lastApplied ? `, last applied ${c.lastApplied.at} by ${c.lastApplied.by}` : ""
      log(`conflict: ${c.path}: file ${c.file}, server ${c.server}${last} (not written)`)
    }
    const exitCode = conflicts.length > 0 ? CONFLICT_EXIT_CODE : 0
    if (conflicts.length > 0) {
      log(
        `${conflicts.length} path(s) changed on the server since the last apply: ` +
          "re-run with --prefer file or --prefer server (optionally =<path>), or `config pull` the server values into the file",
      )
    }

    // PRE-FLIGHT + PLAN PHASE — read-only for every provisioner first, so a
    // plan-time ConfigError (exit 2) aborts BEFORE any apply runs. The
    // preflight validates config-wide invariants a per-provisioner plan cannot
    // see on a first run (the driver plans with `ctx.orgId === ''`), e.g. every
    // `users[].role` name.
    const planned = await planSections(ctx, config, CANONICAL_ORDER, { registry })

    if (opts.dryRun) {
      // Dry run: report the plan only, never apply.
      return { exitCode, report, drift }
    }

    // APPLY PHASE — in canonical order; provisioners mutate ctx (org sets
    // orgId, admin sets actor.userId) so downstream seams scope correctly.
    await applySections(ctx, config, CANONICAL_ORDER, { registry, planned, report })
    if (prepared && backend) await recordDrift(ctx, prepared, backend, opts.appliedBy ?? "cli")
    return { exitCode, report, drift }
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`error: ${err.message}`)
      report.ok = false
      return { exitCode: err.exitCode, report, drift }
    }
    throw err
  }
}
