// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { devAppRoots, discoverInstalledApps, discoverInTreeApps } from "./discover-apps"

describe("discoverInTreeApps", () => {
  it("returns every app dir under apps/api/src/apps/ that has manifest+descriptor", async () => {
    const apps = await discoverInTreeApps()
    const names = apps.map((a) => a.name)
    expect(names).toContain("mail")
    expect(names).toContain("contacts")
    expect(names).toContain("tickets")
    expect(names).toContain("example")
  })

  it("ignores directories missing app.manifest.json or manifest-descriptor.ts", async () => {
    const root = mkdtempSync(join(tmpdir(), "liaison-disc-"))
    try {
      mkdirSync(join(root, "halfbuilt"), { recursive: true })
      writeFileSync(join(root, "halfbuilt", "app.manifest.json"), "{}")
      // No manifest-descriptor.ts → must be skipped
      const apps = await discoverInTreeApps({ rootOverride: root })
      expect(apps.map((a) => a.name)).not.toContain("halfbuilt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("throws when a dir name doesn't match the manifest's name field", async () => {
    const root = mkdtempSync(join(tmpdir(), "liaison-disc-"))
    try {
      mkdirSync(join(root, "MyApp"), { recursive: true })
      writeFileSync(
        join(root, "MyApp", "app.manifest.json"),
        JSON.stringify({ name: "my-app", version: "0.0.1" }),
      )
      writeFileSync(join(root, "MyApp", "manifest-descriptor.ts"), "export const x = {}")
      await expect(discoverInTreeApps({ rootOverride: root })).rejects.toThrow(
        /dir.*name.*manifest|manifest.*name.*dir/i,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("walks LIAISON_DEV_APP_ROOTS in test and development only", async () => {
    const a = mkdtempSync(join(tmpdir(), "liaison-disc-dev-a-"))
    const b = mkdtempSync(join(tmpdir(), "liaison-disc-dev-b-"))
    const prev = { NODE_ENV: process.env.NODE_ENV, ROOTS: process.env.LIAISON_DEV_APP_ROOTS }
    try {
      mkdirSync(join(b, "outside-app"), { recursive: true })
      writeFileSync(
        join(b, "outside-app", "app.manifest.json"),
        JSON.stringify({ name: "outside-app", version: "0.0.1" }),
      )
      writeFileSync(join(b, "outside-app", "manifest-descriptor.ts"), "export const x = {}")
      process.env.LIAISON_DEV_APP_ROOTS = ` ${a}${delimiter}${b} `

      process.env.NODE_ENV = "test"
      expect(devAppRoots()).toEqual([a, b])
      const names = (await discoverInTreeApps()).map((x) => x.name)
      expect(names).toContain("outside-app")
      expect(names).toContain("mail")

      process.env.NODE_ENV = "production"
      expect(devAppRoots()).toEqual([])
      expect((await discoverInTreeApps()).map((x) => x.name)).not.toContain("outside-app")
    } finally {
      process.env.NODE_ENV = prev.NODE_ENV
      if (prev.ROOTS === undefined) delete process.env.LIAISON_DEV_APP_ROOTS
      else process.env.LIAISON_DEV_APP_ROOTS = prev.ROOTS
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("gates test-only apps by NODE_ENV (synthetic fixture, not the real tree)", async () => {
    // A fixture root with one test-only app and one regular app, so the test
    // does not depend on which apps happen to exist under apps/api/src/apps/.
    const root = mkdtempSync(join(tmpdir(), "liaison-disc-env-"))
    const prev = process.env.NODE_ENV
    try {
      for (const name of ["test-bridge-a", "normal-app"]) {
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(
          join(root, name, "app.manifest.json"),
          JSON.stringify({ name, version: "0.0.1" }),
        )
        writeFileSync(join(root, name, "manifest-descriptor.ts"), "export const x = {}")
      }

      process.env.NODE_ENV = "production"
      const prod = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
      expect(prod).not.toContain("test-bridge-a")
      expect(prod).toContain("normal-app")

      process.env.NODE_ENV = "test"
      const test = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
      expect(test).toContain("test-bridge-a")
      expect(test).toContain("normal-app")
    } finally {
      process.env.NODE_ENV = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe("TEST_ONLY_APPS env gate — default-deny (security, Vuln 3)", () => {
    function makeFixtureRoot() {
      const root = mkdtempSync(join(tmpdir(), "liaison-disc-gate-"))
      for (const name of ["test-bridge-a", "chaos-debug", "normal-app"]) {
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(
          join(root, name, "app.manifest.json"),
          JSON.stringify({ name, version: "0.0.1" }),
        )
        writeFileSync(join(root, name, "manifest-descriptor.ts"), "export const x = {}")
      }
      return root
    }

    function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
      const saved: Record<string, string | undefined> = {}
      for (const k of Object.keys(env)) saved[k] = process.env[k]
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      return fn().finally(() => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      })
    }

    it("loads chaos-debug under NODE_ENV=test + CHAOS_DEBUG=1", async () => {
      const root = makeFixtureRoot()
      try {
        await withEnv({ NODE_ENV: "test", CHAOS_DEBUG: "1" }, async () => {
          const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
          expect(apps).toContain("chaos-debug")
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it("loads chaos-debug under NODE_ENV=development + CHAOS_DEBUG=1", async () => {
      const root = makeFixtureRoot()
      try {
        await withEnv({ NODE_ENV: "development", CHAOS_DEBUG: "1" }, async () => {
          const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
          expect(apps).toContain("chaos-debug")
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it("skips chaos-debug under NODE_ENV=test when CHAOS_DEBUG is unset", async () => {
      const root = makeFixtureRoot()
      try {
        await withEnv({ NODE_ENV: "test", CHAOS_DEBUG: undefined }, async () => {
          const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
          expect(apps).not.toContain("chaos-debug")
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    const productionLike = [
      "production",
      "Production",
      "PRODUCTION",
      "prod",
      "staging",
      "stage",
      "qa",
      "preview",
      undefined,
      "",
      "live",
      "main",
      "dev",
      "local",
      "asdf",
    ]
    for (const env of productionLike) {
      it(`skips chaos-debug under NODE_ENV=${JSON.stringify(env)} even with CHAOS_DEBUG=1`, async () => {
        const root = makeFixtureRoot()
        try {
          await withEnv({ NODE_ENV: env, CHAOS_DEBUG: "1" }, async () => {
            const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
            expect(apps).not.toContain("chaos-debug")
          })
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    }

    const acceptedCaseVariants = [
      "test",
      "TEST",
      "Test",
      "development",
      "DEVELOPMENT",
      "Development",
    ]
    for (const env of acceptedCaseVariants) {
      it(`loads chaos-debug under NODE_ENV=${JSON.stringify(env)} + CHAOS_DEBUG=1 (case-insensitive)`, async () => {
        const root = makeFixtureRoot()
        try {
          await withEnv({ NODE_ENV: env, CHAOS_DEBUG: "1" }, async () => {
            const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
            expect(apps).toContain("chaos-debug")
          })
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    }

    it("test-bridge-a loads under NODE_ENV=test without CHAOS_DEBUG flag (no per-app flag)", async () => {
      const root = makeFixtureRoot()
      try {
        await withEnv({ NODE_ENV: "test", CHAOS_DEBUG: undefined }, async () => {
          const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
          expect(apps).toContain("test-bridge-a")
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it("test-bridge-a skips under NODE_ENV=staging", async () => {
      const root = makeFixtureRoot()
      try {
        await withEnv({ NODE_ENV: "staging", CHAOS_DEBUG: undefined }, async () => {
          const apps = (await discoverInTreeApps({ rootOverride: root })).map((a) => a.name)
          expect(apps).not.toContain("test-bridge-a")
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})

describe("discoverInstalledApps", () => {
  it("returns versioned app dirs under the install root", async () => {
    const root = mkdtempSync(join(tmpdir(), "liaison-inst-"))
    try {
      const appDir = join(root, "shopify", "1.2.0")
      mkdirSync(appDir, { recursive: true })
      writeFileSync(
        join(appDir, "app.manifest.json"),
        JSON.stringify({ name: "shopify", version: "1.2.0" }),
      )
      writeFileSync(join(appDir, "bundle.js"), "// noop")
      const apps = await discoverInstalledApps({ rootOverride: root })
      expect(apps).toHaveLength(1)
      expect(apps[0].name).toBe("shopify")
      expect(apps[0].version).toBe("1.2.0")
      expect(apps[0].bundlePath).toBe(join(appDir, "bundle.js"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("env var LIAISON_APPS_DIR is read on every call (not cached at module load)", async () => {
    const a = mkdtempSync(join(tmpdir(), "liaison-inst-a-"))
    const b = mkdtempSync(join(tmpdir(), "liaison-inst-b-"))
    const prev = process.env.LIAISON_APPS_DIR
    try {
      mkdirSync(join(b, "x", "1.0.0"), { recursive: true })
      writeFileSync(
        join(b, "x", "1.0.0", "app.manifest.json"),
        JSON.stringify({ name: "x", version: "1.0.0" }),
      )
      writeFileSync(join(b, "x", "1.0.0", "bundle.js"), "// noop")
      process.env.LIAISON_APPS_DIR = a
      const first = await discoverInstalledApps()
      expect(first).toHaveLength(0)
      process.env.LIAISON_APPS_DIR = b
      const second = await discoverInstalledApps()
      expect(second.map((x) => x.name)).toContain("x")
    } finally {
      process.env.LIAISON_APPS_DIR = prev
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("throws when a dir name doesn't match the manifest's name field", async () => {
    const root = mkdtempSync(join(tmpdir(), "liaison-inst-"))
    try {
      const bad = join(root, "Shopify", "1.0.0")
      mkdirSync(bad, { recursive: true })
      writeFileSync(
        join(bad, "app.manifest.json"),
        JSON.stringify({ name: "shopify", version: "1.0.0" }),
      )
      writeFileSync(join(bad, "bundle.js"), "// noop")
      await expect(discoverInstalledApps({ rootOverride: root })).rejects.toThrow(/name/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns empty array when install root doesn't exist", async () => {
    const apps = await discoverInstalledApps({ rootOverride: "/nonexistent/liaison/apps/xyz" })
    expect(apps).toEqual([])
  })

  it("populates uiBundlePath when ui.js is present alongside bundle.js", async () => {
    const root = mkdtempSync(join(tmpdir(), "liaison-inst-ui-"))
    try {
      const appDir = join(root, "with-ui", "1.0.0")
      mkdirSync(appDir, { recursive: true })
      writeFileSync(
        join(appDir, "app.manifest.json"),
        JSON.stringify({ name: "with-ui", version: "1.0.0" }),
      )
      writeFileSync(join(appDir, "bundle.js"), "// noop")
      writeFileSync(join(appDir, "ui.js"), "export const SettingsPanel = () => null")
      const apps = await discoverInstalledApps({ rootOverride: root })
      expect(apps).toHaveLength(1)
      expect(apps[0].uiBundlePath).toBe(join(appDir, "ui.js"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("omits uiBundlePath when ui.js is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "liaison-inst-no-ui-"))
    try {
      const appDir = join(root, "no-ui", "1.0.0")
      mkdirSync(appDir, { recursive: true })
      writeFileSync(
        join(appDir, "app.manifest.json"),
        JSON.stringify({ name: "no-ui", version: "1.0.0" }),
      )
      writeFileSync(join(appDir, "bundle.js"), "// noop")
      const apps = await discoverInstalledApps({ rootOverride: root })
      expect(apps).toHaveLength(1)
      expect(apps[0].uiBundlePath).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
