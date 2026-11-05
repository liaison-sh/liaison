// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison api-connector validate` runs offline (P2-V7): the real CLI entry,
 * spawned with an EMPTY environment (no JWT_SECRET, ENCRYPTION_KEY, database
 * or Redis), checks an adapter file and exits 0 when it is valid, 1 when it
 * has issues. A subcommand that needs the deployment's environment exits 2
 * when it is missing (a configuration error, told apart from adapter issues).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..")
const dir = mkdtempSync(join(tmpdir(), "api-connector-validate-"))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ADAPTER = {
  id: "crm",
  name: "Fixture CRM",
  version: "1",
  baseUrl: "https://crm.example.com",
  auth: { type: "bearer" },
  operations: [
    {
      name: "find_customers",
      description: "Find companies by email.",
      kind: "read",
      method: "GET",
      path: "/companies",
      params: { type: "object", properties: { email: { type: "string" } } },
      query: { email: "{email}" },
      items: "/data",
      fields: ["id", "name"],
      role: "customer.lookup",
    },
  ],
}

function file(name: string, body: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body))
  return path
}

/** The CLI with nothing in its environment but what launches a process. */
function runBare(args: string[]) {
  const r = spawnSync("bun", ["run", "src/cli/index.ts", ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    timeout: 60_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

describe("liaison api-connector validate, offline (P2-V7)", () => {
  test("a valid adapter: exit 0 with its report, no environment needed", () => {
    const res = runBare(["api-connector", "validate", file("ok.adapter.json", ADAPTER)])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, adapter: { id: "crm" } })
    expect(res.stderr).not.toContain("Invalid environment configuration")
  })

  test("an invalid adapter: exit 1 with its issues", () => {
    const bad = { ...ADAPTER, baseUrl: "http://crm.example.com" }
    const res = runBare(["api-connector", "validate", file("bad.adapter.json", bad)])
    expect(res.status, `stderr: ${res.stderr}`).toBe(1)
    const report = JSON.parse(res.stdout) as { ok: boolean; issues: { path: string }[] }
    expect(report.ok).toBe(false)
    expect(report.issues.map((i) => i.path)).toContain("baseUrl")
  })

  test("an unreadable file: exit 2", () => {
    const res = runBare(["api-connector", "validate", join(dir, "missing.yaml")])
    expect(res.status).toBe(2)
  })

  test("a subcommand that needs the environment: exit 2 when it is missing", () => {
    const res = runBare(["api-connector", "test", "crm", "find_customers"])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("Invalid environment configuration")
  })
})
