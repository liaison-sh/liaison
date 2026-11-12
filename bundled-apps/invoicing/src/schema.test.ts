// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

interface SchemaTable {
  fields: Record<string, unknown>
  constraints?: {
    unique?: (string[] | { columns: string[]; where: string })[]
  }
  indexes?: (string[] | { columns: string[]; where: string })[]
}

function loadSchema(): Record<string, SchemaTable> {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    schema?: Record<string, SchemaTable>
  }
  if (!m.schema) throw new Error("manifest has no `schema` block")
  return m.schema
}

describe("Invoicing app schema (manifest.schema block)", () => {
  it("declares the 10 Phase-17 tables", () => {
    const s = loadSchema()
    for (const t of [
      "documents",
      "document_lines",
      "issuer_profiles",
      "webhook_deliveries",
      "deferred_events",
      "tax_regimes",
      "hs_code_library",
      "product_customs_overlay",
      "contact_relationships",
      "contact_primary_thread",
    ]) {
      expect(s[t], `schema is missing table ${t}`).toBeDefined()
    }
  })

  describe("documents table", () => {
    it("uses bigint for monetary minor-unit columns", () => {
      const t = loadSchema().documents
      for (const col of ["subtotal_minor", "tax_total_minor", "grand_total_minor"]) {
        const f = t?.fields[col] as { type?: string }
        expect(f?.type, `documents.${col} must be bigint, got ${JSON.stringify(f)}`).toBe("bigint")
      }
    })

    it("carries the ship to snapshot columns (nullable text) next to the billing address", () => {
      const t = loadSchema().documents
      expect(t?.fields.counterparty_shipping_address).toBe("text?")
      expect(t?.fields.counterparty_shipping_name).toBe("text?")
      // The billing address stays exactly what it was: the ship to is an ADDITION, never a rename.
      expect(t?.fields.counterparty_address).toBe("text?")
    })

    it("uses smallint for year_of_issue", () => {
      const t = loadSchema().documents
      const f = t?.fields.year_of_issue as { type?: string }
      expect(f?.type).toBe("smallint")
    })

    it("type enum covers all five document kinds", () => {
      const t = loadSchema().documents
      const f = t?.fields.type as { enum?: string[] }
      expect(f?.enum).toEqual(["invoice", "quote", "proforma", "purchase_order", "credit_note"])
    })

    it("status enum covers all lifecycle states across document kinds", () => {
      const t = loadSchema().documents
      const f = t?.fields.status as { enum?: string[] }
      expect(f?.enum).toContain("draft")
      expect(f?.enum).toContain("issued")
      expect(f?.enum).toContain("paid")
      expect(f?.enum).toContain("sent")
      expect(f?.enum).toContain("accepted")
      expect(f?.enum).toContain("rejected")
      expect(f?.enum).toContain("expired")
      expect(f?.enum).toContain("closed")
      expect(f?.enum).toContain("received")
      expect(f?.enum).toContain("cancelled")
      expect(f?.enum).toContain("voided")
      expect(f?.enum).toContain("refunded")
    })

    it("payment_status is separated from status (per spec §6 refund flow)", () => {
      const t = loadSchema().documents
      const f = t?.fields.payment_status as { enum?: string[]; default?: string }
      expect(f?.enum).toEqual(["unpaid", "partial", "paid", "refunded"])
      expect(f?.default).toBe("unpaid")
    })

    it("incoterm enum covers seven Incoterms 2020 codes", () => {
      const t = loadSchema().documents
      const f = t?.fields.incoterm as { enum?: string[]; default?: string }
      expect(f?.enum).toEqual(["EXW", "FCA", "FOB", "CIF", "DAP", "DDP", "DPU"])
      expect(f?.default).toBe("DAP")
    })

    it("pdf_status enum allows pdf_a3_normalization_skipped", () => {
      const t = loadSchema().documents
      const f = t?.fields.pdf_status as { enum?: string[] }
      expect(f?.enum).toContain("pending")
      expect(f?.enum).toContain("ready")
      expect(f?.enum).toContain("failed")
      expect(f?.enum).toContain("pdf_a3_normalization_skipped")
    })

    it("external_refs and lifecycle_log default to JSON empty containers", () => {
      const t = loadSchema().documents
      const ext = t?.fields.external_refs as { type?: string; default?: unknown }
      expect(ext?.type).toBe("json")
      expect(ext?.default).toEqual({})
      const log = t?.fields.lifecycle_log as { type?: string; default?: unknown }
      expect(log?.type).toBe("json")
      expect(log?.default).toEqual([])
    })

    it("issuer_profile_id references issuer_profiles(id)", () => {
      const t = loadSchema().documents
      const f = t?.fields.issuer_profile_id as { references?: { table: string; column: string } }
      expect(f?.references?.table).toBe("issuer_profiles")
      expect(f?.references?.column).toBe("id")
    })

    it("partial unique index on (issuer_profile_id, type, year_of_issue, number_int) where number_int IS NOT NULL", () => {
      const t = loadSchema().documents
      const uniques = t?.constraints?.unique ?? []
      const partial = uniques.find(
        (u) =>
          !Array.isArray(u) &&
          u.columns.includes("issuer_profile_id") &&
          u.columns.includes("number_int"),
      )
      expect(
        partial,
        "documents must declare a partial-unique on the numbering invariant",
      ).toBeDefined()
      const where = (partial as { where: string }).where
      expect(where).toMatch(/number_int IS NOT NULL/)
    })

    it("partial unique index on the top-level shopify_order_id column (Shopify dedup)", () => {
      const t = loadSchema().documents
      const uniques = t?.constraints?.unique ?? []
      const shop = uniques.find((u) => !Array.isArray(u) && u.columns.includes("shopify_order_id"))
      expect(
        shop,
        "documents must declare a partial-unique on the shopify_order_id column",
      ).toBeDefined()
      const where = (shop as { where: string }).where
      expect(where).toMatch(/shopify_order_id IS NOT NULL/)
      // Per-shipment proformas: uniqueness is keyed per shipment batch.
      expect((shop as { columns: string[] }).columns).toEqual([
        "shopify_order_id",
        "scope",
        "shipment_ref",
      ])
    })

    it("declares a nullable shipment_ref column (one proforma per shipment batch)", () => {
      const t = loadSchema().documents
      expect(t?.fields.shipment_ref).toBe("text?")
    })

    it("declares a top-level indexed shopify_order_id column for equality lookup", () => {
      const t = loadSchema().documents
      expect(t?.fields.shopify_order_id).toBe("text?")
      expect(t?.indexes).toContainEqual(["shopify_order_id"])
    })

    it("declares (status, due_at) and (counterparty_contact_id) indexes", () => {
      const t = loadSchema().documents
      expect(t?.indexes).toContainEqual(["status", "due_at"])
      expect(t?.indexes).toContainEqual(["counterparty_contact_id"])
    })
  })

  describe("document_lines table", () => {
    it("uses bigint for monetary minor-unit columns", () => {
      const t = loadSchema().document_lines
      for (const col of ["unit_price_minor", "subtotal_minor", "tax_minor", "total_minor"]) {
        const f = t?.fields[col] as { type?: string }
        expect(f?.type, `document_lines.${col} must be bigint`).toBe("bigint")
      }
    })

    it("uses numeric(15,3) for quantity (fractional services/weights)", () => {
      const t = loadSchema().document_lines
      const f = t?.fields.quantity as { type?: string; precision?: number; scale?: number }
      expect(f?.type).toBe("numeric")
      expect(f?.precision).toBe(15)
      expect(f?.scale).toBe(3)
    })

    it("declares product_source and external_id as snapshot fields", () => {
      const t = loadSchema().document_lines
      expect(t?.fields.product_source).toBeDefined()
      expect(t?.fields.external_id).toBeDefined()
    })

    it("cascades on document delete", () => {
      const t = loadSchema().document_lines
      const f = t?.fields.document_id as { references?: { onDelete?: string } }
      expect(f?.references?.onDelete).toBe("cascade")
    })

    it("declares unique (document_id, position)", () => {
      const t = loadSchema().document_lines
      expect(t?.constraints?.unique).toContainEqual(["document_id", "position"])
    })
  })

  describe("issuer_profiles table", () => {
    it("declares legal_name unique", () => {
      const t = loadSchema().issuer_profiles
      expect(t?.constraints?.unique).toContainEqual(["legal_name"])
    })

    it("includes the per-type prefix and approval-threshold columns", () => {
      const t = loadSchema().issuer_profiles
      for (const col of ["prefix_invoice", "prefix_quote", "prefix_proforma", "prefix_po"]) {
        expect(t?.fields[col], `issuer_profiles.${col} missing`).toBeDefined()
      }
      const inv = t?.fields.invoice_approval_threshold_minor as { type?: string }
      expect(inv?.type).toBe("bigint")
      const po = t?.fields.po_approval_threshold_minor as { type?: string }
      expect(po?.type).toBe("bigint")
    })
  })

  describe("deferred_events table", () => {
    it("declares status enum + retry_count", () => {
      const t = loadSchema().deferred_events
      const s = t?.fields.status as { enum?: string[] }
      expect(s?.enum).toEqual([
        "awaiting_config",
        "awaiting_data",
        "awaiting_dependency",
        "render_failed",
        "email_failed",
        "resolved",
        "permanent_failure",
      ])
      expect(t?.fields.retry_count).toBeDefined()
    })

    it("indexed by (status, retry_count)", () => {
      const t = loadSchema().deferred_events
      expect(t?.indexes).toContainEqual(["status", "retry_count"])
    })
  })

  describe("tax_regimes table", () => {
    it("unique on (issuer_country, treatment)", () => {
      const t = loadSchema().tax_regimes
      expect(t?.constraints?.unique).toContainEqual(["issuer_country", "treatment"])
    })

    it("ships per-language legal-mention templates + requires_hs_code", () => {
      const t = loadSchema().tax_regimes
      expect(t?.fields.legal_mention_template_en).toBeDefined()
      expect(t?.fields.legal_mention_template_fr).toBeDefined()
      expect(t?.fields.legal_mention_template_de).toBeDefined()
      expect(t?.fields.requires_hs_code).toBeDefined()
    })
  })

  describe("hs_code_library and overlay tables", () => {
    it("hs_code_library.code is unique", () => {
      const t = loadSchema().hs_code_library
      expect(t?.constraints?.unique).toContainEqual(["code"])
    })

    it("product_customs_overlay unique on (source, external_id)", () => {
      const t = loadSchema().product_customs_overlay
      expect(t?.constraints?.unique).toContainEqual(["source", "external_id"])
    })

    it("product_customs_overlay.updated_by_user_id is a userRef with onErase anonymize", () => {
      const t = loadSchema().product_customs_overlay
      const f = t?.fields.updated_by_user_id as { userRef?: boolean; onErase?: string }
      expect(f?.userRef).toBe(true)
      expect(f?.onErase).toBe("anonymize")
    })
  })

  describe("contact_relationships table", () => {
    it("unique on contact_id (single-value model per spec §10)", () => {
      const t = loadSchema().contact_relationships
      expect(t?.constraints?.unique).toContainEqual(["contact_id"])
    })

    it("relationship enum and source enum", () => {
      const t = loadSchema().contact_relationships
      const rel = t?.fields.relationship as { enum?: string[] }
      expect(rel?.enum).toEqual(["customer", "vendor", "both", "other"])
      const src = t?.fields.source as { enum?: string[] }
      expect(src?.enum).toEqual(["manual", "inferred"])
    })
  })

  describe("contact_primary_thread table", () => {
    it("unique on contact_id (cache table per spec §9)", () => {
      const t = loadSchema().contact_primary_thread
      expect(t?.constraints?.unique).toContainEqual(["contact_id"])
    })
  })

  describe("e-invoicing identity schema (P1)", () => {
    const BASELINE_DOCUMENTS = new Set([
      "counterparty_address",
      "counterparty_contact_id",
      "counterparty_country",
      "counterparty_email",
      "counterparty_name",
      "counterparty_shipping_address",
      "counterparty_shipping_name",
      "counterparty_vat_id",
      "currency",
      "due_at",
      "external_refs",
      "grand_total_minor",
      "incoterm",
      "issued_at",
      "issuer_profile_id",
      "lifecycle_log",
      "notes",
      "number",
      "number_int",
      "paid_at",
      "payment_status",
      "pdf_file_id",
      "pdf_status",
      "po_number",
      "scope",
      "shipment_ref",
      "shopify_draft_order_id",
      "shopify_draft_order_name",
      "shopify_order_id",
      "shopify_order_number",
      "status",
      "subtotal_minor",
      "tax_total_minor",
      "tax_treatment",
      "type",
      "voided_at",
      "year_of_issue",
    ])
    const BASELINE_ISSUER_PROFILES = new Set([
      "address",
      "archived_at",
      "auto_email_enabled",
      "bank_name",
      "country",
      "default_currency",
      "default_language",
      "default_payment_terms_days",
      "email_templates",
      "iban",
      "invoice_approval_threshold_minor",
      "legal_name",
      "logo_file_id",
      "mail_account_id",
      "po_approval_threshold_minor",
      "prefix_credit_note",
      "prefix_invoice",
      "prefix_po",
      "prefix_proforma",
      "prefix_quote",
      "prices_include_tax",
      "require_two_eyes",
      "shopify_shop_id",
      "swift_bic",
      "tax_registration_id",
      "timezone",
      "vat_id",
    ])

    function isNullable(def: unknown): boolean {
      if (typeof def === "string") return def.endsWith("?")
      const d = def as { required?: boolean; default?: unknown }
      return d.required === false || d.default !== undefined
    }

    it("every documents/issuer_profiles field outside the 0.18.19 baseline is nullable", () => {
      const s = loadSchema()
      for (const [table, baseline] of [
        ["documents", BASELINE_DOCUMENTS],
        ["issuer_profiles", BASELINE_ISSUER_PROFILES],
      ] as const) {
        const added = Object.entries(s[table]?.fields ?? {}).filter(([k]) => !baseline.has(k))
        expect(added.length, `${table} gained no fields`).toBeGreaterThan(0)
        for (const [name, def] of added) {
          expect(isNullable(def), `${table}.${name} must be nullable`).toBe(true)
        }
      }
    })

    it("counterparty_identities unique per contact, contacts-scoped", () => {
      const t = loadSchema().counterparty_identities as SchemaTable & { rlsScope?: string }
      expect(t?.rlsScope).toBe("contacts")
      expect(t?.constraints?.unique).toContainEqual(["contact_id"])
    })

    it("legal_originals fileParent joined on id", () => {
      const s = loadSchema() as Record<string, SchemaTable & { rlsScope?: string }>
      expect(s.legal_originals?.rlsScope).toBe("documents")
      expect(s.legal_originals?.constraints?.unique).toContainEqual(["document_id", "kind"])
      const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
        entities: Record<
          string,
          { tableName?: string; labelField?: string; fileParent?: Record<string, string> }
        >
      }
      expect(m.entities.legal_original?.tableName).toBe("legal_originals")
      expect(m.entities.legal_original?.fileParent?.joinOn).toBe("id")
      expect(m.entities.legal_original?.fileParent?.tableName).toBe("legal_originals")
    })

    it("fx_rates and einvoicing_settings are documents-scoped", () => {
      const s = loadSchema() as Record<string, SchemaTable & { rlsScope?: string }>
      expect(s.fx_rates?.rlsScope).toBe("documents")
      expect(s.einvoicing_settings?.rlsScope).toBe("documents")
      expect(s.fx_rates?.constraints?.unique).toContainEqual(["currency", "rate_date"])
    })

    it("regime enum = four regimes", () => {
      const f = loadSchema().documents?.fields.regime as { enum?: string[] }
      expect(f?.enum).toEqual(["e_invoice", "e_reporting", "out_of_scope", "needs_review"])
    })

    it("documents indexes cover original_document_id and regime", () => {
      const idx = loadSchema().documents?.indexes ?? []
      expect(idx).toContainEqual(["original_document_id"])
      expect(idx).toContainEqual(["regime"])
    })
  })
})
