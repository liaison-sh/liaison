// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { buildSearchDocument, relatedBodyText } from "./doc-builder"
import { registerSearchEnrichment, SearchEnrichmentTestAccess } from "./enrichment"
import {
  collectSearchableRegistrations,
  type SearchableEntityRegistration,
} from "./searchable-entities"

// Mirrors the knowledge `document` searchable-entity registration (app.manifest.json): it declares a
// participant_ids permission field + the team/sensitivity dimension fields. createKnowledgeDocument
// stores organization-scope docs with participant_ids = NULL and (per the fixtures) team = [].
const knowledgeReg: SearchableEntityRegistration = {
  app: "knowledge",
  entityType: "document",
  schemaName: "app_knowledge",
  tableName: "documents",
  readScope: "knowledge:documents:read",
  indexFields: { title: "title", body: "body", labelSecondary: "summary" },
  permissionFields: {
    participantIdsField: "participant_ids",
    dimensionFields: ["team", "sensitivity"],
  },
  mentionable: true,
}

const ticketReg: SearchableEntityRegistration = {
  app: "tickets",
  entityType: "ticket",
  schemaName: "app_tickets",
  tableName: "tickets",
  readScope: "tickets:tickets:read",
  indexFields: { title: "subject", handle: "handle" },
  permissionFields: { dimensionFields: ["team", "sensitivity"] },
  mentionable: true,
}

afterEach(() => {
  SearchEnrichmentTestAccess.reset()
})

describe("buildSearchDocument — permission-field indexing (BL-06: single doc-builder parity)", () => {
  it("does NOT index a NULL participant_ids or an EMPTY team array — so the Meili permission filter does not exclude org-scope docs", async () => {
    // Regression: the full-reindex buildDoc used to index `participant_ids: null` and `team: []`.
    // Meili's `EXISTS` predicate treats a present-but-null field AND an empty array as EXISTING, so
    // the filter clause `(NOT participant_ids EXISTS OR participant_ids = <user>)` excluded
    // organization-scope knowledge docs (which are visible via scope/dimension grants, not
    // participants) — the chaos knowledge-grounded scenario found 0 hits. Fixed by skipping null/empty.
    const doc = await buildSearchDocument(knowledgeReg, "org-1", {
      id: "doc-1",
      title: "Kestrel 6 32-bit Float - Gain Staging and Per-Channel Limiter in Reaper",
      body: "Configuring 32-bit float gain staging and the per-channel limiter",
      participant_ids: null,
      team: [],
      sensitivity: "internal",
    })
    expect("participant_ids" in doc).toBe(false) // null participant list = no restriction, not indexed
    expect("team" in doc).toBe(false) // empty team array = no restriction, not indexed
    expect(doc.sensitivity).toBe("internal") // a real dimension value IS still indexed (gates correctly)
    expect(doc.read_scope).toBe("knowledge:documents:read")
    expect(doc.app).toBe("knowledge")
    expect(doc.entity_type).toBe("document")
    expect(doc.title).toContain("Kestrel 6 32-bit Float")
  })

  it("DOES index a non-empty participant_ids + dimension values (personal-doc + dimension scoping preserved)", async () => {
    const doc = await buildSearchDocument(knowledgeReg, "org-1", {
      id: "doc-2",
      title: "My personal note",
      body: "x",
      participant_ids: ["user-9"], // personal-scope doc: owner is the sole participant
      team: ["sales"],
      sensitivity: "confidential",
    })
    expect(doc.participant_ids).toEqual(["user-9"]) // restriction kept, search must still gate personal docs
    expect(doc.team).toEqual(["sales"])
    expect(doc.sensitivity).toBe("confidential")
  })

  it("emits org_wide=false explicitly (must NOT be omitted like the dimension arrays)", async () => {
    const aclReg: SearchableEntityRegistration = {
      app: "knowledge",
      entityType: "document",
      readScope: "knowledge:documents:read",
      indexFields: { title: "title", body: "body" },
      permissionFields: {
        aclFields: {
          orgWideField: "org_wide",
          userIdsField: "acl_user_ids",
          roleIdsField: "acl_role_ids",
        },
      },
    }
    const doc = await buildSearchDocument(aclReg, "org-1", {
      id: "doc-3",
      title: "Confidential doc",
      body: "body",
      org_wide: false,
      acl_user_ids: [],
      acl_role_ids: [],
    })
    expect(doc.org_wide).toBe(false)
    expect("acl_user_ids" in doc).toBe(false)
    expect("acl_role_ids" in doc).toBe(false)
  })

  it("omits a manifest body field with no value when there is no enrichment hook", async () => {
    const doc = await buildSearchDocument(ticketReg, "org-1", {
      id: "tk-1",
      subject: "USB detection bug",
      handle: "ticket-1",
    })
    // ticketReg has no indexFields.body declared, so no doc.body key at all.
    expect("body" in doc).toBe(false)
  })
})

describe("buildSearchDocument — enrichment hook appends into body", () => {
  it("appends enrichment text after the manifest body value, newline-joined", async () => {
    const regWithBody: SearchableEntityRegistration = {
      ...ticketReg,
      indexFields: { title: "subject", body: "description" },
    }
    registerSearchEnrichment("tickets", "ticket", async () => "extra searchable text")
    const doc = await buildSearchDocument(regWithBody, "org-1", {
      id: "tk-2",
      subject: "USB detection bug",
      description: "manifest body",
    })
    expect(doc.body).toBe("manifest body\nextra searchable text")
  })

  it("uses enrichment text alone when the entity has no manifest body field", async () => {
    registerSearchEnrichment("tickets", "ticket", async () => "contact name, contact@example.com")
    const doc = await buildSearchDocument(ticketReg, "org-1", {
      id: "tk-3",
      subject: "USB detection bug",
      handle: "ticket-3",
    })
    expect(doc.body).toBe("contact name, contact@example.com")
  })

  it("a null enrichment result leaves body as the manifest value alone", async () => {
    const regWithBody: SearchableEntityRegistration = {
      ...ticketReg,
      indexFields: { title: "subject", body: "description" },
    }
    registerSearchEnrichment("tickets", "ticket", async () => null)
    const doc = await buildSearchDocument(regWithBody, "org-1", {
      id: "tk-4",
      subject: "x",
      description: "manifest body only",
    })
    expect(doc.body).toBe("manifest body only")
  })

  it("propagates a thrown enrichment error (job must retry, never swallow)", async () => {
    registerSearchEnrichment("tickets", "ticket", async () => {
      throw new Error("enrichment read failed")
    })
    await expect(
      buildSearchDocument(ticketReg, "org-1", { id: "tk-5", subject: "x", handle: "ticket-5" }),
    ).rejects.toThrow("enrichment read failed")
  })

  it("an entity with no registered hook is unaffected (existing entities keep old behavior)", async () => {
    const doc = await buildSearchDocument(knowledgeReg, "org-1", {
      id: "doc-4",
      title: "t",
      body: "b",
      participant_ids: null,
      team: [],
    })
    expect(doc.body).toBe("b")
  })
})

describe("buildSearchDocument — dedupe_key", () => {
  // A document in no group carries NO key: Meili `distinct` keeps every
  // document without the attribute, and a self-valued key cost one unique
  // facet value per document on every write.
  it("is omitted (dedupes with nothing) when no hook provides a key", async () => {
    const doc = await buildSearchDocument(knowledgeReg, "org-1", { id: "doc-5", title: "t" })
    expect(doc.dedupe_key).toBeUndefined()
  })

  it("a string-returning hook keeps the legacy bodyExtra contract and carries no key", async () => {
    registerSearchEnrichment("tickets", "ticket", async () => "extra text")
    const doc = await buildSearchDocument(ticketReg, "org-1", { id: "tk-1", subject: "s" })
    expect(doc.body).toBe("extra text")
    expect(doc.dedupe_key).toBeUndefined()
  })

  it("a hook-provided dedupeKey is emitted so fragments of one conversation share it", async () => {
    registerSearchEnrichment("tickets", "ticket", async (row) => ({
      bodyExtra: "extra",
      dedupeKey: `conv:${row.contact_id as string}`,
    }))
    const a = await buildSearchDocument(ticketReg, "org-1", { id: "tk-1", contact_id: "c-9" })
    const b = await buildSearchDocument(ticketReg, "org-1", { id: "tk-2", contact_id: "c-9" })
    expect(a.dedupe_key).toBe("conv:c-9")
    expect(a.dedupe_key).toBe(b.dedupe_key as string)
    expect(a.id).not.toBe(b.id as string)
  })

  it("a hook returning a null dedupeKey carries no key (no accidental mass-collapse)", async () => {
    registerSearchEnrichment("tickets", "ticket", async () => ({
      bodyExtra: null,
      dedupeKey: null,
    }))
    const doc = await buildSearchDocument(ticketReg, "org-1", { id: "tk-3" })
    expect(doc.dedupe_key).toBeUndefined()
  })
})

describe("buildSearchDocument — kernel approval_request is findable by uuid", () => {
  it("indexes the uuid as label_secondary next to the request-N handle, so a pasted approvalRequestId (or its first segment) matches", async () => {
    const reg = collectSearchableRegistrations("org-x").entities.find(
      (r) => r.app === "kernel" && r.entityType === "approval_request",
    )
    expect(reg).toBeDefined()
    const doc = await buildSearchDocument(reg!, "org-x", {
      id: "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab",
      handle: "request-42",
      participant_ids: ["u1"],
      created_at: "2026-09-01T00:00:00.000Z",
    })
    expect(doc.title).toBe("request-42")
    expect(doc.label_secondary).toBe("3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab")
    expect(doc.entity_id).toBe("3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab")
  })
})

describe("buildSearchDocument — contacts carry their sharing", () => {
  const contactReg = () =>
    collectSearchableRegistrations("org-1").entities.find(
      (r) => r.app === "kernel" && r.entityType === "contact",
    ) as SearchableEntityRegistration

  it("a private contact is indexed with org_wide=false and its owner on the ACL", async () => {
    const doc = await buildSearchDocument(contactReg(), "org-1", {
      id: "c-1",
      name: "Dana",
      email: "dana@x.example",
      handle: "@contact-1",
      org_wide: false,
      acl_user_ids: ["u-owner"],
      acl_role_ids: ["dim:mail:inbox=acc-1"],
    })
    expect(doc.org_wide).toBe(false)
    expect(doc.acl_user_ids).toEqual(["u-owner"])
    expect(doc.acl_role_ids).toEqual(["dim:mail:inbox=acc-1"])
  })

  it("an organisation contact is indexed org-wide", async () => {
    const doc = await buildSearchDocument(contactReg(), "org-1", {
      id: "c-2",
      name: "Org",
      org_wide: true,
      acl_user_ids: [],
      acl_role_ids: [],
    })
    expect(doc.org_wide).toBe(true)
    expect(doc.acl_user_ids).toBeUndefined()
  })
})

describe("buildSearchDocument — bodyFields and bodyFrom", () => {
  const invoiceReg: SearchableEntityRegistration = {
    app: "invoicing",
    entityType: "document",
    schemaName: "app_invoicing",
    tableName: "documents",
    readScope: "invoicing:documents:read",
    indexFields: {
      title: "number",
      body: "shopify_order_number",
      bodyFields: [
        "counterparty_address",
        "counterparty_email",
        "external_refs.shopify_order_number",
      ],
    },
    permissionFields: {},
    mentionable: true,
  }

  it("appends the row's extra columns and a JSON column's key to the body", async () => {
    const doc = await buildSearchDocument(invoiceReg, "org-1", {
      id: "doc-1",
      number: "3107",
      shopify_order_number: null,
      counterparty_address: "Ottavio Brenna Valdi, Via Esempio Nuova, 8, 10124 Torino",
      counterparty_email: null,
      external_refs: JSON.stringify({ shopify_order_number: "3107" }),
    })
    expect(doc.body).toBe("Ottavio Brenna Valdi, Via Esempio Nuova, 8, 10124 Torino\n3107")
  })

  it("reads the child rows' columns for bodyFrom, deduplicated", async () => {
    const from = {
      tableName: "document_lines",
      foreignKey: "document_id",
      columns: ["description"],
    }
    const seen: unknown[] = []
    const text = await relatedBodyText(
      { ...invoiceReg, indexFields: { title: "number", bodyFrom: from } },
      "org-1",
      { id: "6d1f2c3a-1b2c-4d5e-8f90-0a1b2c3d4e01" },
      from,
      async (orgId, schemaName, f, parentId) => {
        seen.push([orgId, schemaName, f.tableName, parentId])
        return [
          { description: "Ondine MK2 desktop synthesizer" },
          { description: "Ondine MK2 desktop synthesizer" },
          { description: "Shipping" },
        ]
      },
    )
    expect(text).toBe("Ondine MK2 desktop synthesizer\nShipping")
    expect(seen).toEqual([
      ["org-1", "app_invoicing", "document_lines", "6d1f2c3a-1b2c-4d5e-8f90-0a1b2c3d4e01"],
    ])
    // A row without a uuid id reads nothing.
    expect(
      await relatedBodyText(invoiceReg, "org-1", { id: "doc-1" }, from, async () => [
        { description: "x" },
      ]),
    ).toBeNull()
  })
})
