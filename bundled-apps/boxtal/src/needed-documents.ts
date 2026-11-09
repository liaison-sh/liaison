// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which document templates the Ready-to-ship parcels need, by the organisation's document rules
// (kernel data: "a parcel with SKU X going to the US needs the TSCA certificate"). ONE kernel call
// for the whole list (`kernel:document_rules_match`, at most 500 records a call), never one per
// row. The facts sent are the buy-time snapshot's (queue-facts.ts): SKUs, destination, carrier
// family. A row bought before SKUs were kept sends none and simply matches no SKU rule.
//
// Best effort: the print station must paint even when the kernel read fails (a member without the
// scope, a kernel hiccup); the rows then carry the app's own attention marks only.
import type { TemplateNeed } from "./attention"
import type { BoxtalToolCtx } from "./ctx"

/** The record type the shipment prints and matches as (manifest `entities.shipment.print`). */
export const SHIPMENT_RECORD_TYPE = "boxtal:shipment"
/** The kernel tool's cap on records per call. */
export const MATCH_BATCH = 500

export interface NeedRecord {
  id: string
  skus: string[] | null
  countryIso2: string | null
  carrier_family: string | null
}

interface MatchResult {
  matches?: Array<{
    recordId?: unknown
    rules?: Array<{ id?: unknown; name?: unknown }>
    templates?: Array<{ id?: unknown; name?: unknown }>
  }>
}

export async function loadTemplateNeeds(
  ctx: BoxtalToolCtx,
  records: NeedRecord[],
  recordType: string = SHIPMENT_RECORD_TYPE,
): Promise<Map<string, TemplateNeed>> {
  const out = new Map<string, TemplateNeed>()
  for (let i = 0; i < records.length; i += MATCH_BATCH) {
    const batch = records.slice(i, i + MATCH_BATCH).map((r) => ({
      id: r.id,
      ...(r.skus && r.skus.length > 0 ? { skus: r.skus } : {}),
      ...(r.countryIso2 ? { countryIso2: r.countryIso2 } : {}),
      ...(r.carrier_family ? { carrier_family: r.carrier_family } : {}),
    }))
    try {
      const env = await ctx.executeTool("kernel:document_rules_match", {
        recordType,
        records: batch,
      })
      if (env.status !== "completed") {
        ctx.logger?.warn?.("ready list: document_rules_match did not complete", { status: env.status })
        return out
      }
      for (const m of (env.result as MatchResult | null)?.matches ?? []) {
        if (typeof m.recordId !== "string") continue
        const rules = (m.rules ?? []).map((r) => r.name).filter((n): n is string => typeof n === "string" && n !== "")
        const templates = (m.templates ?? []).flatMap((t) =>
          typeof t.id === "string" && typeof t.name === "string" ? [{ id: t.id, name: t.name }] : [],
        )
        out.set(m.recordId, { rules, templates })
      }
    } catch (err) {
      ctx.logger?.warn?.("ready list: document_rules_match failed", { err: String(err) })
      return out
    }
  }
  return out
}
