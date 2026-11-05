// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The one section runner behind `liaison config apply` and the agent's
 * `config_<section>` tools. Both paths run the SAME provisioners in the same
 * canonical order with the same plan-all-then-apply discipline; they differ
 * only in who acts:
 *
 *  - the CLI acts as the provisioning admin it ensures (`*` scopes and the
 *    wildcard data grant), on an org it may be creating in the same run;
 *  - a config tool acts as a real person of a live org
 *    (`buildActorProvisionContext`): the approver of a gated call, or the
 *    caller of a direct one, with their own scopes and dimension grants. The
 *    org is set before any plan, so no provisioner ever resolves an org from
 *    the config's `org.slug` there.
 *
 * Plan-time validation errors are `ConfigError`s, thrown before any apply.
 */
import type { ProvisioningConfig } from "~/cli/config/schema"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { agentsProvisioner } from "~/cli/provisioners/agents"
import { apiConnectorsProvisioner } from "~/cli/provisioners/api-connectors"
import { apiKeysProvisioner } from "~/cli/provisioners/api-keys"
import { appsProvisioner } from "~/cli/provisioners/apps"
import { byokProvisioner } from "~/cli/provisioners/byok"
import { emailProvisioner } from "~/cli/provisioners/email"
import { invoicingProvisioner } from "~/cli/provisioners/invoicing"
import { knowledgeProvisioner } from "~/cli/provisioners/knowledge"
import { liaisonTeamProvisioner } from "~/cli/provisioners/liaison-team"
import { limitsProvisioner } from "~/cli/provisioners/limits"
import { mailMailboxesProvisioner } from "~/cli/provisioners/mail-mailboxes"
import { orgProvisioner } from "~/cli/provisioners/org"
import { rolesProvisioner } from "~/cli/provisioners/roles"
import { setupProvisioner } from "~/cli/provisioners/setup"
import { ticketInboxesProvisioner } from "~/cli/provisioners/ticket-inboxes"
import {
  buildProvisionContext,
  type PendingItem,
  type ProvisionContext,
  type ProvisionDbSeams,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
} from "~/cli/provisioners/types"
import { validateUserRoles } from "~/cli/provisioners/user-roles"
import { usersProvisioner } from "~/cli/provisioners/users"
import { isRecord } from "~/lib/guards"

/**
 * Canonical runtime provisioner order — the single source of truth
 * (correction #20). Task numbers are implementation order, NOT this.
 *
 *   org → limits → admin → setup → roles → email → byok → apiKeys → users → mail → tickets → apps
 *     → apiConnectors → knowledge → agents → invoicing → liaisonTeam
 */
export const CANONICAL_ORDER = [
  "org",
  // Operator only (cli/provisioners/limits.ts): never a config tool section.
  "limits",
  "admin",
  "setup",
  "roles",
  "email",
  "byok",
  "apiKeys",
  "users",
  "mail",
  "tickets",
  "apps",
  "apiConnectors",
  "knowledge",
  "agents",
  "invoicing",
  "liaisonTeam",
] as const

export type ProvisionerKey = (typeof CANONICAL_ORDER)[number]

/** Registry maps a provisioner key to its implementation. Sparse — a key with
 *  no entry is simply skipped (the config section may also be absent). */
export type ProvisionerRegistry = Partial<Record<ProvisionerKey, Provisioner<ProvisioningConfig>>>

export interface ConfigReport {
  ok: boolean
  /** Per-section fragments contributed by each provisioner, keyed by its key. */
  sections: Record<string, unknown>
  pending: PendingItem[]
  changed: string[]
  unchanged: string[]
}

/** The production registry — every provisioner wired in the canonical runtime
 *  order. `roles` runs right after `admin` so a custom role exists before
 *  `users` invites onto it; `knowledge` runs near the end so a source's app
 *  connection is already resolved by the time it runs; `invoicing` runs LAST
 *  so it can build on an `invoicing` app install + `shopify` connection both
 *  provisioned earlier in the same `apps[]` list. */
export const defaultRegistry: ProvisionerRegistry = {
  org: orgProvisioner,
  limits: limitsProvisioner,
  admin: adminProvisioner,
  setup: setupProvisioner,
  roles: rolesProvisioner,
  email: emailProvisioner,
  byok: byokProvisioner,
  apiKeys: apiKeysProvisioner,
  users: usersProvisioner,
  mail: mailMailboxesProvisioner,
  tickets: ticketInboxesProvisioner,
  apps: appsProvisioner,
  apiConnectors: apiConnectorsProvisioner,
  knowledge: knowledgeProvisioner,
  agents: agentsProvisioner,
  invoicing: invoicingProvisioner,
  liaisonTeam: liaisonTeamProvisioner,
}

/** The person a config tool acts as. */
export interface ProvisionActor {
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
}

/**
 * A provisioning context for a live org, acting as a real person. Nothing here
 * is fabricated: the seams run under the actor's own scopes and data grants.
 */
export function buildActorProvisionContext(opts: {
  orgId: string
  actor: ProvisionActor
  log?: (msg: string) => void
  seams?: ProvisionDbSeams
}): ProvisionContext {
  if (!opts.orgId) throw new Error("buildActorProvisionContext: orgId is required")
  if (!opts.actor.userId) throw new Error("buildActorProvisionContext: actor.userId is required")
  const ctx = buildProvisionContext({
    log: opts.log ?? (() => {}),
    // A BYOK key never comes through a tool (it goes through the secret card).
    validateByok: true,
    ...(opts.seams ? { seams: opts.seams } : {}),
    // No server directory is ever read on the tool path: file fields take an
    // uploaded file id instead (config-tool-input.ts refuses path fields).
    configDir: "/nonexistent-config-dir",
  })
  ctx.orgId = opts.orgId
  ctx.actor = {
    userId: opts.actor.userId,
    scopes: [...opts.actor.scopes],
    dimensionGrants: opts.actor.dimensionGrants,
  }
  ctx.toolPath = true
  return ctx
}

export interface PlannedSection {
  key: ProvisionerKey
  plan: ProvisionPlan
}

export interface SectionRunOptions {
  registry?: ProvisionerRegistry
}

function ordered(keys: readonly ProvisionerKey[], registry: ProvisionerRegistry) {
  const wanted = new Set(keys)
  return CANONICAL_ORDER.flatMap((key) => {
    const p = registry[key]
    return wanted.has(key) && p ? [{ key, provisioner: p }] : []
  })
}

/**
 * PREFLIGHT + PLAN for the given sections, read-only, in canonical order. A
 * `ConfigError` here (exit 2 on the CLI) means nothing was written.
 */
export async function planSections(
  ctx: ProvisionContext,
  config: ProvisioningConfig,
  keys: readonly ProvisionerKey[],
  opts: SectionRunOptions = {},
): Promise<PlannedSection[]> {
  const registry = opts.registry ?? defaultRegistry
  const toRun = ordered(keys, registry)
  // Config-wide validations that must abort BEFORE any provisioner writes.
  if (keys.includes("users")) await validateUserRoles(ctx, config)
  const planned: PlannedSection[] = []
  for (const { key, provisioner } of toRun) {
    const plan = await provisioner.plan(ctx, config)
    planned.push({ key, plan })
    for (const action of plan.actions) ctx.log(`[plan] ${provisioner.key}: ${action}`)
  }
  return planned
}

/**
 * Plan every section first (unless `planned` is given), then apply them in
 * canonical order. A plan error in any section stops the run before the first
 * apply. Provisioners mutate ctx (org sets orgId, admin sets actor.userId) so
 * downstream seams scope correctly.
 */
export async function applySections(
  ctx: ProvisionContext,
  config: ProvisioningConfig,
  keys: readonly ProvisionerKey[],
  opts: SectionRunOptions & {
    planned?: PlannedSection[]
    /** Filled in place as sections apply, so a caller that catches a failure
     *  mid-run still holds what the earlier sections did. */
    report?: ConfigReport
    /** Runs before each provisioner's apply; a throw stops the run there (the
     *  tool path checks it still holds its lease). */
    beforeApply?: () => Promise<void>
  } = {},
): Promise<ConfigReport> {
  const registry = opts.registry ?? defaultRegistry
  const planned = opts.planned ?? (await planSections(ctx, config, keys, { registry }))
  const report: ConfigReport = opts.report ?? {
    ok: true,
    sections: {},
    pending: [],
    changed: [],
    unchanged: [],
  }
  for (const { key, plan } of planned) {
    const provisioner = registry[key]
    if (!provisioner) continue
    if (opts.beforeApply) await opts.beforeApply()
    const result = await provisioner.apply(ctx, plan, config)
    mergeResult(report, provisioner.key, result)
  }
  // Second passes, once every section applied (e.g. users whose role is an app
  // role of a catalog app this run's `apps` section installed).
  for (const { key } of planned) {
    const provisioner = registry[key]
    if (!provisioner?.applyLate) continue
    if (opts.beforeApply) await opts.beforeApply()
    mergeResult(report, provisioner.key, await provisioner.applyLate(ctx, config))
  }
  return report
}

function mergeResult(report: ConfigReport, key: string, result: ProvisionResult): void {
  if (result.section !== undefined) {
    report.sections[key] = mergeSection(report.sections[key], result.section)
  }
  if (result.changed) report.changed.push(...result.changed)
  if (result.unchanged) report.unchanged.push(...result.unchanged)
  if (result.pending) report.pending.push(...result.pending)
}

/** A second pass's section joins the first: same-named arrays concatenate. */
function mergeSection(previous: unknown, next: unknown): unknown {
  if (!isRecord(previous) || !isRecord(next)) return next
  const merged: Record<string, unknown> = { ...previous }
  for (const [k, v] of Object.entries(next)) {
    const before = merged[k]
    merged[k] = Array.isArray(before) && Array.isArray(v) ? [...before, ...v] : v
  }
  return merged
}
