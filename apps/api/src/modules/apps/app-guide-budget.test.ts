// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The CORE of an app guide rides in the cached prefix the moment one of the
// app's tools is loaded, on every step for the life of the thread. Measured
// before the split: tickets 33,600 chars, shopify 41,600, boxtal 32,900,
// invoicing 31,700, a DM that touched five apps carried 35,000 tokens of
// guides. The core is bounded here; everything else lives in sections keyed
// by the tools they are about (app-guide.ts).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { normalizeAppGuide } from "~/modules/agent/context/app-guide"

export const APP_GUIDE_CORE_MAX_CHARS = 4_000

const ROOT = path.resolve(import.meta.dir, "../../../../..")
const MANIFESTS = [
  ...new Bun.Glob("apps/api/src/apps/*/app.manifest.json").scanSync(ROOT),
  ...new Bun.Glob("bundled-apps/*/app.manifest.json").scanSync(ROOT),
]

describe("app guide core budget", () => {
  it("finds the manifests", () => {
    expect(MANIFESTS.length).toBeGreaterThan(8)
  })

  for (const rel of MANIFESTS) {
    it(`${rel}: the core is at most ${APP_GUIDE_CORE_MAX_CHARS} chars`, () => {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, rel), "utf-8"))
      if (!manifest.agentInstructions) return
      const guide = normalizeAppGuide(manifest.agentInstructions)
      expect(guide.core.length).toBeLessThanOrEqual(APP_GUIDE_CORE_MAX_CHARS)
      for (const section of guide.sections) {
        expect(section.tools.length).toBeGreaterThan(0)
        expect(section.text.trim().length).toBeGreaterThan(0)
      }
    })
  }
})
