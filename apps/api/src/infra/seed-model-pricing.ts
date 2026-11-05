// SPDX-License-Identifier: FSL-1.1-ALv2
import { MODEL_PRICING_SEED } from "@liaison/shared"
import { withSystemDb } from "~/db/privileged"
import { modelPricing } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "seed-model-pricing" })

/**
 * Seed the GLOBAL `kernel.model_pricing` catalog from `MODEL_PRICING_SEED` at
 * boot. Without this, a fresh self-hosted instance has an EMPTY model_pricing
 * table, so EVERY chat fails the model pre-check with "Model not available"
 * (resolveModelForPreCheck looks the model id up in this table and finds nothing)
 * -- even with a valid provider key configured.
 *
 * Idempotent: `ON CONFLICT (provider, model_id) DO NOTHING`, so it only inserts
 * models missing from the table. It never clobbers existing rows -- live pricing
 * maintained by `syncModelPricing` (source = 'litellm_sync') and any operator
 * customisations are left untouched; a later release that adds new seed models
 * just inserts the new ones on the next boot.
 */
export async function seedModelPricing(): Promise<void> {
  if (MODEL_PRICING_SEED.length === 0) return
  const inserted = await withSystemDb("seed-model-pricing", async (db) => {
    const rows = await db
      .insert(modelPricing)
      .values(
        MODEL_PRICING_SEED.map((m) => ({
          provider: m.provider,
          modelId: m.modelId,
          displayName: m.displayName,
          inputCostPerM: m.inputCostPerM,
          outputCostPerM: m.outputCostPerM,
          contextWindow: m.contextWindow,
          autoEligible: m.autoEligible,
          tierMinimum: m.tierMinimum,
          source: m.source,
        })),
      )
      .onConflictDoNothing({
        target: [modelPricing.provider, modelPricing.modelId],
      })
      .returning({ modelId: modelPricing.modelId })
    return rows.length
  })
  log.info(
    { inserted, total: MODEL_PRICING_SEED.length },
    "Model pricing seed complete (missing rows inserted; existing rows untouched)",
  )
}
