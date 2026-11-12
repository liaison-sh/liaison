// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: HS code assignment and library, product customs overlay, and
// contact relationships.

import type { DocumentType, MutationResult, MutationsCtx, MutationsDb } from "./shared"

// ── E8 — hs_codes.assign + contact_relationships.set + customs overlay ────

export type Relationship = "customer" | "vendor" | "both" | "other"
export type RelationshipSource = "manual" | "inferred"

export interface ContactRelationshipRow {
  contact_id: string
  relationship: Relationship
  source: RelationshipSource
}

export interface ProductCustomsOverlayRow {
  source: string
  external_id: string
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
  updated_by_user_id: string
}

export interface HsCodeLibraryRow {
  code: string
  description: string | null
  last_used_at: string | null
}

// Normalises an HS code to the library's storage format: digits only, 4-10
// long. Strips whitespace, dots and any other separator so "9207.90" and
// "920790" collapse to the same stored value and the library stops holding
// the same code twice in two formats. Returns null for anything that is not
// 4 to 10 digits once separators are stripped.
export function normalizeHsCode(raw: string): string | null {
  if (typeof raw !== "string") return null
  const digits = raw.replace(/[^0-9]/g, "")
  if (!/^\d{4,10}$/.test(digits)) return null
  return digits
}

// UPSERT helpers — find-then-(insert OR update). Matches Shopify's pattern
// in `bundled-apps/shopify/src/connection.ts` since the bridge has no
// dedicated upsert primitive.

async function upsertCustomsOverlay(
  db: MutationsDb,
  row: ProductCustomsOverlayRow,
): Promise<ProductCustomsOverlayRow> {
  const existing = await db.findMany("product_customs_overlay", {
    where: { source: row.source, external_id: row.external_id },
    limit: 1,
  })
  const data = {
    source: row.source,
    external_id: row.external_id,
    hs_code: row.hs_code,
    country_of_origin: row.country_of_origin,
    customs_description: row.customs_description,
    updated_by_user_id: row.updated_by_user_id,
  }
  if (existing.length > 0) {
    const id = String((existing[0] as Record<string, unknown>).id)
    await db.update("product_customs_overlay", id, data)
  } else {
    await db.insert("product_customs_overlay", data)
  }
  return row
}

// Routes the write through the NORMALISED lookup (findHsCodeLibraryRowByNormalizedCode, below)
// rather than an exact-match `where: { code }` — a legacy row stored in a different separator
// format ("9207.90") must be UPDATED, never duplicated, when a normalised write ("920790") comes
// in for the same code. hsCodesAssign used to call the exact-match upsert here directly, which
// inserted a second row instead of updating the differently-formatted existing one.
async function upsertHsCodeLibrary(
  db: MutationsDb,
  input: HsCodeLibraryRow,
): Promise<HsCodeLibraryRow> {
  const existing = await findHsCodeLibraryRowByNormalizedCode(db, input.code)
  if (existing) {
    const id = String(existing.id)
    await db.update("hs_code_library", id, {
      description: input.description,
      last_used_at: input.last_used_at,
    })
  } else {
    await db.insert("hs_code_library", {
      code: input.code,
      description: input.description,
      last_used_at: input.last_used_at,
    })
  }
  return input
}

async function getContactRelationship(
  db: MutationsDb,
  contactId: string,
): Promise<ContactRelationshipRow | null> {
  const rows = await db.findMany("contact_relationships", {
    where: { contact_id: contactId },
    limit: 1,
  })
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    contact_id: String(row.contact_id),
    relationship: row.relationship as Relationship,
    source: row.source as RelationshipSource,
  }
}

async function upsertContactRelationship(
  db: MutationsDb,
  row: ContactRelationshipRow,
): Promise<ContactRelationshipRow> {
  const existing = await db.findMany("contact_relationships", {
    where: { contact_id: row.contact_id },
    limit: 1,
  })
  if (existing.length > 0) {
    const id = String((existing[0] as Record<string, unknown>).id)
    await db.update("contact_relationships", id, {
      relationship: row.relationship,
      source: row.source,
    })
  } else {
    await db.insert("contact_relationships", {
      contact_id: row.contact_id,
      relationship: row.relationship,
      source: row.source,
    })
  }
  return row
}

export async function hsCodesAssign(
  ctx: MutationsCtx,
  input: {
    product_source: string
    external_id: string
    hs_code: string
    country_of_origin?: string
    customs_description?: string
  },
): Promise<MutationResult<{ overlay: ProductCustomsOverlayRow }>> {
  if (!input.product_source || !input.external_id) {
    return {
      status: "error",
      error: {
        code: "invalid_input",
        message: "product_source and external_id are required",
      },
    }
  }
  const normalizedHsCode = input.hs_code ? normalizeHsCode(input.hs_code) : null
  if (!normalizedHsCode) {
    return {
      status: "error",
      error: {
        code: "invalid_hs_code",
        message: `hs_code must be 4 to 10 digits, got ${input.hs_code}`,
      },
    }
  }
  const overlay = await upsertCustomsOverlay(ctx.db, {
    source: input.product_source,
    external_id: input.external_id,
    hs_code: normalizedHsCode,
    country_of_origin: input.country_of_origin ?? null,
    customs_description: input.customs_description ?? null,
    updated_by_user_id: await ctx.getUserId(),
  })
  await upsertHsCodeLibrary(ctx.db, {
    code: normalizedHsCode,
    description: input.customs_description ?? null,
    last_used_at: new Date().toISOString(),
  })
  return { status: "completed", overlay }
}

// Finds a library row whose normalised code matches, checking the exact
// stored value first (the common, already-normalised case) and only
// falling back to a full scan for a legacy row stored in a different format
// (e.g. "9207.90" next to a normalised "920790"). Prevents a normalised
// write from creating a duplicate of an existing differently formatted row.
async function findHsCodeLibraryRowByNormalizedCode(
  db: MutationsDb,
  normalized: string,
): Promise<Record<string, unknown> | null> {
  const exact = await db.findMany("hs_code_library", { where: { code: normalized }, limit: 1 })
  if (exact.length > 0) return exact[0] as Record<string, unknown>
  const all = await db.findMany("hs_code_library", { limit: 5000 })
  for (const row of all) {
    const rec = row as Record<string, unknown>
    if (normalizeHsCode(String(rec.code ?? "")) === normalized) return rec
  }
  return null
}

// Counts product_customs_overlay rows still referencing a given HS code,
// tolerating an overlay row stored in a different (unnormalised) format.
async function countOverlayUsageOfHsCode(db: MutationsDb, normalized: string): Promise<number> {
  const rows = await db.findMany("product_customs_overlay", { limit: 5000 })
  let n = 0
  for (const row of rows) {
    const hsCode = (row as Record<string, unknown>).hs_code
    if (typeof hsCode !== "string" || !hsCode) continue
    if (normalizeHsCode(hsCode) === normalized) n += 1
  }
  return n
}

export async function hsCodesLibraryUpsert(
  ctx: MutationsCtx,
  input: { code: string; description?: string },
): Promise<MutationResult<{ row: HsCodeLibraryRow }>> {
  const normalized = input.code ? normalizeHsCode(input.code) : null
  if (!normalized) {
    return {
      status: "error",
      error: {
        code: "invalid_hs_code",
        message: `code must be 4 to 10 digits, got ${input.code}`,
      },
    }
  }
  const existing = await findHsCodeLibraryRowByNormalizedCode(ctx.db, normalized)
  if (existing) {
    // Omitted description leaves the stored one alone (only an explicit
    // description overwrites it) so a bare code-format normalisation pass
    // never wipes out a description someone already recorded.
    const description =
      input.description !== undefined
        ? input.description
        : ((existing.description as string | null) ?? null)
    const id = String(existing.id)
    await ctx.db.update("hs_code_library", id, { code: normalized, description })
    return {
      status: "completed",
      row: {
        code: normalized,
        description,
        last_used_at: (existing.last_used_at as string | null) ?? null,
      },
    }
  }
  const description = input.description ?? null
  await ctx.db.insert("hs_code_library", { code: normalized, description, last_used_at: null })
  return { status: "completed", row: { code: normalized, description, last_used_at: null } }
}

export async function hsCodesLibraryDelete(
  ctx: MutationsCtx,
  input: { code: string; force?: boolean },
): Promise<MutationResult<{ deleted: true }>> {
  const normalized = input.code ? normalizeHsCode(input.code) : null
  if (!normalized) {
    return {
      status: "error",
      error: {
        code: "invalid_hs_code",
        message: `code must be 4 to 10 digits, got ${input.code}`,
      },
    }
  }
  const existing = await findHsCodeLibraryRowByNormalizedCode(ctx.db, normalized)
  if (!existing) {
    return {
      status: "error",
      error: { code: "not_found", message: `no HS-code library entry for ${normalized}` },
    }
  }
  const usageCount = await countOverlayUsageOfHsCode(ctx.db, normalized)
  if (usageCount > 0 && !input.force) {
    return {
      status: "error",
      error: {
        code: "hs_code_in_use",
        message: `${usageCount} product(s) still use HS code ${normalized}; pass force:true to delete anyway`,
      },
    }
  }
  await ctx.db.delete("hs_code_library", String(existing.id))
  return { status: "completed", deleted: true }
}

export type HsCodesUnassignField = "hs_code" | "country_of_origin" | "customs_description"

const HS_CODES_UNASSIGN_ALL_FIELDS: readonly HsCodesUnassignField[] = [
  "hs_code",
  "country_of_origin",
  "customs_description",
]

export async function hsCodesUnassign(
  ctx: MutationsCtx,
  input: {
    product_source: string
    external_id: string
    fields?: HsCodesUnassignField[]
  },
): Promise<MutationResult<{ deleted: boolean; overlay: ProductCustomsOverlayRow | null }>> {
  if (!input.product_source || !input.external_id) {
    return {
      status: "error",
      error: { code: "invalid_input", message: "product_source and external_id are required" },
    }
  }
  const fields =
    input.fields && input.fields.length > 0 ? input.fields : HS_CODES_UNASSIGN_ALL_FIELDS
  const existing = await ctx.db.findMany("product_customs_overlay", {
    where: { source: input.product_source, external_id: input.external_id },
    limit: 1,
  })
  if (existing.length === 0) {
    return { status: "completed", deleted: false, overlay: null }
  }
  const row = existing[0] as Record<string, unknown>
  const id = String(row.id)
  const clearingAllFields = HS_CODES_UNASSIGN_ALL_FIELDS.every((f) => fields.includes(f))
  if (clearingAllFields) {
    await ctx.db.delete("product_customs_overlay", id)
    return { status: "completed", deleted: true, overlay: null }
  }
  const patch: Record<string, unknown> = {}
  for (const f of fields) patch[f] = null
  await ctx.db.update("product_customs_overlay", id, patch)
  const updated = (
    await ctx.db.findMany("product_customs_overlay", {
      where: { source: input.product_source, external_id: input.external_id },
      limit: 1,
    })
  )[0] as Record<string, unknown>
  const overlay: ProductCustomsOverlayRow = {
    source: String(updated.source),
    external_id: String(updated.external_id),
    hs_code: (updated.hs_code as string | null) ?? null,
    country_of_origin: (updated.country_of_origin as string | null) ?? null,
    customs_description: (updated.customs_description as string | null) ?? null,
    updated_by_user_id: String(updated.updated_by_user_id),
  }
  return { status: "completed", deleted: false, overlay }
}

export async function contactRelationshipsSet(
  ctx: MutationsCtx,
  input: { contact_id: string; relationship: Relationship },
): Promise<MutationResult<{ row: ContactRelationshipRow }>> {
  if (!input.contact_id) {
    return {
      status: "error",
      error: { code: "invalid_input", message: "contact_id is required" },
    }
  }
  const valid: ReadonlyArray<Relationship> = ["customer", "vendor", "both", "other"]
  if (!valid.includes(input.relationship)) {
    return {
      status: "error",
      error: {
        code: "invalid_relationship",
        message: `relationship must be one of ${valid.join(",")}`,
      },
    }
  }
  const row = await upsertContactRelationship(ctx.db, {
    contact_id: input.contact_id,
    relationship: input.relationship,
    source: "manual",
  })
  return { status: "completed", row }
}

// Inference helper (called from document-issue paths). Implements the
// precedence rules from spec §10:
//   - manual rows are NEVER overwritten; if a manual `customer` row exists
//     and a PO is being issued, emit attention (no DB write).
//   - inferred rows upgrade: customer + vendor → both.
//   - missing rows are created as inferred with the natural side.
export async function inferContactRelationshipOnIssue(
  ctx: MutationsCtx,
  input: {
    contact_id: string
    document_type: DocumentType
  },
): Promise<
  | { status: "ok"; row: ContactRelationshipRow; action: "created" | "upgraded" | "noop" }
  | { status: "attention"; reason: "manual_conflict"; existing: ContactRelationshipRow }
> {
  const sideForDoc: Relationship = input.document_type === "purchase_order" ? "vendor" : "customer"
  const opposite: Relationship = sideForDoc === "vendor" ? "customer" : "vendor"
  const existing = await getContactRelationship(ctx.db, input.contact_id)

  if (!existing) {
    const row = await upsertContactRelationship(ctx.db, {
      contact_id: input.contact_id,
      relationship: sideForDoc,
      source: "inferred",
    })
    return { status: "ok", row, action: "created" }
  }

  if (existing.source === "manual") {
    if (existing.relationship !== sideForDoc && existing.relationship !== "both") {
      await ctx.emit({
        entity: "invoicing",
        action: "contact_conflict",
        entityId: input.contact_id,
        data: {
          contact_id: input.contact_id,
          manual_relationship: existing.relationship,
          incoming_side: sideForDoc,
          document_type: input.document_type,
        },
      })
      return { status: "attention", reason: "manual_conflict", existing }
    }
    return { status: "ok", row: existing, action: "noop" }
  }

  if (existing.relationship === opposite) {
    const row = await upsertContactRelationship(ctx.db, {
      contact_id: input.contact_id,
      relationship: "both",
      source: "inferred",
    })
    return { status: "ok", row, action: "upgraded" }
  }
  return { status: "ok", row: existing, action: "noop" }
}
