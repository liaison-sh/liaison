// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APP-HELD SECRETS A PERSON GIVES LIAISON.
//
// Some providers show a secret once in their own dashboard and never hand it to an API (a
// webhook endpoint's signing secret). The app declares the key in
// `connections.<c>.appSecretConfigKeys` (where it is kept, encrypted) and in
// `connections.<c>.appSecretFields` (that a person may set it, under which label, of which
// shape). Every way a person sets one ends here: the route
// `PUT /api/connections/:app/:conn/app-secrets/:key` (the app's settings page and the
// secret request card post to it) and `config apply` (`apps[].appSecrets`).
//
// The value is written by `storeAppHeldSecret` (service.ts), which also rolls a replaced
// webhook signing secret: the old value keeps verifying for 24 hours. Nothing here returns,
// logs or audits the value; the status says only whether a key is set.

import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { apps as appsTable } from "~/db/schema/kernel"
import { manifestRegExp } from "~/lib/manifest-regex"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import {
  type AppSecretField,
  connectionConfigRegistry,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import {
  decryptConnectionConfigValue,
  storeAppHeldSecret,
} from "~/modules/apps/connections/service"

/** The longest value accepted (the store's own bound). */
const MAX_VALUE_LENGTH = 4096

export class AppSecretError extends Error {
  constructor(
    readonly code: "not_found" | "not_settable" | "invalid_value",
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message)
    this.name = "AppSecretError"
  }
}

type ConnectionDecl = {
  appSecretConfigKeys?: string[]
  appSecretFields?: AppSecretField[]
}

/** The fields of a connection a person may set: declared fields whose key is a declared app secret. */
export function settableAppSecretFields(decl: ConnectionDecl | null | undefined): AppSecretField[] {
  const keys = new Set(decl?.appSecretConfigKeys ?? [])
  return (decl?.appSecretFields ?? []).filter((f) => keys.has(f.key))
}

/** The field for `key`, or an error naming what can be set. */
export function settableField(
  decl: ConnectionDecl | null | undefined,
  key: string,
): AppSecretField {
  const fields = settableAppSecretFields(decl)
  const field = fields.find((f) => f.key === key)
  if (!field) {
    const known = fields.map((f) => f.key)
    throw new AppSecretError(
      "not_settable",
      known.length > 0
        ? `"${key}" is not a secret a person sets here; the settable ones: ${known.join(", ")}.`
        : `"${key}" is not a secret a person sets here; this connection has none.`,
      400,
    )
  }
  return field
}

/** Why a value is refused, in words that never hold it; null when it is accepted. */
export function appSecretValueProblem(field: AppSecretField, value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return `${field.label} is empty.`
  if (value.length > MAX_VALUE_LENGTH) {
    return `${field.label} is longer than ${MAX_VALUE_LENGTH} characters.`
  }
  if (field.pattern && !manifestRegExp(field.pattern).test(value.trim())) {
    return field.patternMessage ?? `${field.label} does not have the expected shape.`
  }
  return null
}

/** The connection's declaration, or a 404 naming what is missing. */
export function connectionDeclFor(
  orgId: string,
  appName: string,
  connectionName: string,
): ConnectionDecl {
  const decl = connectionConfigRegistry.get([orgId, appName, connectionName])
  if (!decl) {
    throw new AppSecretError(
      "not_found",
      `Connection "${connectionName}" not declared in app "${appName}" manifest (is the app installed?)`,
      404,
    )
  }
  return decl
}

export interface AppSecretStatus {
  key: string
  label: string
  labelKey?: string
  help?: string
  /** Whether a value is stored. Never the value. */
  set: boolean
  /** A replaced value still verifying until then (ISO), when one does. */
  previousUntil: string | null
}

async function storedConfig(orgId: string, appName: string): Promise<Record<string, unknown>> {
  const rows = await withPrivilegedDb(orgId, "app-secret-status", (tx) =>
    tx
      .select({ config: appsTable.config })
      .from(appsTable)
      .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
      .limit(1),
  )
  const raw = rows[0]?.config
  const config = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  return config && typeof config === "object" ? (config as Record<string, unknown>) : {}
}

const isSet = (v: unknown) => typeof v === "string" && v.length > 0

/** Which settable secrets of a connection are set (yes or no), never their values. */
export async function appSecretStatus(
  orgId: string,
  appName: string,
  connectionName: string,
): Promise<AppSecretStatus[]> {
  const decl = connectionDeclFor(orgId, appName, connectionName)
  const fields = settableAppSecretFields(decl)
  if (fields.length === 0) return []
  const config = await storedConfig(orgId, appName)
  return fields.map((f) => {
    const previousKey = `${f.key}Previous`
    const until = config[`${previousKey}Until`]
    const untilMs = typeof until === "string" ? Date.parse(until) : Number.NaN
    const previousLive =
      (decl.appSecretConfigKeys ?? []).includes(previousKey) &&
      isSet(config[previousKey]) &&
      Number.isFinite(untilMs) &&
      untilMs > Date.now()
    return {
      key: f.key,
      label: f.label,
      ...(f.labelKey ? { labelKey: f.labelKey } : {}),
      ...(f.help ? { help: f.help } : {}),
      set: isSet(config[f.key]),
      previousUntil: previousLive ? new Date(untilMs).toISOString() : null,
    }
  })
}

/**
 * Store a secret a person gave, after checking the key is one they may set and the value has
 * its shape. `rolled`: another value was set (it keeps verifying for a while, when the
 * connection declares the previous key). The same value again writes nothing (`unchanged`), so
 * a double submit never displaces a previous secret that is still verifying. The caller checked
 * the person's scope.
 */
export async function setAppSecret(args: {
  orgId: string
  appName: string
  connectionName: string
  key: string
  value: unknown
}): Promise<{ key: string; rolled: boolean; unchanged: boolean }> {
  const decl = connectionDeclFor(args.orgId, args.appName, args.connectionName)
  const field = settableField(decl, args.key)
  const problem = appSecretValueProblem(field, args.value)
  if (problem) throw new AppSecretError("invalid_value", problem, 400)
  const value = String(args.value).trim()
  const manifestConnections = { [args.connectionName]: decl }
  const before = await storedConfig(args.orgId, args.appName)
  const stored = before[field.key]
  if (isSet(stored)) {
    const current = decryptConnectionConfigValue(
      args.orgId,
      args.appName,
      field.key,
      stored,
      undefined,
      manifestConnections,
    )
    if (current === value) return { key: field.key, rolled: false, unchanged: true }
  }
  await storeAppHeldSecret({
    orgId: args.orgId,
    appName: args.appName,
    key: field.key,
    value,
    manifestConnections,
  })
  return { key: field.key, rolled: isSet(stored), unchanged: false }
}

/** The addresses the app's webhook endpoints are reached at (the org's public base). */
export async function appWebhookAddresses(
  orgId: string,
  appName: string,
): Promise<Array<{ endpoint: string; url: string }>> {
  // The registered endpoints (connection-guides/plan.ts reads them the same way).
  const endpoints = [...webhookHandlers.snapshotUnder([orgId, appName]).keys()]
    .map((raw) => raw.split("\0").at(-1) ?? "")
    .filter((name) => name !== "" && name !== appName)
    .sort()
  if (endpoints.length === 0) return []
  const base = (await orgPublicBaseUrl(orgId)).replace(/\/+$/, "")
  return endpoints.map((endpoint) => ({
    endpoint,
    url: `${base}/webhooks/${orgId}/${appName}/${endpoint}`,
  }))
}
