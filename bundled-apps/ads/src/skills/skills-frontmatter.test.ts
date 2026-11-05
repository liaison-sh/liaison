// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SKILLS_DIR = import.meta.dir
const MANIFEST_PATH = join(SKILLS_DIR, "..", "..", "app.manifest.json")

const PLAYBOOK_FILES = [
  "01-account-structure-by-budget.md",
  "02-creative-strategy.md",
  "03-audience-doctrine.md",
  "04-testing-and-measurement.md",
  "05-high-aov-funnel.md",
  "06-scaling-and-kill-rules.md",
  "07-google-specifics.md",
  "08-merchant-feed-health.md",
  "09-budget-allocation-brand-activation.md",
]

interface Frontmatter {
  name: string
  description: string
  kind: string
  requiredScopes: string[]
}

/** Minimal frontmatter parser: splits on the leading `---\n...\n---` block. */
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error("no frontmatter block found")
  const [, fmBlock, body] = match
  const fm: Record<string, unknown> = {}
  for (const line of (fmBlock ?? "").split("\n")) {
    if (!line.trim()) continue
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1).trim()
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      // e.g. ["ads:campaigns:read"]
      const inner = rawValue.slice(1, -1).trim()
      fm[key] = inner.length === 0 ? [] : inner.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    } else {
      fm[key] = rawValue.replace(/^"(.*)"$/, "$1")
    }
  }
  return { frontmatter: fm as unknown as Frontmatter, body: body ?? "" }
}

function loadManifestScopes(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { scopes: string[] }
  return manifest.scopes
}

describe("ads Tier-2 playbook frontmatter (src/skills/*.md)", () => {
  const manifestScopes = loadManifestScopes()

  it("all 9 playbook files exist and are non-empty", () => {
    for (const file of PLAYBOOK_FILES) {
      const path = join(SKILLS_DIR, file)
      const raw = readFileSync(path, "utf8")
      expect(raw.length, `${file} should be non-empty`).toBeGreaterThan(0)
    }
  })

  for (const file of PLAYBOOK_FILES) {
    describe(file, () => {
      const raw = readFileSync(join(SKILLS_DIR, file), "utf8")
      const { frontmatter, body } = parseFrontmatter(raw)

      it("parses frontmatter with name/description/kind/requiredScopes", () => {
        expect(typeof frontmatter.name).toBe("string")
        expect(typeof frontmatter.description).toBe("string")
        expect(typeof frontmatter.kind).toBe("string")
        expect(Array.isArray(frontmatter.requiredScopes)).toBe(true)
      })

      it("description length is between 1 and 100 chars", () => {
        expect(frontmatter.description.length).toBeGreaterThanOrEqual(1)
        expect(frontmatter.description.length).toBeLessThanOrEqual(100)
      })

      it("kind is 'playbook'", () => {
        expect(frontmatter.kind).toBe("playbook")
      })

      it("requiredScopes is a non-empty subset of the manifest scopes[] array", () => {
        expect(frontmatter.requiredScopes.length).toBeGreaterThan(0)
        for (const scope of frontmatter.requiredScopes) {
          expect(manifestScopes, `scope '${scope}' in ${file} must be declared in manifest scopes[]`).toContain(
            scope,
          )
        }
      })

      it("name matches the file slug (with numeric prefix, per convention)", () => {
        const slug = file.replace(/\.md$/, "")
        expect(frontmatter.name).toBe(slug)
      })

      it("body is non-empty", () => {
        expect(body.trim().length).toBeGreaterThan(0)
      })
    })
  }
})
