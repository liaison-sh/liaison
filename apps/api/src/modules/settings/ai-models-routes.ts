// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AI MODELS PAGE'S API (S7), mounted at /api/settings/ai behind
// kernel:org:admin: which models the org runs, which one Auto is, models added
// from OpenRouter, and the org's own OpenAI-compatible servers.
//
// Every write to `ai.models` goes through `mutateAiModels` (a row lock and one
// sub-path jsonb_set, A11). A test call (network) never runs under that lock:
// it runs first, and the write re-checks what it relied on.
import {
  type AddedModel,
  type AiModelsSettings,
  blockedHostsPatchSchema,
  getReasoningCapability,
  historySettingsPatchSchema,
  type OrgKernelSettings,
  orgKernelSettingsSchema,
  reasoningLevelSchema,
  transcriptionSettingsPatchSchema,
} from "@liaison/shared"
import { asc } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { modelPricing } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { isManagedEdition } from "~/lib/edition"
import { byokEncryptionKey } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { getOrgKernelSettings } from "~/lib/settings"
import { zValidator } from "~/lib/validate"
import { bucketKey, checkRateLimit } from "~/middleware/rate-limiter"
import {
  historySettingsView,
  setOrgHistorySettings,
} from "~/modules/agent/context/history-settings"
import { mutateAiModels, setProviderKeyEntry } from "~/modules/agent/credits/ai-models-store"
import {
  isModelKeyAvailable,
  isProviderUsable,
  providerLabelOf,
  resolveKey,
  selectAutoModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import {
  customModelKey,
  customServerKeyName,
  findAddedModel,
  isChatModelProvider,
  isNativeModelId,
  newServerId,
  openRouterModelKey,
  parseModelKey,
} from "~/modules/agent/credits/model-keys"
import { runModelTestCall } from "~/modules/agent/credits/model-test-call"
import {
  filterCatalogue,
  getOpenRouterCatalogue,
  OpenRouterUnavailableError,
  openRouterEntry,
} from "~/modules/agent/credits/openrouter-catalogue"
import {
  ModelServerError,
  normaliseServerURL,
  validateModelServerUrl,
} from "~/modules/agent/providers/model-server"
import {
  blockedHostsSource,
  effectiveBlockedHosts,
  openRouterDeniedHosts,
} from "~/modules/agent/providers/openrouter-blocked-hosts"
import { resolveModel } from "~/modules/agent/providers/provider"
import {
  setTranscriptionModel,
  transcriptionSettingsView,
} from "~/modules/assist/transcription-models"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { demoSpendMessage, isVisitorDemoOrg, reservedDemoModelId } from "~/modules/demo/demo-spend"

const log = rootLogger.child({ module: "ai-models-routes" })

const NATIVE_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const
const KEY_PROVIDERS = [...NATIVE_PROVIDERS, "openrouter"] as const
const DEFAULT_CUSTOM_CONTEXT_WINDOW = 32_768

function errorBody(message: string, code?: string) {
  return { error: code ? { message, code } : { message } }
}

async function loadSettings(orgId: string): Promise<OrgKernelSettings> {
  return withPrivilegedDb(orgId, "ai-models-settings", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
}

/**
 * The OpenRouter hosts the org's requests never reach: the effective list,
 * whether it is the instance default (the org set none), and that default.
 */
function blockedHostsView(models: AiModelsSettings) {
  const instanceDefault = openRouterDeniedHosts()
  return {
    hosts: effectiveBlockedHosts(models.blockedHosts, instanceDefault),
    isDefault: !Array.isArray(models.blockedHosts),
    defaultHosts: instanceDefault,
  }
}

/** The settings with `ai.models` replaced, for "what if" availability checks. */
function withModels(settings: OrgKernelSettings, models: AiModelsSettings): OrgKernelSettings {
  return { ...settings, ai: { ...(settings.ai ?? {}), models } }
}

async function nativeRows() {
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

function reasoningOf(key: string, provider: string, entry?: AddedModel) {
  const cap = getReasoningCapability(key, provider, entry)
  return { allowedLevels: cap.allowedLevels, defaultLevel: cap.defaultLevel }
}

function serverView(
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

function addedView(entry: AddedModel, models: AiModelsSettings, available: boolean) {
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
function knownKey(
  key: string,
  models: AiModelsSettings,
  natives: ReadonlySet<string>,
): "native" | "added" | null {
  const parsed = parseModelKey(key)
  if (!parsed) return null
  if (parsed.kind === "native") return natives.has(key) ? "native" : null
  return findAddedModel(models, key) ? "added" : null
}

async function resolvedAutoKey(orgId: string, settings: OrgKernelSettings): Promise<string | null> {
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
async function testCallLimited(
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

const AUTO_NOTHING_TO_RUN =
  "Auto would have no model to run. Switch on a model Auto can use, or choose one for Auto, first."

/** Why a catalogue row cannot be added, or null when it can. */
function notAddableReason(row: { inputCostPerM: string | null; outputCostPerM: string | null }) {
  return row.inputCostPerM === null || row.outputCostPerM === null
    ? "This model has no fixed price (OpenRouter prices it per request), so it cannot be added."
    : null
}

const keyParam = z.object({ key: z.string().min(1).max(200) })
const serverIdParam = z.object({ id: z.string().regex(/^[0-9a-f]{8}$/) })

export const aiModelsRoutes = new Hono<AppEnv>()
  // ── A demo visitor's models are fixed ─────────────────────────────────────
  // A visitor is the admin of their demo org, and its model settings are not
  // what their agents run on (the pin comes from code and env), so every write
  // here is refused (`demo_models_locked`), the OpenRouter add-model and its
  // test call on the box key included. Choosing a transcription model stays
  // open: every candidate is priced by the budget. Reads are unchanged.
  .use("*", async (c, next) => {
    const method = c.req.method
    if (method === "GET" || method === "HEAD" || c.req.path.endsWith("/transcription")) {
      return next()
    }
    const orgId = c.get("orgId")
    if (!(await isVisitorDemoOrg(orgId))) return next()
    const { locale } = await loadDemoOrg(orgId)
    return c.json(
      errorBody(demoSpendMessage("demo_models_locked", locale), "demo_models_locked"),
      403,
    )
  })
  // ── The page's whole state ────────────────────────────────────────────────
  .get("/models", async (c) => {
    const orgId = c.get("orgId")
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
    return success(c, {
      providers,
      servers: (models.servers ?? []).map((sv) => serverView(sv, settings)),
      auto: {
        modelKey: models.autoModelKey ?? null,
        resolvedKey: await resolvedAutoKey(orgId, settings),
      },
      defaultReasoningLevel: models.defaultReasoningLevel ?? null,
      blockedHosts: blockedHostsView(models),
      models: [...native, ...added],
    })
  })

  // ── Voice dictation's transcription model (S7) ───────────────────────────
  .get("/transcription", async (c) => {
    return success(c, await transcriptionSettingsView(c.get("orgId")))
  })
  .patch("/transcription", zValidator("json", transcriptionSettingsPatchSchema), async (c) => {
    const orgId = c.get("orgId")
    const { modelKey } = c.req.valid("json")
    const outcome = await setTranscriptionModel(orgId, modelKey)
    if (!outcome.ok) {
      return c.json(
        errorBody("This transcription model is not available to this organization.", outcome.code),
        422,
      )
    }
    return success(c, await transcriptionSettingsView(orgId))
  })

  // ── Conversation history: summarize after N tokens, warm-cache compaction ─
  .get("/history", async (c) => {
    return success(c, await historySettingsView(c.get("orgId")))
  })
  .patch("/history", zValidator("json", historySettingsPatchSchema), async (c) => {
    const orgId = c.get("orgId")
    await setOrgHistorySettings(orgId, c.req.valid("json"))
    return success(c, await historySettingsView(orgId))
  })

  // ── Switch models on and off, choose Auto ────────────────────────────────
  .patch(
    "/models",
    zValidator(
      "json",
      z.strictObject({
        enable: z.array(z.string().min(1).max(200)).max(500).optional(),
        disable: z.array(z.string().min(1).max(200)).max(500).optional(),
        autoModelKey: z.string().min(1).max(200).nullable().optional(),
        // The level of a turn that asks for none; null restores the built-in default.
        defaultReasoningLevel: reasoningLevelSchema.nullable().optional(),
        // The OpenRouter hosts this org's requests never reach; null restores
        // the instance default (LIAISON_OPENROUTER_IGNORE_HOSTS).
        blockedHosts: blockedHostsPatchSchema.optional(),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const body = c.req.valid("json")
      const natives = new Set((await nativeRows()).map((r) => r.modelId))

      type Outcome =
        | { ok: true; models: AiModelsSettings; settings: OrgKernelSettings }
        | { ok: false; status: 400 | 409; message: string; code: string }
      const refuse = (status: 400 | 409, message: string, code: string) => ({
        result: { ok: false as const, status, message, code },
      })
      const outcome = await mutateAiModels<Outcome>(
        orgId,
        "ai-models-patch",
        async (current, tx) => {
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
            return refuse(
              409,
              "This model runs Auto. Choose another model for Auto first.",
              "auto_model",
            )
          }
          // Nor may the patch leave Auto with nothing to run.
          const changesAuto = body.autoModelKey !== undefined || (body.disable ?? []).length > 0
          if (changesAuto && !(await resolvedAutoKey(orgId, nextSettings))) {
            return refuse(409, AUTO_NOTHING_TO_RUN, "auto_model")
          }
          return { next, result: { ok: true, models: next, settings: nextSettings } }
        },
      )
      if (!outcome.ok) return c.json(errorBody(outcome.message, outcome.code), outcome.status)
      // This process routes on the new list at once; others within the cache window.
      if (body.blockedHosts !== undefined) blockedHostsSource.invalidate(orgId)
      return success(c, {
        disabled: outcome.models.disabled ?? [],
        autoModelKey: outcome.models.autoModelKey ?? null,
        resolvedKey: await resolvedAutoKey(orgId, outcome.settings),
        defaultReasoningLevel: outcome.models.defaultReasoningLevel ?? null,
        blockedHosts: blockedHostsView(outcome.models),
      })
    },
  )

  // ── Remove an added model ────────────────────────────────────────────────
  .delete("/models/:key{.+}", zValidator("param", keyParam), async (c) => {
    const orgId = c.get("orgId")
    const { key } = c.req.valid("param")
    if (parseModelKey(key)?.kind === "native") {
      return c.json(errorBody("A built-in model can be switched off, not removed."), 400)
    }
    type Outcome = { status: 204 } | { status: 404 | 409; message: string; code?: string }
    const outcome = await mutateAiModels<Outcome>(
      orgId,
      "ai-models-remove",
      async (current, tx) => {
        if (!findAddedModel(current, key)) {
          return { result: { status: 404, message: "This model is not in your list." } }
        }
        const settings = withModels(
          await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
          current,
        )
        if ((await resolvedAutoKey(orgId, settings)) === key) {
          return {
            result: {
              status: 409,
              message: "This model runs Auto. Choose another model for Auto first.",
              code: "auto_model",
            },
          }
        }
        return {
          next: {
            ...current,
            added: (current.added ?? []).filter((m) => m.key !== key),
            ...(current.autoModelKey === key ? { autoModelKey: null } : {}),
          },
          result: { status: 204 },
        }
      },
    )
    if (outcome.status !== 204) {
      return c.json(errorBody(outcome.message, outcome.code), outcome.status)
    }
    return c.body(null, 204)
  })

  // ── OpenRouter's catalogue ───────────────────────────────────────────────
  .get(
    "/openrouter/catalogue",
    zValidator(
      "query",
      z.object({
        q: z.string().max(200).optional(),
        toolsOnly: z.enum(["true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const { q, toolsOnly } = c.req.valid("query")
      const settings = await loadSettings(orgId)
      if (!(await isProviderUsable(orgId, "openrouter", settings))) {
        return c.json(errorBody("Add an OpenRouter key first.", "openrouter_key_required"), 412)
      }
      let catalogue: Awaited<ReturnType<typeof getOpenRouterCatalogue>>
      try {
        catalogue = await getOpenRouterCatalogue()
      } catch (err) {
        if (err instanceof OpenRouterUnavailableError) {
          return c.json(errorBody(err.message, "openrouter_unavailable"), 502)
        }
        throw err
      }
      const added = new Set((settings.ai?.models?.added ?? []).map((m) => m.key))
      const rows = filterCatalogue(catalogue, {
        q: q ?? "",
        toolsOnly: toolsOnly !== "false",
        limit: 200,
      }).map((m) => {
        const reason = notAddableReason(m)
        return {
          ...m,
          added: added.has(openRouterModelKey(m.upstreamId)),
          addable: reason === null,
          ...(reason ? { notAddableReason: reason } : {}),
        }
      })
      return success(c, { models: rows })
    },
  )

  // ── Add a model from OpenRouter (after a test call) ──────────────────────
  .post(
    "/openrouter/models",
    zValidator("json", z.strictObject({ upstreamId: z.string().min(1).max(180) })),
    async (c) => {
      const orgId = c.get("orgId")
      const { upstreamId } = c.req.valid("json")
      const key = openRouterModelKey(upstreamId)
      const settings = await loadSettings(orgId)
      if (!(await isProviderUsable(orgId, "openrouter", settings))) {
        return c.json(errorBody("Add an OpenRouter key first.", "openrouter_key_required"), 412)
      }
      if (findAddedModel(settings.ai?.models ?? {}, key)) {
        return c.json(errorBody("This model is already in your list.", "already_added"), 409)
      }
      // On the managed service a test call is the org's spend, never ours.
      const { key: apiKey, source } = await resolveKey(orgId, "openrouter")
      if (isManagedEdition() && source === "liaison") {
        return c.json(
          errorBody(
            "A test call runs on your own OpenRouter key. Add your own OpenRouter key first.",
            "byok_required",
          ),
          412,
        )
      }
      let catalogue: Awaited<ReturnType<typeof getOpenRouterCatalogue>>
      try {
        catalogue = await getOpenRouterCatalogue()
      } catch (err) {
        if (err instanceof OpenRouterUnavailableError) {
          return c.json(errorBody(err.message, "openrouter_unavailable"), 502)
        }
        throw err
      }
      const cat = catalogue.find((m) => m.upstreamId === upstreamId)
      if (!cat) {
        return c.json(errorBody("OpenRouter does not list this model.", "not_in_catalogue"), 404)
      }
      const unpriced = notAddableReason(cat)
      if (unpriced) return c.json(errorBody(unpriced, "variable_price"), 422)

      const limited = await testCallLimited(orgId)
      if (limited) {
        c.header("Retry-After", String(limited.retryAfterSeconds))
        return c.json(errorBody(limited.message, "rate_limited"), 429)
      }
      const model = await resolveModel({
        provider: "openrouter",
        modelId: upstreamId,
        apiKey,
        orgId,
      })
      const test = await runModelTestCall(model, { orgId, key })
      if (!test.ok) return c.json(errorBody(test.reason, "test_call_failed"), 422)
      if (!test.toolCalled) {
        return c.json(
          errorBody(
            "The model answered but did not call the test tool, so it cannot run an agent.",
            "test_call_no_tool",
          ),
          422,
        )
      }

      const entry = openRouterEntry(cat, new Date().toISOString())
      const added = await mutateAiModels<boolean>(
        orgId,
        "ai-models-add-openrouter",
        async (cur) => {
          if (findAddedModel(cur, key)) return { result: false }
          return { next: { ...cur, added: [...(cur.added ?? []), entry] }, result: true }
        },
      )
      if (!added) {
        return c.json(errorBody("This model is already in your list.", "already_added"), 409)
      }
      log.info({ orgId, key }, "openrouter model added")
      return success(c, addedView(entry, { ...settings.ai?.models }, true), undefined, 201)
    },
  )

  // ── The org's own servers ────────────────────────────────────────────────
  .post(
    "/servers",
    zValidator(
      "json",
      z.strictObject({
        name: z.string().trim().min(1).max(80),
        baseURL: z.string().trim().min(1).max(500),
        apiKey: z.string().min(1).max(4000).optional(),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const body = c.req.valid("json")
      const baseURL = normaliseServerURL(body.baseURL)
      try {
        await validateModelServerUrl(baseURL)
      } catch (err) {
        if (err instanceof ModelServerError) {
          return c.json(errorBody(err.message, "server_address"), 400)
        }
        throw err
      }
      if (body.apiKey && !byokEncryptionKey) {
        return c.json(errorBody("BYOK encryption not configured"), 500)
      }
      const server = {
        id: newServerId(),
        name: body.name,
        baseURL,
        addedAt: new Date().toISOString(),
      }
      await mutateAiModels(orgId, "ai-models-add-server", async (cur, tx) => {
        if (body.apiKey) {
          await setProviderKeyEntry(tx, orgId, customServerKeyName(server.id), {
            encrypted: encryptSecret(body.apiKey, byokEncryptionKey, CryptoContext.byokApiKey),
            maskedHint: body.apiKey.slice(-4),
            validatedAt: server.addedAt,
          })
        }
        return { next: { ...cur, servers: [...(cur.servers ?? []), server] }, result: null }
      })
      return success(c, { ...server, keySet: Boolean(body.apiKey) }, undefined, 201)
    },
  )

  .delete("/servers/:id", zValidator("param", serverIdParam), async (c) => {
    const orgId = c.get("orgId")
    const { id } = c.req.valid("param")
    type Outcome = { status: 204 } | { status: 404 | 409; message: string; code?: string }
    const outcome = await mutateAiModels<Outcome>(
      orgId,
      "ai-models-remove-server",
      async (cur, tx) => {
        if (!(cur.servers ?? []).some((sv) => sv.id === id)) {
          return { result: { status: 404, message: "This server is not in your list." } }
        }
        const gone = new Set((cur.added ?? []).filter((m) => m.serverId === id).map((m) => m.key))
        const auto = await resolvedAutoKey(
          orgId,
          withModels(await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema), cur),
        )
        if (auto && gone.has(auto)) {
          return {
            result: {
              status: 409,
              message: "A model of this server runs Auto. Choose another model for Auto first.",
              code: "auto_model",
            },
          }
        }
        await setProviderKeyEntry(tx, orgId, customServerKeyName(id), null)
        return {
          next: {
            ...cur,
            servers: (cur.servers ?? []).filter((sv) => sv.id !== id),
            added: (cur.added ?? []).filter((m) => m.serverId !== id),
            ...(cur.autoModelKey && gone.has(cur.autoModelKey) ? { autoModelKey: null } : {}),
          },
          result: { status: 204 },
        }
      },
    )
    if (outcome.status !== 204) {
      return c.json(errorBody(outcome.message, outcome.code), outcome.status)
    }
    return c.body(null, 204)
  })

  // ── Add a model of an own server (after a test call) ─────────────────────
  .post(
    "/servers/:id/models",
    zValidator("param", serverIdParam),
    zValidator(
      "json",
      z.strictObject({
        name: z.string().trim().min(1).max(160),
        contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const { id } = c.req.valid("param")
      const body = c.req.valid("json")
      const settings = await loadSettings(orgId)
      const models = settings.ai?.models ?? {}
      const server = (models.servers ?? []).find((sv) => sv.id === id)
      if (!server) return c.json(errorBody("This server is not in your list."), 404)
      const key = customModelKey(id, body.name)
      if (findAddedModel(models, key)) {
        return c.json(errorBody("This model is already in your list.", "already_added"), 409)
      }

      const limited = await testCallLimited(orgId)
      if (limited) {
        c.header("Retry-After", String(limited.retryAfterSeconds))
        return c.json(errorBody(limited.message, "rate_limited"), 429)
      }
      const apiKey = (await resolveKey(orgId, { provider: "custom", serverId: id })).key
      let test: Awaited<ReturnType<typeof runModelTestCall>>
      try {
        const model = await resolveModel({
          provider: "custom",
          modelId: body.name,
          apiKey,
          baseURL: server.baseURL,
        })
        test = await runModelTestCall(model, { orgId, key })
      } catch (err) {
        if (err instanceof ModelServerError) {
          return c.json(errorBody(err.message, "server_address"), 400)
        }
        throw err
      }
      if (!test.ok) {
        return c.json(
          errorBody(
            `Your model server at ${new URL(server.baseURL).host} did not answer: ${test.reason}`,
            "test_call_failed",
          ),
          422,
        )
      }

      const now = new Date().toISOString()
      const entry: AddedModel = {
        key,
        provider: "custom",
        upstreamId: body.name,
        serverId: id,
        displayName: body.name,
        contextWindow: body.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
        inputCostPerM: null,
        outputCostPerM: null,
        tools: test.toolCalled,
        reasoningEfforts: [],
        canDisableReasoning: false,
        enabled: true,
        addedAt: now,
      }
      const added = await mutateAiModels<boolean>(orgId, "ai-models-add-custom", async (cur) => {
        if (findAddedModel(cur, key)) return { result: false }
        if (!(cur.servers ?? []).some((sv) => sv.id === id)) return { result: false }
        return { next: { ...cur, added: [...(cur.added ?? []), entry] }, result: true }
      })
      if (!added) {
        return c.json(errorBody("This model is already in your list.", "already_added"), 409)
      }
      return success(
        c,
        { ...addedView(entry, models, true), test: { toolCalled: test.toolCalled } },
        undefined,
        201,
      )
    },
  )
