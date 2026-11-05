// SPDX-License-Identifier: FSL-1.1-ALv2
import { execFile, execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { desc } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { getMeili } from "~/infra/search/client"
import { getObjectBuffer, listOrgPrefixIter } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "cli-export-full" })
const execFileAsync = promisify(execFile)

/** A storage object plus its bytes — yielded across every org. */
export interface StorageObject {
  key: string
  buffer: Buffer
}

/**
 * The slice of the MeiliSearch client `export-full` needs. Injectable so the
 * three test dispositions (healthy / per-index / service-absent) are
 * deterministic without a live Meili server.
 */
export interface MeiliExportClient {
  isHealthy: () => Promise<boolean>
  listIndexUids: () => Promise<string[]>
  getIndexDocuments: (uid: string) => Promise<unknown[]>
}

export interface ExportFullArgs {
  output: string
  /**
   * Resolves the `pg_dump` binary path, or `null` when it is absent. Injectable
   * so the "pg_dump absent" disposition is a tested behavior, not an
   * environment artifact.
   */
  pgDumpResolver?: () => string | null
  /** Iterates every storage object across every org. Injectable for tests. */
  storageObjectsIter?: () => AsyncGenerator<StorageObject>
  meili?: MeiliExportClient
  /**
   * Connection string for the dump. A full-instance backup is a privileged
   * operation — it must connect as a superuser/migration role (the app role
   * cannot lock the `drizzle` migration schema), mirroring `db/migrate.ts`.
   */
  dbUrl?: string
}

/**
 * Privileged connection string for the dump. Mirrors `db/migrate.ts`: the app
 * role (`DATABASE_URL`) lacks the lock privilege on the `drizzle` schema, so a
 * full dump must use the migration/superuser role.
 *
 * MIGRATION_DATABASE_URL must be set explicitly — this function never
 * fabricates hardcoded credentials. Failing loudly here is intentional: a
 * silent fallback to wrong credentials would dump the wrong schema or succeed
 * with no data, which is worse than an upfront error.
 */
function resolveDumpDbUrl(): string {
  const explicit = process.env.MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL_TEST
  if (explicit) return explicit
  throw new Error(
    "MIGRATION_DATABASE_URL is not set. " +
      "A full export requires a superuser/migration connection string that has " +
      "lock privileges on the drizzle schema. " +
      "Set MIGRATION_DATABASE_URL to the privileged connection string and retry.",
  )
}

export interface ExportFullResult {
  exitCode: number
  message?: string
}

/**
 * The header the artifact carries about sealed personal mail (Task 14.1).
 *
 * The dump is a byte-faithful copy of the cluster, so for an enrolled personal
 * mailbox it holds envelope metadata and ciphertext and nothing else: the
 * plaintext columns are NULL and the exporter holds no key that could open the
 * ciphertext. Saying so in the artifact matters legally as much as technically.
 * A GDPR Article 15 or 20 request for the CONTENT of a sealed mailbox is served
 * by the data subject exporting from their own unlocked browser (spec 4.5, 8.3),
 * because that is the only place the keys exist. The DPA has to say this too.
 */
/**
 * Tables whose DATA never leaves in an export artifact.
 *
 * `kernel.user_key_wraps` holds `wrapped_account_key` next to `kdf_params` and
 * `verifier`. Migration 0033 states the requirement in the column's own
 * comment: it is an OFFLINE CRACKING ORACLE at passphrase KDF speed and must never
 * reach an admin tool, an export, a database connector, a log line or the
 * `liaison_readonly` role. For a user whose only wrap is a passphrase wrap, an
 * artifact carrying it plus the KDF parameters is everything an attacker needs
 * to grind at their leisure, which would make this file's own "not decryptable
 * by anyone holding this artifact" claim false.
 *
 * `kernel.user_mailbox_identities` is excluded for the same reason and by the
 * same mechanism, since migration 0041 gave it the wrapped identity private
 * halves (`wrapped_ecdh_private`, `wrapped_sign_private` and their IVs). Those
 * are ciphertext under an Account Key this artifact does not carry, so they are
 * a smaller edge than a wrap, but a keyring and its wrap are exactly the pair an
 * attacker wants together and nothing is lost by keeping both out: an enrolled
 * user restored from this artifact re-enrols either way.
 *
 * The DDL is kept (`--exclude-table-data`, not `--exclude-table`) so a restore
 * from this artifact produces a schema-complete cluster where every enrolled
 * user simply re-enrols. Losing a wrap is recoverable; leaking one is not.
 */
export const EXPORT_EXCLUDED_TABLES = [
  "kernel.user_key_wraps",
  "kernel.user_mailbox_identities",
] as const

/**
 * The same list, resolved against the running schema namespace.
 *
 * Production has no `SCHEMA_PREFIX`, so this is byte-identical to the constant
 * above there. Under an isolated test schema (`w1_kernel`) the literal names
 * match nothing, and the exclusion would silently not apply: the dump would
 * carry the very wraps this list exists to keep out, and the test that checks
 * for them would report a product hole that does not exist.
 */
export function exportExcludedTables(): string[] {
  return EXPORT_EXCLUDED_TABLES.map((table) => {
    const [schema, ...rest] = table.split(".")
    return `${schemaRef(schema as string)}.${rest.join(".")}`
  })
}

export const PERSONAL_MAIL_ENCRYPTION_NOTE = {
  summary:
    "Personal mailboxes enrolled in zero-access encryption are exported sealed. " +
    "Their message content is not decryptable by the exporter, by this server, " +
    "or by anyone holding this artifact: the keys exist only in the account " +
    "holder's browser.",
  plaintextColumns: [] as string[],
  ciphertextColumns: [
    "subject_ciphertext",
    "text_body_ciphertext",
    "html_body_ciphertext",
    "snippet_ciphertext",
    "raw_headers_ciphertext",
  ],
  attachments:
    "Attachment objects for enrolled mailboxes are STREAM ciphertext in object storage. " +
    "Filename and MIME type stay cleartext; the bytes do not.",
  subjectAccessRequests:
    "A data subject access or portability request covering the CONTENT of an enrolled " +
    "personal mailbox is fulfilled by the data subject from their own unlocked browser. " +
    "No server-side export can produce that plaintext.",
  keyMaterial:
    "kernel.user_key_wraps and kernel.user_mailbox_identities are excluded from this " +
    "artifact by data (their DDL is present, their rows are not). The first holds each " +
    "enrolled user's wrapped Account Key with its KDF parameters and verifier, which " +
    "together are an offline cracking oracle against a passphrase wrap. The second holds " +
    "the identity keyring, including the private halves wrapped under that Account Key. " +
    "Restoring from this artifact therefore restores a schema-complete cluster in which " +
    "every enrolled user re-enrols.",
} as const

function defaultPgDumpResolver(): string | null {
  try {
    const p = execFileSync("which", ["pg_dump"], { encoding: "utf8" }).trim()
    return p.length > 0 ? p : null
  } catch {
    return null
  }
}

async function* defaultStorageObjectsIter(): AsyncGenerator<StorageObject> {
  const orgs = await withSystemDb("cli-export-list-orgs", (db) =>
    db.select({ id: organizations.id }).from(organizations).orderBy(desc(organizations.id)),
  )
  for (const { id } of orgs) {
    for await (const obj of listOrgPrefixIter({ orgId: id })) {
      const buffer = await getObjectBuffer(obj.Key)
      yield { key: obj.Key, buffer }
    }
  }
}

function defaultMeiliClient(): MeiliExportClient {
  return {
    isHealthy: async () => {
      try {
        return await getMeili().isHealthy()
      } catch {
        return false
      }
    },
    listIndexUids: async () => {
      const res = await getMeili().getIndexes({ limit: 1000 })
      return res.results.map((i) => i.uid)
    },
    getIndexDocuments: async (uid) => {
      const res = await getMeili().index(uid).getDocuments({ limit: 100_000 })
      return res.results
    },
  }
}

/**
 * Full-instance export (Phase 13, E6). Writes a tar.gz to a temp path and
 * atomic-renames it onto `--output` on success — an interrupted run leaves NO
 * partial file at `--output`.
 *
 * Disposition split (Validation step 5): `pg_dump` absent is an ASSERTED hard
 * non-zero with no file; the MeiliSearch *service* being absent is
 * environment-blocked — the other artifact classes are still produced and
 * `manifest.json` records the gap with the exact missing dependency.
 */
export async function exportFull(args: ExportFullArgs): Promise<ExportFullResult> {
  const pgDumpResolver = args.pgDumpResolver ?? defaultPgDumpResolver
  const storageIter = args.storageObjectsIter ?? defaultStorageObjectsIter
  const meili = args.meili ?? defaultMeiliClient()

  // Step 1 (pre-flight): pg_dump MUST resolve before any partial work.
  const pgDumpPath = pgDumpResolver()
  if (!pgDumpPath) {
    const message = "pg_dump not found — install PostgreSQL client tools (pg_dump)"
    log.error({}, message)
    return { exitCode: 1, message }
  }

  const stageDir = mkdtempSync(join(tmpdir(), "liaison-export-stage-"))
  // The tarball is the whole instance: it is built in its own 0700 temp dir
  // (beside the stage dir, so tar does not read it back) and is 0600 before it
  // reaches --output, whatever the process umask.
  const tarDir = mkdtempSync(join(tmpdir(), "liaison-export-tar-"))
  const tmpTarball = join(tarDir, "liaison-export.tar.gz")
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    schemas: "kernel + app_* (all)",
    files: {} as Record<string, string>,
    meilisearch: {} as Record<string, unknown>,
    personalMailEncryption: PERSONAL_MAIL_ENCRYPTION_NOTE,
  }
  const files = manifest.files as Record<string, string>

  try {
    // 1. PostgreSQL dump of ALL schemas.
    const pgDumpFile = join(stageDir, "pg-dump.sql")
    await execFileAsync(pgDumpPath, [
      "--dbname",
      args.dbUrl ?? resolveDumpDbUrl(),
      "--no-owner",
      "--no-privileges",
      ...exportExcludedTables().flatMap((table) => ["--exclude-table-data", table]),
      "--file",
      pgDumpFile,
    ])
    files.postgres = "pg-dump.sql"

    // 2. Object-storage enumeration + download (abort on failure → no tarball).
    let storageCount = 0
    for await (const obj of storageIter()) {
      const safe = obj.key.replace(/[^a-zA-Z0-9._/-]/g, "_")
      const dest = join(stageDir, "storage", safe)
      execFileSync("mkdir", ["-p", dirname(dest)])
      writeFileSync(dest, obj.buffer)
      storageCount += 1
    }
    files.storageObjects = String(storageCount)

    // 3. MeiliSearch snapshot. The pinned client has no retrievable native
    //    dump (createSnapshot/createDump write server-side), so we degrade to a
    //    per-index document export. Service absent → environment-blocked: other
    //    artifacts still produced + manifest notes the exact gap.
    const meiliInfo = manifest.meilisearch as Record<string, unknown>
    let meiliHealthy = false
    try {
      meiliHealthy = await meili.isHealthy()
    } catch {
      meiliHealthy = false
    }
    if (!meiliHealthy) {
      meiliInfo.skipped = true
      meiliInfo.reason =
        "MeiliSearch service unreachable (environment-blocked) — missing dependency: meilisearch host"
    } else {
      try {
        const uids = await meili.listIndexUids()
        for (const uid of uids) {
          const docs = await meili.getIndexDocuments(uid)
          writeFileSync(join(stageDir, `meili-${uid}.json`), JSON.stringify(docs, null, 2))
        }
        meiliInfo.skipped = false
        meiliInfo.mode = "per-index-export"
        meiliInfo.indexes = uids
      } catch (err) {
        meiliInfo.skipped = true
        meiliInfo.reason = `MeiliSearch export failed (environment-blocked): ${
          err instanceof Error ? err.message : String(err)
        }`
      }
    }

    // 4. manifest.json
    writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2))

    // 5. tar.gz the staging dir to a temp path, atomic-rename to --output.
    execFileSync("tar", ["czf", tmpTarball, "-C", stageDir, "."])
    chmodSync(tmpTarball, 0o600)
    moveOwnerOnly(tmpTarball, args.output)
    return { exitCode: 0 }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, "export-full failed")
    // Atomic-rename guarantee: --output is only ever written by the final
    // renameSync, so a failure before that point leaves it untouched. Clean
    // up the temp tarball only.
    if (existsSync(tmpTarball)) rmSync(tmpTarball, { force: true })
    return { exitCode: 1, message }
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
    rmSync(tarDir, { recursive: true, force: true })
  }
}

/**
 * Move the finished 0600 tarball onto `dest`. Across filesystems (the temp dir
 * on another volume) the bytes are copied to a 0600 file beside `dest`, then
 * renamed, so `dest` is never partial and never readable by others.
 */
function moveOwnerOnly(src: string, dest: string): void {
  try {
    renameSync(src, dest)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
  }
  const partial = `${dest}.partial-${process.pid}`
  try {
    copyFileSync(src, partial)
    chmodSync(partial, 0o600)
    renameSync(partial, dest)
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
}

const USAGE = "usage: bun src/cli/export-full.ts --output <path> [--db-url <postgres url>]"

/**
 * Argv parsing for the direct entrypoint. Pure, so the "no --output" case is a
 * unit assertion and not only a process smoke.
 *
 * The option is `--output`, never `--out`: `ExportFullArgs.output` is the field
 * name, and the earlier draft of the validation protocol used `--out`, which
 * this entrypoint would silently ignore. It is rejected explicitly rather than
 * aliased, because a validation command that quietly exports somewhere other
 * than where the next step greps is the exact failure this task exists to
 * remove. There is no `--org`: the export is whole-instance by construction.
 */
export function parseExportFullArgv(argv: string[]): {
  ok: boolean
  output?: string
  dbUrl?: string
  error?: string
} {
  let output: string | undefined
  let dbUrl: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--output" || flag === "--db-url") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `${flag} requires a value\n${USAGE}` }
      }
      if (flag === "--output") output = value
      else dbUrl = value
      i++
      continue
    }
    if (flag === "--out") {
      return {
        ok: false,
        error: `unknown option --out: the option is --output\n${USAGE}`,
      }
    }
    return { ok: false, error: `unknown option ${flag}\n${USAGE}` }
  }
  if (!output) return { ok: false, error: `--output <path> is required\n${USAGE}` }
  return { ok: true, output, dbUrl }
}

/** Direct entrypoint, spec section 13 V9c. `liaison export --full` also reaches `exportFull`. */
if (import.meta.main) {
  const parsed = parseExportFullArgv(process.argv.slice(2))
  if (!parsed.ok || !parsed.output) {
    process.stderr.write(`${parsed.error}\n`)
    process.exit(2)
  }
  const output = parsed.output
  exportFull({ output, dbUrl: parsed.dbUrl })
    .then((res) => {
      if (res.exitCode === 0) process.stdout.write(`Wrote ${output}\n`)
      else process.stderr.write(`${res.message ?? "export failed"}\n`)
      process.exit(res.exitCode)
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
      process.exit(1)
    })
}
