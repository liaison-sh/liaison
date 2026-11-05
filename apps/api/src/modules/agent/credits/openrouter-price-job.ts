// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DAILY OPENROUTER PRICE REFRESH (S8): one catalogue fetch per run, then
// every org's added OpenRouter models get today's EUR prices. A model the
// catalogue no longer lists is marked `unavailableSince` (the AI models page
// says so) and keeps its last prices; one that comes back is cleared.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { jobsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { mutateAiModels } from "~/modules/agent/credits/ai-models-store"
import { getOpenRouterCatalogue } from "~/modules/agent/credits/openrouter-catalogue"

export async function refreshOpenRouterPrices(
  now: Date = new Date(),
): Promise<{ orgs: number; updated: number; unavailable: number }> {
  const catalogue = await getOpenRouterCatalogue({ fresh: true })
  const byId = new Map(catalogue.map((m) => [m.upstreamId, m]))
  const at = now.toISOString()

  const orgs = await withSystemDb("openrouter-price-orgs", async (db) =>
    extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id FROM ${drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("organizations")}`)}
        WHERE settings->'ai'->'models'->'added' @> '[{"provider":"openrouter"}]'::jsonb
      `),
    ),
  )

  let updated = 0
  let unavailable = 0
  for (const { id: orgId } of orgs) {
    try {
      await mutateAiModels(orgId, "openrouter-price-refresh", async (cur) => {
        const added = (cur.added ?? []).map((m) => {
          if (m.provider !== "openrouter") return m
          const cat = byId.get(m.upstreamId)
          if (!cat) {
            unavailable++
            return { ...m, unavailableSince: m.unavailableSince ?? at }
          }
          updated++
          return {
            ...m,
            inputCostPerM: cat.inputCostPerM,
            outputCostPerM: cat.outputCostPerM,
            contextWindow: cat.contextWindow,
            priceUpdatedAt: at,
            unavailableSince: null,
          }
        })
        return { next: { ...cur, added }, result: null }
      })
    } catch (err) {
      log.error({ err, orgId }, "OpenRouter price refresh failed for an org")
    }
  }
  log.info({ orgs: orgs.length, updated, unavailable }, "OpenRouter prices refreshed")
  return { orgs: orgs.length, updated, unavailable }
}
