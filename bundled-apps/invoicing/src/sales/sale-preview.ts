// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The document a stream sale would become, rendered before anything is issued: the sale runs
// through `issueSale` itself (the same checks, parks, classification, lines, rates, mentions and
// totals), on a context that writes nothing. At the issue step the flow renders each document
// unnumbered and watermarked (`previewDocument`, issue.ts) instead of issuing it; a write the
// flow attempts before that (a park: the sale cannot issue) stops the preview and says why.
// Allowed writes: the ECB rate cache (`fx_rates`, public reference rates) only; the e-invoicing
// gate's first-write default is skipped, not written. The preview PDF
// is an internal file of the organization: never mailed, never linked to the buyer.

import type { Sale } from "@liaison/app-sdk/contracts"
import type { PreviewedDocument } from "../issue"
import { issueSale, type SaleCtx } from "./issue-sale"
import type { RevenueStream } from "./streams"

type Row = Record<string, unknown>

/** A write the preview refused; carries what it would have written. */
export class PreviewWrite extends Error {
  constructor(
    readonly entity: string,
    readonly data: Row | null,
  ) {
    super(`preview: would write ${entity}`)
  }
}

const READS = new Set(["findMany", "findOne", "count"])

/** `db` with every write refused (`PreviewWrite`), except the ECB rate cache. */
export function readOnlyDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function" || typeof prop !== "string" || READS.has(prop)) {
        return typeof value === "function" ? value.bind(target) : value
      }
      return (...args: unknown[]) => {
        const entity = typeof args[0] === "string" ? args[0] : "batch"
        if (prop === "insert" && entity === "fx_rates") return value.apply(target, args)
        // The gate mode's first-write default (einvoicing/gate.ts resolveGateMode): the mode is
        // what the read computed; the preview does not write the default down.
        if (prop === "insert" && entity === "einvoicing_settings") return Promise.resolve(args[1])
        const data = (prop === "update" ? args[2] : args[1]) as Row | undefined
        throw new PreviewWrite(entity, data && typeof data === "object" ? data : null)
      }
    },
  })
}

export type SalePreview =
  | { outcome: "preview"; documents: PreviewedDocument[] }
  | { outcome: "would_park"; reason: string; blocked_on: unknown }
  | { outcome: "not_issued"; status: string; reason: string | null }
  | { outcome: "refused"; error: string }

/** Render the documents `sale` would get under `stream`, writing nothing. */
export async function previewSale(
  stream: RevenueStream,
  sale: Sale,
  ctx: SaleCtx,
): Promise<SalePreview> {
  const safe = String(sale.external_id).replace(/[^A-Za-z0-9_-]/g, "_")
  const dry: SaleCtx = {
    ...ctx,
    db: readOnlyDb(ctx.db),
    // The person's decision is the review of this preview: no approval is asked for.
    approval: { approvalRequestId: "preview", approvalDeciderId: "preview", toolName: "preview" },
    requestApproval: async () => {
      throw new PreviewWrite("approval", null)
    },
    // No contact is created for a preview: a placeholder id, read by nothing that is written.
    resolveContact: async () => ({ id: "00000000-0000-4000-8000-000000000000" }),
    emit: async () => undefined,
    preview: { filename: (scope) => `preview-${safe}-${scope}.pdf` },
  }
  try {
    const r = await issueSale(stream, sale, dry)
    if (r.status === "preview") return { outcome: "preview", documents: r.documents }
    return {
      outcome: "not_issued",
      status: r.status,
      reason: "reason" in r && typeof r.reason === "string" ? r.reason : null,
    }
  } catch (err) {
    if (err instanceof PreviewWrite) {
      if (err.entity === "deferred_events" && err.data) {
        return {
          outcome: "would_park",
          reason: String(err.data.reason ?? "parked"),
          blocked_on: err.data.blocked_on ?? null,
        }
      }
      return { outcome: "would_park", reason: `would_write_${err.entity}`, blocked_on: null }
    }
    // What issueDocument refuses before numbering (a missing ECB rate on an e-invoice, an
    // incomplete recipient, the e-invoicing gate): the issue would be refused the same way.
    return { outcome: "refused", error: err instanceof Error ? err.message : String(err) }
  }
}
