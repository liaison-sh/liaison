// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A Knowledge page is indexed (and its search snippets cut) from its text without the
 * file and page tokens: a token holds only an id, which is no word anyone searches for,
 * and a snippet must never show one. Registered at boot, before the indexer, like the
 * tickets and mail hooks (infra/boot-phase10.ts).
 */
import { plainTextOf } from "@liaison/shared"
import { registerSearchEnrichment } from "~/modules/search/enrichment"

/** The indexed text of a page body. */
export function searchableBodyOf(body: unknown): string | null {
  return typeof body === "string" ? plainTextOf(body) : null
}

let registered = false

/** Idempotent: only the first call registers. */
export function registerKnowledgeSearchEnrichment(): void {
  if (registered) return
  registered = true
  registerSearchEnrichment("knowledge", "document", async (row) => ({
    body: searchableBodyOf(row.body),
  }))
}
