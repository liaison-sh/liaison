// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { isUnsafePathSegment } from "~/lib/safe-path"

function orgsTable(): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.organizations`)
}
function usersTable(): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.users`)
}

type SqlClient = RlsClient | RlsTx | PrivilegedDb

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  while (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault
  ) {
    schema = (schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType
  }
  return schema
}

function getDescription(schema: z.ZodTypeAny): string | undefined {
  const direct = (schema as { description?: string }).description
  if (direct) return direct
  if (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault
  ) {
    return getDescription(
      (schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType,
    )
  }
  return undefined
}

function isEncrypted(schema: z.ZodTypeAny): boolean {
  return getDescription(schema) === "encrypted"
}

function walkEncryptedPaths(schema: z.ZodTypeAny, path: string[] = []): string[][] {
  const out: string[][] = []
  if (isEncrypted(schema)) out.push(path)
  const inner = unwrap(schema)
  if (inner instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(inner.shape)) {
      out.push(...walkEncryptedPaths(child as z.ZodTypeAny, [...path, key]))
    }
  }
  return out
}

function getAtPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (cur && typeof cur === "object" && Object.hasOwn(cur, k)) {
      cur = (cur as Record<string, unknown>)[k]
    } else {
      return undefined
    }
  }
  return cur
}

function setAtPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return
  if (path.some(isUnsafePathSegment)) throw new Error(`unsafe settings path '${path.join(".")}'`)
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    if (!Object.hasOwn(cur, k) || !cur[k] || typeof cur[k] !== "object") cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
}

function decryptInPlace(
  data: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const paths = walkEncryptedPaths(schema)
  for (const p of paths) {
    const v = getAtPath(data, p)
    if (typeof v === "string" && v.length > 0) {
      try {
        setAtPath(data, p, decryptSecret(v, env.ENCRYPTION_KEY, CryptoContext.orgSettingsSecret))
      } catch (err) {
        throw new Error(`encrypted setting ${p.join(".")} is not decryptable`, { cause: err })
      }
    }
  }
  return data
}

function encryptPatch(
  patch: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(patch))
  const paths = walkEncryptedPaths(schema)
  for (const p of paths) {
    const v = getAtPath(out, p)
    if (typeof v === "string" && v.length > 0) {
      setAtPath(out, p, encryptSecret(v, env.ENCRYPTION_KEY, CryptoContext.orgSettingsSecret))
    }
  }
  return out
}

export async function getOrgAppSettings<S extends z.ZodTypeAny>(
  tx: SqlClient,
  orgId: string,
  appName: string,
  schema: S,
): Promise<z.infer<S>> {
  const result = await tx.execute(
    drizzleSql`SELECT settings->${appName} AS v FROM ${orgsTable()} WHERE id = ${orgId}`,
  )
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  const row = rows[0] as { v: Record<string, unknown> | string | null } | undefined
  const rawAny = row?.v ?? {}
  const raw: Record<string, unknown> =
    typeof rawAny === "string" ? (JSON.parse(rawAny) as Record<string, unknown>) : rawAny
  const decrypted = decryptInPlace({ ...raw }, schema)
  return schema.parse(decrypted)
}

export async function setOrgAppSettings<S extends z.ZodTypeAny>(
  tx: SqlClient,
  orgId: string,
  appName: string,
  schema: S,
  patch: Partial<z.infer<S>>,
): Promise<void> {
  const encrypted = encryptPatch(patch as Record<string, unknown>, schema)
  const json = JSON.stringify(encrypted)
  await tx.execute(drizzleSql`
    UPDATE ${orgsTable()}
    SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb),
      ${`{${appName}}`},
      COALESCE(settings->${appName}, '{}'::jsonb) || ${json}::jsonb,
      true
    )
    WHERE id = ${orgId}
  `)
}

export async function getUserAppSettings<S extends z.ZodTypeAny>(
  tx: SqlClient,
  userId: string,
  appName: string,
  schema: S,
  defaults: z.infer<S>,
): Promise<z.infer<S>> {
  const result = await tx.execute(
    drizzleSql`SELECT settings ? ${appName} AS has_ns, settings->${appName} AS v FROM ${usersTable()} WHERE id = ${userId}`,
  )
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  const row = rows[0] as { has_ns: boolean; v: Record<string, unknown> | string | null } | undefined
  if (!row?.has_ns) {
    await setUserAppSettings(tx, userId, appName, schema, defaults)
    return defaults
  }
  const rawAny = row.v ?? {}
  const raw: Record<string, unknown> =
    typeof rawAny === "string" ? (JSON.parse(rawAny) as Record<string, unknown>) : rawAny
  const decrypted = decryptInPlace({ ...raw }, schema)
  return schema.parse(decrypted)
}

export async function setUserAppSettings<S extends z.ZodTypeAny>(
  tx: SqlClient,
  userId: string,
  appName: string,
  schema: S,
  patch: Partial<z.infer<S>>,
): Promise<void> {
  const encrypted = encryptPatch(patch as Record<string, unknown>, schema)
  const json = JSON.stringify(encrypted)
  await tx.execute(drizzleSql`
    UPDATE ${usersTable()}
    SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb),
      ${`{${appName}}`},
      COALESCE(settings->${appName}, '{}'::jsonb) || ${json}::jsonb,
      true
    )
    WHERE id = ${userId}
  `)
}

export async function getOrgKernelSettings<S extends z.ZodTypeAny>(
  tx: SqlClient,
  orgId: string,
  schema: S,
): Promise<z.infer<S>> {
  const result = await tx.execute(
    drizzleSql`SELECT settings AS v FROM ${orgsTable()} WHERE id = ${orgId}`,
  )
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  const row = rows[0] as { v: Record<string, unknown> | string | null } | undefined
  const rawAny = row?.v ?? {}
  // postgres.js auto-parses JSONB to object on most paths but can return a string
  // under some role/connection contexts — normalize before walking.
  const raw: Record<string, unknown> =
    typeof rawAny === "string" ? (JSON.parse(rawAny) as Record<string, unknown>) : rawAny
  const decrypted = decryptInPlace({ ...raw }, schema)
  return schema.parse(decrypted)
}

// ── One path at a time (declarative settings, modules/apps/settings-routes.ts) ──
//
// The helpers above merge a patch into the app namespace with jsonb `||`, which
// is SHALLOW: patching `{ signature: { text } }` replaces the whole `signature`
// object and drops its `html`. A settings page saves one field at a time, so
// these read the namespace under a row lock, set the one path in TS (creating
// the intermediate objects), and write the namespace back, in the caller's
// transaction.

function parseNamespace(raw: unknown): Record<string, unknown> {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The value at a dot path of a namespace, `undefined` when absent. */
export function settingAtPath(ns: Record<string, unknown>, path: string[]): unknown {
  return getAtPath(ns, path)
}

/**
 * A copy of `ns` with `path` set to `value`. By default a null removes the key
 * (`onNull: "remove"`), so a field stored in a settings namespace falls back to its
 * declared default; empty parents left by a removal are kept: they hold nothing a
 * reader sees. `onNull: "keep"` stores the null itself: an object handed to an
 * app's whole-object set tool must carry a cleared field as null, because the tool
 * reads an absent field as "keep the stored value" and the clear would be lost.
 */
export function withSettingAtPath(
  ns: Record<string, unknown>,
  path: string[],
  value: unknown,
  options: { onNull?: "remove" | "keep" } = {},
): Record<string, unknown> {
  if (path.length === 0 || path.some(isUnsafePathSegment)) {
    throw new Error(`unsafe settings path '${path.join(".")}'`)
  }
  const out = JSON.parse(JSON.stringify(ns)) as Record<string, unknown>
  if (value === null && options.onNull !== "keep") {
    const parent = getAtPath(out, path.slice(0, -1))
    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
      delete (parent as Record<string, unknown>)[path[path.length - 1]]
    }
    return out
  }
  setAtPath(out, path, value)
  return out
}

/** `organizations.settings.<app>` as stored (no defaults, no schema). */
export async function readOrgAppNamespace(
  tx: SqlClient,
  orgId: string,
  appName: string,
): Promise<Record<string, unknown>> {
  const rows = extractRows<{ v: unknown }>(
    await tx.execute(
      drizzleSql`SELECT settings->${appName} AS v FROM ${orgsTable()} WHERE id = ${orgId}`,
    ),
  )
  return parseNamespace(rows[0]?.v)
}

/** `users.settings.<app>` as stored. Unlike getUserAppSettings, never writes defaults. */
export async function readUserAppNamespace(
  tx: SqlClient,
  userId: string,
  appName: string,
): Promise<Record<string, unknown>> {
  const rows = extractRows<{ v: unknown }>(
    await tx.execute(
      drizzleSql`SELECT settings->${appName} AS v FROM ${usersTable()} WHERE id = ${userId}`,
    ),
  )
  return parseNamespace(rows[0]?.v)
}

async function setNamespacePath(
  tx: SqlClient,
  table: ReturnType<typeof drizzleSql.raw>,
  id: string,
  appName: string,
  path: string[],
  value: unknown,
): Promise<Record<string, unknown>> {
  const rows = extractRows<{ v: unknown }>(
    await tx.execute(
      drizzleSql`SELECT settings->${appName} AS v FROM ${table} WHERE id = ${id} FOR UPDATE`,
    ),
  )
  if (rows.length === 0) throw new Error(`settings write: no row ${id}`)
  const next = withSettingAtPath(parseNamespace(rows[0]?.v), path, value)
  await tx.execute(drizzleSql`
    UPDATE ${table}
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), ${`{${appName}}`}, ${JSON.stringify(next)}::jsonb, true)
    WHERE id = ${id}
  `)
  return next
}

/** Set one dot path of `organizations.settings.<app>`, keeping its siblings. Returns the namespace. */
export function setOrgAppSettingPath(
  tx: SqlClient,
  orgId: string,
  appName: string,
  path: string[],
  value: unknown,
): Promise<Record<string, unknown>> {
  return setNamespacePath(tx, orgsTable(), orgId, appName, path, value)
}

/** Set one dot path of `users.settings.<app>`, keeping its siblings. Returns the namespace. */
export function setUserAppSettingPath(
  tx: SqlClient,
  userId: string,
  appName: string,
  path: string[],
  value: unknown,
): Promise<Record<string, unknown>> {
  return setNamespacePath(tx, usersTable(), userId, appName, path, value)
}
