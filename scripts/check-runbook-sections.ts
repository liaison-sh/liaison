#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:runbook-sections [path]`
//
// Asserts that the production-bootstrap runbook contains the nine required
// section headings in order. Exits 1 with the first missing heading. With no
// path it checks DEFAULT_RUNBOOK, the one runbook these sections are for, so
// the bare package script is a real check rather than a usage error.

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** The production-bootstrap runbook, checked when no path is given. */
export const DEFAULT_RUNBOOK = resolve(import.meta.dir, "../docs/runbooks/production-bootstrap.md")

export const REQUIRED_SECTIONS = [
  "Prerequisites",
  "Initial provisioning",
  "First-run bootstrap",
  "TLS + DNS",
  "Backups",
  "Restore drill",
  "Upgrade",
  "Incident playbook",
  "Where to file issues",
]

export interface CheckResult {
  ok: boolean
  missing: string[]
  outOfOrder: string[]
}

export function checkRunbook(text: string): CheckResult {
  const headingLines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,3})\s+(.+)/.exec(line)
    if (m) headingLines.push(m[2].trim())
  }
  const missing: string[] = []
  const seenIndices: number[] = []
  for (const section of REQUIRED_SECTIONS) {
    const idx = headingLines.findIndex(
      (h) =>
        h.toLowerCase() === section.toLowerCase() ||
        h.toLowerCase().includes(section.toLowerCase()),
    )
    if (idx < 0) {
      missing.push(section)
    } else {
      seenIndices.push(idx)
    }
  }
  const outOfOrder: string[] = []
  for (let i = 1; i < seenIndices.length; i++) {
    if (seenIndices[i] < seenIndices[i - 1]) {
      outOfOrder.push(REQUIRED_SECTIONS[i])
    }
  }
  return { ok: missing.length === 0 && outOfOrder.length === 0, missing, outOfOrder }
}

async function main() {
  const path = process.argv[2] ?? DEFAULT_RUNBOOK
  const abs = resolve(path)
  if (!existsSync(abs)) {
    console.error(`runbook not found: ${abs}`)
    process.exit(1)
  }
  const text = readFileSync(abs, "utf8")
  const result = checkRunbook(text)
  if (result.ok) {
    console.log(`✓ ${path}: all ${REQUIRED_SECTIONS.length} sections present in order`)
    return
  }
  for (const m of result.missing) console.error(`missing section: ${m}`)
  for (const m of result.outOfOrder) console.error(`out of order: ${m}`)
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
