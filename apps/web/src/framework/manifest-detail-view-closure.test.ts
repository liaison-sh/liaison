// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Web-side registration-closure oracle for openEntity.
//
// The API-side detail-view-closure.test.ts checks manifest DATA only. The real
// historical bug lived on the WEB registration walk: bootstrap.ts's
// collectDeclaredComponentNames is a RECURSIVE walker precisely because a flat
// walk misses `views.detail.<entity>.component` (its own comment warns of this).
// If that walk flattens, the missing-export guard no longer knows the detail
// panel component is required; a real UI bundle that omits it registers anyway
// and every `views.detail.<entity>` opens as a dead tab.
//
// This oracle loads the REAL shipped bundled-app manifests from disk and does
// two things:
//   1. Runs the real registration path (registerAppFromManifest) against every
//      manifest and asserts that every `views.detail.<entity>` resolves through
//      the exact openEntity chain: getTabType(app:entity) OR
//      getPanel(app:detail:entity) OR getEntityExternalLink(app, entity).
//   2. Exercises the recursive component-name walk (the same contract as
//      bootstrap.ts's collectDeclaredComponentNames) and asserts it captures
//      every `views.detail.<entity>.component` a real manifest declares — the
//      exact name a flattened walk drops.
//
// red: in `walkComponentNames`, replace the recursive
// `for (const child of ...) walk(child)` descent with a one-level scan (collect
// only node.component + immediate children) -> the shopify/social/ads detail
// panel component names are missed and "the recursive walk captures every
// views.detail component" fails on the missing name.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  getEntityExternalLink,
  getPanel,
  getTabType,
  namespaceRegistryKey,
  resetRegistry,
} from "~/framework/app-registry"
import { type AppManifest, registerAppFromManifest } from "~/framework/define-app"

// apps/web/src/framework -> repo-root/bundled-apps. Resolve relative to this
// file, not CWD (Vitest's CWD varies between root-runner and workspace runs).
// Some Vitest module environments (Node 20 + jsdom) expose a non-file://
// import.meta.url where fileURLToPath throws, so fall back to CWD (apps/web
// under the orchestrator; its grandparent is the repo root).
const REPO_ROOT = (() => {
  try {
    return fileURLToPath(new URL("../../../../..", import.meta.url))
  } catch {
    return path.resolve(process.cwd(), "..", "..")
  }
})()
const BUNDLED_APPS_DIR = join(REPO_ROOT, "bundled-apps")

interface LoadedManifest {
  app: string
  manifest: AppManifest & Record<string, unknown>
}

function loadRealManifests(): LoadedManifest[] {
  return readdirSync(BUNDLED_APPS_DIR)
    .map((dir) => ({ dir, path: join(BUNDLED_APPS_DIR, dir, "app.manifest.json") }))
    .filter(({ path }) => existsSync(path))
    .map(({ dir, path }) => ({
      app: dir,
      manifest: JSON.parse(readFileSync(path, "utf8")) as AppManifest & Record<string, unknown>,
    }))
}

// A complete, correct UI bundle: any export name registerAppFromManifest asks
// for is present (as a stub). This models the shipped bundle, so registration
// itself exercises the full real walk (tabTypes + panels + detail + slots +
// contributions) without a hand-built export bag drifting from the manifest.
function completeExportBag(): Record<string, unknown> {
  const stub = () => null
  return new Proxy({} as Record<string, unknown>, {
    get: () => stub,
    has: () => true,
  })
}

// Recursive component-name collector — the SAME contract as bootstrap.ts's
// collectDeclaredComponentNames. Any node with a string `component` is a
// declared export; the view tree nests (views.detail.<entity>.component), so we
// MUST descend. A flat walk drops detail-panel components; that is the bug this
// oracle guards.
// biome-ignore lint/suspicious/noExplicitAny: walks an arbitrary manifest shape
function walkComponentNames(node: any, out: Set<string>): void {
  if (!node || typeof node !== "object") return
  if (typeof node.component === "string" && node.component.length > 0) out.add(node.component)
  for (const child of Object.values(node)) walkComponentNames(child, out)
}

describe("openEntity registration closure (real bundled manifests, web path)", () => {
  afterEach(() => {
    resetRegistry()
  })

  const manifests = loadRealManifests()

  it("finds the real bundled app manifests", () => {
    expect(manifests.length).toBeGreaterThan(3)
  })

  it("every views.detail entity resolves an open target through the real registration path", () => {
    resetRegistry()
    for (const { manifest } of manifests) {
      registerAppFromManifest(manifest, completeExportBag())
    }

    let checked = 0
    for (const { app, manifest } of manifests) {
      const detail = ((manifest.views as Record<string, unknown> | undefined)?.detail ??
        {}) as Record<string, unknown>
      for (const entity of Object.keys(detail)) {
        checked++
        // The exact openEntity resolution chain (modules/shell/entity-opener.ts):
        const resolved =
          getTabType(`${app}:${entity}`) !== undefined ||
          getPanel(namespaceRegistryKey(app, `detail:${entity}`)) !== undefined ||
          getEntityExternalLink(app, entity) !== undefined
        expect(
          resolved,
          `${app}: views.detail.${entity} resolves no open target (no tab type, no detail panel, no external link) -> dead tab`,
        ).toBe(true)
      }
    }

    // Closed-world guard: if the glob silently drops to near-zero entities,
    // fail loud rather than pass vacuously.
    expect(checked).toBeGreaterThan(5)
  })

  it("the recursive component walk captures every views.detail component (flat-walk regression guard)", () => {
    let detailComponentCount = 0
    for (const { app, manifest } of manifests) {
      const walked = new Set<string>()
      walkComponentNames((manifest.views as Record<string, unknown> | undefined) ?? {}, walked)

      const detail = ((manifest.views as Record<string, unknown> | undefined)?.detail ??
        {}) as Record<string, { component?: string }>
      for (const [entity, block] of Object.entries(detail)) {
        if (typeof block.component !== "string" || block.component.length === 0) continue
        detailComponentCount++
        expect(
          walked.has(block.component),
          `${app}: recursive walk missed views.detail.${entity}.component "${block.component}" (a flattened walk drops nested detail components -> silent missing-export -> dead tab)`,
        ).toBe(true)
      }
    }
    // Closed-world guard: several bundled apps ship detail-panel components
    // (shopify customer/product/..., social finding/dm, ads campaign); if this
    // collapses to zero the glob or the shape changed under us.
    expect(detailComponentCount).toBeGreaterThan(5)
  })
})
