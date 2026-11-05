// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Registry-level unit test: the database Knowledge source is folder-capable
// and is discovered by `listFolderCapableSources`. Uses the documented
// unit-test path (createKnowledgeSourceRegistry + explicit adapter) rather than
// `registerDefaultKnowledgeSources`, which needs a live RLS tx.

import { describe, expect, it } from "bun:test"
import { createDatabaseKnowledgeAdapter } from "~/apps/database/knowledge-adapter"
import { createKnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import {
  listFolderCapableSources,
  registerDefaultKnowledgeSources,
} from "~/apps/knowledge/source-registry"
import type { RlsClient } from "~/db"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:sources:read"],
  dimensionGrants: {},
}

describe("Knowledge source registry — database source", () => {
  it("the database adapter is folder-capable (declares listFolder)", () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => ({ rows: [] }),
      hasRead: () => true,
    })
    expect(typeof adapter.listFolder).toBe("function")
    expect(adapter.source).toBe("database")
  })

  it("appears in listFolderCapableSources when registered", () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register(
      createDatabaseKnowledgeAdapter({
        runRead: async () => ({ rows: [] }),
        hasRead: () => true,
      }),
    )
    const capable = listFolderCapableSources(registry, actor).map((a) => a.source)
    expect(capable).toContain("database")
  })
})

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
