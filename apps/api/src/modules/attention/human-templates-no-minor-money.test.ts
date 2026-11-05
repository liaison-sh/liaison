// SPDX-License-Identifier: FSL-1.1-ALv2
// Standing money-formatting oracle (gestalt contract: money goes through
// currencyExponent()/formatMoneyMinor, never raw minor units in human copy).
//
// Regression it pins: the invoicing overdue-scan attention template once
// interpolated {{data.grand_total_minor}} and the live feed showed
// "Overdue: 3207: 16 days past due (2015800 minor EUR)". Persisted attention
// summaries FREEZE at emit time, so a bad template keeps hurting long after
// the code is fixed — this oracle fails CI the moment any manifest's
// human-facing template references a raw *_minor / *_cents field. Apps must
// interpolate the pre-formatted *_display twin instead.
//
// Scope: every app manifest in the repo (host apps + bundled apps), every
// string in the human-template surfaces (attention translations, approvals,
// agentAttention, digest templates) — plus the literal token " minor " in any
// template string, which is the rendered tell of the same bug class.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
const MANIFEST_ROOTS = [resolve(REPO_ROOT, "apps/api/src/apps"), resolve(REPO_ROOT, "bundled-apps")]

function findManifests(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) continue
    const manifest = join(dir, "app.manifest.json")
    try {
      if (statSync(manifest).isFile()) out.push(manifest)
    } catch {
      /* app without a manifest */
    }
  }
  return out
}

// Human-facing template surfaces: keys whose string values are shown to a
// person verbatim (after {{...}} interpolation). agentInstructions and tool
// descriptions legitimately SAY "minor units" to the agent, so we walk only
// these subtrees.
const HUMAN_TEMPLATE_KEYS = new Set(["attention", "approvals", "agentAttention", "digest"])

function collectHumanTemplateStrings(
  node: unknown,
  path: string,
  inHumanSurface: boolean,
  sink: Array<{ path: string; value: string }>,
): void {
  if (typeof node === "string") {
    if (inHumanSurface) sink.push({ path, value: node })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      collectHumanTemplateStrings(v, `${path}[${i}]`, inHumanSurface, sink)
    })
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectHumanTemplateStrings(
        v,
        path ? `${path}.${k}` : k,
        inHumanSurface || HUMAN_TEMPLATE_KEYS.has(k),
        sink,
      )
    }
  }
}

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g

function isRawMinorMoneyPath(placeholderPath: string): boolean {
  const leaf = placeholderPath.split(".").pop() ?? placeholderPath
  return leaf.endsWith("_minor") || leaf.endsWith("_cents")
}

describe("human-facing manifest templates never leak raw minor-unit money", () => {
  const manifests = MANIFEST_ROOTS.flatMap(findManifests)

  it("finds the manifest corpus (guards against a silent glob regression)", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(5)
  })

  for (const manifestPath of manifests) {
    const rel = relative(REPO_ROOT, manifestPath)
    it(`${rel}`, () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      const strings: Array<{ path: string; value: string }> = []
      collectHumanTemplateStrings(manifest, "", false, strings)

      const violations: string[] = []
      for (const { path, value } of strings) {
        for (const match of value.matchAll(PLACEHOLDER_RE)) {
          const placeholder = (match[1] ?? "").trim()
          if (isRawMinorMoneyPath(placeholder)) {
            violations.push(`${path}: {{${placeholder}}} — interpolate the *_display twin instead`)
          }
        }
        // The rendered tell of the same bug class: template text that would
        // print "<n> minor <CUR>" around an interpolated amount.
        if (/\{\{[^}]+\}\}\s*minor\b/.test(value)) {
          violations.push(`${path}: template renders the literal word "minor" after an amount`)
        }
      }
      expect(violations).toEqual([])
    })
  }
})
