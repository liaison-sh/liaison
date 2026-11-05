// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool's scopes live in ONE field, `requiredScopes`. Two fields for one
// concept let a reader consult the wrong one: approvals read `tool.scope` while
// the tool declared only `requiredScopes`, so every approved call was refused.
//
// Three layers keep the second field from coming back:
//   1. the registry value type has no `scope`, so reading or writing it on a
//      typed tool definition does not compile (required-scopes.test.ts pins
//      that with @ts-expect-error), and registration refuses the key at runtime;
//   2. every manifest in the tree declares `requiredScopes` and never `scope`
//      (below), and the contract refuses a manifest that does;
//   3. an oracle over non-test source (tool-scope-read-oracle.test.ts) for the
//      reads the type cannot see: a value typed `any`, or cast to an ad hoc
//      `{ scope?: ... }` shape. Every `scope` read is either allowlisted by its
//      exact line with the reason it is NOT a tool definition, or it fails.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { validateAppManifest } from "~/modules/apps/contract"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function manifestPaths(): string[] {
  const dirs = [
    "bundled-apps",
    "apps/api/src/apps",
    "apps/api/test-support/apps",
    "scripts/templates",
  ]
  const out: string[] = []
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(ROOT, dir, entry.name, "app.manifest.json")
      try {
        statSync(path)
        out.push(path)
      } catch {
        // No manifest in this directory.
      }
    }
  }
  return out.sort()
}

describe("manifests: a tool lists its scopes in requiredScopes only", () => {
  const paths = manifestPaths()

  it("finds the manifests it guards", () => {
    expect(paths.length).toBeGreaterThanOrEqual(20)
  })

  for (const path of paths) {
    it(`${relative(ROOT, path)}: no tool carries scope, every tool declares requiredScopes`, () => {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        tools?: Record<string, Record<string, unknown>>
      }
      for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
        expect(Object.hasOwn(tool, "scope"), `${name} carries the retired scope key`).toBe(false)
        const required = tool.requiredScopes
        expect(Array.isArray(required), `${name} has no requiredScopes`).toBe(true)
        expect(
          (required as unknown[]).length,
          `${name} has an empty requiredScopes`,
        ).toBeGreaterThan(0)
      }
    })
  }

  it("the contract refuses a manifest tool that carries scope, and names the tool", () => {
    const result = validateAppManifest({
      name: "guardapp",
      version: "1.0.0",
      description: "fixture",
      tools: {
        legacy_tool: {
          description: "declares the retired key",
          handler: "legacyTool",
          scope: "guardapp:items:read",
        },
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("tools.legacy_tool.scope")
    expect(result.error).toContain('"requiredScopes"')
  })

  it("the contract checks EVERY requiredScopes entry against the app namespace", () => {
    const result = validateAppManifest({
      name: "guardapp",
      version: "1.0.0",
      description: "fixture",
      tools: {
        mixed: {
          description: "second scope escapes the namespace",
          handler: "mixed",
          requiredScopes: ["guardapp:items:read", "kernel:users:admin"],
        },
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('tools.mixed.requiredScopes: must start with "guardapp:"')
    expect(result.error).toContain('(got "kernel:users:admin")')
    expect(result.error).not.toContain('(got "guardapp:items:read")')
  })
})
