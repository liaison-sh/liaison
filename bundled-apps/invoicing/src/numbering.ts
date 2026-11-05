// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D3 — In-app numbering helper.
//
// Resolves the per-type prefix from the issuer profile, calls K3
// `ctx.sequences.allocate` to consume the next value in the
// `(issuer, type, year)` sequence, and formats the result with
// `{YYYY}` expansion + 4-digit zero-padding.
//
// Ambient-tx behavior (rollback-safety) is provided by K3 itself; this
// helper is a thin orchestrator on top.

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

interface SequencesSurface {
  sequences: {
    allocate(p: { key: string }): Promise<{ value: number }>
  }
}

export interface IssuerProfileForNumbering {
  id: string
  prefix_invoice?: string
  prefix_quote?: string
  prefix_proforma?: string
  prefix_po?: string
  prefix_credit_note?: string
}

export interface AllocateNumberInput {
  issuer_profile: IssuerProfileForNumbering
  type: DocumentType
  year_of_issue: number
  /**
   * Whether a document of this (issuer, type, year) already holds `value`.
   * The sequence lives in `kernel.app_sequences`, apart from the documents, so
   * documents written another way (an import, a migration, a seed) can hold
   * numbers the sequence has not counted. Given this, the allocator steps past
   * every taken number instead of handing one out twice.
   */
  isTaken?: (value: number) => Promise<boolean>
}

/** How far past the sequence the allocator walks before refusing. */
export const MAX_TAKEN_SKIPS = 10_000

export interface AllocateNumberResult {
  value: number
  formatted: string
}

const PREFIX_KEY_BY_TYPE: Record<DocumentType, keyof IssuerProfileForNumbering> = {
  invoice: "prefix_invoice",
  quote: "prefix_quote",
  proforma: "prefix_proforma",
  purchase_order: "prefix_po",
  credit_note: "prefix_credit_note",
}

/**
 * Expand the prefix template (`{YYYY}` token) and append the sequence value
 * as a zero-padded 4-digit string. Sequences > 9999 are rendered without
 * truncation (the pad is a minimum width, not a maximum).
 */
export function formatNumberString(prefix: string, year: number, seq: number): string {
  const expanded = prefix.replace("{YYYY}", String(year))
  return expanded + seq.toString().padStart(4, "0")
}

export async function allocateNumber(
  ctx: SequencesSurface,
  { issuer_profile, type, year_of_issue, isTaken }: AllocateNumberInput,
): Promise<AllocateNumberResult> {
  const prefixKey = PREFIX_KEY_BY_TYPE[type]
  const prefix = issuer_profile[prefixKey]
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error(
      `issuer_profile is missing ${prefixKey} (required to format ${type} numbers)`,
    )
  }

  const key = `invoicing:doc_number:${issuer_profile.id}:${type}:${year_of_issue}`
  let value = await allocateOnce(ctx, key)
  // A number already on a document is consumed, not reissued: the sequence was
  // behind the table. Each step allocates (and so counts) the taken number, so
  // the sequence ends past every document and the next issue costs one call.
  if (isTaken) {
    let skips = 0
    while (await isTaken(value)) {
      if (++skips > MAX_TAKEN_SKIPS) {
        throw new Error(
          `sequence "${key}" is more than ${MAX_TAKEN_SKIPS} numbers behind the documents already issued`,
        )
      }
      value = await allocateOnce(ctx, key)
    }
  }

  return {
    value,
    formatted: formatNumberString(prefix, year_of_issue, value),
  }
}

async function allocateOnce(ctx: SequencesSurface, key: string): Promise<number> {
  // The bridge returns either `{ value }` or an error envelope `{ error }`.
  // Guard explicitly: a missing/non-numeric value means sequence allocation
  // failed upstream — surfacing the envelope here beats a cryptic
  // `undefined.toString()` deep in number formatting.
  const allocResp = (await ctx.sequences.allocate({ key })) as {
    value?: number
    error?: { code?: string; message?: string }
  }
  if (allocResp == null || typeof allocResp.value !== "number") {
    throw new Error(`sequence allocation failed for "${key}": ${JSON.stringify(allocResp)}`)
  }
  return allocResp.value
}
