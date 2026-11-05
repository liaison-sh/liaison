// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Inlines the long, doctrine-dense routine `.md` sources (src/routines/*.md,
// with frontmatter) into app.manifest.json's `routines[key].promptTemplate`.
//
// WHY: frozen bundled apps are JSON-only (scripts/freeze-app.ts reads only
// app.manifest.json, bundle.js, ui.js, README/CHANGELOG/LICENSE — no lazy
// co-located .md bodies). Authoring long routine prompts as raw JSON strings
// (escaped newlines) is unreadable and drift-prone; this generator mirrors
// src/skills/gen-manifest-skills.ts exactly for the same frozen-app reason.
//
// Scope: ONLY the two long NEW P6 routine templates (weekly-account-review,
// monthly-deep-review) are authored as .md sources here. The KEPT templates
// (low-roas-autopause, restock-resume) stay hand-authored inline in the
// manifest — this generator does not touch them.
//
// Usage:
//   bun run bundled-apps/ads/src/routines/gen-manifest-routines.ts          # apply (writes manifest)
//   bun run bundled-apps/ads/src/routines/gen-manifest-routines.ts --check  # dry-run (exit 1 on drift)
//
// Determinism: re-running with unchanged .md inputs produces byte-identical
// manifest output. Only the two generated routines[key] entries are touched —
// every other manifest key/ordering (including the other routines) is
// preserved verbatim via a targeted JSON patch, never a full re-serialize.

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROUTINES_DIR = import.meta.dir
const MANIFEST_PATH = join(ROUTINES_DIR, "..", "..", "app.manifest.json")

/** The set of routine keys this generator owns (the two new P6 long prompts). */
export const GENERATED_ROUTINE_FILES = ["weekly-account-review.md", "monthly-deep-review.md"] as const

export interface RoutineFrontmatter {
  description: string
  kind: string
  cron: string
  timezone: string
  scopes: string[]
  enabledByDefault: boolean
}

export interface ManifestRoutine {
  description: string
  kind: string
  cron: string
  timezone: string
  promptTemplate: string
  scopes: string[]
  enabledByDefault: boolean
}

/** Minimal frontmatter parser — splits on the leading `---\n...\n---` block. Mirrors gen-manifest-skills.ts. */
export function parseRoutineMd(raw: string): { frontmatter: RoutineFrontmatter; body: string } {
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
      fm[key] =
        inner.length === 0
          ? []
          : inner.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    } else if (rawValue === "true" || rawValue === "false") {
      fm[key] = rawValue === "true"
    } else {
      fm[key] = rawValue.replace(/^"(.*)"$/, "$1")
    }
  }
  return { frontmatter: fm as unknown as RoutineFrontmatter, body: (rest ?? "").trim() }
}

/** Lists the generated routine `.md` files, in stable filename-sorted order. */
export function listRoutineFiles(): string[] {
  return readdirSync(ROUTINES_DIR)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => (GENERATED_ROUTINE_FILES as readonly string[]).includes(f))
    .sort((a, b) => a.localeCompare(b))
}

/** Keys the manifest routine object by the .md filename slug (without extension). */
function keyFor(file: string): string {
  return file.replace(/\.md$/, "")
}

/** Computes the generated routine entries for the two new P6 templates, keyed by filename slug. */
export function computeGeneratedRoutines(): Record<string, ManifestRoutine> {
  const out: Record<string, ManifestRoutine> = {}
  for (const file of listRoutineFiles()) {
    const raw = readFileSync(join(ROUTINES_DIR, file), "utf8")
    const { frontmatter, body } = parseRoutineMd(raw)
    out[keyFor(file)] = {
      description: frontmatter.description,
      kind: frontmatter.kind,
      cron: frontmatter.cron,
      timezone: frontmatter.timezone,
      promptTemplate: body,
      scopes: frontmatter.scopes,
      enabledByDefault: Boolean(frontmatter.enabledByDefault),
    }
  }
  return out
}

/**
 * Computes the FULL routines block that should live in the manifest: the
 * existing hand-authored entries (low-roas-autopause, restock-resume, and
 * anything else) preserved untouched, plus the generated entries for the two
 * new P6 templates merged in (generated always wins for its own keys).
 */
export function computeFullRoutinesBlock(existingRoutines: Record<string, unknown>): Record<string, unknown> {
  const generated = computeGeneratedRoutines()
  const preserved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(existingRoutines)) {
    if (key in generated) continue // generated entries always win for their own keys
    preserved[key] = value
  }
  return { ...preserved, ...generated }
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

/** Patches ONLY the `routines` key of the manifest object; every other key is untouched. */
export function patchManifestRoutines(manifest: Record<string, unknown>): Record<string, unknown> {
  const existingRoutines = (manifest.routines as Record<string, unknown> | undefined) ?? {}
  const nextRoutines = computeFullRoutinesBlock(existingRoutines)
  return { ...manifest, routines: nextRoutines }
}

function main(): void {
  const checkOnly = process.argv.includes("--check")
  const manifest = loadManifest()
  const patched = patchManifestRoutines(manifest)
  const nextRaw = serializeManifest(patched)
  const currentRaw = readManifestRaw()

  if (checkOnly) {
    if (nextRaw !== currentRaw) {
      process.stderr.write("gen-manifest-routines: manifest is out of date. Run without --check to apply.\n")
      process.exit(1)
    }
    process.stdout.write("gen-manifest-routines: manifest routines block is up to date.\n")
    return
  }

  if (nextRaw === currentRaw) {
    process.stdout.write("gen-manifest-routines: no changes (already up to date).\n")
    return
  }
  writeFileSync(MANIFEST_PATH, nextRaw)
  process.stdout.write(`gen-manifest-routines: wrote ${MANIFEST_PATH}\n`)
}

// Only run when executed directly (not when imported by tests).
if (import.meta.path === Bun.main) {
  main()
}
