// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * CLI dispatch wiring + stdout/stderr discipline (Task 17).
 *
 * Spawns the REAL CLI entrypoint (`bun run src/cli/index.ts …`) as a child
 * process against `liaison_test` — same harness shape as
 * cli-smoke.test.ts — so it exercises real process.argv parsing, the
 * env validation at import, and the actual stdout/stderr split.
 *
 * Coverage:
 * - usage / validation: `config apply` with no `--config` → usage to STDERR,
 *   exit 2; unknown subcommand → usage, exit 2; bad `--format` → exit 2;
 * - stdout/stderr discipline: a successful `config apply --format json` (real
 *   DB) → STDOUT parses as JSON ONLY (no human lines), progress on STDERR, and
 *   the JSON carries `env.LIAISON_ORG_ID` + `env.LIAISON_API_KEY`;
 * - `--format env` → STDOUT is ONLY `KEY="VALUE"` lines;
 * - `--dry-run` → exit 0, writes nothing to the DB;
 * - a validation error (malformed config) → exit 2.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { testApiConn } from "~/modules/apps/connections/api/app.test-helpers"
import { acquireTestLock, releaseTestLock, truncateOrgTables } from "~/tests/route-test-setup"

const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..")
const TEST_DB_URL =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

/** Run the real CLI as a child process against liaison_test (explicit env — a
 *  plain `bun run` does NOT auto-load `.env.test`). */
function runCli(args: string[]): CliResult {
  const r = spawnSync("bun", ["run", "src/cli/index.ts", ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      NODE_ENV: "test",
      JWT_SECRET: process.env.JWT_SECRET ?? "test-secret-at-least-32-characters-long",
      ENCRYPTION_KEY:
        process.env.ENCRYPTION_KEY ??
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      BYOK_ENCRYPTION_KEY:
        process.env.BYOK_ENCRYPTION_KEY ??
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      EXPOSE_REFRESH_TOKEN_IN_BODY: process.env.EXPOSE_REFRESH_TOKEN_IN_BODY ?? "true",
      DEVICE_FLOW_CLIENTS: process.env.DEVICE_FLOW_CLIENTS ?? "*",
    },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

let cfgDir: string

function writeConfig(name: string, obj: unknown): string {
  const path = join(cfgDir, name)
  writeFileSync(path, JSON.stringify(obj))
  return path
}

/** A minimal applyable config: org + admin + a GENERATED api key (so the report
 *  carries env.LIAISON_API_KEY). No byok → no network validation. */
function minimalConfig(slug: string) {
  return {
    org: { slug, name: "Dispatch Test Org" },
    admin: { email: "owner@fabrikam.example", name: "Owner", password: "pw-dispatch-1!" },
    apiKeys: [{ label: "hub" }],
  }
}

beforeAll(acquireTestLock)
afterAll(() => {
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true })
  return releaseTestLock()
})

describe("CLI dispatch — usage / validation (exit 2 → STDERR)", () => {
  test("config apply with no --config → usage to stderr, exit 2", () => {
    const res = runCli(["config", "apply"])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("usage:")
    expect(res.stderr).toContain("--config")
    expect(res.stdout.trim()).toBe("")
  })

  test("unknown subcommand → usage, exit 2", () => {
    const res = runCli(["frobnicate"])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("usage:")
    expect(res.stdout.trim()).toBe("")
  })

  test("bad --format → exit 2", () => {
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const path = writeConfig("fmt.json", minimalConfig(`d-${Date.now()}`))
    const res = runCli(["config", "apply", "--config", path, "--format", "xml"])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("--format")
  })

  test("config apply with a malformed config → validation error, exit 2", () => {
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    // Missing required `org` → schema validation fails (exit 2).
    const path = writeConfig("bad.json", { admin: { email: "x", name: "y", password: "z" } })
    const res = runCli(["config", "apply", "--config", path])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("config apply:")
    expect(res.stdout.trim()).toBe("")
  })
})

describe("CLI dispatch — stdout/stderr discipline (config apply, real DB)", () => {
  test("--format json → STDOUT is JSON ONLY; progress on STDERR; env carries LIAISON_ORG_ID + LIAISON_API_KEY", async () => {
    await truncateOrgTables()
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const path = writeConfig("ok.json", minimalConfig(`d-json-${Date.now()}`))
    const res = runCli(["config", "apply", "--config", path, "--format", "json"])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)

    // STDOUT must be pure JSON — parse it; any human prose would throw.
    const report = JSON.parse(res.stdout)
    expect(report.ok).toBe(true)
    expect(typeof report.env.LIAISON_ORG_ID).toBe("string")
    expect(report.env.LIAISON_ORG_ID.length).toBeGreaterThan(0)
    // A generated key always emits its plaintext to env.
    expect(typeof report.env.LIAISON_API_KEY).toBe("string")
    expect(report.env.LIAISON_API_KEY.length).toBeGreaterThan(0)
    // Progress went to STDERR, not STDOUT.
    expect(res.stderr.length).toBeGreaterThan(0)
    // STDOUT has no human-progress markers — the provisioners log `org '<slug>'
    // … created (<uuid>)` style lines, which must never reach the JSON stdout.
    // (`created` itself is a legitimate JSON field name, so we match the
    // human-format prefix `org '`, not the bare word.)
    expect(res.stdout).not.toContain("org '")
    expect(res.stdout).not.toContain("[plan]")
    // The progress lines DID land on stderr.
    expect(res.stderr).toContain("org '")
  })

  test('--format env → STDOUT is ONLY KEY="VALUE" lines', async () => {
    await truncateOrgTables()
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const path = writeConfig("env.json", minimalConfig(`d-env-${Date.now()}`))
    const res = runCli(["config", "apply", "--config", path, "--format", "env"])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // Each line is KEY="VALUE" — strict shape.
      expect(line).toMatch(/^[A-Z_][A-Z0-9_]*="(?:[^"\\]|\\.)*"$/)
    }
    expect(lines.some((l) => l.startsWith("LIAISON_ORG_ID="))).toBe(true)
    expect(lines.some((l) => l.startsWith("LIAISON_API_KEY="))).toBe(true)
  })

  test("--dry-run → exit 0, no JSON sections written (plan only)", async () => {
    await truncateOrgTables()
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const path = writeConfig("dry.json", minimalConfig(`d-dry-${Date.now()}`))
    const res = runCli(["config", "apply", "--config", path, "--dry-run"])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    // Dry-run still emits a (mostly empty) JSON report to stdout — it parses.
    const report = JSON.parse(res.stdout)
    expect(report.ok).toBe(true)
    // Plan-only: no org section was applied, so no LIAISON_ORG_ID in env.
    expect(report.env.LIAISON_ORG_ID).toBeUndefined()
  })
})

describe("CLI dispatch — tickets import (machine-readable report → STDOUT)", () => {
  test("tickets import --dry-run → JSON report on STDOUT (parses), exit 0", async () => {
    await truncateOrgTables()
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const slug = `d-tix-${Date.now()}`
    // Provision the org first (tickets import resolves it by slug).
    const cfgPath = writeConfig("tix-org.json", minimalConfig(slug))
    const applyRes = runCli(["config", "apply", "--config", cfgPath, "--format", "json"])
    expect(applyRes.status, `apply stderr: ${applyRes.stderr}`).toBe(0)

    // A one-line ndjson import file with a single valid ticket.
    const importPath = join(cfgDir, "tickets.ndjson")
    writeFileSync(
      importPath,
      `${JSON.stringify({
        subject: "Dispatch import",
        externalRef: `ext-${Date.now()}`,
        contactEmail: "buyer@example.com",
        messages: [{ kind: "inbound", textBody: "hello" }],
      })}\n`,
    )

    // --dry-run so this never depends on the live outbox/ticket write path.
    const res = runCli(["tickets", "import", "--file", importPath, "--org", slug, "--dry-run"])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)

    // The machine-readable report parses from STDOUT (NOT stderr).
    const report = JSON.parse(res.stdout)
    expect(report).toHaveProperty("created")
    expect(report).toHaveProperty("skipped")
    expect(Array.isArray(report.failed)).toBe(true)
    // STDOUT is ONLY the JSON report — no human progress prose leaked in.
    expect(res.stdout.trim().startsWith("{")).toBe(true)
  })
})

describe("CLI dispatch — projects import (machine-readable report → STDOUT)", () => {
  test("projects import --dry-run --placeholder-unknown-users → JSON report on STDOUT, exit 0", async () => {
    await truncateOrgTables()
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const slug = `d-proj-${Date.now()}`
    const cfgPath = writeConfig("proj-org.json", minimalConfig(slug))
    const applyRes = runCli(["config", "apply", "--config", cfgPath, "--format", "json"])
    expect(applyRes.status, `apply stderr: ${applyRes.stderr}`).toBe(0)

    const importPath = join(cfgDir, "projects.ndjson")
    writeFileSync(
      importPath,
      `${JSON.stringify({
        externalRef: `PJ-${Date.now()}`,
        project: { name: "Dispatch" },
        title: "Dispatch import",
        status: "done",
        completedAt: "2025-01-01T00:00:00.000Z",
        reporterEmail: "unknown.reporter@contoso.example",
        comments: [{ authorEmail: "unknown.author@contoso.example", body: "hello" }],
      })}\n`,
    )

    const res = runCli([
      "projects",
      "import",
      "--file",
      importPath,
      "--org",
      slug,
      "--dry-run",
      "--placeholder-unknown-users",
    ])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    const report = JSON.parse(res.stdout)
    expect(report.createdTasks).toBe(0)
    expect(report.failed).toEqual([])
    expect(report.placeholdersCreated).toEqual([])
    expect(res.stdout.trim().startsWith("{")).toBe(true)
  })

  test("projects usage names --placeholder-unknown-users", () => {
    const res = runCli(["projects"])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("--placeholder-unknown-users")
    // The flag's side effect is documented where the operator reads it: a
    // placeholder holds the (org, email) slot, so onboarding means reactivating.
    expect(res.stderr).toContain("reactivate the placeholder")
    const top = runCli([])
    expect(top.stderr).toContain(
      "projects import --file <ndjson> [--org <slug>] [--dry-run] [--placeholder-unknown-users]",
    )
  })
})

describe("CLI dispatch — projects attach-files (machine-readable report → STDOUT)", () => {
  test("projects attach-files --dry-run on an imported task → JSON report on STDOUT, exit 0", async () => {
    await truncateOrgTables()
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const slug = `d-attach-${Date.now()}`
    const cfgPath = writeConfig("attach-org.json", minimalConfig(slug))
    const applyRes = runCli(["config", "apply", "--config", cfgPath, "--format", "json"])
    expect(applyRes.status, `apply stderr: ${applyRes.stderr}`).toBe(0)

    const externalRef = `AF-${Date.now()}`
    const importPath = join(cfgDir, "attach-tasks.ndjson")
    writeFileSync(
      importPath,
      `${JSON.stringify({ externalRef, project: { name: "Dispatch" }, title: "Has files" })}\n`,
    )
    const imported = runCli(["projects", "import", "--file", importPath, "--org", slug])
    expect(imported.status, `import stderr: ${imported.stderr}`).toBe(0)

    const filesDir = mkdtempSync(join(tmpdir(), "cli-dispatch-files-"))
    writeFileSync(join(filesDir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const batchPath = join(cfgDir, "attach-files.ndjson")
    writeFileSync(
      batchPath,
      `${JSON.stringify({
        externalRef,
        batchKey: "jira:1",
        authorEmail: "unknown.uploader@contoso.example",
        createdAt: "2025-01-01T10:00:00.000+0100",
        files: [
          { sourceId: "1", filename: "shot.png", mimeType: "image/png", size: 7, path: "shot.png" },
        ],
      })}\n`,
    )
    try {
      const res = runCli([
        "projects",
        "attach-files",
        "--file",
        batchPath,
        "--files-dir",
        filesDir,
        "--org",
        slug,
        "--dry-run",
        "--placeholder-unknown-users",
      ])
      expect(res.status, `stderr: ${res.stderr}`).toBe(0)
      expect(res.stdout.trim().startsWith("{")).toBe(true)
      const report = JSON.parse(res.stdout)
      expect(report.failed).toEqual([])
      expect(report.filesStored).toBe(0)
      expect(report.placeholdersPlanned).toEqual([
        { line: 1, email: "unknown.uploader@contoso.example" },
      ])
      expect(report.placeholdersCreated).toEqual([])
    } finally {
      rmSync(filesDir, { recursive: true, force: true })
    }
  })

  test("projects attach-files without --files-dir → its usage, exit 2; usage lists the command", () => {
    const res = runCli(["projects", "attach-files", "--file", "x.ndjson"])
    expect(res.status).toBe(2)
    expect(res.stdout.trim()).toBe("")
    expect(res.stderr).toContain("--files-dir <dir>")
    expect(runCli(["projects"]).stderr).toContain("projects attach-files")
    expect(runCli([]).stderr).toContain(
      "projects attach-files --file <ndjson> --files-dir <dir> [--org <slug>] [--dry-run] [--placeholder-unknown-users]",
    )
  })
})

// The top-level usage names every real subcommand, and the removed one-off
// repair commands are gone.
describe("CLI dispatch: top-level usage", () => {
  test("no command -> exit 2, usage lists every subcommand and the mail vs tickets connect lines", () => {
    const res = runCli([])
    expect(res.status).toBe(2)
    expect(res.stdout.trim()).toBe("")
    for (const sub of [
      "config apply",
      "api-connector validate",
      "api-connector test",
      "connect <app>/<connection>",
      "guide <google|shopify|imap|server|<app>/<connection>>",
      "setup state",
      "tickets import",
      "tickets inbox",
      "tickets backfill-attachments",
      "projects import",
      "projects attach-files",
      "invoicing import",
      "slack import",
      "search reindex",
      "export --full",
      "contacts privatize-mailbox-senders",
      "contacts restore-privatized-senders",
      "contacts apply-provenance",
      "contacts restore-provenance",
      "mailbox verify-attachment",
      "mailbox purge",
      "files purge-deleted-message-attachments",
      "erase-user",
    ]) {
      expect(res.stderr).toContain(sub)
    }
    expect(res.stderr).toMatch(/mail\/gmail +connect a Mail app mailbox/)
    expect(res.stderr).toMatch(/tickets\/gmail +connect a ticket inbox/)
  })

  test("tickets inbox with a missing or unknown subcommand -> JSON usage report on stdout, exit 2", () => {
    for (const argv of [
      ["tickets", "inbox"],
      ["tickets", "inbox", "frob"],
    ]) {
      const res = runCli(argv)
      expect(res.status, argv.join(" ")).toBe(2)
      const report = JSON.parse(res.stdout.trim()) as { error?: string }
      expect(report.error).toContain("usage: liaison tickets inbox <list|create|update|move>")
    }
  })

  test("removed repair commands -> usage, exit 2, and they are not advertised", () => {
    for (const argv of [
      ["jobs", "cleanup-completed", "--dry-run"],
      ["jobs", "thumbnail-backfill"],
      ["tickets", "repair-backlog", "--dry-run"],
      ["tickets", "teams", "list"],
    ]) {
      const res = runCli(argv)
      expect(res.status, argv.join(" ")).toBe(2)
      expect(res.stdout.trim()).toBe("")
      expect(res.stderr).toContain("usage:")
      for (const gone of ["cleanup-completed", "thumbnail-backfill", "repair-backlog", "teams"]) {
        expect(res.stderr).not.toContain(gone)
      }
    }
  })
})

describe("CLI dispatch: api-connector validate | test", () => {
  const ADAPTER = {
    id: "crm",
    name: "Fixture CRM",
    version: "1",
    baseUrl: "https://crm.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        name: "create_note",
        description: "Add a note.",
        kind: "write",
        method: "POST",
        path: "/notes",
        params: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        body: { text: "{text}" },
        fields: ["id"],
      },
    ],
  }

  test("no subcommand -> usage, exit 2", () => {
    const res = runCli(["api-connector"])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("api-connector validate")
    expect(res.stdout.trim()).toBe("")
  })

  test("validate: a valid adapter -> exit 0 with its operations on STDOUT", () => {
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const res = runCli(["api-connector", "validate", writeConfig("ok.adapter.json", ADAPTER)])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    const report = JSON.parse(res.stdout)
    expect(report.ok).toBe(true)
    expect(report.adapter.operations).toEqual([{ name: "create_note", kind: "write" }])
  })

  test("validate: an invalid adapter -> exit 1 with path-precise issues", () => {
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const bad = { ...ADAPTER, baseUrl: "http://crm.example.com" }
    const res = runCli(["api-connector", "validate", writeConfig("bad.adapter.json", bad)])
    expect(res.status).toBe(1)
    const report = JSON.parse(res.stdout)
    expect(report.ok).toBe(false)
    expect(report.issues.map((i: { path: string }) => i.path)).toContain("baseUrl")
  })

  test("config apply refuses the removed apiConnectors section, naming where it moved", () => {
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    writeConfig("crm.adapter.json", ADAPTER)
    const cfg = writeConfig("apiconn-old.json", {
      ...minimalConfig(`d-apiconn-old-${Date.now()}`),
      apiConnectors: [
        { identifier: "crm", adapter: "crm.adapter.json", credentials: { token: "tok" } },
      ],
    })
    const applied = runCli(["config", "apply", "--config", cfg])
    expect(applied.status).toBe(2)
    expect(applied.stderr).toContain(
      "apiConnectors moved into the api-connector app's provisioning",
    )
  })

  test("test: a write operation is refused (exit 1, write_not_testable)", async () => {
    cfgDir = cfgDir || mkdtempSync(join(tmpdir(), "cli-dispatch-"))
    const slug = `d-apiconn-${Date.now()}`
    const cfg = writeConfig("apiconn.json", minimalConfig(slug))
    const applied = runCli(["config", "apply", "--config", cfg])
    expect(applied.status, `stderr: ${applied.stderr}`).toBe(0)
    const { sql } = await import("~/db/connection")
    const [org] = await sql<Array<{ id: string }>>`
      SELECT id FROM kernel.organizations WHERE slug = ${slug}`
    const { upsertAdapterRow } = await import("~/modules/apps/connections/api/store")
    const { validateAdapterDocument } = await import(
      "~/modules/apps/connections/api/adapter-policy"
    )
    const parsed = validateAdapterDocument(ADAPTER)
    if (!parsed.ok) throw new Error("fixture adapter invalid")
    await upsertAdapterRow(testApiConn(org?.id ?? ""), "crm", parsed.adapter, null)
    const res = runCli([
      "api-connector",
      "test",
      "crm",
      "create_note",
      "--param",
      "text=hi",
      "--org",
      slug,
    ])
    expect(res.status).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, code: "write_not_testable" })
  })
})
