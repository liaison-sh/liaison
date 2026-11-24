// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { registerKnowledgeSearchEnrichment } from "~/apps/knowledge/search-enrichment"
import { buildSearchDocument } from "~/modules/search/doc-builder"
import { SearchEnrichmentTestAccess } from "~/modules/search/enrichment"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"

const knowledgeReg: SearchableEntityRegistration = {
  app: "knowledge",
  entityType: "document",
  schemaName: "app_knowledge",
  tableName: "documents",
  readScope: "knowledge:documents:read",
  indexFields: { title: "title", body: "body", labelSecondary: "summary" },
  permissionFields: { participantIdsField: "participant_ids" },
  mentionable: true,
}

const FILE = "2d1c5e7a-3f4b-4c8d-8e9f-1a2b3c4d5e6f"
const PAGE = "0b9a3c5e-1d2f-4a6b-8c7d-9e0f1a2b3c4d"

afterEach(() => {
  SearchEnrichmentTestAccess.reset()
})

describe("knowledge search text", () => {
  it("a page is indexed, and its snippet cut, with no file or page token", async () => {
    registerKnowledgeSearchEnrichment()
    const doc = await buildSearchDocument(knowledgeReg, "org-1", {
      id: "d-1",
      title: "Handbook",
      body: `Wiring ![](liaison-file:${FILE}) see @[Secret](knowledge:document:${PAGE}) end`,
      participant_ids: null,
    })
    expect(doc.body).toBe("Wiring  see  end")
    expect(String(doc.body)).not.toContain(FILE)
    expect(String(doc.body)).not.toContain("Secret")
  })
})
