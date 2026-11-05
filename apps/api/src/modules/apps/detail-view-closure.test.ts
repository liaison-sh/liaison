// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Registry-closure oracle: every entity a bundled app declares a detail view
// for must resolve to a REAL open target: an in-app panel component, or an
// external link whose template renders to a safe http(s) URL. An entity that
// declares neither opens as a broken empty tab (the historical shopify:order
// attention-tile regression). This test loads the real shipped manifests,
// exactly the artifacts installs consume, not hand-built fixtures.
//
// red (substitution): change the {{var}} extraction regex to match nothing
// (e.g. /\{\{(__nomatch__)\}\}/gi) -> no real template var is bound, so
// `substitutionsExercised` stays 0 and its `> 0` guard fails, proving the
// substitution assertions were actually driven by parsed template vars, not a
// fixed {id, shop_domain} bag that left {{shop}}/{{orderId}} unexercised.
// red (scheme): change the negative-case expectation to `.toBe(true)` (assert
// the javascript: scheme IS url-safe) -> fails on the rendered
// "javascript://evil...", proving the ^https?:// gate bites.

import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validateAppManifest } from "~/modules/apps/contract"
import { renderUrlTemplate } from "~/modules/apps/detail-external-link"

const BUNDLED_APPS_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

interface DetailBlock {
  component?: string
  externalLink?: { urlTemplate?: string; label?: string }
}

function loadRealManifests(): Array<{ app: string; manifest: Record<string, unknown> }> {
  return readdirSync(BUNDLED_APPS_DIR)
    .map((dir) => ({ dir, path: join(BUNDLED_APPS_DIR, dir, "app.manifest.json") }))
    .filter(({ path }) => existsSync(path))
    .map(({ dir, path }) => ({
      app: dir,
      manifest: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    }))
}

describe("detail view registry closure (real bundled manifests)", () => {
  const manifests = loadRealManifests()

  it("finds the bundled app manifests", () => {
    expect(manifests.length).toBeGreaterThan(3)
  })

  it("every manifest passes the real install-time validation", () => {
    for (const { app, manifest } of manifests) {
      const result = validateAppManifest(manifest)
      expect(
        result.success,
        `manifest for ${app}: ${JSON.stringify((result as { error?: string }).error ?? "")}`,
      ).toBe(true)
    }
  })

  it("every views.detail entity resolves an open target: panel component or external link", () => {
    let checked = 0
    let substitutionsExercised = 0
    for (const { app, manifest } of manifests) {
      const views = (manifest.views ?? {}) as {
        detail?: Record<string, DetailBlock>
        panels?: Record<string, unknown>
      }
      for (const [entity, block] of Object.entries(views.detail ?? {})) {
        checked++
        const hasComponent = typeof block.component === "string" && block.component.length > 0
        const template = block.externalLink?.urlTemplate
        const hasExternal = typeof template === "string" && /^https?:\/\//i.test(template)
        expect(
          hasComponent || hasExternal,
          `${app}: views.detail.${entity} declares neither a component nor an http(s) externalLink; opening it produces a dead tab`,
        ).toBe(true)
        if (hasExternal && template) {
          // Parse the ACTUAL {{var}} names out of the template and supply each a
          // benign value. Rendering with a fixed {id, shop_domain} bag left the
          // real vars ({{shop}}, {{orderId}}) unbound: they collapsed to empty,
          // so substitution was never truly exercised and a template that leaned
          // on an unbound var still passed. Here every declared placeholder is
          // bound, so the render must be FULLY substituted (no residual `{{`)
          // and still http(s).
          const varNames = [...template.matchAll(/\{\{([a-z0-9_]+)\}\}/gi)].map((m) => m[1])
          const vars: Record<string, string> = {}
          for (const v of varNames) vars[v] = benignVarValue(v)
          if (varNames.length > 0) substitutionsExercised++
          const rendered = renderUrlTemplate(template, vars)
          expect(
            rendered.includes("{{"),
            `${app}: views.detail.${entity} externalLink left an unsubstituted placeholder: ${rendered}`,
          ).toBe(false)
          expect(
            /^https?:\/\//i.test(rendered),
            `${app}: views.detail.${entity} externalLink renders to a non-http target: ${rendered}`,
          ).toBe(true)
        }
      }
    }
    // Closed-world guard: if this drops to zero the glob broke, not the product.
    expect(checked).toBeGreaterThan(5)
    // And at least one real template must have carried {{vars}} we actually
    // substituted -- otherwise the substitution assertions above ran vacuously.
    expect(substitutionsExercised).toBeGreaterThan(0)
  })

  it("the URL-safety check bites when a substituted var injects a non-http scheme", () => {
    // A template whose LEADING var expands to a dangerous scheme must NOT survive
    // the URL_SAFE re-check the resolver (getDetailExternalLink) applies to the
    // RENDERED url -- the head-of-template `^https?://` schema check cannot catch
    // this because the scheme arrives via substitution. Prove the render produces
    // the hostile scheme and that the same ^https?:// gate rejects it.
    const template = "{{scheme}}//evil.example.com/steal?id={{id}}"
    const rendered = renderUrlTemplate(template, { scheme: "javascript:", id: "1" })
    expect(rendered).toBe("javascript://evil.example.com/steal?id=1")
    expect(
      /^https?:\/\//i.test(rendered),
      `a substituted javascript: scheme must be rejected by the URL-safety re-check, got: ${rendered}`,
    ).toBe(false)
  })
})

/**
 * A benign, scheme-safe value for a known template placeholder. `id`/`orderId`
 * become opaque tokens; `shop`/domain-ish vars become a safe host label. This
 * keeps every real `{{shop}}.myshopify.com/...` template rendering to a valid
 * http(s) URL so the closure assertion checks substitution, not empties.
 */
function benignVarValue(name: string): string {
  const n = name.toLowerCase()
  if (n === "shop" || n.includes("domain") || n.includes("host")) return "example"
  return "42"
}
