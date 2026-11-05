// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 13 — S-6 + S-7: real `liaison` CLI process end-to-end smokes.
//
// These spawn the ACTUAL CLI entrypoint (`bun run src/cli/index.ts ...`) as a
// child process against the `liaison_test` DB — not the injected-resolver unit
// branches (those are export-full.test.ts / erase-user.test.ts). They exercise
// real process.argv parsing, the atomic-rename guarantee, real pg_dump on
// PATH, the real MeiliSearch service if present, and the real erase cascade.
//
// Spec: E6 + Validation step 5 (export --full, env-aware disposition);
// G2–G6 + Validation step 6 (erase-user cascade, idempotent, unknown-id).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { detectDrift } from "~/modules/search/drift"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The CLI is `apps/api`-relative; this test file lives at apps/api/src/cli/.
const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..")
const TEST_DB_URL =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"

// `export --full` requires a DDL-privileged connection (the `liaison_app` role
// lacks the lock privilege on the `drizzle` schema). Mirror export-full.test.ts:
// honor an explicit MIGRATION_DATABASE_URL(_TEST), else derive a local superuser
// URL from DATABASE_URL so the spawned CLI can run the real dump.
function resolveMigrationDbUrl(): string | undefined {
  const explicit = process.env.MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL_TEST
  if (explicit) return explicit
  try {
    const u = new URL(TEST_DB_URL)
    u.username = "postgres"
    u.password = "postgres"
    return u.toString()
  } catch {
    return undefined
  }
}
const MIGRATION_DB_URL = resolveMigrationDbUrl()

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Run the real CLI as a child process against liaison_test. A plain `bun run`
 * does NOT auto-load `.env.test`, so DATABASE_URL is injected explicitly so
 * the child targets the same DB this test seeded. NODE_ENV is pinned to
 * "test" for the same determinism reason: `bun test` runs the whole suite in
 * one process and an earlier test file may have mutated the shared
 * process.env NODE_ENV — without this pin the child could inherit
 * NODE_ENV=production and trip the production config guard before doing any
 * work.
 */
function runCli(args: string[]): CliResult {
  const r = spawnSync("bun", ["run", "src/cli/index.ts", ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      NODE_ENV: "test",
      ...(MIGRATION_DB_URL ? { MIGRATION_DATABASE_URL_TEST: MIGRATION_DB_URL } : {}),
    },
  })
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

function tarList(file: string): string[] {
  return execFileSync("tar", ["tzf", file], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

function extractManifest(tarball: string, workDir: string): Record<string, unknown> {
  execFileSync("tar", ["xzf", tarball, "-C", workDir, "./manifest.json"], {
    encoding: "utf8",
  })
  return JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"))
}

let orgId: string
let workDir: string
const tarballs: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  // Ensure the canonical MeiliSearch index exists so `export --full` (S-6) has a
  // healthy index to enumerate. A fresh MeiliSearch (no dev seeding) has zero
  // indices, in which case the export is healthy-but-empty and emits no `meili-*`
  // artifact — the test's "MeiliSearch present ⇒ meili entry in tarball" branch
  // assumes at least the canonical index exists, as it does in any seeded env.
  try {
    await detectDrift({ registeredReadScopes: [], dimensionFields: [] })
  } catch {
    // MeiliSearch genuinely unreachable → S-6 takes its service-absent branch.
  }
})

afterAll(releaseTestLock)

afterEach(() => {
  for (const t of tarballs.splice(0)) {
    try {
      if (existsSync(t)) unlinkSync(t)
    } catch {
      /* best effort */
    }
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true })
    workDir = ""
  }
})

function freshTarball(name = "phase13-backup.tar.gz"): string {
  workDir = mkdtempSync(join(tmpdir(), "liaison-phase13-"))
  const out = join(workDir, name)
  tarballs.push(out)
  return out
}

describe("liaison export --full (real CLI, env-aware)", () => {
  test("produces a complete tarball OR fails loud with the exact missing dependency; no partial file; independent re-run", () => {
    const pgDumpPresent = (() => {
      const r = spawnSync("which", ["pg_dump"], { encoding: "utf8" })
      return r.status === 0 && (r.stdout ?? "").trim().length > 0
    })()

    const out = freshTarball()
    const res = runCli(["export", "--full", "--output", out])

    if (!pgDumpPresent) {
      // pg_dump absent → ASSERTED hard non-zero, exact message, NO file
      // (atomic-temp-path guarantee). Reported disposition, not a skip.
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain("pg_dump not found")
      expect(existsSync(out)).toBe(false)
      // eslint-disable-next-line no-console
      console.log(
        "[S-6] pg_dump environment-blocked — asserted non-zero + no partial file (exact missing dependency reported)",
      )
      return
    }

    // pg_dump present → exit 0, real four-artifact-class tarball.
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    expect(res.stdout).toContain(`Wrote ${out}`)
    expect(existsSync(out)).toBe(true)
    const entries = tarList(out)
    expect(
      entries.some((e) => e.endsWith(".sql") || e.includes("pg-dump")),
      `entries: ${entries.join(",")}`,
    ).toBe(true)
    expect(entries.some((e) => e.endsWith("manifest.json"))).toBe(true)

    const manifest = extractManifest(out, workDir)
    const meili = (manifest.meilisearch ?? {}) as Record<string, unknown>
    if (meili.skipped === true) {
      // MeiliSearch service absent → degraded per spec step 5 (NOT a failure):
      // PG dump + manifest still present, manifest records the exact gap.
      expect(typeof meili.reason).toBe("string")
      expect(String(meili.reason)).toMatch(/meilisearch/i)
      // eslint-disable-next-line no-console
      console.log(
        `[S-6] MeiliSearch environment-blocked — degraded per spec step 5 (reason: ${String(meili.reason)})`,
      )
    } else {
      // MeiliSearch present → per-index export artifacts in the tarball.
      expect(entries.some((e) => e.includes("meili"))).toBe(true)
      expect(meili.mode).toBe("per-index-export")
      // eslint-disable-next-line no-console
      console.log("[S-6] pg_dump + MeiliSearch present — full four-artifact tarball produced")
    }
    // Manifest enumerates schema versions / file mappings (non-empty object).
    expect(typeof manifest).toBe("object")

    // Independent re-run to a SECOND output path — succeeds on its own, no
    // leftover temp file from run 1 (atomic rename leaves only the final
    // artifact at each --output).
    const out2 = join(workDir, "phase13-backup-2.tar.gz")
    tarballs.push(out2)
    const res2 = runCli(["export", "--full", "--output", out2])
    expect(res2.status, `stderr: ${res2.stderr}`).toBe(0)
    expect(existsSync(out2)).toBe(true)
    // No stray *.tmp at either output's directory.
    const stray = execFileSync("bash", [
      "-c",
      `ls ${workDir}/*.tmp 2>/dev/null | wc -l | tr -d ' '`,
    ])
      .toString()
      .trim()
    expect(stray).toBe("0")
  }, 120_000)
})

describe("liaison erase-user (real CLI, cascade + idempotent)", () => {
  async function seedDisposableUser(): Promise<string> {
    // A disposable user in the test org with cross-schema app data: a ticket,
    // a NOT NULL anonymize column (api_keys.created_by — the C1 path), a
    // delete-strategy read marker, and an anonymize attribution message.
    const uid = await withSystemDb("s7-seed-user", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
          SELECT id FROM kernel.users WHERE org_id = ${orgId}
          ORDER BY created_at ASC LIMIT 1
        `)) as unknown as Array<{ id: string }>
      return rows[0]!.id
    })
    const ticketId = crypto.randomUUID()
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await withSystemDb("s7-seed-appdata", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, team,
          sensitivity, reply_token, sla_target_seconds, sla_deadline,
          sla_active_started_at, sla_elapsed_seconds, message_count,
          created_at, updated_at
        ) VALUES (
          ${ticketId}, ${orgId}, ${`tk-${suffix}`}, 'S7 subj', 'open', 'normal',
          'manual', 'support-eu', 'internal',
          ${`TK${suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`},
          3600, now() + interval '1 hour', now(), 0, 0, now(), now()
        )`)
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.api_keys (
          id, org_id, key_hash, key_prefix, label, created_by,
          created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}, ${orgId}, ${`kh-${suffix}`},
          ${`kp-${suffix.slice(0, 6)}`}, 's7-key', ${uid}, now(), now()
        )`)
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.ticket_reads (
          org_id, ticket_id, user_id, read_at
        ) VALUES (${orgId}, ${ticketId}, ${uid}, now())`)
    })
    return uid
  }

  function pii(uid: string): Promise<number> {
    return withSystemDb("s7-pii", async (tx) => {
      const reads = (await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM app_tickets.ticket_reads WHERE user_id = ${uid}`)) as unknown as Array<{
        n: number
      }>
      const keys = (await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM app_tickets.api_keys WHERE created_by = ${uid}`)) as unknown as Array<{
        n: number
      }>
      return reads[0]!.n + keys[0]!.n
    })
  }

  function userRow(uid: string): Promise<{ email: string; name: string } | null> {
    return withSystemDb("s7-userrow", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
          SELECT email, name FROM kernel.users WHERE id = ${uid}`)) as unknown as Array<{
        email: string
        name: string
      }>
      return rows[0] ?? null
    })
  }

  function auditCount(): Promise<number> {
    return withSystemDb("s7-audit-count", async (tx) => {
      const rows = (await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.audit_log`,
      )) as unknown as Array<{ n: number }>
      return rows[0]!.n
    })
  }

  function systemEraseAuditFor(uid: string): Promise<number> {
    return withSystemDb("s7-audit-for", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM kernel.audit_log
          WHERE action = 'user.erased' AND entity_id = ${uid}
            AND actor_type = 'system'`)) as unknown as Array<{ n: number }>
      return rows[0]!.n
    })
  }

  test("cascade removes/anonymizes declared PII, tombstones the user, writes exactly one system audit entry, is idempotent, and no-ops non-zero on unknown ids", async () => {
    const uid = await seedDisposableUser()

    // Pre: PII present on kernel.users + app schemas.
    const before = await userRow(uid)
    expect(before).not.toBeNull()
    expect(before!.email).not.toContain("deleted-user-")
    expect(await pii(uid)).toBeGreaterThan(0)
    const auditBefore = await auditCount()

    // 1. Erase via the real CLI.
    const res = runCli(["erase-user", uid])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    expect(res.stdout).toContain(`Erased ${uid}`)

    // G3: kernel.users row STILL EXISTS (tombstoned, not hard-deleted), id
    // unchanged, email/name replaced with the deterministic sentinel.
    const after = await userRow(uid)
    expect(after).not.toBeNull()
    expect(after!.email).toBe(`deleted-user-${uid}`)
    expect(after!.name).toBe(`deleted-user-${uid}`)

    // G4: no app-schema row/field still holds the user's id (rows deleted for
    // `delete`; NOT NULL anonymize cols re-pointed at the per-org sentinel).
    expect(await pii(uid)).toBe(0)

    // G5: exactly ONE new system audit entry identifying the erased user.
    expect(await systemEraseAuditFor(uid)).toBe(1)
    expect(await auditCount()).toBe(auditBefore + 1)

    // Idempotent re-run (Validation step 6): exit 0, NO second audit entry,
    // no further mutation.
    const auditAfterFirst = await auditCount()
    const res2 = runCli(["erase-user", uid])
    expect(res2.status, `stderr: ${res2.stderr}`).toBe(0)
    expect(await auditCount()).toBe(auditAfterFirst)
    expect(await systemEraseAuditFor(uid)).toBe(1)

    // G6: unknown id → non-zero, NO new audit entry, no mutated rows.
    const auditBeforeUnknown = await auditCount()
    const unknown = crypto.randomUUID()
    const res3 = runCli(["erase-user", unknown])
    expect(res3.status).not.toBe(0)
    expect(await auditCount()).toBe(auditBeforeUnknown)
  }, 120_000)
})
