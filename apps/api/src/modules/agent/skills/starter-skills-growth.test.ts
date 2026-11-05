// SPDX-License-Identifier: FSL-1.1-ALv2
// Module K (K4): the starter skill library must grow beyond its pre-pipeline
// entry set by at least the two spec-named net-new playbooks (routine-state
// diagnosis on projects; vendor-invoice-to-Pennylane flow on invoicing). The
// registry is the runtime projection of these manifest/descriptor declarations
// 1:1 (runtime.ts), so asserting on DECLARED skills is the faithful, fast
// equivalent of "the registry grew" without booting a per-org runtime.
import { describe, expect, it } from "bun:test"
import { knowledgeAppManifest } from "~/apps/knowledge/manifest-descriptor"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import invoicingManifest from "../../../../../../bundled-apps/invoicing/app.manifest.json"

function countSkills(m: { skills?: Record<string, unknown> }): number {
  return m.skills ? Object.keys(m.skills).length : 0
}

describe("starter skill library grew beyond its pre-pipeline entry set", () => {
  it("the routine-state diagnosis skill is registered on projects (net-new)", () => {
    expect(countSkills(projectsAppManifest)).toBeGreaterThan(0)
    expect(Object.keys(projectsAppManifest.skills ?? {})).toContain("diagnose-routine-state")
  })

  it("the vendor-invoice-to-Pennylane flow skill is registered on invoicing (net-new)", () => {
    expect(
      Object.keys((invoicingManifest as { skills?: Record<string, unknown> }).skills ?? {}),
    ).toContain("vendor-invoice-to-pennylane")
  })

  it("total declared skill defs exceed the pre-pipeline baseline", () => {
    // Pre-pipeline these four manifests summed to: tickets 5 (2 JSON + 3
    // descriptor) + knowledge 2 (overview + descriptor create) + projects 0 +
    // invoicing 1 = 8. The two net-new skills push it to >= 10. Floor-pinned
    // (> 8, not === 10) so adding MORE skills later never breaks the test.
    const live =
      countSkills(ticketsAppManifest) +
      countSkills(knowledgeAppManifest) +
      countSkills(projectsAppManifest) +
      countSkills(invoicingManifest as { skills?: Record<string, unknown> })
    expect(live).toBeGreaterThan(8)
  })
})
