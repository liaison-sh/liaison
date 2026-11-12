// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Apps provisioner (Task 11). For each `apps[]` entry with `enable: true`:
 *
 *  - First-party CATALOG apps (pennylane, boxtal, shopify, ... — baked into the
 *    image) are INSTALLED via `installCatalogApp` (idempotent; skipped when the
 *    app already has an active version). This installs the `.liaisonapp` from
 *    the image catalog and hot-registers it, so a declared `connection` resolves
 *    in the same run.
 *  - `enableApp(orgId, name)` is then called DIRECTLY (it owns its own
 *    `withSystemDb` — never wrap it in `ctx.sys`/withSystemDb, correction #10).
 *    It is idempotent (DISTINCT append into `settings.enabledApps`) and is the
 *    surface-curation flag, separate from the install.
 *  - With `connection` present → `provisionConnection(ctx, name, connection)`:
 *    credentials → `createCredentialConnection` (4-key precheck); oauth2 → pending.
 *  - A manifest with NO connections (e.g. invoicing) → install + enable, no pending.
 *  - A non-catalog (built-in/in-tree) app name → enable only, no install.
 *  - `mail` with `providers` → after the enable, converge the org's mail
 *    provider switches (`mail-providers.ts`). Without `providers`, untouched.
 *  - `config` → non-secret app config keys through the kernel allowlist
 *    (`app-config.ts`); a refused key is a usage error, an equal value unchanged.
 *  - `settings` → org fields of the app's settings page (`app-settings.ts`), the
 *    same checks as the settings page's own write.
 *
 * Handles: `installCatalogApp` + `enableApp` (own withSystemDb); the connector
 * uses `ctx.rls` / `ctx.priv` internally.
 */

import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { requireActor } from "~/cli/provisioners/admin"
import { applyAppConfig, assertAppConfigAllowed } from "~/cli/provisioners/app-config"
import {
  applyAppProvision,
  assertProvisionValid,
  planAppProvision,
} from "~/cli/provisioners/app-provision"
import {
  applyAppSettings,
  appSettingsKnown,
  checkAppSettings,
  planAppSettings,
} from "~/cli/provisioners/app-settings"
import {
  type ConnectionFieldChange,
  type ConnectionHealth,
  checkConnectionHealth,
  planConnection,
  provisionConnection,
} from "~/cli/provisioners/connector"
import {
  applyMailProviders,
  type MailProviderResult,
  planMailProviders,
} from "~/cli/provisioners/mail-providers"
import {
  type PendingItem,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
  resolvePlanOrgId,
} from "~/cli/provisioners/types"
import { canonicalJson, declaredAppConfigKeys, readAppConfig } from "~/modules/apps/app-config"
import { appHasProvisioning } from "~/modules/apps/app-provisioning"
import {
  catalogInstallAction,
  installCatalogApp,
  listCatalogWithState,
  noteVersionAhead,
} from "~/modules/apps/catalog"
import { installFromCatalog } from "~/modules/apps/catalog-sources"
import {
  appIsOn,
  enableApp,
  getEnabledApps,
  isAppRegistered,
  settledAppState,
} from "~/modules/apps/enabled-apps"
import { canManageInstanceApps } from "~/modules/apps/operator-org"
import { turnOrgAppOn } from "~/modules/apps/org-app-admin"
import { OrgAppError } from "~/modules/apps/org-app-service"
import { getOrgAppState } from "~/modules/apps/org-apps"

/** Per-app report entry. */
interface AppResult {
  name: string
  enabled: boolean
  /** Present for first-party catalog apps: true once an active version exists. */
  installed?: boolean
  /** Present when the app declares a connection; true for an active credentials
   *  connection, false/absent for an enable-only or oauth2-pending app. */
  connected?: boolean
  /** The connection fields this run replaced (values for non-secret fields only). */
  connectionChanges?: ConnectionFieldChange[]
  /** Post-apply health check of the connection (`config apply` only). */
  health?: ConnectionHealth
  /** Mail app only, when the entry declares `providers`: the switch per provider. */
  providers?: Record<string, MailProviderResult>
  /** What this entry changed (`installed`, `enabled`, `config.<key>`, ...); empty: nothing. */
  changed: string[]
}

interface AppsSection {
  apps: AppResult[]
}

export const appsProvisioner: Provisioner<ProvisioningConfig> = {
  key: "apps",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const list = config.apps
    if (!list || list.length === 0) return { actions: [] }
    if (ctx.toolPath) return planAppsAgainstStore(ctx, config, list)
    // Catalog membership so the plan distinguishes "install + enable" (first-party
    // catalog app) from "enable" (built-in/in-tree app).
    const catalogNames = new Set((await listCatalogWithState()).map((c) => c.name))
    // An existing org's credentials connections are diffed against the stored
    // ones, so a dry run shows a drifted setting before apply replaces it.
    const planOrgId = list.some((a) => a.connection?.credentials)
      ? await resolvePlanOrgId(ctx, config.org.slug, "cli-plan-apps-org")
      : ""
    const actions: string[] = []
    for (const app of list) {
      if (app.enable === false) continue
      const verb = catalogNames.has(app.name) ? "install + enable" : "enable"
      actions.push(
        app.connection
          ? `${verb} app '${app.name}' + connect '${app.connection.name}'`
          : `${verb} app '${app.name}'`,
      )
      if (app.connection)
        actions.push(...(await planConnection(ctx, planOrgId, app.name, app.connection)))
      if (app.providers) actions.push(...(await planMailProviders(ctx, config, app.providers)))
      if (app.config) {
        // Refuse a secret/undeclared/ill-typed key before anything is written
        // when the app is already registered; a catalog app installed by this
        // run is checked in apply, before its first config write.
        if (ctx.orgId && declaredAppConfigKeys(ctx.orgId, app.name) !== null) {
          assertAppConfigAllowed(ctx.orgId, app.name, app.config)
        }
        actions.push(`set app '${app.name}' config: ${Object.keys(app.config).join(", ")}`)
      }
      if (app.settings) {
        // Checked here when the app is registered; one this run installs, in apply.
        if (ctx.orgId && appSettingsKnown(ctx.orgId, app.name)) {
          checkAppSettings(ctx.orgId, app.name, app.settings)
        }
        actions.push(`set app '${app.name}' settings: ${Object.keys(app.settings).join(", ")}`)
      }
      if (app.provision) {
        // Checked here when the app is registered; one this run installs, in apply.
        if (ctx.orgId && appHasProvisioning(ctx.orgId, app.name)) {
          assertProvisionValid(ctx.orgId, app.name, app.provision)
        }
        actions.push(`provision app '${app.name}': ${Object.keys(app.provision).join(", ")}`)
      }
    }
    return { actions }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const list = config.apps
    if (!list || list.length === 0) return {}
    // One kernel.files SELECT policy rebuild for the whole apps[] list, not
    // one per catalog app it (re)installs (each takes an ACCESS EXCLUSIVE lock
    // on kernel.files while the server is serving).
    const { batchFilesSelectPolicyRebuild } = await import("~/infra/boot-phase10")
    return batchFilesSelectPolicyRebuild(() => applyApps(ctx, list))
  },
}

/**
 * Tool-path plan: what each entry would change on the live org (install or
 * upgrade, enable, provider switches, config keys), or that it changes
 * nothing. A connection is never written here without its secret or consent,
 * so it is reported, not counted as a change.
 */
async function planAppsAgainstStore(
  ctx: Parameters<Provisioner<ProvisioningConfig>["plan"]>[0],
  config: ProvisioningConfig,
  list: NonNullable<ProvisioningConfig["apps"]>,
): Promise<ProvisionPlan> {
  const catalogState = new Map((await listCatalogWithState()).map((c) => [c.name, c] as const))
  const enabled = new Set(await getEnabledApps(ctx.orgId))
  const canInstall = await canManageInstanceApps(ctx.orgId)
  const actions: string[] = []
  let changes = 0
  for (const app of list) {
    if (app.enable === false) {
      actions.push(`app '${app.name}': enable:false skipped (no disable path)`)
      continue
    }
    const lines: string[] = []
    const state = catalogState.get(app.name)
    // An app neither installed nor in the catalog would be "enabled" with
    // nothing behind it: a success that achieved nothing. Refused instead.
    if (!state && !(await isAppRegistered(ctx.orgId, app.name))) {
      throw new ConfigError(
        `apps: no app '${app.name}' is installed or in the catalog (the catalog has ${[...catalogState.keys()].join(", ") || "no app"})`,
      )
    }
    // The App store's rule: installing changes every org on a multi-tenant
    // instance, so only the instance operator's org installs (or upgrades).
    if (state && !state.installed && !canInstall) {
      throw new ConfigError(
        `apps: '${app.name}' is not installed on this instance, and installing apps is reserved to the instance operator's organization`,
      )
    }
    if (state && !state.installed) lines.push(`install app '${app.name}' (v${state.version})`)
    else if (state && canInstall && catalogInstallAction(state) === "upgrade") {
      lines.push(`upgrade app '${app.name}' ${state.installedVersion} -> ${state.version}`)
    } else if (state && catalogInstallAction(state) === "ahead") {
      // Not a change (apply keeps it), but said: the catalog's older version
      // is not what this org will run.
      actions.push(
        `app '${app.name}': kept newer v${state.installedVersion} (catalog has v${state.version})`,
      )
    }
    // An app already on (its pages and tools are there) is not enabled again:
    // the card would ask a person to approve a change nobody sees. One an admin
    // turned Off (or removed) is a real change, whatever the enabledApps list says.
    const status = (await isAppRegistered(ctx.orgId, app.name))
      ? ((await getOrgAppState(ctx.orgId, app.name))?.status ?? "active")
      : null
    if (status !== null && status !== "active") {
      lines.push(`turn on app '${app.name}' (now ${status === "disabled" ? "off" : status})`)
    } else if (!enabled.has(app.name) && !(await appIsOn(ctx.orgId, app.name))) {
      lines.push(`enable app '${app.name}'`)
    }
    if (app.providers) {
      for (const line of await planMailProviders(ctx, config, app.providers)) {
        if (/ unchanged /.test(line)) continue
        lines.push(line)
      }
    }
    if (app.config) {
      if (declaredAppConfigKeys(ctx.orgId, app.name) !== null) {
        assertAppConfigAllowed(ctx.orgId, app.name, app.config)
      }
      const stored = await ctx.priv("config-plan-app-config", (tx) =>
        readAppConfig(tx, ctx.orgId, app.name),
      )
      for (const [key, value] of Object.entries(app.config)) {
        if (canonicalJson(stored[key] ?? null) !== canonicalJson(value)) {
          lines.push(`set app '${app.name}' config '${key}'`)
        }
      }
    }
    if (app.settings) {
      if (appSettingsKnown(ctx.orgId, app.name)) {
        lines.push(...(await planAppSettings(ctx, app.name, app.settings)))
      } else {
        lines.push(`set app '${app.name}' settings: ${Object.keys(app.settings).join(", ")}`)
      }
    }
    if (app.provision) lines.push(...(await planAppProvision(ctx, app.name, app.provision)))
    changes += lines.length
    if (app.connection) {
      actions.push(
        `app '${app.name}' connection '${app.connection.name}': connected once its credentials or consent are given`,
      )
    }
    actions.push(...(lines.length > 0 ? lines : [`app '${app.name}' unchanged`]))
  }
  return { actions, changes }
}

async function applyApps(
  ctx: Parameters<Provisioner<ProvisioningConfig>["apply"]>[0],
  list: NonNullable<ProvisioningConfig["apps"]>,
): Promise<ProvisionResult> {
  const apps: AppResult[] = []
  const changed: string[] = []
  const unchanged: string[] = []
  const pending: PendingItem[] = []

  // Installed-state (+ versions) of every first-party catalog app: an app already
  // installed at the SAME version as the baked catalog is a no-op (re-installing
  // would needlessly rewrite the on-disk bundle); a DIFFERENT version is an
  // upgrade (the deploy shipped a newer bundle) -- re-install to pick it up.
  const catalogState = new Map((await listCatalogWithState()).map((c) => [c.name, c] as const))
  // The tool path installs as the App store does (installFromCatalog: the
  // instance-operator rule); an org that may not install keeps the installed
  // version instead of upgrading it.
  const canInstall = !ctx.toolPath || (await canManageInstanceApps(ctx.orgId))

  for (const app of list) {
    if (app.enable === false) {
      // v1 has no disable path — record intent and skip.
      ctx.log(`app '${app.name}': enable:false — skipped (no disable path in v1)`)
      apps.push({ name: app.name, enabled: false, changed: [] })
      continue
    }

    // What this entry changes: the report's own entries from here on.
    const changedBefore = changed.length
    const ownChanges = () =>
      changed.slice(changedBefore).map((key) => key.replace(`apps.${app.name}.`, ""))
    // On before this run (the tool path): an enable is then no change for anyone.
    const wasOn = ctx.toolPath && (await appIsOn(ctx.orgId, app.name))

    // First-party catalog app → install it (idempotent; skip when already
    // installed). Non-catalog (built-in/in-tree) names skip straight to enable.
    let installed: boolean | undefined
    const state = catalogState.get(app.name)
    if (state) {
      // Upgrade when the baked catalog version differs from what's installed
      // (a re-install of the same version overwrites in place, so this also
      // recovers a corrupted/patched bundle when the version is unchanged and
      // the operator forces it -- but by default same-version is a no-op).
      const action = catalogInstallAction(state)
      const needsUpgrade = canInstall && action === "upgrade"
      if (action === "ahead") {
        // A newer release set the active version (a rollback, or an old
        // process in a rolling deploy): this image's older package would be
        // refused, and the org registers the version this process runs.
        noteVersionAhead(app.name, state.installedVersion ?? "", state.version)
        ctx.log(
          `app '${app.name}': active v${state.installedVersion} is newer than this release's catalog (v${state.version}), kept`,
        )
        unchanged.push(`apps.${app.name}.installed`)
      } else if (state.installed && !needsUpgrade) {
        ctx.log(`app '${app.name}': already installed (v${state.installedVersion})`)
        unchanged.push(`apps.${app.name}.installed`)
      } else {
        requireActor(ctx, `apps: installing catalog app '${app.name}'`)
        const install = ctx.toolPath ? installFromCatalog : installCatalogApp
        await install({
          orgId: ctx.orgId,
          name: app.name,
          installedBy: ctx.actor.userId,
        })
        if (needsUpgrade) {
          ctx.log(
            `app '${app.name}': upgraded ${state.installedVersion} -> ${state.version} from catalog`,
          )
        } else {
          ctx.log(`app '${app.name}': installed from catalog (v${state.version})`)
        }
        // Reflect the just-installed version in the snapshot so a LATER apps[]
        // entry for the SAME app (e.g. `social`, listed once per OAuth
        // connection) sees it as already-installed at the new version instead of
        // re-running the upgrade -- which would redundantly re-install and, on a
        // version bump, double-insert the apps_installed (name, version) row.
        catalogState.set(app.name, { ...state, installed: true, installedVersion: state.version })
        changed.push(`apps.${app.name}.installed`)
      }
      installed = true
    }

    // enableApp owns its own withSystemDb — call directly (#10). Idempotent
    // DISTINCT; it returns whether it actually appended so we report changed
    // vs unchanged accurately (a re-enable is a no-op, not a change).
    const newlyEnabled = await enableApp(ctx.orgId, app.name)
    // Listed is not On: an app an admin turned Off (or removed) is turned on
    // through the admin page's own path, so it really runs again.
    let turnedOn = false
    try {
      turnedOn = await turnOrgAppOn(ctx.orgId, app.name, {
        actorId: ctx.actor.userId || null,
        actorType: ctx.toolPath ? "agent" : "user",
      })
    } catch (err) {
      if (err instanceof OrgAppError) throw new ConfigError(`apps: '${app.name}': ${err.message}`)
      throw err
    }
    if ((newlyEnabled || turnedOn) && !wasOn) {
      ctx.log(`app '${app.name}': enabled`)
      changed.push(`apps.${app.name}.enabled`)
    } else {
      ctx.log(`app '${app.name}': already enabled`)
      unchanged.push(`apps.${app.name}.enabled`)
    }

    // Mail provider switches: after the enable above, so one apply can enable
    // the mail app and switch its providers (the schema allows `providers`
    // on the mail app only).
    let providers: Record<string, MailProviderResult> | undefined
    if (app.providers) {
      const r = await applyMailProviders(ctx, app.providers)
      changed.push(...r.changed)
      unchanged.push(...r.unchanged)
      pending.push(...r.pending)
      providers = r.providers
    }

    if (app.config) {
      const r = await applyAppConfig(ctx, app.name, app.config)
      changed.push(...r.changed)
      unchanged.push(...r.unchanged)
    }

    if (app.settings) {
      const r = await applyAppSettings(ctx, app.name, app.settings)
      changed.push(...r.changed)
      unchanged.push(...r.unchanged)
    }

    if (!app.connection) {
      if (app.provision) {
        const r = await applyAppProvision(ctx, app.name, app.provision)
        changed.push(...r.changed)
        unchanged.push(...r.unchanged)
      }
      apps.push({
        name: app.name,
        enabled: (await settledAppState(ctx.orgId, app.name)) === "on",
        ...(installed ? { installed } : {}),
        ...(providers ? { providers } : {}),
        changed: ownChanges(),
      })
      continue
    }

    const result = await provisionConnection(ctx, app.name, app.connection)
    if (result.changed) changed.push(...result.changed)
    if (result.unchanged) unchanged.push(...result.unchanged)
    if (result.pending) pending.push(result.pending)
    // The app's own setup runs once its connection is in place (it may use it).
    if (app.provision) {
      const r = await applyAppProvision(ctx, app.name, app.provision)
      changed.push(...r.changed)
      unchanged.push(...r.unchanged)
    }
    // A connection that is unchanged can still be dead (a host that moved, a
    // revoked token): probe the stored row when the app has a probe, and turn
    // a failure into a pending item instead of a silent success.
    let health: ConnectionHealth | undefined
    if (ctx.connectionProbe && result.connected && result.identifier !== undefined) {
      health = await checkConnectionHealth(
        ctx,
        ctx.connectionProbe,
        app.name,
        app.connection.name,
        app.provision as Record<string, unknown> | undefined,
      )
      if (health.status === "FAIL") {
        pending.push({
          kind: "credentials",
          app: app.name,
          connection: app.connection.name,
          identifier: result.identifier,
          action: `fix the ${app.name} connection settings and re-run config apply`,
          message: `Connection '${app.name}/${app.connection.name}' health check failed: ${health.error ?? "unknown error"}`,
        })
      }
    }
    apps.push({
      name: app.name,
      enabled: (await settledAppState(ctx.orgId, app.name)) === "on",
      ...(installed ? { installed } : {}),
      connected: result.connected,
      ...(result.fieldChanges ? { connectionChanges: result.fieldChanges } : {}),
      ...(health ? { health } : {}),
      ...(providers ? { providers } : {}),
      changed: ownChanges(),
    })
  }

  const section: AppsSection = { apps }
  return {
    section,
    ...(changed.length > 0 ? { changed } : {}),
    ...(unchanged.length > 0 ? { unchanged } : {}),
    ...(pending.length > 0 ? { pending } : {}),
  }
}
