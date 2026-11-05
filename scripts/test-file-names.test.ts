// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test files are named after the behaviour they cover, never after the
// development phase or the sequence number they were written in. A name like
// `phase9-s8-bulk-assign` or `web-03-messaging` tells a reader nothing once the
// plan that numbered it is gone, and it lets two lanes collide on one number.
// This guard walks the Playwright scenarios (every path segment, so a phase
// folder is caught too) and every apps/api test file.
import { describe, expect, it } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const E2E_ROOT = "apps/web/src/tests/e2e"
const API_ROOT = "apps/api/src"
const PHASE_NAME = /phase-?\d+/
const SEQUENCE_NAME = /^web-\d{2}-/

function walk(rel: string, out: string[]): void {
  for (const entry of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.endsWith("-snapshots")) continue
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) walk(child, out)
    else out.push(child)
  }
}

function isBadSegment(segment: string): boolean {
  return PHASE_NAME.test(segment) || SEQUENCE_NAME.test(segment)
}

function badTestFileNames(): string[] {
  const bad: string[] = []
  const e2e: string[] = []
  walk(E2E_ROOT, e2e)
  for (const file of e2e) {
    const segments = file.slice(E2E_ROOT.length + 1).split("/")
    if (segments.some(isBadSegment)) bad.push(file)
  }
  const api: string[] = []
  walk(API_ROOT, api)
  for (const file of api) {
    if (/\.test\.tsx?$/.test(file) && isBadSegment(path.basename(file))) bad.push(file)
  }
  return bad.sort()
}

describe("test file names describe behaviour", () => {
  it("no e2e or api test file is named after a phase or a web-NN sequence number", () => {
    expect(badTestFileNames()).toEqual([])
  })
})
