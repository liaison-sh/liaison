// SPDX-License-Identifier: FSL-1.1-ALv2
// Drift guard: the kernel owns the `monitoring` notification group and lists the
// incident kinds by name (`MONITORING_INCIDENT_KINDS`); the monitoring bundled app
// owns the kinds its manifest translations write. If a manifest kind is renamed,
// the incident would silently fall back to the `work` group (explicit list, no
// prefix match), so this test ties the two together. It lives in apps/api because a
// bundled app may only import `@liaison/app-sdk`, and the kernel constant must not
// depend on a bundled app.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { groupForKind, MONITORING_INCIDENT_KINDS } from "@liaison/shared"

const MANIFEST_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "bundled-apps",
  "monitoring",
  "app.manifest.json",
)

function manifestKinds(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    attention: { translations: { kind: string }[] }
  }
  return manifest.attention.translations.map((t) => t.kind)
}

describe("monitoring notification group stays in step with the monitoring manifest", () => {
  it("MONITORING_INCIDENT_KINDS equals the set of kinds the manifest translations write", () => {
    const kinds = manifestKinds()
    // Not vacuous: the manifest has several translations per kind.
    expect(kinds.length).toBeGreaterThan(0)
    expect([...new Set(kinds)].sort()).toEqual([...MONITORING_INCIDENT_KINDS].sort())
  })

  it("every kind the manifest writes routes to the monitoring group", () => {
    for (const kind of manifestKinds())
      expect({ kind, group: groupForKind(kind) }).toEqual({ kind, group: "monitoring" })
  })
})
