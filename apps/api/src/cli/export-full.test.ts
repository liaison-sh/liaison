// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { exportFull, parseExportFullArgv } from "~/cli/export-full"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function tarList(file: string): string[] {
  return execFileSync("tar", ["tzf", file], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

let workDir: string

/** This file lives at apps/api/src/cli/, so the api dir is two levels up. */
const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..")

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(releaseTestLock)

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

function freshOut(name = "backup.tar.gz"): string {
  workDir = mkdtempSync(join(tmpdir(), "liaison-export-"))
  return join(workDir, name)
}

const noStorage = async function* () {
  // no-op: zero storage objects (still a valid tarball)
}

// Resolve a privileged connection URL for the pg_dump integration tests.
// MIGRATION_DATABASE_URL is the canonical source; if unset in this test
// environment we derive a local superuser URL from DATABASE_URL (same pattern
// the production CLI documents for operators who haven't set the var yet).
function resolveTestDumpUrl(): string | undefined {
  const explicit = process.env.MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL_TEST
  if (explicit) return explicit
  const appUrl = process.env.DATABASE_URL
  if (!appUrl) return undefined
  try {
    const u = new URL(appUrl)
    u.username = "postgres"
    u.password = "postgres"
    return u.toString()
  } catch {
    return undefined
  }
}
const testDbUrl = resolveTestDumpUrl()

// Resolve pg_dump from PATH rather than hardcoding a single platform's location
// (Homebrew's /opt/homebrew/bin on macOS vs /usr/bin on Linux). These cases
// actually exec the resolved binary to build a real tarball, so a wrong path
// fails the test on the other platform.
function resolvePgDump(): string {
  return execFileSync("which", ["pg_dump"], { encoding: "utf8" }).trim()
}
const pgDumpPath = resolvePgDump()

describe("liaison export --full (E6)", () => {
  test("(a) pg_dump present: exit 0 + tarball lists all four artifact classes", async () => {
    const out = freshOut()
    const res = await exportFull({
      output: out,
      dbUrl: testDbUrl,
      pgDumpResolver: () => pgDumpPath,
      storageObjectsIter: noStorage,
      meili: {
        isHealthy: async () => true,
        listIndexUids: async () => ["liaison_search"],
        getIndexDocuments: async () => [{ id: "doc-1" }],
      },
    })
    expect(res.exitCode).toBe(0)
    expect(existsSync(out)).toBe(true)
    const entries = tarList(out)
    expect(entries.some((e) => e.endsWith(".sql") || e.includes("pg-dump"))).toBe(true)
    expect(entries.some((e) => e.includes("meili"))).toBe(true)
    expect(entries.some((e) => e.endsWith("manifest.json"))).toBe(true)

    // E6 completeness: the dump must cover ALL schemas (kernel + app_*), not a
    // `--schema=kernel`-only subset. Extract pg-dump.sql and assert both a
    // kernel object and at least one app_* schema object are present.
    execFileSync("tar", ["xzf", out, "-C", workDir, "./pg-dump.sql"])
    const dump = readFileSync(join(workDir, "pg-dump.sql"), "utf8")
    expect(dump).toMatch(/\bkernel\./)
    expect(dump).toMatch(/\bapp_\w+\./)

    // The manifest must enumerate the artifact file mappings, not just exist.
    execFileSync("tar", ["xzf", out, "-C", workDir, "./manifest.json"])
    const manifest = JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"))
    expect(manifest.files.postgres).toBe("pg-dump.sql")
    expect(String(manifest.schemas)).toMatch(/app_/)
  })

  test("(b) pg_dump absent: ASSERTED non-zero, message, no file", async () => {
    const out = freshOut()
    const res = await exportFull({
      output: out,
      pgDumpResolver: () => null,
      storageObjectsIter: noStorage,
      meili: {
        isHealthy: async () => true,
        listIndexUids: async () => [],
        getIndexDocuments: async () => [],
      },
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.message).toContain("pg_dump not found")
    expect(existsSync(out)).toBe(false)
  })

  test("(c) MeiliSearch service absent: exit 0, other artifacts produced, manifest notes the gap", async () => {
    const out = freshOut()
    const res = await exportFull({
      output: out,
      dbUrl: testDbUrl,
      pgDumpResolver: () => pgDumpPath,
      storageObjectsIter: noStorage,
      meili: {
        isHealthy: async () => false,
        listIndexUids: async () => {
          throw new Error("meili unreachable")
        },
        getIndexDocuments: async () => {
          throw new Error("meili unreachable")
        },
      },
    })
    expect(res.exitCode).toBe(0)
    expect(existsSync(out)).toBe(true)
    const entries = tarList(out)
    expect(entries.some((e) => e.endsWith(".sql") || e.includes("pg-dump"))).toBe(true)
    expect(entries.some((e) => e.endsWith("manifest.json"))).toBe(true)
    // Read manifest from the tarball. Use the `./`-prefixed entry name the
    // archive actually stores — GNU tar (Linux) matches the stored path exactly,
    // unlike BSD tar (macOS) which also accepts the bare `manifest.json`.
    execFileSync("tar", ["xzf", out, "-C", workDir, "./manifest.json"])
    const manifest = JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"))
    expect(manifest.meilisearch.skipped).toBe(true)
    expect(String(manifest.meilisearch.reason)).toMatch(/meili/i)
  })

  test("atomic rename: a failure after the pg dump leaves NO file at --output", async () => {
    const out = freshOut()
    const res = await exportFull({
      output: out,
      dbUrl: testDbUrl,
      pgDumpResolver: () => pgDumpPath,
      // biome-ignore lint/correctness/useYield: generator throws on entry; no yield needed to drive the test path
      storageObjectsIter: async function* () {
        throw new Error("storage unreachable")
      },
      meili: {
        isHealthy: async () => true,
        listIndexUids: async () => [],
        getIndexDocuments: async () => [],
      },
    })
    expect(res.exitCode).not.toBe(0)
    expect(existsSync(out)).toBe(false)
  })

  test("fails with a clear error when MIGRATION_DATABASE_URL is unset and no dbUrl is injected", async () => {
    const out = freshOut()
    // Temporarily clear the env var to exercise the loud-failure path.
    const saved = process.env.MIGRATION_DATABASE_URL
    const savedTest = process.env.MIGRATION_DATABASE_URL_TEST
    delete process.env.MIGRATION_DATABASE_URL
    delete process.env.MIGRATION_DATABASE_URL_TEST
    try {
      const res = await exportFull({
        output: out,
        // No dbUrl — must throw loudly, not silently use wrong credentials.
        pgDumpResolver: () => pgDumpPath,
        storageObjectsIter: noStorage,
        meili: {
          isHealthy: async () => false,
          listIndexUids: async () => [],
          getIndexDocuments: async () => [],
        },
      })
      // The error is caught inside exportFull, which returns exitCode != 0.
      expect(res.exitCode).not.toBe(0)
      expect(res.message).toMatch(/MIGRATION_DATABASE_URL/)
    } finally {
      if (saved !== undefined) process.env.MIGRATION_DATABASE_URL = saved
      if (savedTest !== undefined) process.env.MIGRATION_DATABASE_URL_TEST = savedTest
    }
  })

  // ── Task 14.1: the DIRECT entrypoint ──────────────────────────────────────
  //
  // Spec section 13 V9c runs `bun src/cli/export-full.ts --output ...` inside
  // liaison-app-1. Before this task the file had no `import.meta.main`, so that
  // command loaded the module, did nothing and exited 0: an SC5 check that
  // could not fail. These cases exercise the real process, not `exportFull`.
  test("(d) direct entrypoint: no --output is a usage error, exit non-zero", () => {
    const r = spawnSync("bun", ["run", "src/cli/export-full.ts"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: "test" },
    })
    // A module with no entrypoint does not exit at all: its redis and database
    // imports keep the loop alive. So "did it exit, with a number" is part of
    // the assertion. Without it a hang would time out and read as non-zero.
    expect(r.error).toBeUndefined()
    expect(typeof r.status).toBe("number")
    expect(r.status).toBe(2)
    // Asserted on the message, not just the code: an env-validation crash also
    // exits non-zero and would make a bare code assertion pass for the wrong
    // reason.
    expect(`${r.stderr}${r.stdout}`).toContain("--output")
  })

  test("(e) direct entrypoint: --output plus --db-url writes the tarball", () => {
    const out = freshOut("direct.tar.gz")
    // A bare `bun run` does NOT load .env.test, so DATABASE_URL is injected the
    // way cli-smoke.test.ts does. Without it the child points at no
    // database at all and blocks on connection retries rather than failing.
    const r = spawnSync(
      "bun",
      [
        "run",
        "src/cli/export-full.ts",
        "--output",
        out,
        ...(testDbUrl ? ["--db-url", testDbUrl] : []),
      ],
      {
        cwd: API_DIR,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL:
            process.env.DATABASE_URL ??
            "postgres://liaison_app:liaison_app@localhost:5432/liaison_test",
          ...(testDbUrl ? { MIGRATION_DATABASE_URL_TEST: testDbUrl } : {}),
        },
      },
    )
    expect(`${r.stderr}${r.stdout}`).toContain(out)
    expect(r.status).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(tarList(out).some((e) => e.endsWith("manifest.json"))).toBe(true)
  })

  test("(f) argv parsing: --out is rejected rather than silently ignored", () => {
    expect(parseExportFullArgv(["--output", "/tmp/a.tar.gz"])).toEqual({
      ok: true,
      output: "/tmp/a.tar.gz",
      dbUrl: undefined,
    })
    expect(parseExportFullArgv([]).ok).toBe(false)
    expect(parseExportFullArgv(["--output"]).ok).toBe(false)
    // The earlier draft of the validation protocol used `--out`. Aliasing it
    // would export somewhere other than where the next V9c step greps.
    const wrong = parseExportFullArgv(["--out", "/tmp/a.tar.gz"])
    expect(wrong.ok).toBe(false)
    expect(String(wrong.error)).toContain("--output")
  })

  test("the manifest states that sealed personal mail is not decryptable by the exporter", async () => {
    const out = freshOut()
    const res = await exportFull({
      output: out,
      dbUrl: testDbUrl,
      pgDumpResolver: () => pgDumpPath,
      storageObjectsIter: noStorage,
      meili: {
        isHealthy: async () => false,
        listIndexUids: async () => [],
        getIndexDocuments: async () => [],
      },
    })
    expect(res.exitCode).toBe(0)
    execFileSync("tar", ["xzf", out, "-C", workDir, "./manifest.json"])
    const manifest = JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"))
    const note = manifest.personalMailEncryption
    expect(note).toBeDefined()
    expect(String(note.summary)).toMatch(/not decryptable/i)
    expect(note.plaintextColumns).toEqual([])
    expect(Array.isArray(note.ciphertextColumns)).toBe(true)
    expect(note.ciphertextColumns).toContain("text_body_ciphertext")
    expect(String(note.subjectAccessRequests)).toMatch(/data subject|browser/i)
    expect(String(note.keyMaterial)).toMatch(/user_key_wraps/)
  })

  test("the dump carries no wrapped Account Key, KDF parameters or verifier", async () => {
    // `kernel.user_key_wraps.wrapped_account_key` plus `kdf_params` is an
    // OFFLINE CRACKING ORACLE at passphrase KDF speed: for a user whose only wrap is
    // a passphrase wrap, whoever holds this artifact holds everything needed to
    // grind at their leisure, and the manifest's "not decryptable by anyone
    // holding this artifact" would be false. Migration 0033 says the column
    // must never reach an export; the export is the one place that was not
    // enforcing it.
    const wrapUserId = crypto.randomUUID()
    const cracker = "CRACKINGORACLECANARY"
    const { withSystemDb } = await import("~/db/privileged")
    const { sql: drizzleSql } = await import("drizzle-orm")
    const minimal = await import("~/seed/tiers/minimal")
    const { createTestOrg } = await import("~/tests/helpers/org")
    const user = await minimal.person((await createTestOrg()).id)
    await withSystemDb("export-wraps-canary", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.user_key_wraps
          (id, org_id, user_id, wrap_type, label, wrapped_account_key, kdf_params, verifier)
        VALUES (${wrapUserId}::uuid, ${user.orgId}::uuid, ${user.id}::uuid, 'passphrase',
                ${cracker}, ${Buffer.from(cracker)}, ${JSON.stringify({ memoryKib: 65536, canary: cracker })}::jsonb,
                ${Buffer.from(cracker)})`),
    )
    try {
      const out = freshOut()
      const res = await exportFull({
        output: out,
        dbUrl: testDbUrl,
        pgDumpResolver: () => pgDumpPath,
        storageObjectsIter: noStorage,
        meili: {
          isHealthy: async () => false,
          listIndexUids: async () => [],
          getIndexDocuments: async () => [],
        },
      })
      expect(res.exitCode).toBe(0)
      execFileSync("tar", ["xzf", out, "-C", workDir, "./pg-dump.sql"])
      const dump = readFileSync(join(workDir, "pg-dump.sql"), "utf8")
      // Non-vacuity: the dump really is a dump of THIS cluster, so a canary
      // that is absent is absent because it was excluded, not because the file
      // is empty or unrelated.
      expect(dump.length).toBeGreaterThan(1000)
      expect(dump).toContain("kernel")
      expect(dump).not.toContain(cracker)
      expect(dump).not.toMatch(/COPY kernel\.user_key_wraps/)
    } finally {
      await withSystemDb("export-wraps-canary-cleanup", (tx) =>
        tx.execute(drizzleSql`DELETE FROM kernel.user_key_wraps WHERE id = ${wrapUserId}::uuid`),
      )
    }
  }, 120_000)

  test("the dump carries no wrapped identity private half", async () => {
    // Migration 0041 put the identity keyring's wrapped private halves on
    // kernel.user_mailbox_identities. They are ciphertext under an Account Key
    // no artifact carries, but an export that shipped them would hand an
    // attacker the keyring and the wrap together, which is the pair that opens
    // a mailbox. The table's DATA is therefore excluded exactly as the wraps
    // table is.
    const identityId = crypto.randomUUID()
    const canary = "IDENTITYPRIVATECANARY"
    const { withSystemDb } = await import("~/db/privileged")
    const { sql: drizzleSql } = await import("drizzle-orm")
    const minimal = await import("~/seed/tiers/minimal")
    const { createTestOrg } = await import("~/tests/helpers/org")
    const user = await minimal.person((await createTestOrg()).id)
    await withSystemDb("export-identity-canary", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (id, org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation,
           status, wrapped_ecdh_private, wrapped_sign_private, ecdh_wrap_iv, sign_wrap_iv)
        VALUES (${identityId}::uuid, ${user.orgId}::uuid, ${user.id}::uuid, 3,
                ${Buffer.from("ecdh-public")}, ${Buffer.from("sign-public")},
                ${Buffer.from("attestation")}, 'active',
                ${Buffer.from(canary)}, ${Buffer.from(canary)},
                ${Buffer.from("iv-ecdh")}, ${Buffer.from("iv-sign")})`),
    )
    try {
      const out = freshOut()
      const res = await exportFull({
        output: out,
        dbUrl: testDbUrl,
        pgDumpResolver: () => pgDumpPath,
        storageObjectsIter: noStorage,
        meili: {
          isHealthy: async () => false,
          listIndexUids: async () => [],
          getIndexDocuments: async () => [],
        },
      })
      expect(res.exitCode).toBe(0)
      execFileSync("tar", ["xzf", out, "-C", workDir, "./pg-dump.sql"])
      const dump = readFileSync(join(workDir, "pg-dump.sql"), "utf8")
      // Non-vacuity, same as the wraps canary above.
      expect(dump.length).toBeGreaterThan(1000)
      expect(dump).toContain("kernel")
      expect(dump).not.toContain(canary)
      expect(dump).not.toMatch(/COPY kernel\.user_mailbox_identities/)
    } finally {
      await withSystemDb("export-identity-canary-cleanup", (tx) =>
        tx.execute(
          drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE id = ${identityId}::uuid`,
        ),
      )
    }
  }, 120_000)
})
