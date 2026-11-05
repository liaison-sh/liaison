// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * BYOK provisioner (Task 8). Ensures per-provider BYOK keys live in
 * `settings.providerKeys.<provider>` as `{ encrypted, maskedHint, validatedAt }`,
 * idempotent by a case-insensitive masked-hint compare (the last 6 chars), with
 * optional live validation against the provider's models endpoint.
 *
 * Handle: `withPrivilegedDb` (org-scoped) via the `ctx.priv` seam. The jsonb
 * merge mirrors the BYOK route (`modules/settings/ai-keys-routes.ts`) exactly so
 * a key saved here is read back identically by the settings UI.
 *
 * Secrecy invariants:
 * - The plaintext key is NEVER logged or placed in the report — only the masked
 *   hint (last 6 chars) and the validation outcome surface.
 * - An unchanged re-run does NOT re-encrypt: `encryptSecret` is reached through
 *   an injectable seam (`deps.encryptSecret`) so the test can assert 0 calls.
 */
import { orgKernelSettingsSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey } from "~/lib/env"
import { getOrgKernelSettings } from "~/lib/settings"
import type { OpenRouterAutoOutcome } from "~/modules/agent/credits/openrouter-default"
import { openRouterBaseURL } from "~/modules/agent/providers/openrouter"

/** Per-provider report entry. The plaintext key never appears here. */
interface ByokProviderResult {
  provider: string
  maskedHint: string
  /** False on a validation failure (key still stored); true otherwise. */
  validated: boolean
  /** Whether this run wrote (encrypted) the key (false = idempotent skip). */
  set: boolean
}

interface ByokSection {
  providers: ByokProviderResult[]
  /**
   * With an `openrouter` key: whether OpenRouter's default model was made Auto
   * (the org's only usable key is OpenRouter's), so the org can chat without a
   * dashboard step.
   */
  openRouterAuto?: OpenRouterAutoOutcome
}

/**
 * Provider validation endpoints — URL + headers keyed by the API key. Mirrors
 * `ai-keys-routes.ts` PROVIDER_VALIDATION. A provider absent from this map is
 * stored without a network check (validated:true, no call).
 */
const PROVIDER_VALIDATION: Record<
  string,
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
  openrouter: (key) => ({
    url: `${openRouterBaseURL()}/key`,
    headers: { Authorization: `Bearer ${key}` },
  }),
}

/**
 * Injectable seams so the provisioner is unit-testable without a network call
 * or a real crypto key. Defaults wire the production `encryptSecret`/`fetch`.
 * This is a constructor seam — NOT a cast.
 */
export interface ByokDeps {
  encryptSecret: (plaintext: string, key: string, context: string) => string
  /** The subset of `fetch` this provisioner uses — a URL + headers/signal init →
   *  a response carrying `.ok`. Narrower than `typeof fetch` so a test mock need
   *  not implement `preconnect` etc. (no cast needed at the callsite). */
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{
    ok: boolean
  }>
  encryptionKey: string
  /** Make OpenRouter's default model Auto when Auto has nothing else to run. */
  ensureOpenRouterAuto?: (orgId: string) => Promise<OpenRouterAutoOutcome>
}

const defaultDeps: ByokDeps = {
  encryptSecret,
  fetch: globalThis.fetch,
  encryptionKey: byokEncryptionKey,
  // Imported lazily: the credit meter pulls in the agent module graph.
  ensureOpenRouterAuto: async (orgId) =>
    (await import("~/modules/agent/credits/openrouter-default")).ensureOpenRouterAutoModel(orgId),
}

/** Validate a provider key over the network. Returns false on any non-OK or
 *  unreachable response; never throws (a validation failure is a warning, not a
 *  fatal). */
async function validateProviderKey(
  provider: string,
  apiKey: string,
  deps: ByokDeps,
): Promise<boolean> {
  const spec = PROVIDER_VALIDATION[provider]
  if (!spec) return true // No endpoint known → treat as validated (stored as-is).
  const { url, headers } = spec(apiKey)
  try {
    const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    return res.ok
  } catch {
    return false
  }
}

export function createByokProvisioner(
  deps: ByokDeps = defaultDeps,
): Provisioner<ProvisioningConfig> {
  return {
    key: "byok",

    async plan(ctx, config): Promise<ProvisionPlan> {
      const byok = config.byok
      if (!byok) return { actions: [] }
      const actions: string[] = []
      // The driver plans every provisioner before any apply, so `ctx.orgId` is
      // unset here (org is created in its apply). Without an org we cannot read
      // the stored masked hints — report the generic intent; `apply` does the
      // real masked-hint idempotency compare. Never log the key, only the hint.
      const stored =
        ctx.orgId === ""
          ? null
          : await ctx.priv("cli-plan-byok", (tx) =>
              getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
            )
      for (const [provider, entry] of Object.entries(byok)) {
        const hint = entry.apiKey.slice(-6)
        const existingHint = stored?.providerKeys?.[provider]?.maskedHint ?? ""
        if (existingHint.toLowerCase() === hint.toLowerCase()) {
          actions.push(`byok '${provider}' unchanged (…${hint})`)
        } else {
          actions.push(`set byok '${provider}' (…${hint})`)
        }
      }
      return { actions }
    },

    async apply(ctx, _plan, config): Promise<ProvisionResult> {
      const byok = config.byok
      if (!byok) return {}

      const providers: ByokProviderResult[] = []
      const changed: string[] = []
      const unchanged: string[] = []

      // Read the current settings ONCE so the per-provider hint compare avoids a
      // round trip per key.
      const stored = await ctx.priv("cli-byok-read", (tx) =>
        getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
      )

      for (const [provider, entry] of Object.entries(byok)) {
        const maskedHint = entry.apiKey.slice(-6)
        const existingHint = stored.providerKeys?.[provider]?.maskedHint ?? ""

        // Idempotent skip: case-insensitive masked-hint match → NO re-encrypt,
        // NO write (the "encryptSecret = 0 calls on re-run" guarantee). Report the
        // STORED validation outcome — NOT an unconditional `true`: the first run
        // may have stored the key after a FAILED/unconfirmed validation check, and
        // a skip must not falsely claim the key validated. A `validated` field
        // written before this fix may be absent; treat absent as `false`
        // (unconfirmed) rather than optimistically true.
        if (existingHint.toLowerCase() === maskedHint.toLowerCase()) {
          const storedValidated = stored.providerKeys?.[provider]?.validated === true
          ctx.log(`byok '${provider}' already set (…${maskedHint}, validated=${storedValidated})`)
          providers.push({ provider, maskedHint, validated: storedValidated, set: false })
          unchanged.push(`byok.${provider}`)
          continue
        }

        // Validation default-on; per-provider `validate:false` or the global
        // `--no-validate-byok` flag (ctx.validateByok=false) skips the call.
        const wantValidate = ctx.validateByok && entry.validate !== false
        const validated = wantValidate
          ? await validateProviderKey(provider, entry.apiKey, deps)
          : true
        if (wantValidate && !validated) {
          ctx.log(`warning: byok '${provider}' failed validation — storing the key anyway`)
        }

        const encrypted = deps.encryptSecret(
          entry.apiKey,
          deps.encryptionKey,
          CryptoContext.byokApiKey,
        )
        const validatedAt = new Date().toISOString()

        const k = drizzleSql.raw(schemaRef("kernel"))
        await ctx.priv("cli-byok-write", async (tx) => {
          await tx.execute(drizzleSql`
            UPDATE ${k}.organizations
            SET settings = COALESCE(settings, '{}'::jsonb) ||
              jsonb_build_object('providerKeys',
                COALESCE(settings->'providerKeys', '{}'::jsonb) ||
                jsonb_build_object(${provider}::text, jsonb_build_object(
                  'encrypted', ${encrypted}::text,
                  'maskedHint', ${maskedHint}::text,
                  'validatedAt', ${validatedAt}::text,
                  'validated', ${validated}::boolean
                ))
              ),
              updated_at = now()
            WHERE id = ${ctx.orgId}::uuid
          `)
        })

        ctx.log(`byok '${provider}' set (…${maskedHint}, validated=${validated})`)
        providers.push({ provider, maskedHint, validated, set: true })
        changed.push(`byok.${provider}`)

        // `exa` (and, failing it, `openrouter`, the web-plugin backend) is the
        // key that makes the kernel `web_search` tool usable at all.
        // Re-evaluate its live registration right after the write so the tool
        // appears in the SAME `config apply` run that added the key, without a
        // process restart.
        if (provider === "exa" || provider === "openrouter") {
          const { refreshWebSearchToolRegistration } = await import(
            "~/modules/agent/tools/kernel-tools"
          )
          await refreshWebSearchToolRegistration(ctx.orgId)
        }
      }

      // An OpenRouter key alone is enough to chat: when Auto has nothing else to
      // run, OpenRouter's default model becomes Auto. Asked on every run with an
      // `openrouter` entry (also an unchanged one), so a re-apply repairs an org
      // keyed before this step existed. Idempotent, and a no-op once Auto runs.
      const section: ByokSection = { providers }
      if (byok.openrouter && deps.ensureOpenRouterAuto) {
        const outcome = await deps.ensureOpenRouterAuto(ctx.orgId)
        section.openRouterAuto = outcome
        if (outcome.status === "set") {
          ctx.log(`Auto runs on OpenRouter's default model (${outcome.key})`)
          changed.push("byok.openrouter.auto")
        } else if (outcome.status === "unavailable") {
          ctx.log(
            `warning: Auto has no model to run yet: ${outcome.reason} Add an OpenRouter model and make it Auto in Settings > AI models.`,
          )
        }
      }
      return {
        section,
        ...(changed.length > 0 ? { changed } : {}),
        ...(unchanged.length > 0 ? { unchanged } : {}),
      }
    },
  }
}

/** Production BYOK provisioner (real `encryptSecret` + `fetch`). */
export const byokProvisioner = createByokProvisioner()
