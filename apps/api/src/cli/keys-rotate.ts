// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison keys rotate --family encryption|byok --from-env <VAR> --to-env <VAR> [--execute]`
//
// Re-encrypts every stored secret from one key to another, so ENCRYPTION_KEY or
// BYOK_ENCRYPTION_KEY can be rotated without losing what they protect. Without
// it, changing the key makes every connected account's tokens, every TOTP
// secret, every OAuth client secret and every BYOK provider key undecryptable:
// the server reads them with the new key and fails.
//
// NOT A CRYPTO CHANGE. The algorithm, the format and the per-field context (AAD)
// are exactly `encryptSecret`'s (lib/crypto.ts): each value is decrypted with
// the old key under its own context and encrypted again with the new key under
// the same context.
//
// WHERE THE CIPHERTEXTS ARE. Two kinds of place, both listed below and pinned
// by keys-rotate.test.ts against `CryptoContext`, so a new encrypted field
// fails that test until this tool knows where it lives:
//   * dedicated columns, one context each (`COLUMNS`);
//   * JSON documents holding encrypted values at app-defined paths (org
//     settings, app config). Those are walked, and a string shaped like an
//     `encryptSecret` output is re-keyed when the old key opens it under one of
//     the family's contexts. Anything else in the document is left as it is.
//
// SAFE TO RE-RUN. A value the NEW key already opens counts as `current` and is
// left alone, so a run interrupted half way is finished by running it again.
// The whole run is one transaction: it commits everything or nothing.
//
// Run it with the app STOPPED (the runbook, docs/runbooks/key-rotation.md): a
// server still running on the old key would write new values with it between
// this run and the restart. A dry run (the default) reports what it would do
// and changes nothing.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, decryptSecret, encryptSecret, mailboxServerKeyContext } from "~/lib/crypto"

export const KEYS_ROTATE_USAGE =
  "usage: liaison keys rotate --family encryption|byok --from-env <VAR> --to-env <VAR> [--execute] [--skip-undecryptable]"

export type KeyFamily = "encryption" | "byok"

/** A column holding one `encryptSecret` value per row, under one context. */
export interface EncryptedColumn {
  schema: string
  table: string
  column: string
  context: string
  family: KeyFamily
  /**
   * For a column whose AAD is bound to its row (the value of `context` is then
   * the prefix): the extra columns to read and the full context they build.
   */
  rowContext?: { columns: string[]; build: (row: Record<string, string>) => string }
}

/** A JSON column whose documents may hold `encryptSecret` values anywhere. */
export interface EncryptedJsonColumn {
  schema: string
  table: string
  column: string
  /** The column naming the org a row belongs to (`id` for the org row itself). */
  orgColumn: string
  /**
   * Which key a value at this path is under. Only the run's family is touched:
   * a value of the other family is under a key this run does not hold, and is
   * neither re-keyed nor counted.
   */
  familyAt: (path: readonly string[]) => KeyFamily
}

const ENCRYPTION_ONLY = (): KeyFamily => "encryption"

export const COLUMNS: EncryptedColumn[] = [
  {
    schema: "kernel",
    table: "connected_accounts",
    column: "access_token_encrypted",
    context: CryptoContext.connectedAccountAccessToken,
    family: "encryption",
  },
  {
    schema: "kernel",
    table: "connected_accounts",
    column: "refresh_token_encrypted",
    context: CryptoContext.connectedAccountRefreshToken,
    family: "encryption",
  },
  {
    schema: "kernel",
    table: "connected_accounts",
    column: "credentials_encrypted",
    context: CryptoContext.connectedAccountCredentials,
    family: "encryption",
  },
  {
    schema: "kernel",
    table: "oauth_providers",
    column: "client_secret_encrypted",
    context: CryptoContext.oauthProviderClientSecret,
    family: "encryption",
  },
  {
    schema: "kernel",
    table: "users",
    column: "totp_secret",
    context: CryptoContext.totpSecret,
    family: "encryption",
  },
  {
    schema: "app_mcp_manager",
    table: "mcp_connections",
    column: "secrets_encrypted",
    context: CryptoContext.mcpConnectionSecrets,
    family: "encryption",
  },
  {
    // Server-managed mailbox data keys. Only the wrap is re-keyed: the mail
    // rows they seal are untouched.
    schema: "kernel",
    table: "mailbox_server_keys",
    column: "wrapped_key",
    context: CryptoContext.mailboxServerKey,
    family: "encryption",
    rowContext: {
      columns: ["org_id", "account_id", "key_version"],
      build: (row) =>
        mailboxServerKeyContext(row.org_id ?? "", row.account_id ?? "", Number(row.key_version)),
    },
  },
]

export const JSON_COLUMNS: EncryptedJsonColumn[] = [
  {
    schema: "kernel",
    table: "organizations",
    column: "settings",
    orgColumn: "id",
    // BYOK provider keys, built-in providers and custom servers alike, live
    // under `providerKeys` (settings/ai-keys-routes.ts, ai-models-routes.ts,
    // cli/provisioners/byok.ts); every other secret in settings is ENCRYPTION_KEY's.
    familyAt: (path) => (path[0] === "providerKeys" ? "byok" : "encryption"),
  },
  {
    // Per-person app settings: the same encrypted schema paths as the org's
    // (lib/settings.ts, setUserAppSettings), under orgSettingsSecret.
    schema: "kernel",
    table: "users",
    column: "settings",
    orgColumn: "org_id",
    familyAt: ENCRYPTION_ONLY,
  },
  {
    schema: "kernel",
    table: "apps",
    column: "config",
    orgColumn: "org_id",
    familyAt: ENCRYPTION_ONLY,
  },
  {
    schema: "kernel",
    table: "connected_accounts",
    column: "metadata",
    orgColumn: "org_id",
    familyAt: ENCRYPTION_ONLY,
  },
  {
    schema: "app_mcp_manager",
    table: "mcp_connections",
    column: "oauth_metadata",
    orgColumn: "org_id",
    familyAt: ENCRYPTION_ONLY,
  },
]

/** The contexts a JSON document's values may be under, per key family. */
export const JSON_CONTEXTS: Record<KeyFamily, string[]> = {
  encryption: [
    CryptoContext.orgSettingsSecret,
    CryptoContext.googleClientSecret,
    CryptoContext.appConfigConnectionSecret,
  ],
  byok: [CryptoContext.byokApiKey],
}

/**
 * Contexts that are never at rest in the database, with where they are instead.
 * Listed so the coverage test can tell "handled elsewhere" from "forgotten".
 */
export const NOT_AT_REST: Record<string, string> = {
  [CryptoContext.totpSetupSecret]:
    "Redis, for a TOTP setup in progress; it expires in minutes, and a setup cut by the rotation is started again",
}

/** `encryptSecret`'s output: base64 12-byte IV, base64 16-byte tag, base64 ciphertext. */
const CIPHERTEXT_SHAPE = /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]*={0,2}$/

export function looksEncrypted(value: string): boolean {
  return CIPHERTEXT_SHAPE.test(value)
}

type Rekey =
  | { status: "rekeyed"; value: string }
  | { status: "current" }
  | { status: "undecryptable" }

function tryDecrypt(value: string, key: string, context: string): string | null {
  try {
    return decryptSecret(value, key, context)
  } catch {
    return null
  }
}

/** Re-key one value: old key → new key under the first context that opens it. */
export function rekeyValue(
  value: string,
  contexts: string[],
  fromKey: string,
  toKey: string,
): Rekey {
  for (const context of contexts) {
    const plain = tryDecrypt(value, fromKey, context)
    if (plain !== null) return { status: "rekeyed", value: encryptSecret(plain, toKey, context) }
  }
  for (const context of contexts) {
    if (tryDecrypt(value, toKey, context) !== null) return { status: "current" }
  }
  return { status: "undecryptable" }
}

export interface TargetReport {
  target: string
  rekeyed: number
  current: number
  undecryptable: number
}

export interface RotateReport {
  family: KeyFamily
  executed: boolean
  targets: TargetReport[]
  undecryptable: number
}

export interface RotateOptions {
  family: KeyFamily
  fromKey: string
  toKey: string
  execute: boolean
  /** Rotate anyway when some values open with neither key (they stay as they are). */
  skipUndecryptable?: boolean
  /** Test seam: only rows of these orgs. A real rotation is always whole-instance. */
  onlyOrgIds?: string[]
}

export class KeysRotateRefused extends Error {}

const HEX_KEY = /^[0-9a-f]{64}$/i

interface JsonWalk {
  family: KeyFamily
  familyAt: (path: readonly string[]) => KeyFamily
  contexts: string[]
  fromKey: string
  toKey: string
  tally: TargetReport
}

/** Walk a JSON value, re-keying every encrypted-looking string of the run's family. */
function rekeyJson(node: unknown, path: string[], w: JsonWalk): unknown {
  if (typeof node === "string") {
    if (!looksEncrypted(node) || w.familyAt(path) !== w.family) return node
    const r = rekeyValue(node, w.contexts, w.fromKey, w.toKey)
    w.tally[r.status] += 1
    return r.status === "rekeyed" ? r.value : node
  }
  if (Array.isArray(node)) return node.map((n, i) => rekeyJson(n, [...path, String(i)], w))
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = rekeyJson(v, [...path, k], w)
    return out
  }
  return node
}

async function tableExists(tx: PrivilegedDb, schema: string, table: string): Promise<boolean> {
  const rows = extractRows<{ ok: boolean }>(
    await tx.execute(
      drizzleSql`SELECT to_regclass(${`"${schemaRef(schema)}"."${table}"`}) IS NOT NULL AS ok`,
    ),
  )
  return rows[0]?.ok === true
}

function orgFilter(orgColumn: string, onlyOrgIds: string[] | undefined) {
  if (!onlyOrgIds) return drizzleSql``
  if (onlyOrgIds.length === 0) return drizzleSql` AND false`
  return drizzleSql` AND ${drizzleSql.raw(`"${orgColumn}"`)}::text IN (${drizzleSql.join(
    onlyOrgIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )})`
}

class DryRunRollback extends Error {}

/** Re-encrypt every stored secret of a key family from `fromKey` to `toKey`. */
export async function rotateEncryptionKey(opts: RotateOptions): Promise<RotateReport> {
  if (!HEX_KEY.test(opts.fromKey) || !HEX_KEY.test(opts.toKey)) {
    throw new KeysRotateRefused("both keys must be 64 hex characters (32 bytes)")
  }
  if (opts.fromKey.toLowerCase() === opts.toKey.toLowerCase()) {
    throw new KeysRotateRefused("the new key is the old key")
  }
  const report: RotateReport = {
    family: opts.family,
    executed: false,
    targets: [],
    undecryptable: 0,
  }

  try {
    await withSystemDb("keys-rotate", async (tx) => {
      for (const col of COLUMNS.filter((c) => c.family === opts.family)) {
        const tally: TargetReport = {
          target: `${col.schema}.${col.table}.${col.column}`,
          rekeyed: 0,
          current: 0,
          undecryptable: 0,
        }
        report.targets.push(tally)
        if (!(await tableExists(tx, col.schema, col.table))) continue
        const rel = drizzleSql.raw(`"${schemaRef(col.schema)}"."${col.table}"`)
        const c = drizzleSql.raw(`"${col.column}"`)
        const extra = (col.rowContext?.columns ?? []).map(
          (name) =>
            drizzleSql`, ${drizzleSql.raw(`"${name}"`)}::text AS ${drizzleSql.raw(`"${name}"`)}`,
        )
        const rows = extractRows<{ id: string; v: string } & Record<string, string>>(
          await tx.execute(
            drizzleSql`SELECT id::text AS id, ${c} AS v${drizzleSql.join(extra, drizzleSql``)} FROM ${rel}
              WHERE ${c} IS NOT NULL AND ${c} <> ''${orgFilter("org_id", opts.onlyOrgIds)}
              FOR UPDATE`,
          ),
        )
        for (const row of rows) {
          const context = col.rowContext ? col.rowContext.build(row) : col.context
          const r = rekeyValue(row.v, [context], opts.fromKey, opts.toKey)
          tally[r.status] += 1
          if (r.status === "rekeyed" && opts.execute) {
            await tx.execute(
              drizzleSql`UPDATE ${rel} SET ${c} = ${r.value} WHERE id = ${row.id}::uuid`,
            )
          }
        }
      }

      const contexts = JSON_CONTEXTS[opts.family]
      for (const col of JSON_COLUMNS) {
        const tally: TargetReport = {
          target: `${col.schema}.${col.table}.${col.column}`,
          rekeyed: 0,
          current: 0,
          undecryptable: 0,
        }
        report.targets.push(tally)
        if (!(await tableExists(tx, col.schema, col.table))) continue
        const rel = drizzleSql.raw(`"${schemaRef(col.schema)}"."${col.table}"`)
        const c = drizzleSql.raw(`"${col.column}"`)
        const rows = extractRows<{ id: string; v: unknown }>(
          await tx.execute(
            drizzleSql`SELECT id::text AS id, ${c} AS v FROM ${rel}
              WHERE ${c} IS NOT NULL${orgFilter(col.orgColumn, opts.onlyOrgIds)}
              FOR UPDATE`,
          ),
        )
        for (const row of rows) {
          const doc = typeof row.v === "string" ? (JSON.parse(row.v) as unknown) : row.v
          const before = tally.rekeyed
          const next = rekeyJson(doc, [], {
            family: opts.family,
            familyAt: col.familyAt,
            contexts,
            fromKey: opts.fromKey,
            toKey: opts.toKey,
            tally,
          })
          if (tally.rekeyed > before && opts.execute) {
            await tx.execute(
              drizzleSql`UPDATE ${rel} SET ${c} = ${JSON.stringify(next)}::jsonb WHERE id = ${row.id}::uuid`,
            )
          }
        }
      }

      report.undecryptable = report.targets.reduce((n, t) => n + t.undecryptable, 0)
      if (opts.execute && report.undecryptable > 0 && !opts.skipUndecryptable) {
        throw new KeysRotateRefused(
          `${report.undecryptable} stored value(s) open with neither key; nothing was changed. ` +
            "Check the old key, or pass --skip-undecryptable to rotate the rest and leave those as they are.",
        )
      }
      if (!opts.execute) throw new DryRunRollback()
    })
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err
    return report
  }
  report.executed = true
  return report
}

interface ParsedArgs {
  family: KeyFamily
  fromEnv: string
  toEnv: string
  execute: boolean
  skipUndecryptable: boolean
}

export function parseKeysRotateArgs(argv: string[]): ParsedArgs | string {
  let family: string | undefined
  let fromEnv: string | undefined
  let toEnv: string | undefined
  let execute = false
  let skipUndecryptable = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--family") family = argv[++i]
    else if (a === "--from-env") fromEnv = argv[++i]
    else if (a === "--to-env") toEnv = argv[++i]
    else if (a === "--execute") execute = true
    else if (a === "--skip-undecryptable") skipUndecryptable = true
    else return `unknown argument ${a}`
  }
  if (family !== "encryption" && family !== "byok") return "--family must be encryption or byok"
  if (!fromEnv || !toEnv)
    return "--from-env and --to-env name the environment variables holding the keys"
  return { family, fromEnv, toEnv, execute, skipUndecryptable }
}

/** CLI entry. Keys come from named environment variables, never the command line. */
export async function runKeysRotateCli(
  argv: string[],
  envSource: Record<string, string | undefined> = process.env,
): Promise<{ exitCode: number; report?: RotateReport; message?: string }> {
  const parsed = parseKeysRotateArgs(argv)
  if (typeof parsed === "string") return { exitCode: 2, message: `${parsed}\n${KEYS_ROTATE_USAGE}` }
  const fromKey = envSource[parsed.fromEnv] ?? ""
  const toKey = envSource[parsed.toEnv] ?? ""
  try {
    const report = await rotateEncryptionKey({
      family: parsed.family,
      fromKey,
      toKey,
      execute: parsed.execute,
      skipUndecryptable: parsed.skipUndecryptable,
    })
    const message = report.executed
      ? `Re-encrypted under the new key. Set ${parsed.family === "byok" ? "BYOK_ENCRYPTION_KEY" : "ENCRYPTION_KEY"} to it before starting the app.`
      : report.undecryptable > 0
        ? `Dry run: ${report.undecryptable} value(s) open with neither key; --execute will refuse until that is resolved.`
        : "Dry run: nothing changed. Run again with --execute."
    return { exitCode: 0, report, message }
  } catch (err) {
    if (err instanceof KeysRotateRefused) return { exitCode: 1, message: err.message }
    throw err
  }
}
