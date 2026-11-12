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

  it("a member with only knowledge scopes gets no adapter, even with knowledge scopes", () => {
    const sources = sourcesFor(["knowledge:documents:read", "knowledge:sources:read"])
    expect(sources).toEqual([])
  })

  // Google Drive and GitLab sync through their own source kinds (bundled apps,
  // app-sources.ts): no kernel adapter, whatever the scopes.
  it("no connector is a kernel adapter here, whatever the scopes", () => {
    expect(sourcesFor(["google-drive:accounts:read", "gitlab:repo:read"])).toEqual([])
    expect(sourcesFor(["*"])).toEqual([])
  })
})
