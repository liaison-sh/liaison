// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The models a managed org starts with. A new org on a managed server holds no
// key of its own and the platform's OpenRouter key reaches no model until one
// is added, so its first chat failed with "Auto has no model to run". The
// server's operator names the models in LIAISON_MANAGED_DEFAULT_MODELS
// (OpenRouter ids, comma-separated); `createCloudOrg` adds each one from
// OpenRouter's catalogue, switched on, and makes the first one Auto.
//
// Idempotent, so a resumed creation completes it: a model already in the org's
// list is left as it is, and Auto is set only while the org has none. Admins
// add, remove or switch models afterwards like any other added model.
//
// Creation does not wait for OpenRouter: when its catalogue cannot be read
// then, the first turn of a managed org with no Auto model adds them
// (`ensureManagedDefaultModelsOnDemand`, from the turn's model pre-check), so
// an outage at signup never leaves the org without a model for good.

import { isManagedEdition } from "~/lib/edition"
import { env, parseManagedDefaultModels } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { mutateAiModels } from "~/modules/agent/credits/ai-models-store"
import { findAddedModel } from "~/modules/agent/credits/model-keys"
import {
  getOpenRouterCatalogue,
  openRouterEntry,
} from "~/modules/agent/credits/openrouter-catalogue"

const log = rootLogger.child({ module: "cloud-default-models" })

export interface DefaultModelsOutcome {
  /** Model keys now in the org's list from the configured ids. */
  added: string[]
  /** Configured ids the catalogue does not list, or lists without a fixed price or tools. */
  missing: string[]
  /** The Auto model key this call set, if it set one. */
  auto: string | null
}

/** The configured default model ids (empty when unset). */
export function managedDefaultModelIds(raw = env.LIAISON_MANAGED_DEFAULT_MODELS): string[] {
  return raw ? (parseManagedDefaultModels(raw) ?? []) : []
}

/**
 * Add the configured default models to the org, the first available one as
 * Auto when the org has no Auto model. Throws when OpenRouter's catalogue
 * cannot be read (the caller decides whether creation waits for it).
 */
export async function ensureManagedDefaultModels(
  orgId: string,
  ids: string[] = managedDefaultModelIds(),
): Promise<DefaultModelsOutcome> {
  if (ids.length === 0) return { added: [], missing: [], auto: null }
  const catalogue = await getOpenRouterCatalogue()
  const now = new Date().toISOString()
  const missing: string[] = []
  const entries = ids.flatMap((id) => {
    const cat = catalogue.find((m) => m.upstreamId === id)
    if (!cat?.tools || cat.inputCostPerM === null || cat.outputCostPerM === null) {
      missing.push(id)
      return []
    }
    return [openRouterEntry(cat, now)]
  })
  if (missing.length > 0) {
    log.error(
      { orgId, missing },
      "LIAISON_MANAGED_DEFAULT_MODELS names models OpenRouter does not offer with a fixed price and tools",
    )
  }
  const outcome = await mutateAiModels<DefaultModelsOutcome>(
    orgId,
    "cloud-default-models",
    async (cur) => {
      const toAdd = entries.filter((e) => !findAddedModel(cur, e.key))
      const auto = cur.autoModelKey ? null : (entries[0]?.key ?? null)
      return {
        next: {
          ...cur,
          added: [...(cur.added ?? []), ...toAdd],
          ...(auto ? { autoModelKey: auto } : {}),
        },
        result: { added: entries.map((e) => e.key), missing, auto },
      }
    },
  )
  log.info({ orgId, ...outcome }, "managed org default models")
  return outcome
}

/** One on-demand attempt per org per window, so an outage is not retried on every turn. */
const ON_DEMAND_RETRY_MS = 60_000
const lastOnDemandAttempt = new Map<string, number>()

/**
 * For a turn that found no Auto model: on a managed server with default models
 * configured, add them now (the creation could not). True when the org has an
 * Auto model afterwards; never throws (the turn then reports no model as before).
 */
export async function ensureManagedDefaultModelsOnDemand(
  orgId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!isManagedEdition() || managedDefaultModelIds().length === 0) return false
  const last = lastOnDemandAttempt.get(orgId)
  if (last !== undefined && now - last < ON_DEMAND_RETRY_MS) return false
  lastOnDemandAttempt.set(orgId, now)
  try {
    const outcome = await ensureManagedDefaultModels(orgId)
    if (outcome.auto) lastOnDemandAttempt.delete(orgId)
    return outcome.auto !== null
  } catch (err) {
    log.error({ err, orgId }, "managed org default models still unavailable on its first turn")
    return false
  }
}
