// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shipments point at their invoice (or proforma) by its id. People read the
// document NUMBER ("INV-2026-0022"), so every surface that names the linked
// document resolves the ids to numbers here, in one invoicing read per page.
import type { CrossAppEnvelope } from "./ctx"

export interface DocumentNumbersCtx {
  executeTool(target: string, args: string | Record<string, unknown>): Promise<CrossAppEnvelope>
}

/** The invoicing read caps a page at 100 documents. */
const PAGE = 100

/**
 * id -> number for the documents `refs` names. A ref the read does not return
 * (deleted, not yet numbered, or the invoicing read refused) is simply absent:
 * the caller falls back to a neutral label, never to the raw id.
 */
export async function documentNumbersById(
  ctx: DocumentNumbersCtx,
  refs: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(refs.filter((r): r is string => typeof r === "string" && r.length > 0))]
  const out = new Map<string, string>()
  for (let i = 0; i < ids.length; i += PAGE) {
    const slice = ids.slice(i, i + PAGE)
    let env: CrossAppEnvelope
    try {
      env = await ctx.executeTool("invoicing:documents_search", { ids: slice, limit: slice.length })
    } catch {
      continue
    }
    if (env.status !== "completed" || !Array.isArray(env.result)) continue
    for (const row of env.result as Array<{ id?: unknown; number?: unknown }>) {
      if (typeof row.id === "string" && typeof row.number === "string" && row.number.length > 0) {
        out.set(row.id, row.number)
      }
    }
  }
  return out
}
