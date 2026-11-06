// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  checkBundledAppVersions,
  type FreezePackage,
  freezePackage,
  main,
} from "./check-bundled-app-version"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), content)
}

const manifest = (version: string) => JSON.stringify({ name: "demo", version })

/** A repo whose `base` branch has bundled-apps/demo at 1.0.0, checked out on `work`. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "bundled-version-"))
  dirs.push(root)
  git(root, "init", "-q", "-b", "base")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "t")
  write(root, "bundled-apps/demo/app.manifest.json", manifest("1.0.0"))
  write(root, "bundled-apps/demo/handlers.ts", "export const a = 1\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "base")
  git(root, "checkout", "-qb", "work")
  return root
}

function commit(root: string): void {
  git(root, "add", ".")
  git(root, "commit", "-qm", "change")
}

describe("check-bundled-app-version", () => {
  it("refuses a source change that keeps the version", async () => {
    const root = repo()
    write(root, "bundled-apps/demo/handlers.ts", "export const a = 2\n")
    commit(root)
    expect(await checkBundledAppVersions(root, "base")).toEqual([
      { app: "demo", base: "1.0.0", head: "1.0.0", files: ["handlers.ts"] },
    ])
    expect(await main(["--base", "base"], {}, root)).toBe(1)
  })

  it("refuses an uncommitted change too, and a lowered version", async () => {
    const root = repo()
    write(root, "bundled-apps/demo/handlers.ts", "export const a = 3\n")
    write(root, "bundled-apps/demo/app.manifest.json", manifest("0.9.0"))
    expect((await checkBundledAppVersions(root, "base")).map((i) => i.head)).toEqual(["0.9.0"])
  })

  it("accepts a source change with a raised version", async () => {
    const root = repo()
    write(root, "bundled-apps/demo/handlers.ts", "export const a = 2\n")
    write(root, "bundled-apps/demo/app.manifest.json", manifest("1.0.1"))
    commit(root)
    expect(await checkBundledAppVersions(root, "base")).toEqual([])
    expect(await main(["--base", "base"], {}, root)).toBe(0)
  })

  it("ignores test files, build output and a new app", async () => {
    const root = repo()
    write(root, "bundled-apps/demo/handlers.test.ts", "test\n")
    write(root, "bundled-apps/demo/__tests__/x.ts", "x\n")
    write(root, "bundled-apps/other/app.manifest.json", manifest("0.1.0"))
    commit(root)
    expect(await checkBundledAppVersions(root, "base")).toEqual([])
  })

  it("is skipped without a base", async () => {
    expect(await main([], {}, "/nonexistent")).toBe(0)
  })

  // The demo deploy of 2026-11-02 failed at migrate: a change to
  // packages/app-sdk/src/app-settings.ts reached invoicing's PDF templates while
  // invoicing kept 0.20.12, and the check only looked under bundled-apps/invoicing/.
  describe("workspace package files the app's package carries", () => {
    const SETTINGS = "packages/app-sdk/src/app-settings.ts"
    /** A packager whose demo package carries app-settings.ts; `reaches` says whether its code lands. */
    const fakeFreeze =
      (reaches: boolean, calls: string[] = []): FreezePackage =>
      async (root, app, overrides) => {
        calls.push(`${app}${overrides ? "+base" : ""}`)
        if (app !== "demo") return { bytes: new Uint8Array([0]), sources: [] }
        const settings = overrides?.get(SETTINGS) ?? readFileSync(join(root, SETTINGS), "utf8")
        return {
          bytes: new TextEncoder().encode(reaches ? settings : "same"),
          sources: ["bundled-apps/demo/handlers.ts", SETTINGS],
        }
      }

    function repoWithSdk(): string {
      const root = repo()
      git(root, "checkout", "-q", "base")
      write(root, SETTINGS, "export const k = 1\n")
      commit(root)
      git(root, "checkout", "-q", "work")
      git(root, "merge", "-q", "base")
      return root
    }

    it("refuses a shared change that reaches the package and keeps the version", async () => {
      const root = repoWithSdk()
      write(root, SETTINGS, "export const k = 2\n")
      commit(root)
      const calls: string[] = []
      expect(await checkBundledAppVersions(root, "base", fakeFreeze(true, calls))).toEqual([
        { app: "demo", base: "1.0.0", head: "1.0.0", files: [SETTINGS] },
      ])
      expect(calls).toEqual(["demo", "demo+base"])
      expect(await main(["--base", "base"], {}, root, fakeFreeze(true))).toBe(1)
    })

    it("accepts it with a raised version, and when the bundler drops the change", async () => {
      const root = repoWithSdk()
      write(root, SETTINGS, "export const k = 2\n")
      write(root, "bundled-apps/demo/app.manifest.json", manifest("1.0.1"))
      commit(root)
      expect(await checkBundledAppVersions(root, "base", fakeFreeze(true))).toEqual([])

      const shaken = repoWithSdk()
      write(shaken, SETTINGS, "export const k = 2\n")
      commit(shaken)
      expect(await checkBundledAppVersions(shaken, "base", fakeFreeze(false))).toEqual([])
    })

    it("counts the app as changed when the base package cannot be made", async () => {
      const root = repoWithSdk()
      write(root, SETTINGS, "export const k = 2\n")
      commit(root)
      const failing: FreezePackage = async (r, app, overrides) => {
        if (overrides) throw new Error("cannot overlay")
        return fakeFreeze(false)(r, app)
      }
      expect((await checkBundledAppVersions(root, "base", failing)).map((i) => i.app)).toEqual([
        "demo",
      ])
    })

    it("freezes nothing when no shared file changed, and ignores shared tests", async () => {
      const root = repoWithSdk()
      write(root, "bundled-apps/demo/handlers.test.ts", "test\n")
      write(root, "packages/app-sdk/src/app-settings.test.ts", "test\n")
      write(root, "apps/api/src/x.ts", "x\n")
      commit(root)
      const never: FreezePackage = async () => {
        throw new Error("froze an app although no shared file changed")
      }
      expect(await checkBundledAppVersions(root, "base", never)).toEqual([])
    })

    // `bun install` in an app (scripts/build-bundled-app.sh, so any test that builds the
    // catalog) installs its workspace packages as copies, and the bundlers read those.
    describe("through the app's installed copy of a workspace package", () => {
      const SDK = "packages/app-sdk/src/index.ts"
      const COPY = "bundled-apps/demo/node_modules/@liaison/app-sdk/src/index.ts"
      const sdk = (k: number) => `export const k = ${k}\nconsole.log(k)\n`
      const packageJson = JSON.stringify({ name: "@liaison/app-sdk", main: "src/index.ts" })

      /** A repo whose demo app imports the SDK from an installed copy of it. */
      function repoWithCopy(): string {
        const root = mkdtempSync(join(tmpdir(), "bundled-copy-"))
        dirs.push(root)
        git(root, "init", "-q", "-b", "base")
        git(root, "config", "user.email", "t@example.com")
        git(root, "config", "user.name", "t")
        write(root, ".gitignore", "node_modules\n")
        for (const dir of ["packages/app-sdk", "bundled-apps/demo/node_modules/@liaison/app-sdk"]) {
          write(root, `${dir}/package.json`, packageJson)
          write(root, `${dir}/src/index.ts`, sdk(1))
        }
        write(
          root,
          "bundled-apps/demo/app.manifest.json",
          JSON.stringify({
            name: "copy-demo",
            version: "1.0.0",
            packageFormat: 1,
            license: "MIT",
            scopes: [],
          }),
        )
        write(
          root,
          "bundled-apps/demo/handlers.ts",
          'import { k } from "@liaison/app-sdk"\nexport const a = k\n',
        )
        commit(root)
        git(root, "checkout", "-qb", "work")
        return root
      }

      it("reports the workspace file, never the copy, and an overlay reaches the bytes", async () => {
        const root = repoWithCopy()
        const now = await freezePackage(root, "demo")
        expect(now.sources).toContain(SDK)
        expect(now.sources).not.toContain(COPY)
        const same = await freezePackage(root, "demo", new Map([[SDK, sdk(1)]]))
        expect(Buffer.from(same.bytes).equals(Buffer.from(now.bytes))).toBe(true)
        const other = await freezePackage(root, "demo", new Map([[SDK, sdk(2)]]))
        expect(Buffer.from(other.bytes).equals(Buffer.from(now.bytes))).toBe(false)
      })

      it("still refuses a shared change that keeps the version", async () => {
        const root = repoWithCopy()
        write(root, SDK, sdk(2))
        write(root, COPY, sdk(2))
        commit(root)
        expect(await checkBundledAppVersions(root, "base")).toEqual([
          { app: "demo", base: "1.0.0", head: "1.0.0", files: [SDK] },
        ])
      })

      it("refuses to build from a copy older than its source", async () => {
        const root = repoWithCopy()
        write(root, SDK, sdk(2))
        await expect(freezePackage(root, "demo")).rejects.toThrow("the installed copy is stale")
      })
    })

    // The real packager: the files it reports, and a base overlay that reaches the bytes.
    it("the packager reports the shared files it inlines, never a test file, and overlays them", async () => {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
      const now = await freezePackage(repoRoot, "invoicing")
      expect(now.sources).toContain("bundled-apps/invoicing/app.manifest.json")
      expect(now.sources).toContain("bundled-apps/invoicing/templates/shared.ts")
      expect(now.sources).toContain(SETTINGS)
      expect(now.sources.filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f))).toEqual([])
      expect(now.sources.filter((f) => f.split("/").includes("node_modules"))).toEqual([])

      const current = readFileSync(join(repoRoot, SETTINGS), "utf8")
      const same = await freezePackage(repoRoot, "invoicing", new Map([[SETTINGS, current]]))
      expect(Buffer.from(same.bytes).equals(Buffer.from(now.bytes))).toBe(true)
      const marked = `${current}\nexport const OVERLAY_MARKER = "overlay-marker-7f3a"\nconsole.log(OVERLAY_MARKER)\n`
      const other = await freezePackage(repoRoot, "invoicing", new Map([[SETTINGS, marked]]))
      expect(Buffer.from(other.bytes).equals(Buffer.from(now.bytes))).toBe(false)
    }, 120_000)
  })
})
