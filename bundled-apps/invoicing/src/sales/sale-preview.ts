// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The document a stream sale would become, rendered before anything is issued: the sale runs
// through `issueSale` itself (the same checks, parks, classification, lines, rates, mentions and
// totals), on a context that writes nothing. At the issue step the flow renders each document
// unnumbered and watermarked (`previewDocument`, issue.ts) instead of issuing it; a write the
// flow attempts before that (a park: the sale cannot issue) stops the preview and says why.
// Allowed writes: the ECB rate cache (`fx_rates`, public reference rates) only; the e-invoicing
// gate's first-write default and the buyer's derived identity are skipped, not written. The preview PDF
// is an internal file of the organization: never mailed, never linked to the buyer. It is stored
// under a `sale_preview` row (the host inserts it with the file), readable by a person who holds
// the issuer's settings read and documents read scopes; the previews of a sale are replaced by
// its next preview and removed after PREVIEW_TTL_DAYS (catch-up.ts).
//
// With `render: false` the same run checks everything and renders nothing: what the catch-up
// preview reports as each sale's blockers, from the very checks the issue runs.

import type { Sale } from "@liaison/app-sdk/contracts"
import type { PreviewedDocument, PreviewParent } from "../issue"
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
        // The buyer's derived identity the issue records on its contact (ensureDerivedIdentity): a
        // preview's contact is a placeholder, so nothing is recorded.
        if ((prop === "insert" || prop === "update") && entity === "counterparty_identities")
          return Promise.resolve(prop === "update" ? args[2] : args[1])
        const data = (prop === "update" ? args[2] : args[1]) as Row | undefined
        throw new PreviewWrite(entity, data && typeof data === "object" ? data : null)
      }
    },
  })
}

export type SalePreview =
  | { outcome: "preview"; documents: PreviewedDocument[] }
  | {
      outcome: "would_park"
      reason: string
      blocked_on: unknown
      /** The park's status: `awaiting_data` waits on the sale's own data, anything else on the
       *  organization (issuer profile, configuration, a rate). */
      status: string | null
    }
  | { outcome: "not_issued"; status: string; reason: string | null }
  | { outcome: "refused"; error: string }

/** Render the documents `sale` would get under `stream`, writing nothing. */
export async function previewSale(
  stream: RevenueStream,
  sale: Sale,
  ctx: SaleCtx,
  opts: { render?: boolean; parent?: (scope: "goods" | "software") => PreviewParent } = {},
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
    preview: {
      filename: (scope) => `preview-${safe}-${scope}.pdf`,
      render: opts.render !== false,
      ...(opts.parent ? { parent: opts.parent } : {}),
    },
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
          status: typeof err.data.status === "string" ? err.data.status : null,
        }
      }
      return {
        outcome: "would_park",
        reason: `would_write_${err.entity}`,
        blocked_on: null,
        status: null,
      }
    }
    // What issueDocument refuses before numbering (a missing ECB rate on an e-invoice, an
    // incomplete recipient, the e-invoicing gate): the issue would be refused the same way.
    return { outcome: "refused", error: err instanceof Error ? err.message : String(err) }
  }
}
