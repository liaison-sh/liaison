// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Switches inside an app, per org (`kernel.org_app_features`): THE writer, and the
 * words a refusal uses. The reader is `isFeatureOffForTool` in org-apps.ts, which
 * loads the rows with the rest of the org's app state.
 *
 * A member has no write path on the table: every write comes here, on a privileged
 * handle, after the feature's declared `adminScope` is checked, and records who and
 * when. An app's own writer calls it for a feature whose row is derived from the
 * app's data (`derived: true`, it stays true to that data); every other feature is an
 * admin's switch, written through `setAdminOrgAppFeature` by the features route
 * (Settings > Apps > <app>) and `liaison config apply` (`apps[].features`).
 *
 * A writer that keeps the row inside its own transaction uses `writeOrgAppFeature`
 * and calls `noteOrgFeatureChanged` once it has committed; `setOrgAppFeature` does
 * both in a transaction of its own.
 */
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { orgAppFeatures } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { manifestRegistry } from "~/modules/apps/app-registries"
import {
  enabledFeaturesFor,
  FEATURE_OFF_CODE,
  noteOrgAppsChanged,
  primeOrgApps,
} from "~/modules/apps/org-apps"
import { seedLegalStarterTemplates } from "~/modules/documents/legal-templates/starters"
import { serverT } from "~/modules/i18n/server-i18n"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "apps/org-features" })

/** A refused feature write: nothing was written. */
export class OrgFeatureError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: "forbidden" | "not_found",
    message: string,
  ) {
    super(message)
    this.name = "OrgFeatureError"
  }
}

export interface OrgFeatureWrite {
  orgId: string
  app: string
  feature: string
  enabled: boolean
  /** Who is writing. `userId` null is a system writer, which still names its scopes. */
  actor: { userId: string | null; scopes: readonly string[] }
}

/**
 * Write the row in the caller's transaction, after checking the declared
 * `adminScope`. `changed` is false when the row already says this: who and when stay
 * as they were and nobody is told. On `changed`, the caller calls
 * `noteOrgFeatureChanged` after its commit.
 */
export async function writeOrgAppFeature(
  tx: PrivilegedDb,
  write: OrgFeatureWrite,
): Promise<{ changed: boolean }> {
  const { orgId, app, feature, enabled, actor } = write
  const declared = manifestRegistry.get([orgId, app])?.features?.[feature]
  if (!declared) {
    throw new OrgFeatureError(
      404,
      "not_found",
      `The app ${app} declares no feature ${feature}, so nothing was written.`,
    )
  }
  if (!hasScope(declared.adminScope, [...actor.scopes])) {
    throw new OrgFeatureError(
      403,
      "forbidden",
      `Changing the feature ${feature} of ${app} needs the scope ${declared.adminScope}, so nothing was written.`,
    )
  }
  const stamp = { enabled, changedBy: actor.userId, changedAt: new Date() }
  const written = await tx
    .insert(orgAppFeatures)
    .values({ orgId, appName: app, feature, ...stamp })
    .onConflictDoUpdate({
      target: [orgAppFeatures.orgId, orgAppFeatures.appName, orgAppFeatures.feature],
      set: stamp,
      where: sql`${orgAppFeatures.enabled} IS DISTINCT FROM ${enabled}`,
    })
    .returning({ feature: orgAppFeatures.feature })
  if (written.length === 0) return { changed: false }
  // Switching on the feature an app names for the corporate starter templates offers them at
  // once, in this transaction (the other starters came with the app).
  if (
    enabled &&
    manifestRegistry.get([orgId, app])?.legalStarterTemplates?.corporateFeature === feature
  )
    await seedLegalStarterTemplates(tx, orgId, { corporateTemplates: true })
  // Durable and delivered to every process after the commit: each one tells its
  // own live MCP sessions that the tool list changed (mcp/catalog-notifier.ts).
  await tx.queueEvent({
    app: "kernel",
    entity: "app",
    action: "feature_update",
    entityId: `${app}:${feature}`,
    orgId,
    actorId: actor.userId ?? undefined,
    data: { app, feature, enabled },
  })
  return { changed: true }
}

/**
 * A feature row committed: this process and its peers reload the org's state, and
 * open tabs are told. A failed broadcast only delays the tabs until their next load.
 */
export async function noteOrgFeatureChanged(
  orgId: string,
  app: string,
  feature: string,
  enabled: boolean,
): Promise<void> {
  await noteOrgAppsChanged(orgId)
  void broadcastEphemeral({
    app: "kernel",
    entity: "org_app",
    action: "update",
    orgId,
    data: { app, feature, enabled },
  }).catch((err) =>
    log.warn({ err, orgId, app, feature }, "org feature broadcast failed; tabs converge on reload"),
  )
}

/** Derived feature rows a writer recomputes after its commit, still running, by org. */
const pendingRecomputes = new Map<string, Set<Promise<unknown>>>()

/**
 * A writer whose feature row follows its data (it is recomputed once the data's transaction
 * committed) names that work here while it runs, so a call refused only because the row is not
 * written yet can wait for it instead (`settleFeatureRecomputes`).
 */
export function trackFeatureRecompute(orgId: string, work: Promise<unknown>): void {
  let pending = pendingRecomputes.get(orgId)
  if (!pending) {
    pending = new Set()
    pendingRecomputes.set(orgId, pending)
  }
  const set = pending
  set.add(work)
  const done = () => {
    set.delete(work)
    if (set.size === 0 && pendingRecomputes.get(orgId) === set) pendingRecomputes.delete(orgId)
  }
  work.then(done, done)
}

/**
 * Waits, at most `budgetMs`, for the org's feature rows still being recomputed after a commit
 * (the cache is fresh once they end). False when nothing was pending: the cached answer stands.
 */
export async function settleFeatureRecomputes(orgId: string, budgetMs = 5_000): Promise<boolean> {
  const pending = pendingRecomputes.get(orgId)
  if (!pending || pending.size === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  return true
}

/** Write the row in a transaction of its own, then tell everyone. */
export async function setOrgAppFeature(write: OrgFeatureWrite): Promise<{ changed: boolean }> {
  const { orgId, app, feature, enabled } = write
  const result = await withPrivilegedDb(orgId, "org-feature-write", (tx) =>
    writeOrgAppFeature(tx, write),
  )
  if (result.changed) await noteOrgFeatureChanged(orgId, app, feature, enabled)
  return result
}

/** A feature an admin switches by hand, as the settings page and `config apply` see it. */
export interface AdminFeature {
  feature: string
  labelKey: string
  descriptionKey?: string
  adminScope: string
  enabled: boolean
}

/**
 * The features of `app` an admin switches (every declared one but the derived), with
 * whether each is on. Null: the app is not registered in this org.
 */
export async function listAdminFeatures(
  orgId: string,
  app: string,
): Promise<AdminFeature[] | null> {
  const manifest = manifestRegistry.get([orgId, app])
  if (!manifest) return null
  await primeOrgApps(orgId)
  const on = new Set(enabledFeaturesFor(orgId).flatMap((f) => (f.app === app ? [f.feature] : [])))
  return Object.entries(manifest.features ?? {})
    .filter(([, d]) => d.derived !== true)
    .map(([feature, d]) => ({
      feature,
      labelKey: d.labelKey,
      ...(d.descriptionKey ? { descriptionKey: d.descriptionKey } : {}),
      adminScope: d.adminScope,
      enabled: on.has(feature),
    }))
    .sort((a, b) => a.feature.localeCompare(b.feature))
}

/**
 * An admin's switch: refuses a feature the app derives from its own data (its row
 * follows that data, a hand-set one would be overwritten), then writes like
 * `setOrgAppFeature`.
 */
export async function setAdminOrgAppFeature(write: OrgFeatureWrite): Promise<{ changed: boolean }> {
  const declared = manifestRegistry.get([write.orgId, write.app])?.features?.[write.feature]
  if (declared?.derived === true) {
    throw new OrgFeatureError(
      403,
      "forbidden",
      `The feature ${write.feature} of ${write.app} follows the app's own data and has no switch, so nothing was written.`,
    )
  }
  return setOrgAppFeature(write)
}

/** What every door answers for a tool of a feature that is off. Never retryable. */
export interface FeatureOffAnswer {
  code: typeof FEATURE_OFF_CODE
  feature: string
  message: string
  next: string
  retryable: false
}

/** The catalog's text for `key`, or undefined when it has none. */
function declaredText(key: string | undefined): string | undefined {
  if (!key) return undefined
  const text = serverT("en", key)
  return text === key ? undefined : text
}

/**
 * The answer for this tool, in the words its feature declares. A feature that
 * declares none gets plain facts: what did not run, and who can change that.
 */
export function featureOffAnswer(
  orgId: string,
  tool: { appName: string; name: string; feature?: string; featureApp?: string },
): FeatureOffAnswer {
  const feature = tool.feature ?? ""
  const declared = manifestRegistry.get([orgId, tool.featureApp ?? tool.appName])?.features?.[
    feature
  ]
  const label = declaredText(declared?.labelKey) ?? feature
  return {
    code: FEATURE_OFF_CODE,
    feature,
    message:
      declaredText(declared?.offMessageKey) ??
      `${label} is off for this workspace, so ${tool.appName}__${tool.name} did not run and nothing changed.`,
    next:
      declaredText(declared?.offNextKey) ??
      (declared
        ? `Say that it is off. Someone holding ${declared.adminScope} can turn it on.`
        : "Say that it is off."),
    retryable: false,
  }
}
