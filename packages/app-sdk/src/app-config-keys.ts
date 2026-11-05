// SPDX-License-Identifier: FSL-1.1-ALv2
// App config keys: the allowlist of NON-SECRET `kernel.apps.config` keys an
// administrator may write for an app (the kernel route
// `PUT /api/apps/:app/config/:key` and the `config apply` `apps[].config` map).
// An app declares them in its manifest under `configKeys`; bundled apps read
// them back with `ctx.config.get(key)`.
//
// Connection secrets (`clientSecretConfigKey`, `webhookSecretConfigKey`) live in
// the same store, encrypted, and are written only by the kernel: a manifest may
// never declare one of them as a config key, and the write path refuses them.
import { z } from "zod"

export const APP_CONFIG_KEY_TYPES = ["json", "string", "url"] as const
export type AppConfigKeyType = (typeof APP_CONFIG_KEY_TYPES)[number]

/** Largest serialized value accepted for one config key. */
export const APP_CONFIG_VALUE_MAX_BYTES = 64 * 1024

export const appConfigKeySchema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/, "configKeys[].key must be an identifier"),
    type: z.enum(APP_CONFIG_KEY_TYPES),
    label: z.string().min(1).max(120).optional(),
  })
  .strict()

export type AppConfigKeyDecl = z.infer<typeof appConfigKeySchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Every config key a manifest's `connections` map reserves for a secret.
 * Accepts the raw manifest value (validated or not), so every caller shares it.
 */
export function connectionSecretConfigKeys(connections: unknown): Set<string> {
  const keys = new Set<string>()
  if (!isRecord(connections)) return keys
  for (const conn of Object.values(connections)) {
    if (!isRecord(conn)) continue
    if (typeof conn.clientSecretConfigKey === "string") keys.add(conn.clientSecretConfigKey)
    if (typeof conn.webhookSecretConfigKey === "string") keys.add(conn.webhookSecretConfigKey)
  }
  return keys
}

/**
 * Cross-field problems of a manifest's `configKeys` (the shape itself is the
 * schema's job): a duplicate key, or a key a connection reserves for a secret.
 * Returns human-readable messages, empty when the declaration is valid.
 */
export function configKeysDeclarationErrors(configKeys: unknown, connections: unknown): string[] {
  const errors: string[] = []
  if (!Array.isArray(configKeys)) return errors
  const secrets = connectionSecretConfigKeys(connections)
  const seen = new Set<string>()
  for (const decl of configKeys) {
    if (!isRecord(decl) || typeof decl.key !== "string") continue
    if (seen.has(decl.key)) errors.push(`configKeys: key "${decl.key}" is declared twice`)
    seen.add(decl.key)
    if (secrets.has(decl.key)) {
      errors.push(
        `configKeys: key "${decl.key}" is a connection secret key and cannot be an app config key`,
      )
    }
  }
  return errors
}

export type AppConfigWriteErrorCode = "undeclared" | "secret" | "invalid"

export type AppConfigWriteCheck =
  | { ok: true; decl: AppConfigKeyDecl; value: unknown }
  | { ok: false; code: AppConfigWriteErrorCode; message: string }

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Validate one value against its declared type. `null` clears the key and is
 * valid for every type. Returns an error message, or null when valid.
 */
export function appConfigValueError(type: AppConfigKeyType, value: unknown): string | null {
  if (value === undefined) return "value is required (use null to clear the key)"
  if (value === null) return null
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return "value must be a JSON value"
  }
  if (serialized === undefined) return "value must be a JSON value"
  if (new TextEncoder().encode(serialized).length > APP_CONFIG_VALUE_MAX_BYTES) {
    return `value exceeds ${APP_CONFIG_VALUE_MAX_BYTES} bytes`
  }
  switch (type) {
    case "json":
      return null
    case "string":
      return typeof value === "string" ? null : "value must be a string"
    case "url":
      if (typeof value !== "string") return "value must be a URL string"
      return isHttpUrl(value) ? null : "value must be an http or https URL"
  }
}

/**
 * The single allowlist check shared by every app-config write path: the key
 * must be declared in the app's `configKeys`, must not be a connection secret
 * key, and the value must match the declared type.
 */
export function checkAppConfigWrite(
  manifest: {
    configKeys?: ReadonlyArray<AppConfigKeyDecl> | null
    connections?: unknown
  },
  key: string,
  value: unknown,
  extraSecretKeys: Iterable<string> = [],
): AppConfigWriteCheck {
  const secrets = connectionSecretConfigKeys(manifest.connections)
  for (const k of extraSecretKeys) secrets.add(k)
  if (secrets.has(key)) {
    return {
      ok: false,
      code: "secret",
      message: `"${key}" is a connection secret and cannot be written as app config`,
    }
  }
  const decl = (manifest.configKeys ?? []).find((d) => d.key === key)
  if (!decl) {
    return {
      ok: false,
      code: "undeclared",
      message: `"${key}" is not a config key declared by the app manifest`,
    }
  }
  const error = appConfigValueError(decl.type, value)
  if (error) return { ok: false, code: "invalid", message: `${key}: ${error}` }
  return { ok: true, decl, value }
}
