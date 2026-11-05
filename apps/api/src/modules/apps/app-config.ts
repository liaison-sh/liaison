// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Admin write path for an app's NON-SECRET config keys in `kernel.apps.config`,
 * the store bundled apps read with `ctx.config.get(key)` (the sandbox bridge in
 * `sandbox/bridge/identity.ts`). Shared by the kernel route
 * `PUT /api/apps/:app/config/:key` and the `config apply` `apps[].config` map,
 * so both go through ONE allowlist: the key must be declared in the installed
 * app's manifest `configKeys`, must not be a connection secret key, and the
 * value must match the declared type (`checkAppConfigWrite` in the SDK).
 */

import {
  type AppConfigKeyDecl,
  type AppConfigWriteCheck,
  checkAppConfigWrite,
} from "@liaison/app-sdk"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { apps as appsTable } from "~/db/schema/kernel/apps"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { resolveConnectionSecretConfigKeys } from "~/modules/apps/connections/service"
import { writeAuditLog } from "~/modules/audit/service"

/** The installed app's declared config keys, or null when the app is not registered. */
export function declaredAppConfigKeys(orgId: string, appName: string): AppConfigKeyDecl[] | null {
  const entry = manifestRegistry.get([orgId, appName])
  if (!entry) return null
  return entry.configKeys ?? []
}

/**
 * Allowlist + type check for one write, against the app registered for the org.
 * Secret keys come from the registered connection declarations (both secret
 * fields of every connection the app declares).
 */
export function checkAppConfigWriteForOrg(
  orgId: string,
  appName: string,
  key: string,
  value: unknown,
): AppConfigWriteCheck | { ok: false; code: "unknown_app"; message: string } {
  const configKeys = declaredAppConfigKeys(orgId, appName)
  if (configKeys === null) {
    return { ok: false, code: "unknown_app", message: `App "${appName}" is not installed` }
  }
  const connections = Object.fromEntries(
    Array.from(connectionConfigRegistry.entriesOf(orgId))
      .filter(([[o, a]]) => o === orgId && a === appName)
      .map(([[, , connName], conn]) => [connName, conn]),
  )
  return checkAppConfigWrite(
    { configKeys, connections },
    key,
    value,
    resolveConnectionSecretConfigKeys(orgId, appName, connections),
  )
}

/** Canonical JSON (sorted object keys), so jsonb key reordering is not a change. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(src)
          .sort()
          .map((k) => [k, src[k]]),
      )
    }
    return v
  })
}

export async function readAppConfig(
  tx: PrivilegedDb,
  orgId: string,
  appName: string,
): Promise<Record<string, unknown>> {
  const rows = await tx
    .select({ config: appsTable.config })
    .from(appsTable)
    .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
    .limit(1)
  const raw = rows[0]?.config
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

/** Stored value of a key, `null` when absent (the same view `ctx.config.get` has). */
function storedValue(config: Record<string, unknown>, key: string): unknown {
  return config[key] ?? null
}

export interface AppConfigWriteResult {
  changed: boolean
  value: unknown
}

/**
 * Write one already-checked key. `null` removes it. Idempotent: an equal value
 * (canonical JSON) writes nothing and reports `changed: false`. A change is
 * audit-logged with the actor and the before/after values (non-secret by
 * construction: secret keys never pass the check).
 */
export async function writeAppConfigKey(opts: {
  orgId: string
  appName: string
  key: string
  value: unknown
  actorId: string | null
  actorType: "user" | "system"
  source: "api" | "config-apply"
}): Promise<AppConfigWriteResult> {
  const { orgId, appName, key, value } = opts
  return withPrivilegedDb(orgId, "app-config-write", async (tx) => {
    const before = storedValue(await readAppConfig(tx, orgId, appName), key)
    if (canonicalJson(before) === canonicalJson(value)) return { changed: false, value }
    const updated = await tx
      .update(appsTable)
      .set({
        config:
          value === null
            ? drizzleSql`coalesce(${appsTable.config}, '{}'::jsonb) - ${key}::text`
            : drizzleSql`coalesce(${appsTable.config}, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
      .returning({ id: appsTable.id })
    if (updated.length === 0) {
      throw new Error(`app-config write: no kernel.apps row for app "${appName}" in org ${orgId}`)
    }
    await writeAuditLog(tx, {
      orgId,
      actorId: opts.actorId,
      actorType: opts.actorType,
      app: "kernel",
      entityType: "app_config",
      entityId: updated[0]?.id,
      action: "app_config_updated",
      changes: { [key]: { from: before, to: value } },
      metadata: { app: appName, key, source: opts.source },
    })
    return { changed: true, value }
  })
}
