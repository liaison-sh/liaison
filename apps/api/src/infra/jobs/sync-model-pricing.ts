// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { modelPricing, systemConfig } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { jobsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"

/**
 * Kernel table for this job's raw SQL, resolved per call through `schemaRef`.
 * The job's Drizzle queries already follow SCHEMA_PREFIX, so a fixed `kernel.`
 * here would split one run across two schemas: the rate read from one table and
 * written to another, and the staleness scan over rows the sync never touched.
 */
function kernelTable(table: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent(table)}`)
}

const ECB_URL =
  "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata"
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const BOOTSTRAP_RATE = 1.15

interface EcbRateValue {
  rate: number
  fetchedAt: string
}

interface EcbResponse {
  dataSets?: Array<{
    series?: Record<string, { observations?: Record<string, [number?]> }>
  }>
}

type LitellmPricing = Record<string, Record<string, unknown>>

async function fetchEcbRate(): Promise<number | null> {
  try {
    const res = await fetch(ECB_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`ECB HTTP ${res.status}`)
    const data = (await res.json()) as EcbResponse
    const rate = data?.dataSets?.[0]?.series?.["0:0:0:0:0"]?.observations?.["0"]?.[0]
    if (typeof rate !== "number" || rate <= 0) throw new Error(`Invalid ECB rate: ${rate}`)
    return rate
  } catch (err) {
    log.warn({ err }, "Failed to fetch ECB exchange rate")
    return null
  }
}

async function getLastKnownRate(): Promise<number | null> {
  const [row] = await withSystemDb("read-ecb-rate", (db) =>
    db.select().from(systemConfig).where(eq(systemConfig.key, "usd_eur_rate")),
  )

  const value = row?.value as EcbRateValue | undefined
  if (value?.rate && typeof value.rate === "number") {
    log.info({ rate: value.rate }, "Using last-known ECB rate")
    return value.rate
  }

  return null
}

async function getEffectiveRate(freshRate: number | null): Promise<number> {
  if (freshRate !== null) return freshRate

  const lastKnown = await getLastKnownRate()
  if (lastKnown !== null) return lastKnown

  log.warn("No last-known ECB rate found, using bootstrap rate")
  return BOOTSTRAP_RATE
}

/** Store `rate` as the current USD to EUR rate, stamped now (what a successful ECB fetch stores). */
export async function persistEcbRate(rate: number): Promise<void> {
  const value: EcbRateValue = { rate, fetchedAt: new Date().toISOString() }

  await withSystemDb("persist-ecb-rate", async (db) => {
    await db.execute(drizzleSql`
      INSERT INTO ${kernelTable("system_config")} (key, value, updated_at)
      VALUES ('usd_eur_rate', ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  })
}

// A rate this fresh is reused rather than fetched again.
const RATE_REUSE_MS = 24 * 60 * 60 * 1000

/**
 * The USD to EUR rate the pricing sync uses, for other price conversions (the
 * OpenRouter catalogue): the rate the sync last stored when it is under a day
 * old, else a fresh ECB fetch (stored for the next caller), else the last-known
 * or bootstrap rate exactly as the sync falls back. Dollars divide by it.
 */
export async function currentUsdEurRate(): Promise<number> {
  const [row] = await withSystemDb("read-ecb-rate", (db) =>
    db.select().from(systemConfig).where(eq(systemConfig.key, "usd_eur_rate")),
  )
  const value = row?.value as EcbRateValue | undefined
  const fetchedAt = value?.fetchedAt ? Date.parse(value.fetchedAt) : Number.NaN
  if (
    typeof value?.rate === "number" &&
    value.rate > 0 &&
    Number.isFinite(fetchedAt) &&
    Date.now() - fetchedAt < RATE_REUSE_MS
  ) {
    return value.rate
  }
  const fresh = await fetchEcbRate()
  if (fresh !== null) await persistEcbRate(fresh)
  return getEffectiveRate(fresh)
}

/** A USD per-token price as EUR per million tokens, at `ecbRate` USD per EUR. */
export function usdPerTokenToEurPerM(perTokenCost: number, ecbRate: number): string {
  return convertToEurCost(perTokenCost, ecbRate)
}

async function fetchLitellmPricing(): Promise<LitellmPricing | null> {
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`LiteLLM HTTP ${res.status}`)
    return (await res.json()) as LitellmPricing
  } catch (err) {
    log.warn({ err }, "Failed to fetch LiteLLM pricing data")
    return null
  }
}

function findLitellmEntry(
  litellm: LitellmPricing,
  provider: string,
  modelId: string,
): Record<string, unknown> | undefined {
  return litellm[modelId] ?? litellm[`${provider}/${modelId}`]
}

function convertToEurCost(perTokenCost: number, ecbRate: number): string {
  return ((perTokenCost * 1_000_000) / ecbRate).toFixed(8)
}

function resolveContextWindow(entry: Record<string, unknown>, fallback: number): number {
  const maxInputTokens = entry.max_input_tokens
  if (typeof maxInputTokens === "number") return maxInputTokens
  const maxTokens = entry.max_tokens
  if (typeof maxTokens === "number") return maxTokens
  return fallback
}

export async function syncModelPricing(): Promise<void> {
  // Step 1: Fetch ECB rate
  const freshRate = await fetchEcbRate()
  const ecbRate = await getEffectiveRate(freshRate)

  if (freshRate !== null) {
    await persistEcbRate(freshRate)
  }

  // Step 2: Fetch LiteLLM data
  const litellm = await fetchLitellmPricing()
  if (!litellm) {
    log.warn("Skipping price sync — LiteLLM data unavailable")
    return
  }

  // Step 3: Scoped sync — only update existing litellm_sync models
  await withSystemDb("sync-model-pricing", async (db) => {
    const syncModels = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.source, "litellm_sync"))

    for (const model of syncModels) {
      const entry = findLitellmEntry(litellm, model.provider, model.modelId)

      if (!entry || entry.mode !== "chat") {
        log.info({ modelId: model.modelId }, "No LiteLLM match found — skipping")
        continue
      }

      const { input_cost_per_token: inputPerToken, output_cost_per_token: outputPerToken } = entry
      if (typeof inputPerToken !== "number" || typeof outputPerToken !== "number") continue

      await db
        .update(modelPricing)
        .set({
          inputCostPerM: convertToEurCost(inputPerToken, ecbRate),
          outputCostPerM: convertToEurCost(outputPerToken, ecbRate),
          contextWindow: resolveContextWindow(entry, model.contextWindow),
          updatedAt: new Date(),
        })
        .where(eq(modelPricing.id, model.id))

      log.debug({ modelId: model.modelId }, "Updated model pricing")
    }

    // Step 4: Staleness check
    const staleResult = await db.execute(drizzleSql`
      SELECT model_id FROM ${kernelTable("model_pricing")}
      WHERE source = 'litellm_sync' AND updated_at < now() - interval '7 days'
    `)

    for (const { model_id: modelId } of extractRows<{ model_id: string }>(staleResult)) {
      log.warn({ modelId }, "Model pricing is stale (>7 days)")
    }
  })
}
