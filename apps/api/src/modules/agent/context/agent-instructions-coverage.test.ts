// SPDX-License-Identifier: FSL-1.1-ALv2
// Directory-driven coverage (success criterion 13): every PRODUCT manifest — host
// (apps/api/src/apps) and bundled (bundled-apps) — must declare a non-empty
// `agentInstructions`. The enumerated quality test (agent-instructions.test.ts)
// checks the curated 80–6000 bounds + banned literals; THIS test catches "someone
// added app N and forgot the key" — a gap an enumerated map cannot see.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const API_APPS = join(import.meta.dir, "..", "..", "..", "apps") // apps/api/src/apps
const BUNDLED = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "bundled-apps")

// Test/fixture apps legitimately carry no agentInstructions — they are never
// registered as product apps. Everything else MUST declare a non-empty one.
const FIXTURE_SKIP = new Set(["chaos-debug", "example", "test", "test-bridge-a", "test-bridge-b"])

function productManifests(root: string): { app: string; path: string }[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !FIXTURE_SKIP.has(d.name))
    .map((d) => ({ app: d.name, path: join(root, d.name, "app.manifest.json") }))
    .filter((m) => {
      try {
        readFileSync(m.path)
        return true
      } catch {
        return false
      }
    })
}

describe("every product manifest declares a non-empty agentInstructions", () => {
  const all = [...productManifests(API_APPS), ...productManifests(BUNDLED)]

  it("found a non-trivial set of product manifests (sanity)", () => {
    expect(all.length).toBeGreaterThanOrEqual(10) // 7 host product + 5 bundled
  })

  it.each(all)("$app declares a non-empty agentInstructions", ({ path }) => {
    const m = JSON.parse(readFileSync(path, "utf8")) as { agentInstructions?: unknown }
    const raw = m.agentInstructions
    // A guide is a string or { core, sections } (app-guide.ts); the core is
    // what rides with the app, so it is what must be non-empty.
    const core = typeof raw === "string" ? raw : ((raw as { core?: unknown })?.core ?? "")
    expect(typeof core).toBe("string")
    expect(String(core).trim().length).toBeGreaterThan(0)
  })
})
