#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:spdx`
//
// Walks scripts/, deploy/, qa/, .github/workflows/, and any *.sh / *.sql in
// the repo. For each file matching the syntax table extensions, asserts that
// exactly one SPDX header line is present at the top (after a shebang for
// shell). Fails with the offending file path + reason.
//
// Track E (Task 57). Task 56 (bulk insertion) is the one-time codemod that
// seeds existing files; this script is the validator the CI gate runs.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve } from "node:path"

const REPO_ROOT = process.env.LIAISON_ROOT
  ? resolve(process.env.LIAISON_ROOT)
  : resolve(new URL("..", import.meta.url).pathname)

// Directories that MUST be SPDX-tagged, per spec Track E:
// source files in apps/, packages/, scripts/ get exactly one SPDX header.
// deploy/ + .github/workflows are operator-facing infra and included for
// consistency; qa/load too because the k6 scripts ship in the same release.
const SCOPED_DIRS = ["apps", "packages", "scripts", "deploy", "qa/load", ".github/workflows"]

const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".sh",
  ".sql",
  ".yml",
  ".yaml",
])

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-e2e",
  ".git",
  ".cache",
  ".turbo",
  "out",
  ".vite",
  "public",
  "test-results",
  "logs",
])

// Exclude generated artifacts and snapshot fixtures — adding a comment to
// these would break the generator round-trip or invalidate the snapshot.
function isExcludedPath(rel: string): boolean {
  // A self-hosted instance's provisioning input (config + gathered company
  // knowledge), gitignored and written by the setup playbook, never source.
  if (rel.startsWith("deploy/setup/")) return true
  // Generated drizzle migrations metadata (regen-controlled by drizzle-kit)
  if (rel.includes("/db/migrations/meta/")) return true
  // Generated i18n dictionaries (regen by scripts/i18n-gen-dictionaries.ts)
  if (rel.includes("/i18n/generated/")) return true
  if (rel.endsWith("/i18n/locales/_generated.ts")) return true
  // Gitignored desktop sidecar build output (bun compile entry shims written
  // by the sidecar build under apps/desktop/sidecar/.entries/; never committed).
  if (rel.includes("/sidecar/.entries/")) return true
  // The bundled Atelier (MIT, D39): upstream bytes the sidecar checks against
  // its MANIFEST.json, with the upstream LICENSE beside them.
  if (rel.includes("apps/desktop/sidecar/vendor/atelier/")) return true
  // Playwright + visual snapshots
  if (rel.endsWith(".snap") || rel.endsWith(".snap.png")) return true
  if (rel.includes("__snapshots__/")) return true
  if (rel.includes("-snapshots/")) return true
  return false
}

const SPDX_LINE = /SPDX-License-Identifier:\s*FSL-1\.1-ALv2/

// Number of lines from the top of the file where an SPDX header may legally
// live. References to SPDX strings deeper in the file (e.g., in test fixtures
// or in the codemod's TYPES table) are not counted as "headers."
const HEADER_LINES = 8

function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (EXCLUDED_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (e.isFile()) yield full
  }
}

export interface CheckIssue {
  path: string
  reason: "missing" | "duplicate"
}

export function checkSpdxIn(roots: string[]): CheckIssue[] {
  const issues: CheckIssue[] = []
  for (const root of roots) {
    let exists: boolean
    try {
      exists = statSync(root).isDirectory()
    } catch {
      continue
    }
    if (!exists) continue
    for (const file of walk(root)) {
      if (!EXTENSIONS.has(extname(file))) continue
      const rel = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file
      if (isExcludedPath(rel)) continue
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const header = text.split("\n").slice(0, HEADER_LINES).join("\n")
      const matches = header.match(/SPDX-License-Identifier:[^\n]*/g) ?? []
      const valid = matches.filter((m) => SPDX_LINE.test(m))
      if (valid.length === 0) issues.push({ path: file, reason: "missing" })
      else if (valid.length > 1) issues.push({ path: file, reason: "duplicate" })
    }
  }
  return issues
}

async function main() {
  const roots = SCOPED_DIRS.map((d) => resolve(REPO_ROOT, d))
  const issues = checkSpdxIn(roots)
  if (issues.length === 0) {
    console.log("✓ check:spdx — all in-scope files have a single SPDX header")
    return
  }
  for (const i of issues) {
    console.error(`${i.reason}: ${i.path}`)
  }
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
