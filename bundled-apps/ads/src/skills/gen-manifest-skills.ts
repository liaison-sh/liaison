// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Inlines the Tier-2 playbook `.md` source files (src/skills/*.md, with
// frontmatter) into app.manifest.json's `skills` object.
//
// WHY: frozen bundled apps are JSON-only (scripts/freeze-app.ts reads only
// app.manifest.json, bundle.js, ui.js, README/CHANGELOG/LICENSE — no lazy
// co-located .md bodies like the in-tree knowledge app uses). The .md files
// here are the authoring source of truth; this script is the one place that
// converts them into the inline `body` strings the frozen manifest ships.
//
// Usage:
//   bun run bundled-apps/ads/src/skills/gen-manifest-skills.ts          # apply (writes manifest)
//   bun run bundled-apps/ads/src/skills/gen-manifest-skills.ts --check  # dry-run (exit 1 on drift)
//
// Determinism: re-running with unchanged .md inputs produces byte-identical
// manifest output. Only the `skills` object is touched — every other
// manifest key/ordering is preserved verbatim via a targeted JSON patch
// rather than a full re-serialize-from-object round trip.

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SKILLS_DIR = import.meta.dir
const MANIFEST_PATH = join(SKILLS_DIR, "..", "..", "app.manifest.json")

export interface PlaybookFrontmatter {
  name: string
  description: string
  kind: string
  requiredScopes: string[]
}

export interface ManifestSkill {
  description: string
  kind: string
  enabledByDefault: boolean
  requiredScopes: string[]
  body: string
}

/** Minimal frontmatter parser — splits on the leading `---\n...\n---` block. */
export function parsePlaybookMd(raw: string): { frontmatter: PlaybookFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error("no frontmatter block found")
  const [, fmBlock, rest] = match
  const fm: Record<string, unknown> = {}
  for (const line of (fmBlock ?? "").split("\n")) {
    if (!line.trim()) continue
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1).trim()
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim()
      fm[key] = inner.length === 0 ? [] : inner.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    } else {
      fm[key] = rawValue.replace(/^"(.*)"$/, "$1")
    }
  }
  return { frontmatter: fm as unknown as PlaybookFrontmatter, body: (rest ?? "").trim() }
}

/** Lists the co-located playbook `.md` files, in stable filename-sorted order. */
export function listPlaybookFiles(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Computes the generated `skills` block for the 9 Tier-2 playbooks, keyed by
 * playbook `name` (frontmatter name, WITH the numeric prefix per convention).
 * Does NOT include the existing `ads-playbook` entry — callers merge it in.
 */
export function computePlaybookSkills(): Record<string, ManifestSkill> {
  const out: Record<string, ManifestSkill> = {}
  for (const file of listPlaybookFiles()) {
    const raw = readFileSync(join(SKILLS_DIR, file), "utf8")
    const { frontmatter, body } = parsePlaybookMd(raw)
    out[frontmatter.name] = {
      description: frontmatter.description,
      kind: frontmatter.kind,
      enabledByDefault: false,
      requiredScopes: frontmatter.requiredScopes,
      body,
    }
  }
  return out
}

/**
 * Computes the FULL skills block that should live in the manifest: the
 * existing hand-authored entries (e.g. ads-playbook) preserved
 * untouched, plus the 9 generated playbook entries merged in.
 */
export function computeFullSkillsBlock(existingSkills: Record<string, unknown>): Record<string, unknown> {
  const playbooks = computePlaybookSkills()
  const preserved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(existingSkills)) {
    if (key in playbooks) continue // generated playbooks always win for their own keys
    preserved[key] = value
  }
  return { ...preserved, ...playbooks }
}

function readManifestRaw(): string {
  return readFileSync(MANIFEST_PATH, "utf8")
}

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readManifestRaw())
}

/** Re-serializes the manifest with the repo's JSON style: 2-space indent, trailing newline. */
function serializeManifest(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Patches ONLY the `skills` key of the manifest object; every other key is untouched. */
export function patchManifestSkills(manifest: Record<string, unknown>): Record<string, unknown> {
  const existingSkills = (manifest.skills as Record<string, unknown> | undefined) ?? {}
  const nextSkills = computeFullSkillsBlock(existingSkills)
  return { ...manifest, skills: nextSkills }
}

function main(): void {
  const checkOnly = process.argv.includes("--check")
  const manifest = loadManifest()
  const patched = patchManifestSkills(manifest)
  const nextRaw = serializeManifest(patched)
  const currentRaw = readManifestRaw()

  if (checkOnly) {
    if (nextRaw !== currentRaw) {
      process.stderr.write("gen-manifest-skills: manifest is out of date. Run without --check to apply.\n")
      process.exit(1)
    }
    process.stdout.write("gen-manifest-skills: manifest skills block is up to date.\n")
    return
  }

  if (nextRaw === currentRaw) {
    process.stdout.write("gen-manifest-skills: no changes (already up to date).\n")
    return
  }
  writeFileSync(MANIFEST_PATH, nextRaw)
  process.stdout.write(`gen-manifest-skills: wrote ${MANIFEST_PATH}\n`)
}

// Only run when executed directly (not when imported by tests).
if (import.meta.path === Bun.main) {
  main()
}
