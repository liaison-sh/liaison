// SPDX-License-Identifier: FSL-1.1-ALv2
import { orgKernelSettingsSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { getOrgKernelSettings } from "~/lib/settings"
import { zValidator } from "~/lib/validate"
import { mutateAiModels } from "~/modules/agent/credits/ai-models-store"
import { hasUsableModelKey, isModelKeyAvailable } from "~/modules/agent/credits/credit-meter"
import { openRouterBaseURL } from "~/modules/agent/providers/openrouter"
import { invalidateOrgEmbedder } from "~/modules/search/message-indexer"
import { settleSecretRequestsForTarget } from "~/modules/secret-requests/announce"
import { BYOK_PROVIDER_NAMES, BYOK_PROVIDERS, type ByokProvider } from "~/modules/settings/byok"

const log = rootLogger.child({ module: "ai-keys" })

const SUPPORTED_PROVIDERS = BYOK_PROVIDERS
type Provider = ByokProvider

const PROVIDER_VALIDATION: Record<
  Provider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  openai: (key) => ({
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${key}` },
  }),
  google: (key) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    headers: {},
  }),
  mistral: (key) => ({
    url: "https://api.mistral.ai/v1/models",
    headers: { Authorization: `Bearer ${key}` },
  }),
  // The key's own record: answers 200 for a live key, 401 otherwise.
  openrouter: (key) => ({
    url: `${openRouterBaseURL()}/key`,
    headers: { Authorization: `Bearer ${key}` },
  }),
}

const PROVIDER_DISPLAY = BYOK_PROVIDER_NAMES

/**
 * An OpenRouter key is also what `web_search` runs on when the org has no Exa
 * key, so saving or removing one re-evaluates the tool's live registration
 * (imported lazily: kernel-tools pulls in the whole agent tool graph).
 */
async function refreshWebSearch(orgId: string): Promise<void> {
  const { refreshWebSearchToolRegistration } = await import("~/modules/agent/tools/kernel-tools")
  await refreshWebSearchToolRegistration(orgId)
}

/**
 * An OpenRouter key alone is enough to chat: when Auto has nothing else to
 * run, OpenRouter's default model becomes Auto (openrouter-default.ts). Best
 * effort: the key is saved whatever OpenRouter's catalogue says, and a turn
 * retries the same step.
 */
async function ensureOpenRouterAuto(orgId: string): Promise<void> {
  try {
    const { ensureOpenRouterAutoModel } = await import("~/modules/agent/credits/openrouter-default")
    await ensureOpenRouterAutoModel(orgId)
  } catch (err) {
    log.warn({ orgId, err }, "could not make OpenRouter's default model Auto")
  }
}

/**
 * What a failed key check is logged as: the error's kind and code, never its
 * message or URL. Some providers take the key in the URL's query string
 * (Google), and a failed fetch carries that URL in its message and `path`.
 */
function fetchFailure(err: unknown): { name: string; code?: string } {
  if (!(err instanceof Error)) return { name: typeof err }
  const code: unknown = Reflect.get(err, "code")
  return { name: err.name, ...(typeof code === "string" ? { code } : {}) }
}

export const aiKeysRoutes = new Hono<AppEnv>()
  .post(
    "/",
    zValidator(
      "json",
      z.object({
        provider: z.enum(SUPPORTED_PROVIDERS),
        apiKey: z.string().min(1),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const { provider, apiKey } = c.req.valid("json")

      const { url, headers } = PROVIDER_VALIDATION[provider](apiKey)
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) {
          return c.json(
            { error: { message: `Invalid API key for ${PROVIDER_DISPLAY[provider]}` } },
            400,
          )
        }
      } catch (err) {
        log.warn(
          { provider, failure: fetchFailure(err) },
          "Provider validation endpoint unreachable",
        )
        return c.json(
          {
            error: {
              message: `Cannot validate key — ${PROVIDER_DISPLAY[provider]} API is unreachable. Try again.`,
            },
          },
          502,
        )
      }

      if (!byokEncryptionKey) {
        return c.json({ error: { message: "BYOK encryption not configured" } }, 500)
      }

      const encrypted = encryptSecret(apiKey, byokEncryptionKey, CryptoContext.byokApiKey)
      const maskedHint = apiKey.slice(-6)
      const validatedAt = new Date().toISOString()

      const k = drizzleSql.raw(schemaRef("kernel"))
      await withPrivilegedDb(orgId, "save-byok-key", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE ${k}.organizations
          SET settings = COALESCE(settings, '{}'::jsonb) ||
            jsonb_build_object('providerKeys',
              COALESCE(settings->'providerKeys', '{}'::jsonb) ||
              jsonb_build_object(${provider}::text, jsonb_build_object(
                'encrypted', ${encrypted}::text,
                'maskedHint', ${maskedHint}::text,
                'validatedAt', ${validatedAt}::text
              ))
            ),
            updated_at = now()
          WHERE id = ${orgId}::uuid
        `)
      })

      // The semantic search leg memoises "this org has no usable embedding key"
      // per process. A key written here is exactly the event that answer stops
      // being true, so the memo is dropped rather than left to a restart.
      invalidateOrgEmbedder(orgId)
      if (provider === "openrouter") {
        await refreshWebSearch(orgId)
        await ensureOpenRouterAuto(orgId)
      }
      // An agent waiting on this provider's key (its card, or a new
      // workspace's setup card) hears it was saved, wherever it was saved.
      await settleSecretRequestsForTarget(extractRlsContext(c), { kind: "byok", provider })

      return success(c, { provider, maskedHint, validatedAt })
    },
  )
  .get("/", async (c) => {
    const orgId = c.get("orgId")

    const settings = await withPrivilegedDb(orgId, "list-byok-keys", (tx) =>
      getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    )
    const providerKeys = settings.providerKeys
    if (!providerKeys) return success(c, [])

    // A custom server's key (`custom:<serverId>`) belongs to that server and is
    // shown on the AI models page with it, not as a provider key (A14).
    const keys = Object.entries(providerKeys)
      .filter(([prov]) => !prov.startsWith("custom:"))
      .map(([prov, entry]) => ({
        provider: prov,
        maskedHint: entry.maskedHint ?? "",
        validatedAt: entry.validatedAt ?? "",
      }))

    return success(c, keys)
  })
  .post(
    "/:provider/validate",
    zValidator("param", z.object({ provider: z.enum(SUPPORTED_PROVIDERS) })),
    async (c) => {
      const orgId = c.get("orgId")
      const { provider } = c.req.valid("param")

      if (!byokEncryptionKey) {
        return c.json({ error: { message: "BYOK encryption not configured" } }, 500)
      }

      const settings = await withPrivilegedDb(orgId, "revalidate-byok-key", (tx) =>
        getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
      )
      const entry = settings.providerKeys?.[provider]
      if (!entry?.encrypted) {
        return c.json({ error: { message: `No ${PROVIDER_DISPLAY[provider]} key stored` } }, 404)
      }

      const apiKey = decryptSecret(entry.encrypted, byokEncryptionKey, CryptoContext.byokApiKey)
      const { url, headers } = PROVIDER_VALIDATION[provider](apiKey)
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) {
          return c.json(
            { error: { message: `${PROVIDER_DISPLAY[provider]} rejected the stored key` } },
            400,
          )
        }
      } catch (err) {
        log.warn({ provider, failure: fetchFailure(err) }, "Re-validation endpoint unreachable")
        return c.json(
          { error: { message: `Cannot reach ${PROVIDER_DISPLAY[provider]} — try again` } },
          502,
        )
      }

      const validatedAt = new Date().toISOString()
      const k = drizzleSql.raw(schemaRef("kernel"))
      await withPrivilegedDb(orgId, "revalidate-byok-key-write", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE ${k}.organizations
          SET settings = jsonb_set(
            settings,
            ${`{providerKeys,${provider},validatedAt}`}::text[],
            to_jsonb(${validatedAt}::text)
          ),
          updated_at = now()
          WHERE id = ${orgId}::uuid
        `)
      })

      invalidateOrgEmbedder(orgId)
      return success(c, { provider, validatedAt })
    },
  )
  .delete("/:provider", async (c) => {
    const orgId = c.get("orgId")
    const provider = c.req.param("provider")
    if (!SUPPORTED_PROVIDERS.includes(provider as Provider)) {
      return c.json({ error: { message: "Unsupported provider" } }, 400)
    }

    const k = drizzleSql.raw(schemaRef("kernel"))
    // Under the org row lock: a key Auto's chosen model runs on cannot go
    // while Auto is that model (its turns would quietly fall back). The org's
    // LAST model key is the exception, as when an OpenRouter key alone made its
    // default model Auto: there is no other model to set Auto to, so refusing
    // would make the key impossible to remove. It goes, and a turn then says
    // to add a key.
    const removed = await mutateAiModels<boolean>(orgId, "remove-byok-key", async (models, tx) => {
      const autoKey = models.autoModelKey
      if (autoKey) {
        const settings = await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema)
        const { [provider]: _gone, ...otherKeys } = settings.providerKeys ?? {}
        const without = { ...settings, providerKeys: otherKeys }
        if (
          (await isModelKeyAvailable(orgId, autoKey, settings)) &&
          !(await isModelKeyAvailable(orgId, autoKey, without)) &&
          (await hasUsableModelKey(orgId, without))
        ) {
          return { result: false }
        }
      }
      await tx.execute(drizzleSql`
        UPDATE ${k}.organizations
        SET settings = settings #- ${`{providerKeys,${provider}}`}::text[],
            updated_at = now()
        WHERE id = ${orgId}::uuid
      `)
      return { result: true }
    })
    if (!removed) {
      return c.json(
        {
          error: {
            message: `Auto runs a model on this ${PROVIDER_DISPLAY[provider as Provider]} key. Set Auto to another model first.`,
            code: "auto_model",
          },
        },
        409,
      )
    }

    invalidateOrgEmbedder(orgId)
    if (provider === "openrouter") await refreshWebSearch(orgId)

    return c.body(null, 204)
  })
