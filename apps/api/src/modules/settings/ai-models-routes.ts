// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AI MODELS PAGE'S API (S7), mounted at /api/settings/ai behind
// kernel:org:admin: which models the org runs, which one Auto is, models added
// from OpenRouter, and the org's own OpenAI-compatible servers.
//
// Every write to `ai.models` goes through `mutateAiModels` (a row lock and one
// sub-path jsonb_set, A11). A test call (network) never runs under that lock:
// it runs first, and the write re-checks what it relied on. What the kernel
// tools share with these routes lives in ai-models-admin.ts.
import {
  type AddedModel,
  historySettingsPatchSchema,
  orgKernelSettingsSchema,
  transcriptionSettingsPatchSchema,
} from "@liaison/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { isManagedEdition } from "~/lib/edition"
import { byokEncryptionKey } from "~/lib/env"
import { success } from "~/lib/response"
import { getOrgKernelSettings } from "~/lib/settings"
import { zValidator } from "~/lib/validate"
import {
  historySettingsView,
  setOrgHistorySettings,
} from "~/modules/agent/context/history-settings"
import { mutateAiModels, setProviderKeyEntry } from "~/modules/agent/credits/ai-models-store"
import { cellCreditPricing, creditsForUnits } from "~/modules/agent/credits/credit-cost"
import { isProviderUsable, resolveKey } from "~/modules/agent/credits/credit-meter"
import { withMultiplier } from "~/modules/agent/credits/managed-money"
import {
  customModelKey,
  customServerKeyName,
  findAddedModel,
  newServerId,
  openRouterModelKey,
  parseModelKey,
} from "~/modules/agent/credits/model-keys"
import { runModelTestCall } from "~/modules/agent/credits/model-test-call"
import {
  filterCatalogue,
  getOpenRouterCatalogue,
  OpenRouterUnavailableError,
} from "~/modules/agent/credits/openrouter-catalogue"
import {
  ModelServerError,
  normaliseServerURL,
  validateModelServerUrl,
} from "~/modules/agent/providers/model-server"
import { resolveModel } from "~/modules/agent/providers/provider"
import {
  setTranscriptionModel,
  transcriptionSettingsView,
} from "~/modules/assist/transcription-models"
import {
  addedReply,
  addOpenRouterModel,
  aiModelsPatchSchema,
  autoPriceOf,
  demoModelsLocked,
  getAiModelsState,
  isNoZeroRetentionRefusal,
  loadSettings,
  notAddableReason,
  patchAiModels,
  resolvedAutoKey,
  testCallLimited,
  testCallRateLimitKey,
  withModels,
} from "~/modules/settings/ai-models-admin"

export { isNoZeroRetentionRefusal, testCallRateLimitKey }

const DEFAULT_CUSTOM_CONTEXT_WINDOW = 32_768

function errorBody(message: string, code?: string) {
  return { error: code ? { message, code } : { message } }
}

/**
 * Voice dictation's models as the page shows them: USD per minute on a
 * self-hosted server, credits per minute on a managed cell (S18): the pushed
 * `dictationMinute` credit price, the same for every model, absent while
 * the cell has no pushed pricing.
 */
async function transcriptionView(orgId: string) {
  const view = await transcriptionSettingsView(orgId)
  if (!isManagedEdition()) return view
  const pricing = await cellCreditPricing("transcription-view")
  const perMinute = pricing ? creditsForUnits(pricing, "dictationMinute", 1) : null
  return {
    ...view,
    available: view.available.map(({ pricePerMinuteUsd: _list, ...m }) => ({
      ...m,
      ...(perMinute !== null ? { creditsPerMinute: perMinute } : {}),
    })),
  }
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
    const locked = await demoModelsLocked(c.get("orgId"))
    if (!locked) return next()
    return c.json(errorBody(locked.message, locked.code), locked.status)
  })
  // ── The page's whole state ────────────────────────────────────────────────
  .get("/models", async (c) => success(c, await getAiModelsState(c.get("orgId"))))

  // ── Voice dictation's transcription model (S7) ───────────────────────────
  .get("/transcription", async (c) => {
    return success(c, await transcriptionView(c.get("orgId")))
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
    return success(c, await transcriptionView(orgId))
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
  .patch("/models", zValidator("json", aiModelsPatchSchema), async (c) => {
    const outcome = await patchAiModels(c.get("orgId"), c.req.valid("json"))
    if (!outcome.ok) return c.json(errorBody(outcome.message, outcome.code), outcome.status)
    return success(c, outcome.view)
  })

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
        if ((await resolvedAutoKey(orgId, settings, tx)) === key) {
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
      const managed = isManagedEdition()
      const autoKey = managed ? await resolvedAutoKey(orgId, settings) : null
      const auto = autoKey ? await autoPriceOf(autoKey, settings) : null
      const rows = filterCatalogue(catalogue, {
        q: q ?? "",
        toolsOnly: toolsOnly !== "false",
        limit: 200,
      }).map((m) => {
        const reason = notAddableReason(m)
        const row = {
          ...m,
          added: added.has(openRouterModelKey(m.upstreamId)),
          addable: reason === null,
          ...(reason ? { notAddableReason: reason } : {}),
        }
        return managed ? withMultiplier(row, auto) : row
      })
      return success(c, { models: rows })
    },
  )

  // ── Add a model from OpenRouter (after a test call) ──────────────────────
  .post(
    "/openrouter/models",
    zValidator("json", z.strictObject({ upstreamId: z.string().min(1).max(180) })),
    async (c) => {
      const outcome = await addOpenRouterModel(
        c.get("orgId"),
        c.req.valid("json").upstreamId,
        c.get("userId"),
      )
      if (!outcome.ok) {
        if (outcome.retryAfterSeconds) c.header("Retry-After", String(outcome.retryAfterSeconds))
        return c.json(errorBody(outcome.message, outcome.code), outcome.status)
      }
      return success(c, outcome.view, undefined, 201)
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
          tx,
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
        // unmetered-model-call: the org's own model server, on its own key (its bill, not the instance's)
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
        {
          ...(await addedReply(orgId, entry, settings, true)),
          test: { toolCalled: test.toolCalled },
        },
        undefined,
        201,
      )
    },
  )
