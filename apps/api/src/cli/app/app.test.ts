// SPDX-License-Identifier: FSL-1.1-ALv2
// `liaison app status | rollback | verify` (S8, S9): status reports the state the
// App store shows, rollback reports what the service did or why it refused, and
// verify checks a package or manifest offline. The services are faked here; the
// real ones are covered by modules/apps/app-versions.test.ts.
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_SIGNING_KEYS, type AppStatement, statementBytes } from "@liaison/shared"
import { createTestSigningKey } from "@liaison/shared/src/app-signing/testing"
import { type AppManageDeps, runAppRollback, runAppStatus, statusLines } from "~/cli/app/manage"
import { runAppOffline, runAppVerify } from "~/cli/app/verify"
import type { AppVersionState } from "~/modules/apps/activation"

const work = mkdtempSync(join(tmpdir(), "cli-app-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function state(over: Partial<AppVersionState> = {}): AppVersionState {
  return {
    name: "boxtal",
    version: "2.0.0",
    previousVersion: "1.0.0",
    previousOnDisk: true,
    noRollback: false,
    upgradeFailed: null,
    ...over,
  }
}

function deps(over: Partial<AppManageDeps> = {}): AppManageDeps {
  return {
    listStates: async () => [state()],
    loadProblems: async () => [],
    rollback: async () => ({ version: "1.0.0", previousVersion: "2.0.0" }),
    ...over,
  }
}

describe("statusLines", () => {
  it("reads running, upgrade failed and failed to load, a load failure first", () => {
    const lines = statusLines(
      [
        state({ name: "a" }),
        state({
          name: "b",
          upgradeFailed: {
            version: "3.0.0",
            reasonCode: "registration_failed",
            reasonMessage: "boom",
            at: new Date(),
          },
        }),
        state({
          name: "c",
          upgradeFailed: {
            version: "3.0.0",
            reasonCode: null,
            reasonMessage: null,
            at: new Date(),
          },
        }),
      ],
      [{ app: "c", org: "acme", code: "registration_failed", message: "threw" }],
    )
    expect(lines.map((l) => [l.name, l.state])).toEqual([
      ["a", "running"],
      ["b", "upgrade_failed"],
      ["c", "failed_to_load"],
    ])
    expect(lines[1]?.upgradeFailed).toEqual({
      version: "3.0.0",
      reasonCode: "registration_failed",
      reasonMessage: "boom",
    })
    expect(lines[2]?.failedIn).toEqual([
      { org: "acme", code: "registration_failed", message: "threw" },
    ])
  })

  it("offers a rollback only when the previous version is on disk and the active one allows it", () => {
    const [ok, gone, security] = statusLines(
      [
        state({ name: "a" }),
        state({ name: "b", previousOnDisk: false }),
        state({ name: "c", noRollback: true }),
      ],
      [],
    )
    expect([ok?.canRollBack, ok?.previousVersion]).toEqual([true, "1.0.0"])
    expect([gone?.canRollBack, gone?.previousVersion]).toEqual([false, null])
    expect([security?.canRollBack, security?.noRollback]).toEqual([false, true])
  })

  it("lists a built-in app that failed to load, without versions", () => {
    const [line] = statusLines(
      [],
      [{ app: "mail", org: "acme", code: "manifest_invalid", message: null }],
    )
    expect(line).toMatchObject({ name: "mail", state: "failed_to_load", version: null })
  })
})

describe("app status", () => {
  it("prints every installed app", async () => {
    const res = await runAppStatus([], deps())
    expect(res.exitCode).toBe(0)
    expect(res.report).toMatchObject({ ok: true, apps: [{ name: "boxtal", state: "running" }] })
  })

  it("asks the services for the named app only, and exits 1 when it is not installed", async () => {
    const asked: Array<string[] | undefined> = []
    const res = await runAppStatus(
      ["nope"],
      deps({
        listStates: async (names) => {
          asked.push(names)
          return []
        },
      }),
    )
    expect(asked).toEqual([["nope"]])
    expect(res.exitCode).toBe(1)
    expect(res.message).toContain("nope is not an installed app")
  })
})

describe("app rollback", () => {
  it("needs a name", async () => {
    const res = await runAppRollback([], deps())
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("liaison app rollback <name>")
  })

  it("reports the version now active", async () => {
    const called: string[] = []
    const res = await runAppRollback(
      ["boxtal"],
      deps({
        rollback: async (name) => {
          called.push(name)
          return { version: "1.0.0", previousVersion: "2.0.0" }
        },
      }),
    )
    expect(called).toEqual(["boxtal"])
    expect(res).toEqual({
      exitCode: 0,
      report: { ok: true, name: "boxtal", version: "1.0.0", rolledBackFrom: "2.0.0" },
    })
  })

  it("exits 1 with the service's reason and the version still running", async () => {
    const refusal = Object.assign(new Error("boxtal 2.0.0 is a security release (noRollback)"), {
      code: "no_rollback",
      runningVersion: "2.0.0",
    })
    const res = await runAppRollback(
      ["boxtal"],
      deps({
        rollback: async () => {
          throw refusal
        },
      }),
    )
    expect(res.exitCode).toBe(1)
    expect(res.report).toEqual({
      ok: false,
      name: "boxtal",
      code: "no_rollback",
      runningVersion: "2.0.0",
    })
    expect(res.message).toContain("security release")
  })
})

const MANIFEST = {
  name: "verify-fixture",
  version: "1.2.0",
  packageFormat: 1,
  license: "MIT",
  scopes: [],
}

function writeManifest(file: string, manifest: Record<string, unknown>): string {
  const path = join(work, file)
  writeFileSync(path, JSON.stringify(manifest))
  return path
}

function writePackage(file: string, manifest: Record<string, unknown>, withBundle = true): string {
  const stage = mkdtempSync(join(work, "stage-"))
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  const files = ["app.manifest.json"]
  if (withBundle) {
    writeFileSync(join(stage, "bundle.js"), "function noop() {}")
    files.push("bundle.js")
  }
  const tar = join(work, file)
  spawnSync("tar", ["-czf", tar, "-C", stage, ...files])
  return tar
}

describe("app verify", () => {
  it("passes a valid manifest, and reports it unsigned", async () => {
    const res = await runAppVerify(writeManifest("ok.json", MANIFEST))
    expect(res.exitCode).toBe(0)
    expect(res.report).toMatchObject({
      ok: true,
      name: "verify-fixture",
      version: "1.2.0",
      signature: { status: "unsigned" },
      checks: [
        { check: "manifest", ok: true },
        { check: "host_api", ok: true },
        { check: "icon", ok: true },
      ],
    })
  })

  it("fails a manifest the schema refuses", async () => {
    const res = await runAppVerify(writeManifest("bad.json", { name: "Bad Name!" }))
    expect(res.exitCode).toBe(1)
    expect(res.report).toMatchObject({ ok: false, checks: [{ check: "manifest", ok: false }] })
  })

  it("fails a host API range this build does not provide", async () => {
    const res = await runAppVerify(writeManifest("host.json", { ...MANIFEST, host: "^99" }))
    expect(res.exitCode).toBe(1)
    const checks = (
      res.report as { checks: Array<{ check: string; ok: boolean; message?: string }> }
    ).checks
    expect(checks.find((c) => c.check === "host_api")).toMatchObject({ ok: false })
    expect(checks.find((c) => c.check === "host_api")?.message).toContain("needs host API ^99")
  })

  it("reports a noRollback security release", async () => {
    const res = await runAppVerify(writeManifest("sec.json", { ...MANIFEST, noRollback: true }))
    expect(res.report).toMatchObject({ ok: true, noRollback: true })
  })

  it("checks a package's files and its manifest", async () => {
    const ok = await runAppVerify(writePackage("ok.liaisonapp", MANIFEST))
    expect(ok.exitCode).toBe(0)
    expect(ok.report).toMatchObject({
      checks: [
        { check: "package", ok: true },
        { check: "manifest", ok: true },
        { check: "host_api", ok: true },
        { check: "icon", ok: true },
      ],
    })
    const missing = await runAppVerify(writePackage("nobundle.liaisonapp", MANIFEST, false))
    expect(missing.exitCode).toBe(1)
    expect(missing.report).toMatchObject({ checks: [{ check: "package", ok: false }] })
  })

  it("exits 2 on a file it cannot read, and with usage when the file is missing", async () => {
    expect((await runAppVerify(join(work, "absent.json"))).exitCode).toBe(2)
    const usage = await runAppOffline(["verify"])
    expect(usage).toMatchObject({ exitCode: 2, report: null })
    expect(usage?.message).toContain("liaison app verify <file|dir>")
  })
})

// The signed statement of a first-party artifact (P3): `verify` checks it with the
// pinned keys and reports the key and what matched.
describe("app verify: signed statement", () => {
  const SIGNED = { ...MANIFEST, host: "^1" }
  const UI = 'import { createSignal as a } from "solid-js";\nexport const x = a(1);\n'
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

  /** An artifact dir as the release publishes it: package, loose files, statement. */
  async function artifact(over: Partial<AppStatement> = {}) {
    const key = await createTestSigningKey("test-cli")
    const dir = mkdtempSync(join(work, "artifact-"))
    const stage = mkdtempSync(join(work, "astage-"))
    writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(SIGNED))
    writeFileSync(join(stage, "bundle.js"), "function noop() {}")
    writeFileSync(join(stage, "ui.js"), UI)
    const pkg = join(dir, "verify-fixture-1.2.0.liaisonapp")
    spawnSync("tar", ["-czf", pkg, "-C", stage, "app.manifest.json", "bundle.js", "ui.js"])
    cpSync(join(stage, "ui.js"), join(dir, "ui.js"))
    cpSync(join(stage, "app.manifest.json"), join(dir, "manifest.json"))
    const statement: AppStatement = {
      v: 1,
      keyId: "test-cli",
      name: "verify-fixture",
      version: "1.2.0",
      hostApi: "^1",
      sha256: {
        ui: sha(UI),
        manifest: sha(JSON.stringify(SIGNED)),
        package: sha(readFileSync(pkg)),
      },
      sourceDigest: "c".repeat(64),
      issuedAt: "2026-10-26T00:00:00.000Z",
      ...over,
    }
    const bytes = statementBytes(statement)
    writeFileSync(join(dir, "statement.json"), bytes)
    writeFileSync(join(dir, "statement.sig"), await key.sign(bytes))
    return { dir, pkg, key }
  }

  it("verifies a dir and a package beside its statement, naming the key and the matches", async () => {
    const { dir, pkg, key } = await artifact()
    for (const target of [dir, pkg]) {
      const res = await runAppVerify(target, { keys: [key.key] })
      expect(res.exitCode).toBe(0)
      expect(res.report).toMatchObject({
        ok: true,
        name: "verify-fixture",
        signature: {
          status: "verified",
          keyId: "test-cli",
          name: "verify-fixture",
          version: "1.2.0",
          matches: { name: true, version: true, ui: true, manifest: true, package: true },
        },
      })
    }
  })

  it("refuses a statement from an unpinned key, against the shipped keys, and with no key at all", async () => {
    const { dir } = await artifact()
    const other = await createTestSigningKey("test-cli")
    const res = await runAppVerify(dir, { keys: [other.key] })
    expect(res.exitCode).toBe(1)
    expect(res.report).toMatchObject({
      ok: false,
      signature: { status: "refused", reason: "bad_signature" },
    })
    // The shipped key list pins the release key(s) only, so a test key's statement
    // fails closed against it.
    expect(APP_SIGNING_KEYS.map((k) => k.keyId)).not.toContain("test-cli")
    const shipped = await runAppVerify(dir)
    expect(shipped.exitCode).toBe(1)
    expect(shipped.report).toMatchObject({
      signature: { status: "refused", reason: "unknown_key" },
    })
    // And an empty key list verifies nothing.
    const none = await runAppVerify(dir, { keys: [] })
    expect(none.exitCode).toBe(1)
    expect(none.report).toMatchObject({ signature: { status: "refused", reason: "no_keys" } })
  })

  it("refuses a statement for another version (swap) and says which hash differs", async () => {
    const swapped = await artifact({ version: "1.1.0" })
    const res = await runAppVerify(swapped.dir, { keys: [swapped.key.key] })
    expect(res.exitCode).toBe(1)
    expect(res.report).toMatchObject({
      signature: { status: "refused", reason: "artifact_mismatch", matches: { version: false } },
    })
    const tampered = await artifact({
      sha256: { ui: "0".repeat(64), manifest: "0".repeat(64), package: "0".repeat(64) },
    })
    const t = await runAppVerify(tampered.pkg, { keys: [tampered.key.key] })
    expect(t.report).toMatchObject({
      signature: { status: "refused", matches: { ui: false, manifest: false, package: false } },
    })
  })

  it("a dir without exactly one package is a usage error", async () => {
    const empty = mkdtempSync(join(work, "empty-"))
    expect((await runAppVerify(empty)).exitCode).toBe(2)
  })
})
