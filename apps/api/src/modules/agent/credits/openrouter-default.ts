// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AUTO ON AN OPENROUTER KEY ALONE.
//
// Auto's own rule picks among the native catalogue (Anthropic, OpenAI, Google,
// Mistral). An org whose only key is OpenRouter's has none of those, and an
// OpenRouter model joins Auto only once it is an added model an admin chose.
// So a workspace provisioned with one OpenRouter key had nothing to run until
// someone opened Settings > AI models, added a model and made it Auto.
//
// `ensureOpenRouterAutoModel` does that step for it, when and only when the
// org holds no native key and Auto has nothing else to run: it adds
// OpenRouter's default model (the same model the demo runs on, `VISITOR_MODEL_UPSTREAM_DEFAULT`) from OpenRouter's
// catalogue and makes it Auto. It runs where an OpenRouter key is stored
// (`liaison config apply`, the AI keys settings route) and, for a workspace
// keyed before this existed, on the first turn that finds Auto empty.
//
// It runs ONCE per org: it records `ai.models.openRouterDefaultProvisionedAt`,
// and once that is set it never adds the default again, so an admin who
// removes it (or switches it off, or picks another Auto) is obeyed. It never
// overrides a choice: an org whose Auto already runs something is left alone,
// and everything it relied on is re-checked under the org row lock before the
// write, so an admin's concurrent change wins.
import {
  type AiModelsSettings,
  type OrgKernelSettings,
  orgKernelSettingsSchema,
} from "@liaison/shared"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { mutateAiModels } from "~/modules/agent/credits/ai-models-store"
import {
  hasUsableNativeKey,
  isProviderUsable,
  selectAutoModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import { findAddedModel, openRouterModelKey } from "~/modules/agent/credits/model-keys"
import {
  getOpenRouterCatalogue,
  OpenRouterUnavailableError,
  openRouterEntry,
} from "~/modules/agent/credits/openrouter-catalogue"
import { isVisitorDemoOrg, reservedDemoModelId } from "~/modules/demo/demo-spend"
import { VISITOR_MODEL_UPSTREAM_DEFAULT } from "~/modules/demo/demo-spend-ceiling"

const log = rootLogger.child({ module: "openrouter-default" })

/** The model key Auto gets on an OpenRouter key alone. */
export const OPENROUTER_AUTO_DEFAULT_KEY = openRouterModelKey(VISITOR_MODEL_UPSTREAM_DEFAULT)

export type OpenRouterAutoOutcome =
  /** The default was added (if absent) and made Auto. */
  | { status: "set"; key: string }
  /** Auto already runs a model (or the workspace is pinned): nothing to do. */
  | { status: "not_needed" }
  /** Done once already for this org: whatever the admin did since stands. */
  | { status: "already_provisioned" }
  /** No usable OpenRouter key. */
  | { status: "no_key" }
  /** OpenRouter cannot provide the default right now, or an admin switched it off. */
  | { status: "unavailable"; reason: string }

/**
 * Why the default must not be made Auto for this org now, or null when it
 * may. Asked once before the catalogue fetch and again under the row lock.
 */
async function skipReason(
  orgId: string,
  settings: OrgKernelSettings,
  reason: string,
  /** Under the row lock: the mutation's privileged transaction, read on directly. */
  db?: PrivilegedDb,
): Promise<OpenRouterAutoOutcome | null> {
  const models: AiModelsSettings = settings.ai?.models ?? {}
  if (models.openRouterDefaultProvisionedAt) return { status: "already_provisioned" }
  // Only for an org with no native key: where a native model is usable, an
  // added model is Auto only when an admin chose it.
  if (await hasUsableNativeKey(orgId, settings, db)) return { status: "not_needed" }
  if (await selectAutoModelForOrg(orgId, reason, settings, db)) return { status: "not_needed" }
  if (!(await isProviderUsable(orgId, "openrouter", settings, db))) return { status: "no_key" }
  const existing = findAddedModel(models, OPENROUTER_AUTO_DEFAULT_KEY)
  if (existing && !existing.enabled) {
    return { status: "unavailable", reason: `${existing.displayName} is switched off.` }
  }
  return null
}

/**
 * Make OpenRouter's default model this org's Auto when the org holds no native
 * key, Auto has nothing else to run, the org can reach OpenRouter, and this
 * was never done for it before. Idempotent; never throws for an OpenRouter
 * outage (it reports `unavailable`). The managed edition is left as it is:
 * its Auto runs on the platform's native keys.
 */
export async function ensureOpenRouterAutoModel(orgId: string): Promise<OpenRouterAutoOutcome> {
  if (isManagedEdition()) return { status: "not_needed" }
  // A demo visitor's model is the pin; the reserved demo org is pinned too.
  if (await isVisitorDemoOrg(orgId)) return { status: "not_needed" }
  if (await reservedDemoModelId(orgId)) return { status: "not_needed" }

  const settings: OrgKernelSettings = await withPrivilegedDb(
    orgId,
    "openrouter-auto:settings",
    (tx) => getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const skip = await skipReason(orgId, settings, "openrouter-auto:check")
  if (skip) return skip

  const key = OPENROUTER_AUTO_DEFAULT_KEY
  // The network (catalogue) first, never under the row lock.
  let entry = findAddedModel(settings.ai?.models ?? {}, key) ?? null
  if (!entry) {
    try {
      const cat = (await getOpenRouterCatalogue()).find(
        (m) => m.upstreamId === VISITOR_MODEL_UPSTREAM_DEFAULT,
      )
      if (!cat) {
        return { status: "unavailable", reason: "OpenRouter does not list its default model." }
      }
      if (!cat.tools || cat.inputCostPerM === null || cat.outputCostPerM === null) {
        return {
          status: "unavailable",
          reason: "OpenRouter's default model has no fixed price or does not call tools.",
        }
      }
      entry = openRouterEntry(cat, new Date().toISOString())
    } catch (err) {
      if (err instanceof OpenRouterUnavailableError) {
        log.warn(
          { orgId, err: err.message },
          "OpenRouter catalogue unavailable for the Auto default",
        )
        return { status: "unavailable", reason: err.message }
      }
      throw err
    }
  }

  const fresh = entry
  const outcome = await mutateAiModels<OpenRouterAutoOutcome>(
    orgId,
    "openrouter-auto:set",
    async (cur, tx) => {
      // Re-check under the org row lock: an admin may have chosen an Auto
      // model, added a native key or removed the OpenRouter key meanwhile.
      const now = await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema)
      const locked = { ...now, ai: { ...(now.ai ?? {}), models: cur } }
      const changed = await skipReason(orgId, locked, "openrouter-auto:recheck", tx)
      if (changed) return { result: changed }
      const present = findAddedModel(cur, key)
      return {
        next: {
          ...cur,
          added: present ? cur.added : [...(cur.added ?? []), fresh],
          autoModelKey: key,
          openRouterDefaultProvisionedAt: new Date().toISOString(),
        },
        result: { status: "set", key },
      }
    },
  )
  if (outcome.status === "set") log.info({ orgId, key }, "OpenRouter default model made Auto")
  return outcome
}
