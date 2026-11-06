// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ai_models_get` / `ai_models_set`: Settings > Models for an agent or an MCP
// client. Both run the page's own code (ai-models-admin.ts), so a change gets
// the same checks, row lock and test call as the page. Masked key hints stay
// out of a read: an agent needs a model's key, never a hint of a provider's
// secret.
import { reasoningLevelSchema } from "@liaison/shared"
import { z } from "zod"
import { openRouterModelKey } from "~/modules/agent/credits/model-keys"
import {
  filterCatalogue,
  getOpenRouterCatalogue,
  OpenRouterUnavailableError,
} from "~/modules/agent/credits/openrouter-catalogue"
import {
  type AiModelsPatch,
  type AiModelsRefusal,
  addOpenRouterModel,
  demoModelsLocked,
  getAiModelsState,
  notAddableReason,
  patchAiModels,
} from "~/modules/settings/ai-models-admin"

const modelKey = z.string().min(1).max(200)

export const aiModelsSetParams = z.strictObject({
  autoModelKey: modelKey
    .nullable()
    .optional()
    .describe("The model key Auto runs; null goes back to the cheapest model with a key."),
  defaultReasoningLevel: reasoningLevelSchema
    .nullable()
    .optional()
    .describe("The level of a turn that asks for none; null restores the built-in default."),
  enable: z.array(modelKey).max(50).optional().describe("Model keys to switch on."),
  disable: z.array(modelKey).max(50).optional().describe("Model keys to switch off."),
  addFromOpenRouter: z
    .string()
    .min(1)
    .max(180)
    .optional()
    .describe(
      "An OpenRouter id to add first, e.g. deepseek/deepseek-v4.1-flash-1017. Its model key is openrouter/<id>.",
    ),
})
export type AiModelsSetParams = z.infer<typeof aiModelsSetParams>

interface AiModelsToolCtx {
  orgId: string
}

function toolRefusal(refused: AiModelsRefusal) {
  return { error: refused.message, code: refused.code }
}

/** The patch part of a request: only the fields it names. */
function patchOf(p: AiModelsSetParams): AiModelsPatch {
  return {
    ...(p.autoModelKey !== undefined ? { autoModelKey: p.autoModelKey } : {}),
    ...(p.defaultReasoningLevel !== undefined
      ? { defaultReasoningLevel: p.defaultReasoningLevel }
      : {}),
    ...(p.enable ? { enable: p.enable } : {}),
    ...(p.disable ? { disable: p.disable } : {}),
  }
}

export async function handleAiModelsGet(
  params: { openRouterSearch?: string },
  ctx: AiModelsToolCtx,
) {
  const state = await getAiModelsState(ctx.orgId)
  const view = {
    auto: state.auto,
    defaultReasoningLevel: state.defaultReasoningLevel,
    providers: state.providers.map((p) => ({ provider: p.provider, usable: p.usable })),
    models: state.models.map((m) => ({
      key: m.key,
      displayName: m.displayName,
      enabled: m.enabled,
      available: m.available,
      inputCostPerM: m.inputCostPerM,
      outputCostPerM: m.outputCostPerM,
      reasoningLevels: m.reasoning.allowedLevels,
    })),
  }
  if (!params.openRouterSearch) return view
  if (!state.providers.some((p) => p.provider === "openrouter" && p.usable)) {
    return { ...view, openRouter: { error: "Add an OpenRouter key first." } }
  }
  try {
    const added = new Set(state.models.map((m) => m.key))
    const rows = filterCatalogue(await getOpenRouterCatalogue(), {
      q: params.openRouterSearch,
      toolsOnly: true,
      limit: 20,
    })
    return {
      ...view,
      openRouter: {
        models: rows.map((m) => ({
          upstreamId: m.upstreamId,
          displayName: m.displayName,
          inputCostPerM: m.inputCostPerM,
          outputCostPerM: m.outputCostPerM,
          added: added.has(openRouterModelKey(m.upstreamId)),
          addable: notAddableReason(m) === null,
        })),
      },
    }
  } catch (err) {
    if (err instanceof OpenRouterUnavailableError) {
      return { ...view, openRouter: { error: err.message } }
    }
    throw err
  }
}

/** Answer before any approval card: a demo org's models are fixed, an empty request does nothing. */
export async function aiModelsSetRefusal(params: unknown, ctx: AiModelsToolCtx) {
  const locked = await demoModelsLocked(ctx.orgId)
  if (locked) return toolRefusal(locked)
  const parsed = aiModelsSetParams.safeParse(params)
  if (!parsed.success) return null
  if (parsed.data.addFromOpenRouter || Object.keys(patchOf(parsed.data)).length > 0) return null
  return { error: "Nothing to change: name at least one setting.", code: "nothing_to_change" }
}

export async function handleAiModelsSet(params: AiModelsSetParams, ctx: AiModelsToolCtx) {
  const locked = await demoModelsLocked(ctx.orgId)
  if (locked) return toolRefusal(locked)

  let added: string | undefined
  if (params.addFromOpenRouter) {
    const key = openRouterModelKey(params.addFromOpenRouter)
    const { models } = await getAiModelsState(ctx.orgId)
    if (!models.some((m) => m.key === key)) {
      const outcome = await addOpenRouterModel(ctx.orgId, params.addFromOpenRouter)
      if (!outcome.ok) return toolRefusal(outcome)
      added = key
    }
  }

  const patch = patchOf(params)
  if (Object.keys(patch).length === 0) return { added: added ?? null }
  const outcome = await patchAiModels(ctx.orgId, patch)
  if (!outcome.ok) {
    return { ...toolRefusal(outcome), ...(added ? { added, note: "The model was added." } : {}) }
  }
  return {
    ...(added ? { added } : {}),
    autoModelKey: outcome.view.autoModelKey,
    resolvedKey: outcome.view.resolvedKey,
    defaultReasoningLevel: outcome.view.defaultReasoningLevel,
    disabled: outcome.view.disabled,
  }
}
