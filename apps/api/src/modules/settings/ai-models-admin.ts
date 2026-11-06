// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT THE AI MODELS SETTINGS DO, for both of their callers: the page's API
// (ai-models-routes.ts) and the `ai_models_get` / `ai_models_set` kernel tools.
//
// Every write to `ai.models` goes through `mutateAiModels` (a row lock and one
// sub-path jsonb_set, A11). A test call (network) never runs under that lock:
// it runs first, and the write re-checks what it relied on.
//
// A refusal is a value, not an exception: the routes turn it into a response
// and the tools into `{ error, code }`.
import {
  type AddedModel,
  type AiModelsSettings,
  blockedHostsPatchSchema,
  getReasoningCapability,
  type OrgKernelSettings,
  orgKernelSettingsSchema,
  reasoningLevelSchema,
} from "@liaison/shared"
import { asc } from "drizzle-orm"
import { z } from "zod"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { modelPricing } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { getOrgKernelSettings } from "~/lib/settings"
import { bucketKey, checkRateLimit } from "~/middleware/rate-limiter"
import { mutateAiModels } from "~/modules/agent/credits/ai-models-store"
import {
  isModelKeyAvailable,
  isProviderUsable,
  providerLabelOf,
  resolveKey,
  selectAutoModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import {
  customServerKeyName,
  findAddedModel,
  isChatModelProvider,
  isNativeModelId,
  openRouterModelKey,
  parseModelKey,
} from "~/modules/agent/credits/model-keys"
import { runModelTestCall } from "~/modules/agent/credits/model-test-call"
import {
  getOpenRouterCatalogue,
  OpenRouterUnavailableError,
  openRouterEntry,
} from "~/modules/agent/credits/openrouter-catalogue"
import {
  blockedHostsSource,
  effectiveBlockedHosts,
  openRouterDeniedHosts,
} from "~/modules/agent/providers/openrouter-blocked-hosts"
import { resolveModel } from "~/modules/agent/providers/provider"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { demoSpendMessage, isVisitorDemoOrg, reservedDemoModelId } from "~/modules/demo/demo-spend"

const log = rootLogger.child({ module: "ai-models-admin" })

export const NATIVE_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const
export const KEY_PROVIDERS = [...NATIVE_PROVIDERS, "openrouter"] as const

/** Why a change was refused: the HTTP status the page's API answers with. */
export interface AiModelsRefusal {
  ok: false
  status: 400 | 403 | 404 | 409 | 412 | 422 | 429 | 502
  message: string
  code: string
  retryAfterSeconds?: number
}

function refusal(
  status: AiModelsRefusal["status"],
  message: string,
  code: string,
): AiModelsRefusal {
  return { ok: false, status, message, code }
}

export const aiModelsPatchSchema = z.strictObject({
  enable: z.array(z.string().min(1).max(200)).max(500).optional(),
  disable: z.array(z.string().min(1).max(200)).max(500).optional(),
  autoModelKey: z.string().min(1).max(200).nullable().optional(),
  // The level of a turn that asks for none; null restores the built-in default.
  defaultReasoningLevel: reasoningLevelSchema.nullable().optional(),
  // The OpenRouter hosts this org's requests never reach; null restores
  // the instance default (LIAISON_OPENROUTER_IGNORE_HOSTS).
  blockedHosts: blockedHostsPatchSchema.optional(),
})
export type AiModelsPatch = z.infer<typeof aiModelsPatchSchema>

/**
 * A demo visitor's models are fixed: a visitor is the admin of their demo org,
 * and its model settings are not what their agents run on (the pin comes from
 * code and env). The refusal for a write, or null when the org may write.
 */
export async function demoModelsLocked(orgId: string): Promise<AiModelsRefusal | null> {
  if (!(await isVisitorDemoOrg(orgId))) return null
  const { locale } = await loadDemoOrg(orgId)
  return refusal(403, demoSpendMessage("demo_models_locked", locale), "demo_models_locked")
}

export async function loadSettings(orgId: string): Promise<OrgKernelSettings> {
  return withPrivilegedDb(orgId, "ai-models-settings", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
}

/**
 * The OpenRouter hosts the org's requests never reach: the effective list,
 * whether it is the instance default (the org set none), and that default.
 */
export function blockedHostsView(models: AiModelsSettings) {
  const instanceDefault = openRouterDeniedHosts()
  return {
    hosts: effectiveBlockedHosts(models.blockedHosts, instanceDefault),
    isDefault: !Array.isArray(models.blockedHosts),
    defaultHosts: instanceDefault,
  }
}

/** The settings with `ai.models` replaced, for "what if" availability checks. */
export function withModels(
  settings: OrgKernelSettings,
  models: AiModelsSettings,
): OrgKernelSettings {
  return { ...settings, ai: { ...(settings.ai ?? {}), models } }
}

export async function nativeRows() {
  const rows = await withSystemDb("ai-models-native", (tx) =>
    tx
      .select({
        modelId: modelPricing.modelId,
        provider: modelPricing.provider,
        displayName: modelPricing.displayName,
        contextWindow: modelPricing.contextWindow,
        inputCostPerM: modelPricing.inputCostPerM,
        outputCostPerM: modelPricing.outputCostPerM,
      })
      .from(modelPricing)
      .orderBy(asc(modelPricing.provider), asc(modelPricing.displayName)),
  )
  // Chat models only: the catalogue also prices non-model work (web search).
  return rows.filter((r) => isNativeModelId(r.modelId) && isChatModelProvider(r.provider))
}

export function reasoningOf(key: string, provider: string, entry?: AddedModel) {
  const cap = getReasoningCapability(key, provider, entry)
  return { allowedLevels: cap.allowedLevels, defaultLevel: cap.defaultLevel }
}

export function serverView(
  server: NonNullable<AiModelsSettings["servers"]>[number],
  settings: OrgKernelSettings,
) {
  return {
    id: server.id,
    name: server.name,
    baseURL: server.baseURL,
    keySet: Boolean(settings.providerKeys?.[customServerKeyName(server.id)]?.encrypted),
    addedAt: server.addedAt,
  }
}

export function addedView(entry: AddedModel, models: AiModelsSettings, available: boolean) {
  const server = (models.servers ?? []).find((sv) => sv.id === entry.serverId)
  return {
    key: entry.key,
    provider: entry.provider,
    providerLabel: providerLabelOf(entry.provider, server?.name),
    displayName: entry.displayName,
    upstreamId: entry.upstreamId,
    ...(entry.serverId ? { serverId: entry.serverId } : {}),
    enabled: entry.enabled,
    native: false,
    available,
    contextWindow: entry.contextWindow,
    inputCostPerM: entry.inputCostPerM,
    outputCostPerM: entry.outputCostPerM,
    tools: entry.tools,
    reasoning: reasoningOf(entry.key, entry.provider, entry),
    unavailableSince: entry.unavailableSince ?? null,
    priceUpdatedAt: entry.priceUpdatedAt ?? null,
  }
}

/** Does `key` name a model this org has (a native row or an added entry)? */
export function knownKey(
  key: string,
  models: AiModelsSettings,
  natives: ReadonlySet<string>,
): "native" | "added" | null {
  const parsed = parseModelKey(key)
  if (!parsed) return null
  if (parsed.kind === "native") return natives.has(key) ? "native" : null
  return findAddedModel(models, key) ? "added" : null
}

export async function resolvedAutoKey(
  orgId: string,
  settings: OrgKernelSettings,
): Promise<string | null> {
  const pinned = await reservedDemoModelId(orgId)
  if (pinned) return pinned
  return (await selectAutoModelForOrg(orgId, "ai-models-auto", settings))?.modelId ?? null
}

/** The test calls' rate limit: per org, `TEST_CALL_LIMIT` an hour. */
const TEST_CALL_LIMIT = 10
const TEST_CALL_WINDOW_SECONDS = 60 * 60
const testCallBucket = (orgId: string) => `ai-models-test-call:${orgId}`

/**
 * The key of an org's test-call bucket as the prefixed `redis` client names it
 * (tests reset it): `bucketKey` carries REDIS_PREFIX itself, the client adds it.
 */
export function testCallRateLimitKey(orgId: string): string {
  return bucketKey(testCallBucket(orgId), TEST_CALL_WINDOW_SECONDS).slice(REDIS_PREFIX.length)
}

/**
 * Count one test call against the org's hourly allowance: null when it may
 * run, else the 429 to send (with Retry-After).
 */
export async function testCallLimited(
  orgId: string,
): Promise<{ retryAfterSeconds: number; message: string } | null> {
  const result = await checkRateLimit(redis, [
    {
      identifier: testCallBucket(orgId),
      limit: TEST_CALL_LIMIT,
      windowSeconds: TEST_CALL_WINDOW_SECONDS,
    },
  ])
  if (result.allowed) return null
  const minutes = Math.max(1, Math.ceil(result.failed.retryAfterSeconds / 60))
  return {
    retryAfterSeconds: result.failed.retryAfterSeconds,
    message: `Too many test calls: ${TEST_CALL_LIMIT} an hour. Try again in ${minutes} min.`,
  }
}

export const AUTO_NOTHING_TO_RUN =
  "Auto would have no model to run. Switch on a model Auto can use, or choose one for Auto, first."

/** Why a catalogue row cannot be added, or null when it can. */
export function notAddableReason(row: {
  inputCostPerM: string | null
  outputCostPerM: string | null
}) {
  return row.inputCostPerM === null || row.outputCostPerM === null
    ? "This model has no fixed price (OpenRouter prices it per request), so it cannot be added."
    : null
}

/** The AI models page's whole state. */
export async function getAiModelsState(orgId: string) {
  const settings = await loadSettings(orgId)
  const models = settings.ai?.models ?? {}
  const disabled = new Set(models.disabled ?? [])
  const rows = await nativeRows()

  const usable = new Map<string, boolean>()
  for (const provider of KEY_PROVIDERS) {
    usable.set(provider, await isProviderUsable(orgId, provider, settings))
  }
  const providers = KEY_PROVIDERS.map((provider) => {
    const entry = settings.providerKeys?.[provider]
    return {
      provider,
      label: providerLabelOf(provider),
      keySet: Boolean(entry?.encrypted),
      usable: usable.get(provider) === true,
      ...(entry?.maskedHint ? { maskedHint: entry.maskedHint } : {}),
    }
  })
  const native = rows.map((r) => ({
    key: r.modelId,
    provider: r.provider,
    providerLabel: providerLabelOf(r.provider),
    displayName: r.displayName,
    enabled: !disabled.has(r.modelId),
    native: true,
    available: !disabled.has(r.modelId) && usable.get(r.provider) === true,
    contextWindow: r.contextWindow,
    inputCostPerM: r.inputCostPerM,
    outputCostPerM: r.outputCostPerM,
    tools: true,
    reasoning: reasoningOf(r.modelId, r.provider),
  }))
  const added = []
  for (const entry of models.added ?? []) {
    added.push(addedView(entry, models, await isModelKeyAvailable(orgId, entry.key, settings)))
  }
  return {
    providers,
    servers: (models.servers ?? []).map((sv) => serverView(sv, settings)),
    auto: {
      modelKey: models.autoModelKey ?? null,
      resolvedKey: await resolvedAutoKey(orgId, settings),
    },
    defaultReasoningLevel: models.defaultReasoningLevel ?? null,
    blockedHosts: blockedHostsView(models),
    models: [...native, ...added],
  }
}

/** Switch models on and off, choose Auto, set the default reasoning level and blocked hosts. */
export async function patchAiModels(orgId: string, body: AiModelsPatch) {
  const natives = new Set((await nativeRows()).map((r) => r.modelId))

  type Outcome =
    | { ok: true; models: AiModelsSettings; settings: OrgKernelSettings }
    | AiModelsRefusal
  const refuse = (status: AiModelsRefusal["status"], message: string, code: string) => ({
    result: { ok: false as const, status, message, code },
  })
  const outcome = await mutateAiModels<Outcome>(orgId, "ai-models-patch", async (current, tx) => {
    // Every check below reads the state under the row lock, so a
    // concurrent patch cannot slip a change past them.
    const settings = withModels(
      await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
      current,
    )
    const next: AiModelsSettings = {
      ...current,
      disabled: [...(current.disabled ?? [])],
      added: (current.added ?? []).map((m) => ({ ...m })),
    }
    const disabledSet = new Set(next.disabled)
    for (const [list, on] of [
      [body.enable ?? [], true],
      [body.disable ?? [], false],
    ] as const) {
      for (const key of list) {
        const kind = knownKey(key, current, natives)
        if (!kind) return refuse(400, `Unknown model: ${key}`, "unknown_model")
        if (kind === "native") {
          if (on) disabledSet.delete(key)
          else disabledSet.add(key)
        } else {
          const entry = next.added?.find((m) => m.key === key)
          if (entry) entry.enabled = on
        }
      }
    }
    next.disabled = [...disabledSet].sort()
    if (body.autoModelKey !== undefined) next.autoModelKey = body.autoModelKey
    if (body.defaultReasoningLevel !== undefined) {
      if (body.defaultReasoningLevel === null) delete next.defaultReasoningLevel
      else next.defaultReasoningLevel = body.defaultReasoningLevel
    }
    if (body.blockedHosts !== undefined) {
      if (body.blockedHosts === null) delete next.blockedHosts
      else next.blockedHosts = body.blockedHosts
    }
    const nextSettings = withModels(settings, next)

    if (next.autoModelKey && body.autoModelKey !== undefined) {
      if (!(await isModelKeyAvailable(orgId, next.autoModelKey, nextSettings))) {
        return refuse(
          400,
          "Auto can only run a model that is switched on and has a key.",
          "auto_unavailable",
        )
      }
    }
    // The model Auto will run once this patch lands: the new Auto setting,
    // the automatic rule when the patch clears it, or else what Auto runs
    // now. That model cannot be among the ones this patch switches off.
    const auto =
      body.autoModelKey === undefined
        ? await resolvedAutoKey(orgId, settings)
        : body.autoModelKey === null
          ? await resolvedAutoKey(orgId, nextSettings)
          : body.autoModelKey
    if (auto && (body.disable ?? []).includes(auto)) {
      return refuse(409, "This model runs Auto. Choose another model for Auto first.", "auto_model")
    }
    // Nor may the patch leave Auto with nothing to run.
    const changesAuto = body.autoModelKey !== undefined || (body.disable ?? []).length > 0
    if (changesAuto && !(await resolvedAutoKey(orgId, nextSettings))) {
      return refuse(409, AUTO_NOTHING_TO_RUN, "auto_model")
    }
    return { next, result: { ok: true, models: next, settings: nextSettings } }
  })
  if (!outcome.ok) return outcome
  // This process routes on the new list at once; others within the cache window.
  if (body.blockedHosts !== undefined) blockedHostsSource.invalidate(orgId)
  return {
    ok: true as const,
    view: {
      disabled: outcome.models.disabled ?? [],
      autoModelKey: outcome.models.autoModelKey ?? null,
      resolvedKey: await resolvedAutoKey(orgId, outcome.settings),
      defaultReasoningLevel: outcome.models.defaultReasoningLevel ?? null,
      blockedHosts: blockedHostsView(outcome.models),
    },
  }
}

/** Add a model from OpenRouter, after a test call that calls the tool. */
export async function addOpenRouterModel(orgId: string, upstreamId: string) {
  const key = openRouterModelKey(upstreamId)
  const settings = await loadSettings(orgId)
  if (!(await isProviderUsable(orgId, "openrouter", settings))) {
    return refusal(412, "Add an OpenRouter key first.", "openrouter_key_required")
  }
  if (findAddedModel(settings.ai?.models ?? {}, key)) {
    return refusal(409, "This model is already in your list.", "already_added")
  }
  // On the managed service a test call is the org's spend, never ours.
  const { key: apiKey, source } = await resolveKey(orgId, "openrouter")
  if (isManagedEdition() && source === "liaison") {
    return refusal(
      412,
      "A test call runs on your own OpenRouter key. Add your own OpenRouter key first.",
      "byok_required",
    )
  }
  let catalogue: Awaited<ReturnType<typeof getOpenRouterCatalogue>>
  try {
    catalogue = await getOpenRouterCatalogue()
  } catch (err) {
    if (err instanceof OpenRouterUnavailableError) {
      return refusal(502, err.message, "openrouter_unavailable")
    }
    throw err
  }
  const cat = catalogue.find((m) => m.upstreamId === upstreamId)
  if (!cat) {
    return refusal(404, "OpenRouter does not list this model.", "not_in_catalogue")
  }
  const unpriced = notAddableReason(cat)
  if (unpriced) return refusal(422, unpriced, "variable_price")

  const limited = await testCallLimited(orgId)
  if (limited) {
    return {
      ...refusal(429, limited.message, "rate_limited"),
      retryAfterSeconds: limited.retryAfterSeconds,
    }
  }
  const model = await resolveModel({
    provider: "openrouter",
    modelId: upstreamId,
    apiKey,
    orgId,
  })
  const test = await runModelTestCall(model, { orgId, key })
  if (!test.ok) return refusal(422, test.reason, "test_call_failed")
  if (!test.toolCalled) {
    return refusal(
      422,
      "The model answered but did not call the test tool, so it cannot run an agent.",
      "test_call_no_tool",
    )
  }

  const entry = openRouterEntry(cat, new Date().toISOString())
  const added = await mutateAiModels<boolean>(orgId, "ai-models-add-openrouter", async (cur) => {
    if (findAddedModel(cur, key)) return { result: false }
    return { next: { ...cur, added: [...(cur.added ?? []), entry] }, result: true }
  })
  if (!added) {
    return refusal(409, "This model is already in your list.", "already_added")
  }
  log.info({ orgId, key }, "openrouter model added")
  return { ok: true as const, view: addedView(entry, { ...settings.ai?.models }, true) }
}
