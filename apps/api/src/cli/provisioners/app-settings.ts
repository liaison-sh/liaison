// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].settings`: fields of the app's manifest settings page that live in the
 * org's settings (`organizations.settings.<app>`, a field's default `source`),
 * written as `PATCH /api/apps/:app/settings/org` writes them: the path must be an
 * org field the manifest declares, the value passes the field's validator, the
 * field's siblings are kept, and each write emits `app_setting:updated` for the
 * audit. A field kept in the app's config (`source: config`) goes through
 * `apps[].config`; one backed by the app's own tools is set on its settings page.
 * Who may write a field is its section's adminScope (config-section-scopes.ts).
 * Idempotent: an equal stored value is reported `unchanged` and not written.
 */

import { fieldSourceKind } from "@liaison/app-sdk"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisionContext } from "~/cli/provisioners/types"
import { readOrgAppNamespace, setOrgAppSettingPath, settingAtPath } from "~/lib/settings"
import { canonicalJson } from "~/modules/apps/app-config"
import { appSettingsRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import type { RegisteredSettingsField } from "~/modules/apps/settings-schema-from-manifest"

interface CheckedSetting {
  path: string
  value: unknown
}

/** The org fields of an app's settings page, or null when the app is not registered. */
function orgFields(orgId: string, appName: string): Map<string, RegisteredSettingsField> | null {
  const entry = appSettingsRegistry.get([orgId, appName])
  if (!entry) return null
  return entry.manifestSettings?.fields.org ?? new Map()
}

/** True once the app is registered for the org, so its settings fields can be checked. */
export function appSettingsKnown(orgId: string, appName: string): boolean {
  return orgFields(orgId, appName) !== null
}

/** The validated values, or a ConfigError naming the first refused path. */
export function checkAppSettings(
  orgId: string,
  appName: string,
  settings: Record<string, unknown>,
): CheckedSetting[] {
  const fields = orgFields(orgId, appName) ?? new Map<string, RegisteredSettingsField>()
  const out: CheckedSetting[] = []
  for (const [path, raw] of Object.entries(settings)) {
    const label = `apps.${appName}.settings.${path}`
    const reg = fields.get(path)
    if (!reg) {
      const known = [...fields]
        .filter(([, r]) => fieldSourceKind(r.field) === "settings")
        .map(([k]) => k)
      throw new ConfigError(
        `${label}: not an org setting of ${appName} (its settings: ${known.join(", ") || "none"})`,
      )
    }
    const kind = fieldSourceKind(reg.field)
    if (kind === "config") {
      throw new ConfigError(`${label}: kept in the app's config, set it under apps[].config`)
    }
    if (kind !== "settings") {
      throw new ConfigError(`${label}: saved by the app itself, set it on its settings page`)
    }
    const parsed = reg.validator.safeParse(raw)
    if (!parsed.success) {
      throw new ConfigError(`${label}: ${parsed.error.issues[0]?.message ?? "invalid value"}`)
    }
    out.push({ path, value: parsed.data })
  }
  return out
}

/** The scopes writing these fields needs: each field's section adminScope. */
export function appSettingsAdminScopes(
  orgId: string,
  appName: string,
  settings: Record<string, unknown>,
): string[] {
  const fields = orgFields(orgId, appName)
  const out = new Set<string>()
  for (const path of Object.keys(settings)) {
    out.add(fields?.get(path)?.adminScope ?? "kernel:apps:admin")
  }
  return [...out]
}

/** The paths whose stored value differs from the desired one. */
async function changedPaths(
  ctx: ProvisionContext,
  appName: string,
  checked: CheckedSetting[],
): Promise<CheckedSetting[]> {
  const namespace = await ctx.priv("config-app-settings-read", (tx) =>
    readOrgAppNamespace(tx, ctx.orgId, appName),
  )
  return checked.filter(
    (s) =>
      canonicalJson(settingAtPath(namespace, s.path.split(".")) ?? null) !== canonicalJson(s.value),
  )
}

/** Plan lines: one per field the apply would change. */
export async function planAppSettings(
  ctx: ProvisionContext,
  appName: string,
  settings: Record<string, unknown>,
): Promise<string[]> {
  const checked = checkAppSettings(ctx.orgId, appName, settings)
  return (await changedPaths(ctx, appName, checked)).map(
    (s) => `set app '${appName}' setting '${s.path}' to ${canonicalJson(s.value)}`,
  )
}

export async function applyAppSettings(
  ctx: ProvisionContext,
  appName: string,
  settings: Record<string, unknown>,
): Promise<{ changed: string[]; unchanged: string[] }> {
  // The fields come from the app's registered manifest; registration is warmed by
  // the org provisioner (a no-op then) or by the catalog install before this.
  await ensureAppsForOrg(ctx.orgId)
  const checked = checkAppSettings(ctx.orgId, appName, settings)
  const toWrite = new Set((await changedPaths(ctx, appName, checked)).map((s) => s.path))
  const result = { changed: [] as string[], unchanged: [] as string[] }
  for (const { path, value } of checked) {
    const label = `apps.${appName}.settings.${path}`
    if (!toWrite.has(path)) {
      ctx.log(`app '${appName}': setting '${path}' already set`)
      result.unchanged.push(label)
      continue
    }
    await ctx.priv("config-app-settings-write", async (tx) => {
      await setOrgAppSettingPath(tx, ctx.orgId, appName, path.split("."), value)
      await tx.queueEvent({
        app: "kernel",
        entity: "app_setting",
        action: "updated",
        entityId: ctx.orgId,
        orgId: ctx.orgId,
        actorId: ctx.actor.userId || null,
        actorType: "user",
        data: { app: appName, path, scope: "org" },
      })
    })
    ctx.log(`app '${appName}': setting '${path}' written`)
    result.changed.push(label)
  }
  return result
}
