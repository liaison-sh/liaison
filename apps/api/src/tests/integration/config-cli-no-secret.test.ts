// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration test — no secret on CLI output (spec §8.7).
 *
 * Spawns the REAL `liaison config apply` CLI as a child process against
 * `liaison_test` with a config carrying three distinct secrets:
 *   - a BYOK provider API key,
 *   - an app connection token (a credentials connection's `token` field),
 *   - the admin account password.
 *
 * It then captures BOTH stdout and stderr and asserts NONE of those secret
 * substrings appears in EITHER stream. stdout is the machine report (must carry
 * only masked hints / prefixes / non-secret fields); stderr is human progress
 * (must log field NAMES + masked hints, never raw values). This is the
 * end-to-end guard that the report builder + pino-redact discipline hold under
 * a real process, not just in unit isolation.
 *
 * `--no-validate-byok` keeps the BYOK provisioner from making a network call,
 * and `--echo-supplied` is NOT passed, so even the (separate) supplied-key echo
 * path stays off — the three secrets above are the ones that must never leak.
 *
 * Mirrors the child-process harness in `cli/cli-smoke.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// The CLI is `apps/api`-relative; this test file lives at apps/api/src/tests/integration/.
const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..")
const TEST_DB_URL =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

/** Spawn the real CLI against liaison_test. DATABASE_URL + NODE_ENV are injected
 *  explicitly (a plain `bun run` does not auto-load `.env.test`). The crypto env
 *  the env validator requires is inherited from the Strobe `env` arg. */
function runCli(args: string[]): CliResult {
  const r = spawnSync("bun", ["run", "src/cli/index.ts", ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, NODE_ENV: "test" },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

let workDir = ""
afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true })
    workDir = ""
  }
})

describe("config apply — no secret on stdout/stderr (§8.7)", () => {
  test("a run with a BYOK key, an app connection token, and an admin password leaks none of them to either stream", () => {
    const suffix = crypto.randomUUID().slice(0, 12)
    // Three distinct, recognizable secrets. Random tails so an accidental match
    // is impossible to confuse with a substring of a non-secret field.
    const byokSecret = `sk-ant-secret-${crypto.randomUUID().replace(/-/g, "")}`
    const connectionToken = `glpat-secret-${crypto.randomUUID().replace(/-/g, "")}`
    const adminPassword = `Adm1n-Pass-${crypto.randomUUID().replace(/-/g, "")}!`

    const config = {
      org: { slug: `cli-nosecret-${suffix}`, name: "No Secret Org" },
      admin: {
        email: `admin-${suffix}@fabrikam.example`,
        name: "Secret Admin",
        password: adminPassword,
      },
      byok: {
        anthropic: { apiKey: byokSecret, validate: false },
      },
      apps: [
        {
          name: "test",
          enable: true,
          connection: {
            name: "service",
            identifier: `service-${suffix}`,
            ownerType: "org",
            // `token` + `group` are the test app's `service` credentialFields.
            credentials: { token: connectionToken, group: "fabrikam" },
          },
        },
      ],
    }

    workDir = mkdtempSync(join(tmpdir(), "liaison-cli-nosecret-"))
    const configPath = join(workDir, "config.json")
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    chmodSync(configPath, 0o600)

    const res = runCli(["config", "apply", "--config", configPath, "--no-validate-byok"])

    const combined = `${res.stdout}\n---STDERR---\n${res.stderr}`
    // A non-zero exit would still be a valid no-secret check, but surface the
    // streams so a provisioning regression is debuggable, not a silent skip.
    expect(res.status, `config apply failed; streams:\n${combined}`).toBe(0)

    // The headline assertions: NONE of the three secrets appears on EITHER stream.
    expect(res.stdout).not.toContain(byokSecret)
    expect(res.stderr).not.toContain(byokSecret)
    expect(res.stdout).not.toContain(connectionToken)
    expect(res.stderr).not.toContain(connectionToken)
    expect(res.stdout).not.toContain(adminPassword)
    expect(res.stderr).not.toContain(adminPassword)

    // Sanity: the run actually did the provisioning we asked for (so the absence
    // of the secrets is from scrubbing, not from the run no-op'ing). stdout is
    // the JSON report; it should carry the org id env var.
    expect(res.stdout).toContain("LIAISON_ORG_ID")
  }, 120_000)
})
