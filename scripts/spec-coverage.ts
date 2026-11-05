#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Spec coverage check — extracts success-criteria identifiers from a phase
 * spec and verifies that at least one test (file or describe block) carries
 * a matching `[SC<n>]` marker, so a missing criterion fails closed.
 *
 * Usage:
 *   bun scripts/spec-coverage.ts \
 *     --spec path/to/spec.md \
 *     --search-roots apps/web/src,apps/api/src \
 *     --output /tmp/strobe/tests/spec-coverage.md
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

interface Args {
  specs: string[]
  searchRoots: string[]
  output?: string
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { searchRoots: [], specs: [] }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if ((a === "--spec" || a === "--main-spec" || a === "--phase-spec") && next) {
      args.specs!.push(next)
      i++
    } else if (a === "--search-roots" && next) {
      args.searchRoots = next.split(",")
      i++
    } else if (a === "--output" && next) {
      args.output = next
      i++
    }
  }
  if (!args.specs || args.specs.length === 0) {
    throw new Error("--spec, --main-spec, or --phase-spec <path> is required")
  }
  if (!args.searchRoots || args.searchRoots.length === 0) {
    args.searchRoots = ["apps/web/src", "apps/api/src"]
  }
  return args as Args
}

async function listFiles(root: string, out: string[] = []): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = resolve(root, name)
    const s = await stat(full)
    if (s.isDirectory()) await listFiles(full, out)
    else if (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".json")) {
      out.push(full)
    }
  }
  return out
}

function specSlug(specPath: string): string {
  const fromFile = basename(specPath).match(/phase-(\d+(?:-\d+)*)-spec/i)
  if (fromFile) return `phase${fromFile[1]!.replace(/-/g, ".")}`
  const fromDir = basename(dirname(specPath)).match(/phase-(\d+(?:-\d+)*)/i)
  if (fromDir) return `phase${fromDir[1]!.replace(/-/g, ".")}`
  return basename(specPath)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase()
}

function extractCriteria(specBody: string, slug: string): string[] {
  // Indexes numbered list items in the "Success Criteria" section. Items are
  // plain markdown ordered-list entries: `1. The X does Y.`
  const ids = new Set<string>()
  const sectionMatch = specBody.match(/##\s+\d+\.[^\n]*Success Criteria[\s\S]+?(?=\n##\s+\d+\.|$)/i)
  const region = sectionMatch ? sectionMatch[0] : specBody
  // Skip the section heading line; only ordered-list items inside the section.
  const numbered = region.matchAll(/^\s{0,3}(\d+)\.\s+\S/gm)
  for (const m of numbered) ids.add(`${slug}:SC${m[1]}`)
  // Also accept explicit [SCn] markers anywhere in the spec body.
  for (const m of specBody.matchAll(/\[SC(\d+)\]/g)) ids.add(`${slug}:SC${m[1]}`)
  return Array.from(ids).sort(compareCriterionIds)
}

function compareCriterionIds(a: string, b: string): number {
  const [aSlug, aSc] = a.split(":")
  const [bSlug, bSc] = b.split(":")
  if (aSlug !== bSlug) return aSlug.localeCompare(bSlug)
  return Number(aSc?.slice(2) ?? 0) - Number(bSc?.slice(2) ?? 0)
}

function isTestFile(file: string): boolean {
  return /(?:\.test|\.scenario\.test)\.tsx?$/.test(file)
}

function normalizeMarker(raw: string, slugs: string[]): string | null {
  const namespaced = raw.match(/^([a-z0-9._-]+):SC(\d+)$/i)
  if (namespaced) return `${namespaced[1]!.toLowerCase()}:SC${namespaced[2]}`
  const legacy = raw.match(/^SC(\d+)$/i)
  if (legacy && slugs.length === 1) return `${slugs[0]}:SC${legacy[1]}`
  return null
}

async function findCoverageMarkers(
  files: string[],
  slugs: string[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  for (const file of files.filter(isTestFile)) {
    const body = await readFile(file, "utf8")
    for (const call of body.matchAll(/\b(?:it|test)\s*\(\s*(["'`])([\s\S]*?)\1/g)) {
      const testName = call[2].trim()
      for (const m of testName.matchAll(/\[((?:[a-z0-9._-]+:)?SC\d+)\]/gi)) {
        const id = normalizeMarker(m[1]!, slugs)
        if (!id) continue
        const tests = found.get(id) ?? []
        tests.push(testName)
        found.set(id, tests)
      }
    }
  }
  return found
}

async function findProductionMarkers(files: string[]): Promise<string[]> {
  const offenders: string[] = []
  for (const file of files.filter((f) => !isTestFile(f))) {
    const body = await readFile(file, "utf8")
    if (/\[(?:[a-z0-9._-]+:)?SC\d+\]/i.test(body)) offenders.push(file)
  }
  return offenders
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const specEntries = await Promise.all(
    args.specs.map(async (spec) => ({
      spec,
      slug: specSlug(spec),
      body: await readFile(spec, "utf8"),
    })),
  )
  const slugs = specEntries.map((entry) => entry.slug)
  const expected = Array.from(
    new Set(specEntries.flatMap((entry) => extractCriteria(entry.body, entry.slug))),
  ).sort(compareCriterionIds)
  const allFiles: string[] = []
  for (const root of args.searchRoots) {
    await listFiles(resolve(root), allFiles)
  }
  const productionMarkers = await findProductionMarkers(allFiles)
  const found = await findCoverageMarkers(allFiles, slugs)
  const missing = expected.filter((id) => !found.has(id))
  const lines: string[] = []
  lines.push(`# Spec Coverage Report — ${args.specs.join(", ")}`)
  lines.push("")
  lines.push(`Total criteria: ${expected.length}`)
  lines.push(`Covered: ${expected.length - missing.length}`)
  lines.push(`Missing: ${missing.length}`)
  lines.push(`Production marker violations: ${productionMarkers.length}`)
  lines.push("")
  lines.push("| ID | Status | Tests |")
  lines.push("|----|--------|-------|")
  for (const id of expected) {
    const tests = found.get(id) ?? []
    lines.push(
      `| ${id} | ${tests.length > 0 ? "covered" : "MISSING"} | ${tests.map(escapeTableCell).join("<br>")} |`,
    )
  }
  if (productionMarkers.length > 0) {
    lines.push("")
    lines.push("## Production Marker Violations")
    for (const file of productionMarkers) lines.push(`- ${file}`)
  }
  const report = lines.join("\n")
  if (args.output) {
    await writeFile(args.output, report, "utf8")
    console.log(`Wrote ${args.output}`)
  } else {
    console.log(report)
  }
  if (missing.length > 0 || productionMarkers.length > 0) {
    console.error(`Missing coverage for: ${missing.join(", ")}`)
    if (productionMarkers.length > 0) {
      console.error(`Production files contain [SCn] markers: ${productionMarkers.join(", ")}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
