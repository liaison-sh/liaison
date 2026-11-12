// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The default registry: each source app's own read scope gates its adapter.

import { describe, expect, it } from "bun:test"
import { registerDefaultKnowledgeSources } from "~/apps/knowledge/source-registry"
import type { RlsClient } from "~/db"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:sources:read"],
  dimensionGrants: {},
}

describe("registerDefaultKnowledgeSources: the source app's own read scope gates the adapter", () => {
  // Building the registry runs no query; the credential is only resolved when an
  // adapter is used, so a stand-in tx is enough to see which adapters exist.
  const build = (scopes: string[]) =>
    registerDefaultKnowledgeSources({
      tx: {} as unknown as RlsClient,
      orgId: "org-1",
      userId: "u1",
      scopes,
    })
  const sourcesFor = (scopes: string[]) =>
    build(scopes)
      .listEnabled({ ...actor, scopes })
      .map((a) => a.source)

  it("a member without the GitLab or Drive scope gets neither adapter, even with knowledge scopes", () => {
    const sources = sourcesFor(["knowledge:documents:read", "knowledge:sources:read"])
    expect(sources).not.toContain("gitlab")
    expect(sources).not.toContain("google-drive")
  })

  it("holding gitlab:repo:read adds the GitLab adapter only", () => {
    const sources = sourcesFor(["gitlab:repo:read"])
    expect(sources).toContain("gitlab")
    expect(sources).not.toContain("google-drive")
  })

  it("holding the Drive read scope adds the Drive adapter only", () => {
    const sources = sourcesFor(["google-drive:accounts:read"])
    expect(sources).toContain("google-drive")
    expect(sources).not.toContain("gitlab")
  })

  it("the wildcard holder gets both", () => {
    const sources = sourcesFor(["*"])
    expect(sources).toContain("gitlab")
    expect(sources).toContain("google-drive")
  })
})
