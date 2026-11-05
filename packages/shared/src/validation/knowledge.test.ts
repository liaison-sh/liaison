// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  expandKnowledgeSensitivityGrants,
  knowledgeCollectionPatchSchema,
  knowledgeCollectionSchema,
  knowledgeCreateDocumentSchema,
  knowledgeFederatedSearchSchema,
  knowledgeLinkRemoteSchema,
  knowledgeSourceLinkVerifySchema,
  knowledgeSourcePolicyPatchSchema,
  knowledgeTagSchema,
  knowledgeUpdateDocumentSchema,
} from "./knowledge"

describe("Knowledge validation", () => {
  it("accepts personal documents only without org dimensions or collections", () => {
    const parsed = knowledgeCreateDocumentSchema.parse({
      documentScope: "personal",
      title: "My note",
      body: "private",
      collectionIds: [],
      ownerUserId: "11111111-1111-1111-1111-111111111111",
    })
    expect(parsed.documentScope).toBe("personal")
    expect(parsed.collectionIds).toEqual([])
  })

  it("rejects personal documents placed in organization collections", () => {
    expect(() =>
      knowledgeCreateDocumentSchema.parse({
        documentScope: "personal",
        title: "My note",
        body: "private",
        collectionIds: ["11111111-1111-1111-1111-111111111111"],
      }),
    ).toThrow(/personal documents cannot belong to organization collections/i)
  })

  it("requires sensitivity for organization documents and defaults to internal", () => {
    const parsed = knowledgeCreateDocumentSchema.parse({
      documentScope: "organization",
      title: "Runbook",
      body: "steps",
    })
    expect(parsed.sensitivity).toBe("internal")
  })

  it("keeps federated search empty-query mode explicit", () => {
    const parsed = knowledgeFederatedSearchSchema.parse({ query: "", limit: 25 })
    expect(parsed.query).toBe("")
    expect(parsed.mode).toBe("blended")
  })

  it("an update names only what it changes: no create default is applied", () => {
    expect(knowledgeUpdateDocumentSchema.parse({ body: "x", revision: 1 })).toEqual({
      body: "x",
      revision: 1,
    })
  })

  it("requires revision on updates", () => {
    expect(() => knowledgeUpdateDocumentSchema.parse({ title: "No revision" })).toThrow(/revision/i)
  })

  it("validates remote links without attachment fields", () => {
    const parsed = knowledgeLinkRemoteSchema.parse({
      source: "google-drive",
      externalId: "drive-1",
      collectionId: "11111111-1111-1111-1111-111111111111",
      title: "Company Policies",
    })
    expect(parsed.source).toBe("google-drive")
  })
})

describe("knowledgeLinkRemoteSchema.url scheme allowlist", () => {
  it("accepts https URLs", () => {
    const r = knowledgeLinkRemoteSchema.safeParse({
      source: "drive",
      externalId: "1",
      title: "T",
      url: "https://example.com/x",
    })
    expect(r.success).toBe(true)
  })

  it("accepts http URLs", () => {
    const r = knowledgeLinkRemoteSchema.safeParse({
      source: "drive",
      externalId: "1",
      title: "T",
      url: "http://example.com",
    })
    expect(r.success).toBe(true)
  })

  it("rejects javascript: URLs with a recognizable error", () => {
    const r = knowledgeLinkRemoteSchema.safeParse({
      source: "drive",
      externalId: "1",
      title: "T",
      url: "javascript:alert(1)",
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join("|")
      expect(msgs).toMatch(/url must use http or https|Invalid url/i)
    }
  })

  it("rejects data: URLs", () => {
    const r = knowledgeLinkRemoteSchema.safeParse({
      source: "drive",
      externalId: "1",
      title: "T",
      url: "data:text/html,<x>",
    })
    expect(r.success).toBe(false)
  })

  it("rejects vbscript: URLs", () => {
    const r = knowledgeLinkRemoteSchema.safeParse({
      source: "drive",
      externalId: "1",
      title: "T",
      url: "vbscript:msgbox(1)",
    })
    expect(r.success).toBe(false)
  })

  it("accepts missing url (optional)", () => {
    const r = knowledgeLinkRemoteSchema.safeParse({
      source: "drive",
      externalId: "1",
      title: "T",
    })
    expect(r.success).toBe(true)
  })
})

describe("expandKnowledgeSensitivityGrants", () => {
  it("expands confidential to public+internal+confidential", () => {
    expect(expandKnowledgeSensitivityGrants(["confidential"])).toEqual([
      "public",
      "internal",
      "confidential",
    ])
  })
  it("preserves wildcard", () => {
    expect(expandKnowledgeSensitivityGrants(["*"])).toEqual(["*"])
  })
  it("passes unknown levels through", () => {
    expect(expandKnowledgeSensitivityGrants(["custom-tier"])).toEqual(["custom-tier"])
  })
  it("returns empty array for empty input", () => {
    expect(expandKnowledgeSensitivityGrants([])).toEqual([])
  })
})

describe("knowledgeCollectionSchema", () => {
  it("rejects caller-supplied orgId via strict mode", () => {
    const r = knowledgeCollectionSchema.safeParse({
      name: "Ops",
      orgId: "11111111-1111-1111-1111-111111111111",
    })
    expect(r.success).toBe(false)
  })
  it("requires non-empty trimmed name", () => {
    expect(knowledgeCollectionSchema.safeParse({ name: "   " }).success).toBe(false)
  })
  it("accepts valid minimal payload", () => {
    const r = knowledgeCollectionSchema.safeParse({ name: "Ops" })
    expect(r.success).toBe(true)
  })
  it("patch schema accepts empty object", () => {
    const r = knowledgeCollectionPatchSchema.safeParse({})
    expect(r.success).toBe(true)
  })
})

describe("knowledgeTagSchema", () => {
  it("rejects empty trimmed name", () => {
    expect(knowledgeTagSchema.safeParse({ name: " " }).success).toBe(false)
  })
  it("accepts a 64-char name", () => {
    expect(knowledgeTagSchema.safeParse({ name: "a".repeat(64) }).success).toBe(true)
  })
})

describe("knowledgeSourcePolicyPatchSchema", () => {
  it("rejects negative cacheBytes", () => {
    expect(knowledgeSourcePolicyPatchSchema.safeParse({ cacheBytes: -1 }).success).toBe(false)
  })
  it("clamps policy to enum", () => {
    expect(knowledgeSourcePolicyPatchSchema.safeParse({ policy: "frobnicate" }).success).toBe(false)
  })
  it("accepts a fully populated patch", () => {
    expect(
      knowledgeSourcePolicyPatchSchema.safeParse({
        policy: "content_cache",
        connectionMode: "shared",
        broadSearchEnabled: true,
        cacheBytes: 1024,
        retainedChunks: 100,
        retentionDays: 30,
      }).success,
    ).toBe(true)
  })
})

describe("knowledgeSourceLinkVerifySchema", () => {
  it("requires revision", () => {
    expect(knowledgeSourceLinkVerifySchema.safeParse({}).success).toBe(false)
  })
  it("rejects negative revision", () => {
    expect(knowledgeSourceLinkVerifySchema.safeParse({ revision: -1 }).success).toBe(false)
  })
  it("accepts revision = 0", () => {
    expect(knowledgeSourceLinkVerifySchema.safeParse({ revision: 0 }).success).toBe(true)
  })
})
