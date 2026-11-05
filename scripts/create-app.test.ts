// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import { createApp } from "./create-app"

const NAME = "test-scaffold-app"

// Scaffold into an isolated temp repo root so the generated app is never
// discovered by the real auto-discovery during other test runs.
let repoRoot: string

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true })
})

describe("createApp", () => {
  it("creates backend + frontend dirs with required files", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    const { backendDir, frontendDir } = await createApp({ name: NAME, repoRoot })
    expect(existsSync(join(backendDir, "app.manifest.json"))).toBe(true)
    expect(existsSync(join(backendDir, "manifest-descriptor.ts"))).toBe(true)
    expect(existsSync(join(backendDir, "handlers.ts"))).toBe(true)
    expect(existsSync(join(backendDir, "handlers.test.ts"))).toBe(true)
    expect(existsSync(join(frontendDir, "Panel.tsx"))).toBe(true)
  })

  it("manifest declares the app name and a placeholder scope", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    const { backendDir } = await createApp({ name: NAME, repoRoot })
    const m = JSON.parse(readFileSync(join(backendDir, "app.manifest.json"), "utf8"))
    expect(m.name).toBe(NAME)
    expect(m.scopes).toContain(`${NAME}:items:read`)
  })

  it("generates a manifest that passes packageManifestSchema validation", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    const { backendDir } = await createApp({ name: NAME, repoRoot })
    const raw = JSON.parse(readFileSync(join(backendDir, "app.manifest.json"), "utf8"))
    // A scaffolded app must be freezable/installable out of the box — if the
    // template manifest drifts from the schema, `app:freeze` would fail later.
    const result = packageManifestSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })

  it("substitutes the PascalCase class name into the descriptor and panel", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    const { backendDir, frontendDir } = await createApp({ name: NAME, repoRoot })
    const descriptor = readFileSync(join(backendDir, "manifest-descriptor.ts"), "utf8")
    expect(descriptor).toContain("TestScaffoldAppAppManifest")
    const panel = readFileSync(join(frontendDir, "Panel.tsx"), "utf8")
    expect(panel).toContain("TestScaffoldAppPanel")
    expect(panel).toContain(`data-testid="${NAME}-panel"`)
  })

  it("rejects a name that already exists", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    await createApp({ name: NAME, repoRoot })
    await expect(createApp({ name: NAME, repoRoot })).rejects.toThrow(/exists/)
  })

  it("rejects invalid app names (non-kebab-case)", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    await expect(createApp({ name: "Bad_Name", repoRoot })).rejects.toThrow(/kebab-case/i)
  })

  it("when `outDir` is set, writes a single flat tree (no apps/api split) at outDir", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "scaffold-"))
    const outDir = join(repoRoot, "external-app")
    const { backendDir, frontendDir } = await createApp({ name: NAME, outDir, repoRoot })
    // backend files land at outDir/ (top-level), frontend files land at outDir/web/
    expect(backendDir).toBe(outDir)
    expect(frontendDir).toBe(join(outDir, "web"))
    expect(existsSync(join(outDir, "app.manifest.json"))).toBe(true)
    expect(existsSync(join(outDir, "handlers.ts"))).toBe(true)
    expect(existsSync(join(outDir, "web", "Panel.tsx"))).toBe(true)
    // crucially: NOT scaffolded into liaison/apps/api/src/apps/<name>/
    expect(existsSync(join(repoRoot, "apps/api/src/apps", NAME))).toBe(false)
  })
})
