// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SCRIPT = path.join(import.meta.dir, "check-desktop-no-node.ts")
const roots: string[] = []

type DependencyKind =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies"

interface Dependency {
  name: string
  /** Which manifest field declares it. Defaults to `dependencies`. */
  kind?: DependencyKind
  engines?: Record<string, string>
  /** Written as the package's bin script, shebang included. */
  binScript?: string
  /** Declared in the manifest but never written to node_modules. */
  missing?: boolean
}

function fixture(
  dependency: Dependency | null,
  manifest: Record<string, unknown> = {},
  app: "desktop" | "mobile" = "desktop",
): string {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-no-node-"))
  roots.push(root)
  const pkg = path.join(root, "apps", app)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: `@liaison/${app}-fixture`,
      [dependency?.kind ?? "dependencies"]: dependency ? { [dependency.name]: "1.0.0" } : {},
      ...manifest,
    }),
  )
  if (dependency && !dependency.missing) {
    const dep = path.join(pkg, "node_modules", dependency.name)
    mkdirSync(dep, { recursive: true })
    writeFileSync(
      path.join(dep, "package.json"),
      JSON.stringify({
        name: dependency.name,
        version: "1.0.0",
        ...(dependency.engines ? { engines: dependency.engines } : {}),
        ...(dependency.binScript ? { bin: { [dependency.name]: "cli.js" } } : {}),
      }),
    )
    if (dependency.binScript) writeFileSync(path.join(dep, "cli.js"), dependency.binScript)
  }
  return root
}

function run(root: string) {
  return Bun.spawnSync(["bun", SCRIPT, "--root", root], { stdout: "pipe", stderr: "pipe" })
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("check-desktop-no-node", () => {
  it("exits 1 when a scanned package.json declares engines.node with no bun key", () => {
    const result = run(fixture({ name: "needs-node", engines: { node: ">=20" } }))
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("needs-node")
  })

  it("exits 0 when every dependency is bun-compatible", () => {
    expect(run(fixture(null)).exitCode).toBe(0)
    expect(run(fixture({ name: "bun-ok", engines: { node: ">=20", bun: ">=1" } })).exitCode).toBe(0)
  })

  it("exits 1 when a declared dependency cannot be resolved at all", () => {
    // Silently skipping an unresolvable dependency is how the gate passed while
    // inspecting nothing: an uninstalled tree must fail loudly, not look clean.
    const result = run(fixture({ name: "never-installed", missing: true }))
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("never-installed")
  })

  it("exits 1 when the scanned package itself declares engines.node with no bun key", () => {
    const result = run(fixture(null, { engines: { node: ">=20" } }))
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("engines.node")
  })

  it("exits 1 when a script in the scanned package shells to node", () => {
    const result = run(fixture(null, { scripts: { start: "node ./server.js" } }))
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("start")
  })

  it("exits 1 when a dependency's bin entry is a node shebang script", () => {
    const result = run(
      fixture({ name: "node-bin", binScript: "#!/usr/bin/env node\nconsole.log(1)\n" }),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("node-bin")
  })

  it("exits 0 when a dependency's bin entry is a bun shebang script", () => {
    const result = run(
      fixture({ name: "bun-bin", binScript: "#!/usr/bin/env bun\nconsole.log(1)\n" }),
    )
    expect(result.exitCode).toBe(0)
  })

  it("exits 1 when an optional or peer dependency needs node", () => {
    // The four platform packages that carry the shipped Claude Code CLI are
    // optionalDependencies: a gate that reads only dependencies and
    // devDependencies never looks at the binary the app actually ships.
    for (const kind of ["optionalDependencies", "peerDependencies"] as const) {
      const result = run(fixture({ name: "needs-node", kind, engines: { node: ">=20" } }))
      expect(result.stdout.toString()).toContain("needs-node")
      expect(result.exitCode).toBe(1)
    }
  })

  it("exits 1 when an allowlisted dependency is not installed at all", () => {
    // The allowlist is evidence about a package that is there. Skipping the
    // resolve because a name is allowlisted lets the gate vouch for nothing.
    const result = run(fixture({ name: "typescript", missing: true }))
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("typescript")
  })

  it("names every inspected dependency and its verdict", () => {
    const result = run(fixture({ name: "bun-ok", engines: { node: ">=20", bun: ">=1" } }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toMatch(/bun-ok: inspected/)
  })

  it("exits 1 when apps/mobile declares a dependency that needs node", () => {
    // The mobile shell ships the same way the desktop one does: a webview and
    // native code, no Node runtime. A gate that only ever looked at
    // apps/desktop would have vouched for nothing here.
    const result = run(fixture({ name: "needs-node", engines: { node: ">=20" } }, {}, "mobile"))
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("needs-node")
  })

  it("exits 0 against the real apps/mobile tree", () => {
    const result = Bun.spawnSync(["bun", SCRIPT], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stdout.toString() + result.stderr.toString()).toContain("apps/mobile")
    expect(result.exitCode).toBe(0)
  })

  it("exits 0 against the real apps/desktop tree", () => {
    const result = Bun.spawnSync(["bun", SCRIPT], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stdout.toString() + result.stderr.toString()).toContain("apps/desktop")
    expect(result.exitCode).toBe(0)
  })
})
