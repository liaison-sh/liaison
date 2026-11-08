// SPDX-License-Identifier: FSL-1.1-ALv2
// An org's move carries its custom apps' outbound-domain grant as is: revoked
// domains stay revoked on the target; a source without the field (an older
// release, or a grandfathered row) keeps every declared domain.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { type CustomAppPackage, installCustomAppPackages } from "./custom-apps"

const ORG = "00000000-0000-4000-8000-0000000d0a01"

function pkg(over: Partial<CustomAppPackage> = {}): CustomAppPackage {
  const bytes = Buffer.from(`package ${crypto.randomUUID()}`)
  return {
    name: "crm-oabcdef12",
    version: "1.0.0",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    schema: "app_crm_oabcdef12",
    b64: bytes.toString("base64"),
    installedBy: "00000000-0000-4000-8000-0000000d0a02",
    grantedScopes: [],
    grantedConnections: [],
    grantedCapabilities: [],
    grantedCrossAppCalls: [],
    approveUiFullAccess: false,
    ...over,
  }
}

async function installedWith(p: CustomAppPackage) {
  const seen: Array<Record<string, unknown>> = []
  await installCustomAppPackages(ORG, "t1", [p], (async (opts) => {
    seen.push(opts as unknown as Record<string, unknown>)
    return { name: p.name, version: p.version }
  }) as Parameters<typeof installCustomAppPackages>[3])
  return seen[0]
}

describe("custom apps on an org move", () => {
  it("records the source's domain grant as is", async () => {
    const opts = await installedWith(pkg({ grantedDomains: ["api.crm.example"] }))
    expect(opts.recordedDomains).toEqual(["api.crm.example"])
    expect(opts.grantedDomains).toBeUndefined()
  })

  it("a grandfathered or older source keeps every declared domain", async () => {
    expect((await installedWith(pkg({ grantedDomains: null }))).recordedDomains).toBeUndefined()
    expect((await installedWith(pkg())).recordedDomains).toBeUndefined()
  })
})
