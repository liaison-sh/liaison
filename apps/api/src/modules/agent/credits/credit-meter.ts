// SPDX-License-Identifier: FSL-1.1-ALv2
import type { CloudUnitItem } from "@liaison/control-plane-contract"
import {
  type AddedModel,
  type AiModelsSettings,
  AUTO_REASONING_LEVEL,
  DEMO_BOX_KEY_REASONING_LEVEL,
  getReasoningCapability,
  type OrgKernelSettings,
  OUT_OF_CREDITS_CODE,
  orgKernelSettingsSchema,
  PAYMENT_REQUIRED_CODE,
  type ReasoningLevel,
  tierAtLeast,
} from "@liaison/shared"
import { eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { creditTransactions, modelPricing, organizations } from "~/db/schema/kernel"
import { currentUsdEurRate } from "~/infra/jobs/sync-model-pricing"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { isManagedEdition } from "~/lib/edition"
import { byokEncryptionKey, env } from "~/lib/env"
import { isLoadOrg } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { getOrgKernelSettings } from "~/lib/settings"
import { UUID_RE } from "~/lib/uuid"
import {
  CREDIT_PRICING_MISSING,
  CREDIT_PRICING_MISSING_MESSAGE,
  cellCreditPricing,
  creditsForEur,
  creditsForUnits,
  requireCellCreditPricing,
} from "~/modules/agent/credits/credit-cost"
import { checkBalance, deductCredits } from "~/modules/agent/credits/credit-service"
import {
  CHAT_MODEL_PROVIDERS,
  customServerKeyName,
  findAddedModel,
  isChatModelProvider,
  isNativeModelId,
  parseModelKey,
} from "~/modules/agent/credits/model-keys"
import {
  ANTHROPIC_CACHE_WRITE_RATE_FACTOR,
  resolveAnthropicCacheTtl,
} from "~/modules/agent/providers/anthropic-cache-ttl"
import { boxKeyModels } from "~/modules/agent/providers/openrouter"
import { selectAutoModel } from "~/modules/agent/providers/provider"
import type { AddedModelReasoningCaps } from "~/modules/agent/providers/reasoning"
import type { StepTokenCap } from "~/modules/agent/providers/step-token-cap"
import { readProviderCostUsd, readStepUsage } from "~/modules/agent/providers/step-usage"
import { maybeRequestAutoTopUp } from "~/modules/cloud/auto-topup-trigger"
import {
  assertPaymentNotRequired,
  PaymentRequiredError,
  paymentRequired,
} from "~/modules/cloud/suspension"
import { demoVisitorSpendState } from "~/modules/demo/demo-alerts"
import {
  acquireVisitorTurnSlot,
  currentVerifiedIdentity,
  type DemoReservation,
  type DemoSpendIdentity,
  type DemoTurnSlot,
  isLive,
  releaseReservation,
  releaseTurnSlot,
  reserveVisitorStep,
  settleStep,
  visitorSpendIdentity,
} from "~/modules/demo/demo-budget"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import {
  assertDemoPlatformKeyAllowed,
  checkDemoSpendCeiling,
  DemoKeyRequiredError,
  DemoReservationRequiredError,
  type DemoSpendCode,
  DemoSpendRefusedError,
  demoOrgKind,
  demoPlatformKeyAllowed,
  demoSpendExhausted,
  demoVisitorModelKey,
  demoVisitorUpstreamId,
  isReservedDemoOrg,
  isVisitorDemoOrg,
  releaseDemoTurnReservation,
  reservedDemoModelId,
} from "~/modules/demo/demo-spend"
import {
  microEurOfTokens,
  microEurOfUsd,
  RESERVED_STEP_OUTPUT_TOKENS,
  VISITOR_CACHED_INPUT_MICRO_EUR_PER_M,
  VISITOR_INPUT_MICRO_EUR_PER_M,
  VISITOR_MODEL_CONTEXT_WINDOW,
  VISITOR_OUTPUT_MICRO_EUR_PER_M,
  visitorRequestInputMicroEur,
  visitorStepOutputMicroEur,
} from "~/modules/demo/demo-spend-ceiling"
import { ENV_KEY_MAP } from "./platform-key-env"

/** Exported so the telemetry lines this module emits can be observed. */
export const creditMeterLogger = rootLogger.child({ module: "credit-meter" })
const log = creditMeterLogger

// --- Persistent-deduction-failure circuit breaker ---------------------------
// A deduction failure (deductCredits throwing) means the agent already produced
// a response we cannot bill. We swallow the per-turn loss so the user is not
// punished for a transient DB blip — but a *persistent* failure would otherwise
// be silent unlimited free usage (a revenue bypass) with no signal. We keep a
// per-org consecutive-failure counter in Redis: it increments on each failure,
// resets on the first successful deduction, and after a small threshold the
// pre-turn gate hard-blocks further agent turns for that org instead of serving
// them free, while logging a loud operator-visible alert.
const DEDUCT_FAIL_THRESHOLD = 3
// TTL so a counter that goes quiet (no further failures, but also no success to
// reset it) self-heals rather than blocking the org forever.
const DEDUCT_FAIL_TTL_SECONDS = 24 * 60 * 60
const deductFailKey = (orgId: string): string => `agent:credit-deduct-fail:${orgId}`

/**
 * Record a credit-deduction failure for an org and return the running
 * consecutive-failure count. Increments a Redis counter (with a TTL set on the
 * first increment). Best-effort: a Redis outage must not itself crash billing,
 * but it is logged loudly because it disables the circuit breaker.
 */
async function recordDeductionFailure(orgId: string): Promise<number> {
  try {
    const count = await redis.incr(deductFailKey(orgId))
    if (count === 1) await redis.expire(deductFailKey(orgId), DEDUCT_FAIL_TTL_SECONDS)
    return count
  } catch (err) {
    log.error(
      { err, orgId, alert: "credit_deduction_breaker_unavailable" },
      "Failed to record credit-deduction failure — circuit breaker disabled for this org",
    )
    return 0
  }
}

/** Reset the consecutive-failure counter after a successful deduction. */
async function resetDeductionFailures(orgId: string): Promise<void> {
  try {
    await redis.del(deductFailKey(orgId))
  } catch (err) {
    log.error({ err, orgId }, "Failed to reset credit-deduction failure counter")
  }
}

/**
 * Whether the org has tripped the deduction-failure circuit breaker, i.e. it
 * has hit DEDUCT_FAIL_THRESHOLD consecutive deduction failures and must be
 * hard-blocked at the pre-turn gate rather than served free. Fail-open on a
 * Redis read error (logged) — the breaker is a backstop, not the primary gate.
 */
async function deductionBreakerTripped(orgId: string): Promise<boolean> {
  try {
    const raw = await redis.get(deductFailKey(orgId))
    return raw != null && Number(raw) >= DEDUCT_FAIL_THRESHOLD
  } catch (err) {
    log.error(
      { err, orgId, alert: "credit_deduction_breaker_unavailable" },
      "Failed to read credit-deduction failure counter — cannot enforce block",
    )
    return false
  }
}

/**
 * The model a pre-checked call runs on.
 *
 * `modelId` is the model KEY (A1): what a thread, an agent or a routine stores,
 * and what every message, usage row and reasoning lookup records. Only the
 * provider call reads `upstreamId` (and `baseURL` for an org's own server),
 * through `resolveModelFromCredit`.
 */
export interface ModelInfo {
  provider: string
  modelId: string
  /** The id sent to the provider. A native model's is its key. */
  upstreamId: string
  /** An org's own server's address (provider "custom"), from org settings. */
  baseURL?: string
  serverId?: string
  /** An added model's reasoning capability, from its entry. Native models have none. */
  reasoningCaps?: AddedModelReasoningCaps
  inputCostPerM: string
  outputCostPerM: string
  contextWindow: number
  source?: string
  updatedAt?: Date | string
  /**
   * The output limit of each agent loop request, set for the demo orgs on the
   * box's key only (see `resolveModelForPreCheck`); absent means uncapped.
   */
  stepTokenCap?: StepTokenCap
  /**
   * An added (non-custom) model whose entry has no fixed price (OpenRouter
   * gave none, or a dynamic one). Its prices above read "0", so it must never
   * run on the platform key: `preCheck` refuses that.
   */
  unpriced?: boolean
  /**
   * Auto picked this model: nothing was chosen by the person, the
   * conversation, the agent or the routine (or a stored choice is no longer
   * available), or it is a demo visitor's Auto pin. Such a turn runs at
   * Auto's level (`resolveTurnReasoningLevel`, providers/reasoning.ts).
   */
  autoPicked?: boolean
  /**
   * The level Auto runs this model at, when it is not `AUTO_REASONING_LEVEL`:
   * the visitor pin on a demo box's key runs at `DEMO_BOX_KEY_REASONING_LEVEL`.
   */
  autoReasoningLevel?: ReasoningLevel
  /**
   * The organization's default level for a turn that asks for none
   * (`settings.ai.models.defaultReasoningLevel`); absent when unset.
   */
  orgDefaultReasoningLevel?: ReasoningLevel
}

// Discriminated union: success vs failure with explicit HTTP status and side-effect flag
type PreCheckSuccess = {
  allowed: true
  keySource: "liaison" | "byok"
  model: ModelInfo
  providerKey: string
  /**
   * A visitor demo org's call on the box key: its per-step reservations. The
   * caller settles it (`finalizeUsage({ demo })`, `meterSideCall`)
   * and a turn asks it for the next step (`stepFinished`).
   */
  demo?: DemoStepMeter
  /**
   * A load org (lib/load-harness.ts): the call runs on the load model
   * (providers/load-scripts.ts), so no key is resolved and no spend reserved.
   */
  loadOrgId?: string
  /** The org the check ran for (OpenRouter applies its blocked hosts). */
  orgId?: string
}

type PreCheckFailure = {
  allowed: false
  status: 400 | 402 | 403 | 429 | 500 | 503
  persistSystemMessage: boolean
  reason: string
  /** A demo spend refusal's code (`demo_*`), for the client. */
  code?: DemoSpendCode
  /**
   * A billing refusal's code: `credit_rate_missing` when the cell has no pushed
   * rate, `payment_required` while the org's renewal is unpaid,
   * `out_of_credits` when the balance is spent. Every other refusal carries no
   * code and speaks for itself through `reason`.
   */
  billingCode?:
    | typeof CREDIT_PRICING_MISSING
    | typeof PAYMENT_REQUIRED_CODE
    | typeof OUT_OF_CREDITS_CODE
}

export type PreCheckResult = PreCheckSuccess | PreCheckFailure

/**
 * The key for a provider, or for a resolved model (A5): a model of an org's
 * own server finds its key under `providerKeys["custom:<serverId>"]`, and a
 * server without a key gets an empty one. Neither ever falls back to an
 * environment key.
 */
/**
 * The OpenRouter ids a visitor org's reservation may hold the box key for: the
 * visitor pin, the web-search plugin model and the transcription models. The
 * request guard in openrouter.ts enforces the same set on the wire.
 */
export function visitorBoxKeyModels(): ReadonlySet<string> {
  const models = new Set(boxKeyModels().keys())
  // The reserved org's pin is not a visitor's.
  const reserved = env.LIAISON_DEMO_RESERVED_MODEL
  if (reserved.startsWith("openrouter/")) models.delete(reserved.slice("openrouter/".length))
  models.add(demoVisitorUpstreamId())
  return models
}

export interface ResolveKeyOptions {
  /**
   * The live reservation a visitor org's call holds (demo-budget.ts). Without
   * one, a visitor org never gets this box's key.
   */
  reservation?: DemoReservation
}

/**
 * A VISITOR org's licence to the box key, checked at hand-out: a live
 * reservation for this org, provider OpenRouter, and a model the reservation
 * names (the pin, or a registered side model). Throws a coded refusal.
 */
async function assertVisitorBoxKey(
  orgId: string,
  provider: string,
  upstreamId: string | undefined,
  opts: ResolveKeyOptions,
): Promise<void> {
  const { locale } = await loadDemoOrg(orgId)
  const r = opts.reservation
  const verified = (await currentVerifiedIdentity(orgId)) !== null
  const refuse = (): never => {
    throw new DemoReservationRequiredError(
      verified ? "demo_unavailable" : "demo_verification_required",
      locale,
    )
  }
  if (!r || provider !== "openrouter" || r.orgId !== orgId || r.provider !== "openrouter") refuse()
  const res = r as DemoReservation
  if (!visitorBoxKeyModels().has(res.upstreamId)) refuse()
  if (upstreamId !== undefined && upstreamId !== res.upstreamId) refuse()
  if (!(await isLive(res, orgId))) refuse()
}

export async function resolveKey(
  orgId: string,
  target: string | { provider: string; serverId?: string; upstreamId?: string },
  opts: ResolveKeyOptions = {},
): Promise<{ key: string; source: "byok" | "liaison" }> {
  const provider = typeof target === "string" ? target : target.provider
  const settings = await withPrivilegedDb(orgId, "resolve-key", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  if (provider === "custom") {
    const serverId = typeof target === "string" ? undefined : target.serverId
    const entry = serverId ? settings.providerKeys?.[customServerKeyName(serverId)] : undefined
    if (entry?.encrypted && byokEncryptionKey) {
      return {
        key: decryptSecret(entry.encrypted, byokEncryptionKey, CryptoContext.byokApiKey),
        source: "byok",
      }
    }
    return { key: "", source: "byok" }
  }
  const byokEntry = settings.providerKeys?.[provider]

  if (byokEntry?.encrypted && byokEncryptionKey) {
    const plaintext = decryptSecret(
      byokEntry.encrypted,
      byokEncryptionKey,
      CryptoContext.byokApiKey,
    )
    return { key: plaintext, source: "byok" }
  }

  // Fall back to the deployment's own key, EXCEPT on a demo box.
  //
  // A demo instance hands a stranger an admin account in an org they own, and
  // this fallback would quietly spend whatever provider key happens to be set
  // on that box for every one of them. `demoPlatformKeyAllowed` says no for a
  // demo org (the reserved App Review org is the single exception, and its
  // spend is capped by `checkDemoSpendCeiling`), and the refusal names what to
  // do about it rather than reading as a misconfiguration. It returns on its
  // first line on every normal deployment, so no org on a real box reaches a
  // query or a branch added here.
  //
  // A VISITOR org reaches the box key only as a capability: a live reservation,
  // OpenRouter, the reservation's own model (assertVisitorBoxKey). No other
  // provider's environment key is ever handed to a visitor org.
  if ((await demoOrgKind(orgId)) === "visitor") {
    await assertVisitorBoxKey(
      orgId,
      provider,
      typeof target === "string" ? undefined : target.upstreamId,
      opts,
    )
    const boxKey = process.env.OPENROUTER_API_KEY
    if (!boxKey) {
      throw new Error('No API key available for provider "openrouter" on this demo box.')
    }
    return { key: boxKey, source: "liaison" }
  }
  await assertDemoPlatformKeyAllowed(orgId)

  // A managed org past due, suspended or closed spends nothing on the platform
  // key: every paid call resolves its key here, so this one refusal
  // covers chat, side calls (titles, link ingest, media, embeddings), web
  // search and dictation. BYOK never applies in the managed edition.
  if (isManagedEdition()) await assertPaymentNotRequired(orgId)

  const envVar = ENV_KEY_MAP[provider]
  const envKey = envVar ? process.env[envVar] : undefined
  if (envKey) {
    return { key: envKey, source: "liaison" }
  }

  throw new Error(
    `No API key available for provider "${provider}". Configure a BYOK key or set ${envVar ?? `<unknown env var for ${provider}>`}.`,
  )
}

/**
 * Does this org have a usable key for `provider`, counting only what it owns?
 *
 * This is the BYOK half alone. It is NOT the question a surface that advertises
 * a capability should ask, because the environment key it used to also accept
 * is refused for a demo org by `resolveKey`. Use `isProviderUsable`.
 */
/**
 * Run a read on `db`, the privileged transaction of this org the caller already
 * holds (a settings mutation under its row lock), or in its own privileged
 * transaction without one. Reading on the held one takes no second privileged
 * slot, so the checks of a mutation cannot deadlock a full pool.
 */
function onPrivileged<T>(
  db: PrivilegedDb | undefined,
  orgId: string,
  reason: string,
  fn: (tx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  return db ? fn(db) : withPrivilegedDb(orgId, reason, fn)
}

function isProviderConfigured(
  provider: string,
  settings: { providerKeys?: Record<string, { encrypted?: string | null } | undefined> },
): boolean {
  const byokEntry = settings.providerKeys?.[provider]
  return Boolean(byokEntry?.encrypted && byokEncryptionKey)
}

/** Is there an environment key on this box for `provider`? */
function hasEnvKey(provider: string): boolean {
  const envVar = ENV_KEY_MAP[provider]
  return Boolean(envVar && process.env[envVar])
}

/**
 * Can `orgId` actually get a key for `provider` right now?
 *
 * The same resolution `resolveKey` performs, asked without performing it: the
 * org's own BYOK key, or the deployment's environment key WHEN THIS ORG IS
 * ALLOWED TO REACH IT. That last clause is the whole point. Every surface that
 * advertises a capability ahead of use asks this, so what is offered and what
 * `resolveKey` will hand over cannot disagree.
 *
 * On a normal deployment `demoPlatformKeyAllowed` returns true on its first
 * line, so this is the old predicate exactly, with no extra query.
 */
export async function isProviderUsable(
  orgId: string,
  provider: string,
  settings: { providerKeys?: Record<string, { encrypted?: string | null } | undefined> },
  /** A privileged transaction of this org the caller holds (see onPrivileged). */
  db?: PrivilegedDb,
): Promise<boolean> {
  if (isProviderConfigured(provider, settings)) return true
  if (!hasEnvKey(provider)) return false
  // A visitor org can use the box key for OpenRouter only, once verified and
  // while visitor spend is on: the pin runs there (and web search on it).
  if (await isVisitorDemoOrg(orgId, db)) return visitorBoxKeyUsable(orgId, provider, db)
  return await demoPlatformKeyAllowed(orgId, db)
}

/** Can a visitor org reach the box key for `provider` right now? OpenRouter, verified, spend on. */
async function visitorBoxKeyUsable(
  orgId: string,
  provider: string,
  db?: PrivilegedDb,
): Promise<boolean> {
  if (provider !== "openrouter") return false
  if ((await demoVisitorSpendState()) !== "on") return false
  return (await currentVerifiedIdentity(orgId, db)) !== null
}

/**
 * AN AGENT'S DEFAULT MODEL, KEPT ONLY WHEN THIS ORG CAN RUN IT.
 *
 * `agents.model_preference` is set once (by a seed, a config file, the
 * settings page) and keys change afterwards. An agent seeded on Claude Sonnet
 * in a workspace whose only key is Google's asked for Sonnet on every turn,
 * and every turn failed on the missing Anthropic key until the person found
 * the model picker (the demo visitor who pasted a Gemini key, 2026-10).
 *
 * A default whose provider the org cannot reach (`isProviderUsable`, the same
 * resolution `resolveKey` performs) is dropped to null, which is auto mode,
 * and auto picks only among the providers the org can use. A usable default
 * comes back unchanged, so nothing moves for an org whose default works. A
 * model the catalog does not know is also returned unchanged: the pre-check
 * already answers that one with "Model not available".
 */
export async function usableDefaultModel(
  orgId: string,
  modelId: string | null | undefined,
): Promise<string | null> {
  if (!modelId) return null
  const parsed = parseModelKey(modelId)
  const { settings, row } = await withPrivilegedDb(orgId, "usable-default-model", async (tx) => ({
    settings: await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    row:
      parsed?.kind === "native"
        ? (
            await tx
              .select({ provider: modelPricing.provider })
              .from(modelPricing)
              .where(eq(modelPricing.modelId, modelId))
              .limit(1)
          )[0]
        : undefined,
  }))
  // A native id the catalogue does not know is returned unchanged: the
  // pre-check answers that one with "Model not available".
  if (parsed?.kind === "native" && !row) return modelId
  return (await isModelKeyAvailable(orgId, modelId, settings, row ?? null)) ? modelId : null
}

// --- The org's model catalogue: native models, added models, availability ---

function aiModelsOf(settings: OrgKernelSettings): AiModelsSettings {
  return settings.ai?.models ?? {}
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  openrouter: "OpenRouter",
}

/** The picker's group label of a model: its provider, or its server's name. */
export function providerLabelOf(provider: string, serverName?: string): string {
  if (provider === "custom") return serverName ?? "Your server"
  return PROVIDER_LABELS[provider] ?? provider
}

/** The ModelInfo of an added model, or null when its server is gone. */
function addedModelInfo(entry: AddedModel, models: AiModelsSettings): ModelInfo | null {
  let baseURL: string | undefined
  if (entry.provider === "custom") {
    const server = (models.servers ?? []).find((sv) => sv.id === entry.serverId)
    if (!server) return null
    baseURL = server.baseURL
  }
  return {
    provider: entry.provider,
    modelId: entry.key,
    upstreamId: entry.upstreamId,
    ...(baseURL ? { baseURL } : {}),
    ...(entry.serverId ? { serverId: entry.serverId } : {}),
    reasoningCaps: {
      reasoningEfforts: entry.reasoningEfforts,
      canDisableReasoning: entry.canDisableReasoning,
    },
    // A custom server costs nothing to meter: its usage records tokens at 0.
    inputCostPerM: entry.provider === "custom" ? "0" : (entry.inputCostPerM ?? "0"),
    outputCostPerM: entry.provider === "custom" ? "0" : (entry.outputCostPerM ?? "0"),
    contextWindow: entry.contextWindow,
    source: entry.provider,
    ...(entry.priceUpdatedAt ? { updatedAt: entry.priceUpdatedAt } : {}),
    ...(entry.provider !== "custom" &&
    (entry.inputCostPerM === null || entry.outputCostPerM === null)
      ? { unpriced: true }
      : {}),
  }
}

/**
 * Is the model behind `key` available to this org: enabled, and its provider
 * reachable (a usable key for native and OpenRouter models, the server for a
 * custom one)? The reserved demo org's pin is applied by the callers that list
 * models; the pre-check answers that org with its pin before asking.
 */
export async function isModelKeyAvailable(
  orgId: string,
  key: string,
  settings: OrgKernelSettings,
  nativeRow?: { provider: string } | null,
  /** A privileged transaction of this org the caller holds (see onPrivileged). */
  db?: PrivilegedDb,
): Promise<boolean> {
  const parsed = parseModelKey(key)
  if (!parsed) return false
  const models = aiModelsOf(settings)
  if (await isVisitorDemoOrg(orgId, db)) {
    // The pin is available on the visitor's own OpenRouter key, or on the box
    // key once verified. An added model runs on the visitor's own key only.
    if (key === demoVisitorModelKey()) {
      return (
        isProviderConfigured("openrouter", settings) ||
        (await visitorBoxKeyUsable(orgId, "openrouter", db))
      )
    }
    if (parsed.kind !== "native") {
      const entry = findAddedModel(models, key)
      return Boolean(
        entry?.enabled &&
          entry.provider !== "custom" &&
          isProviderConfigured(entry.provider, settings),
      )
    }
  }
  if (parsed.kind === "native") {
    if ((models.disabled ?? []).includes(key)) return false
    const row =
      nativeRow ??
      (
        await onPrivileged(db, orgId, "model-availability", (tx) =>
          tx
            .select({ provider: modelPricing.provider })
            .from(modelPricing)
            .where(eq(modelPricing.modelId, key))
            .limit(1),
        )
      )[0]
    if (!row || !isChatModelProvider(row.provider)) return false
    return isProviderUsable(orgId, row.provider, settings, db)
  }
  const entry = findAddedModel(models, key)
  if (!entry?.enabled) return false
  if (entry.provider === "custom") {
    return (models.servers ?? []).some((sv) => sv.id === entry.serverId)
  }
  return isProviderUsable(orgId, "openrouter", settings, db)
}

/** A model key resolved to the ModelInfo a call runs on, regardless of enablement. */
async function lookupModelInfo(
  orgId: string,
  key: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<ModelInfo | null> {
  const parsed = parseModelKey(key)
  if (!parsed) return null
  if (parsed.kind === "native") {
    const row = await onPrivileged(db, orgId, "pre-check-model", async (tx) => {
      const [r] = await tx.select().from(modelPricing).where(eq(modelPricing.modelId, key))
      return r
    })
    return row ? { ...row, upstreamId: row.modelId } : null
  }
  const models = aiModelsOf(settings)
  const entry = findAddedModel(models, key)
  return entry ? addedModelInfo(entry, models) : null
}

/**
 * THE VISITOR PIN, built from code and env alone (`LIAISON_DEMO_VISITOR_MODEL`
 * and the derivation block in demo-spend-ceiling.ts), never from org settings:
 * a visitor is the admin of their org and could otherwise re-price or re-point
 * it. On the box key it carries the visitor step cap (its output limit and the
 * step meter's hook) and runs at the demo's reasoning level.
 */
export function demoVisitorModelInfo(onBoxKey = true): ModelInfo {
  const perM = (micro: number) => (micro / 1_000_000).toFixed(6)
  return {
    provider: "openrouter",
    modelId: demoVisitorModelKey(),
    upstreamId: demoVisitorUpstreamId(),
    inputCostPerM: perM(VISITOR_INPUT_MICRO_EUR_PER_M),
    outputCostPerM: perM(VISITOR_OUTPUT_MICRO_EUR_PER_M),
    contextWindow: VISITOR_MODEL_CONTEXT_WINDOW,
    source: "demo_visitor_pin",
    // The pin is a demo's Auto: the pinned model (DeepSeek V4.1 Flash by
    // default) takes low and high, and reasoning cannot be switched off for
    // it here. On the box key it runs at the demo's level (low, so a visitor
    // does not wait; the box-key guard forces it on the request), on the
    // visitor's own key at Auto's.
    reasoningCaps: { reasoningEfforts: ["low", "high"], canDisableReasoning: false },
    autoPicked: true,
    ...(onBoxKey
      ? { autoReasoningLevel: DEMO_BOX_KEY_REASONING_LEVEL, stepTokenCap: visitorStepTokenCap() }
      : {}),
  }
}

/** The step cap of a visitor step on the box key (env, read in demo mode). */
export function visitorStepTokenCap(): StepTokenCap {
  return { maxOutputTokens: env.LIAISON_DEMO_STEP_OUTPUT_TOKENS, visitor: true }
}

/**
 * How many steps one visitor call may take: a routine run reads more before it acts than a
 * chat turn does, so it has its own limit (env.ts).
 */
export function visitorStepsPerTurn(opts: { routine?: boolean } = {}): number {
  return opts.routine === true
    ? env.LIAISON_DEMO_ROUTINE_STEPS_PER_TURN
    : env.LIAISON_DEMO_STEPS_PER_TURN
}

/**
 * What one visitor step holds before it runs, µEUR: its capped output at worst.
 * Its input is added as its request leaves (demo-spend-ceiling.ts, ONE STEP).
 */
export function visitorStepBase(): number {
  return visitorStepOutputMicroEur(env.LIAISON_DEMO_STEP_OUTPUT_TOKENS)
}

/** The providers a visitor org holds its OWN key for (chat providers only). */
function visitorByokProviders(settings: OrgKernelSettings): string[] {
  return Object.keys(settings.providerKeys ?? {}).filter(
    (p) => isChatModelProvider(p) && isProviderConfigured(p, settings),
  )
}

/**
 * The model a visitor org's call runs on: a model on a provider it holds its
 * own key for (unpinned: its key, its money), else the pin. Auto prefers a
 * BYOK provider when there is one.
 */
async function visitorModelFor(
  orgId: string,
  requestedModelId: string | null | undefined,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<ModelInfo> {
  if (requestedModelId === demoVisitorModelKey()) {
    return demoVisitorModelInfo(!isProviderConfigured("openrouter", settings))
  }
  if (requestedModelId) {
    const info = await lookupModelInfo(orgId, requestedModelId, settings, db)
    if (info && info.provider !== "custom" && isProviderConfigured(info.provider, settings)) {
      return info
    }
  }
  const byok = visitorByokProviders(settings).filter((p) => p !== "openrouter")
  if (byok.length > 0) {
    const pick = await onPrivileged(db, orgId, "visitor-auto", (tx) =>
      selectAutoModel(tx, { providers: byok, exclude: aiModelsOf(settings).disabled ?? [] }),
    )
    if (pick) {
      const info = await lookupModelInfo(orgId, pick.modelId, settings, db)
      if (info) return { ...info, autoPicked: true }
    }
  }
  return demoVisitorModelInfo(!isProviderConfigured("openrouter", settings))
}

/** A visitor org's Auto / side-call pick: a BYOK model, else the pin. */
async function visitorSelection(
  orgId: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<{ provider: string; modelId: string }> {
  const info = await visitorModelFor(orgId, null, settings, db)
  return { provider: info.provider, modelId: info.modelId }
}

/**
 * Can `web_search` run for this org: an Exa key resolvable (env-level OR org
 * BYOK), or failing that an OpenRouter key (the web-plugin backend,
 * `resolveWebSearchBackend` in web-tools.ts, which tries the same two in the
 * same order through `resolveKey`)? Reuses `isProviderUsable`, the
 * non-throwing form of that resolution, so the kernel-tool registration gate
 * and the runtime key lookup never disagree. Used at tool-registration time
 * (and re-checked when an Exa or OpenRouter key changes) to decide whether
 * `web_search` is advertised to the agent at all.
 */
export async function isWebSearchConfigured(orgId: string): Promise<boolean> {
  const settings = await withPrivilegedDb(orgId, "web-search-tool-visibility", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  if (await isProviderUsable(orgId, "exa", settings)) return true
  return await isProviderUsable(orgId, "openrouter", settings)
}

/**
 * AUTO MODE'S MODEL FOR THIS ORG: the cheapest auto-eligible model whose
 * provider the org can actually get a key for (its BYOK key, or the
 * deployment's). Picking the globally cheapest auto model regardless broke
 * every auto turn of an org whose keys are for another provider: "No API key
 * available for provider google" while its OpenAI key sat unused.
 *
 * Only auto-eligible models are ever picked, so an operator who turns a
 * model's flag off is obeyed. Every provider's catalog has one (Anthropic's
 * since migration 0139), so a single key of any provider is enough. When none
 * of the org's usable providers has one (an operator turned them all off),
 * the org's added models are next.
 *
 * An org with no usable native provider (only an OpenRouter key, or only its
 * own server) runs on its Auto setting when that names an available model,
 * else on the cheapest enabled added model it can reach. When it has none of
 * those the answer is null: Auto never picks a provider the org has no key
 * for (that pick used to fail every side call on "No API key for provider
 * google" in a workspace that had never had one).
 */
export async function selectSideCallModelForOrg(
  orgId: string,
  reason: string,
): Promise<{ provider: string; modelId: string } | null> {
  const settings = await withPrivilegedDb(orgId, `${reason}:settings`, (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  if (await isVisitorDemoOrg(orgId)) return visitorSelection(orgId, settings)
  const usable = await usableAutoProviders(orgId, reason, settings)
  if (usable.length > 0) {
    const pick = await withPrivilegedDb(orgId, reason, (tx) =>
      selectAutoModel(tx, { providers: usable }),
    )
    if (pick) return pick
  }
  return addedSideCallModel(orgId, settings)
}

/**
 * A side call's model among the org's ADDED models, for an org whose native
 * catalogue it cannot reach: the Auto setting when it names an available
 * model, else the cheapest enabled added model whose key is usable (a model
 * with no known price ranks last). Null when there is none.
 */
async function addedSideCallModel(
  orgId: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<{ provider: string; modelId: string } | null> {
  const models = aiModelsOf(settings)
  const autoKey = models.autoModelKey
  if (autoKey && (await isModelKeyAvailable(orgId, autoKey, settings, undefined, db))) {
    const info = await lookupModelInfo(orgId, autoKey, settings, db)
    if (info) return { provider: info.provider, modelId: info.modelId }
  }
  const priceOf = (entry: AddedModel): number =>
    entry.inputCostPerM === null || entry.outputCostPerM === null
      ? Number.POSITIVE_INFINITY
      : Number(entry.inputCostPerM) + Number(entry.outputCostPerM)
  const candidates = [...(models.added ?? [])].sort(
    (a, b) => priceOf(a) - priceOf(b) || a.key.localeCompare(b.key),
  )
  for (const entry of candidates) {
    if (!(await isModelKeyAvailable(orgId, entry.key, settings, undefined, db))) continue
    const info = addedModelInfo(entry, models)
    if (info) return { provider: info.provider, modelId: info.modelId }
  }
  return null
}

/** Can this org get a key for any native chat provider (Anthropic, OpenAI, Google, Mistral)? */
export async function hasUsableNativeKey(
  orgId: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<boolean> {
  for (const provider of CHAT_MODEL_PROVIDERS) {
    if (await isProviderUsable(orgId, provider, settings, db)) return true
  }
  return false
}

/** Does this org hold any key a model can run on (native, OpenRouter, or its own server)? */
export async function hasUsableModelKey(
  orgId: string,
  settings: OrgKernelSettings,
  /** A privileged transaction of this org the caller holds (see onPrivileged). */
  db?: PrivilegedDb,
): Promise<boolean> {
  return (await hasUsableNativeKey(orgId, settings, db)) || reachesAddedModels(orgId, settings, db)
}

/** Can this org reach any added model's provider (OpenRouter, or a server of its own)? */
async function reachesAddedModels(
  orgId: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<boolean> {
  if ((aiModelsOf(settings).servers ?? []).length > 0) return true
  return isProviderUsable(orgId, "openrouter", settings, db)
}

/** The providers with an auto-eligible model that this org can get a key for. */
async function usableAutoProviders(
  orgId: string,
  reason: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<string[]> {
  const providers = await onPrivileged(db, orgId, `${reason}:providers`, (tx) =>
    tx
      .selectDistinct({ provider: modelPricing.provider })
      .from(modelPricing)
      .where(eq(modelPricing.autoEligible, true)),
  )
  const usable: string[] = []
  for (const { provider } of providers) {
    if (!isChatModelProvider(provider)) continue
    if (await isProviderUsable(orgId, provider, settings, db)) usable.push(provider)
  }
  return usable
}

/**
 * Today's rule for a TURN, restricted to the models the org has switched on:
 * the cheapest enabled auto-eligible native model of a usable provider. An org
 * with no usable native provider (an OpenRouter key alone, or its own server)
 * runs on the cheapest enabled added model it can reach, as its side calls
 * do. Null when there is nothing the org can run: every candidate switched
 * off, or no usable key at all (`noAutoModelReason` says which). It never
 * returns a model of a provider the org has no key for.
 */
async function turnRuleModelForOrg(
  orgId: string,
  reason: string,
  settings: OrgKernelSettings,
  db?: PrivilegedDb,
): Promise<{ provider: string; modelId: string } | null> {
  const exclude = aiModelsOf(settings).disabled ?? []
  const usable = await usableAutoProviders(orgId, reason, settings, db)
  if (usable.length === 0) return addedSideCallModel(orgId, settings, db)
  return onPrivileged(db, orgId, reason, (tx) =>
    selectAutoModel(tx, { providers: usable, exclude }),
  )
}

/**
 * THE MODEL A TURN RUNS ON WHEN NOTHING IS PICKED (S5): the org's Auto setting
 * (`ai.models.autoModelKey`) when it names an available model, otherwise the
 * side-call rule restricted to the models the org has switched on. Applies to
 * conversation turns, sub-runs and routines only (A5); side calls ask
 * `selectSideCallModelForOrg`. Where a native model is usable, an added model
 * is Auto only when an admin chose it; with no usable native provider the
 * org's added models are the rule. Null when Auto has nothing to run (every
 * candidate switched off, or no usable key): `noAutoModelReason` says what to
 * do.
 */
export async function selectAutoModelForOrg(
  orgId: string,
  reason: string,
  preloaded?: OrgKernelSettings,
  /** A privileged transaction of this org the caller holds (see onPrivileged). */
  db?: PrivilegedDb,
): Promise<{ provider: string; modelId: string } | null> {
  const settings =
    preloaded ??
    (await onPrivileged(db, orgId, `${reason}:settings`, (tx) =>
      getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    ))
  if (await isVisitorDemoOrg(orgId, db)) return visitorSelection(orgId, settings, db)
  const autoKey = aiModelsOf(settings).autoModelKey
  if (autoKey && (await isModelKeyAvailable(orgId, autoKey, settings, undefined, db))) {
    const info = await lookupModelInfo(orgId, autoKey, settings, db)
    if (info) return { provider: info.provider, modelId: info.modelId }
  }
  return turnRuleModelForOrg(orgId, reason, settings, db)
}

/** The error of a call whose org has no model key it can use. */
export const NO_USABLE_MODEL_KEY =
  "Auto has no model to run: this workspace has no usable model key. Add a model key in Settings > AI models (one OpenRouter key is enough)."

/**
 * The error of a call whose org holds a usable key, but none of whose models
 * Auto can run: its native providers have no auto-eligible model, or it has
 * no enabled added model on OpenRouter or its own server.
 */
export const NO_AUTO_MODEL_FOR_KEYS =
  "Auto has no model to run: none of the models your keys reach is available to Auto. Add or switch on a model, then choose it for Auto, in Settings > AI models."

/**
 * The plain error of a turn whose Auto has nothing to run. With no usable key
 * at all it says to add one (never the name of a provider the org never had);
 * with keys whose models Auto cannot run, it says so; otherwise it names the
 * model Auto would run once switched on (the cheapest switched-off candidate).
 */
async function noAutoModelReason(orgId: string, settings: OrgKernelSettings): Promise<string> {
  if (!(await hasUsableModelKey(orgId, settings))) return NO_USABLE_MODEL_KEY
  const usable = await usableAutoProviders(orgId, "no-auto-model", settings)
  if (usable.length === 0) return NO_AUTO_MODEL_FOR_KEYS
  // Only a usable provider's model is named: never one the org has no key for.
  const name = await withPrivilegedDb(orgId, "no-auto-model", async (tx) => {
    const pick = usable.length > 0 ? await selectAutoModel(tx, { providers: usable }) : null
    if (!pick) return null
    const [row] = await tx
      .select({ displayName: modelPricing.displayName })
      .from(modelPricing)
      .where(eq(modelPricing.modelId, pick.modelId))
      .limit(1)
    return row?.displayName ?? pick.modelId
  })
  const what = name ? `Switch on ${name}` : "Switch on a model"
  return `Auto has no model to run: the models it can use are switched off. ${what}, or choose a model for Auto, in Settings, AI models.`
}

export interface AvailableModel {
  /** The model key. */
  key: string
  /** Same as `key`; kept for one release for clients that read the old shape. */
  modelId: string
  provider: string
  /** The picker's group: the provider's name, or the custom server's. */
  providerLabel: string
  displayName: string
  tierMinimum: string
  autoEligible: boolean
  contextWindow: number
  /** EUR per million tokens; null when unknown. */
  inputCostPerM: string | null
  outputCostPerM: string | null
  reasoning: { allowedLevels: ReasoningLevel[]; defaultLevel: ReasoningLevel }
  /** Whether the model calls tools. */
  tools: boolean
}

/**
 * Models this org can actually use: rows in the global `model_pricing` catalog
 * whose provider has a usable key (BYOK org key, or a Liaison-managed env key).
 * The model picker calls this so it only shows models the org has a key for —
 * picking a model whose provider has no key would otherwise fail at send time.
 */
export async function listAvailableModels(orgId: string): Promise<AvailableModel[]> {
  const { settings, allRows } = await withPrivilegedDb(
    orgId,
    "list-available-models",
    async (tx) => {
      const settings = await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema)
      const allRows = await tx
        .select({
          modelId: modelPricing.modelId,
          provider: modelPricing.provider,
          displayName: modelPricing.displayName,
          tierMinimum: modelPricing.tierMinimum,
          autoEligible: modelPricing.autoEligible,
          contextWindow: modelPricing.contextWindow,
          inputCostPerM: modelPricing.inputCostPerM,
          outputCostPerM: modelPricing.outputCostPerM,
        })
        .from(modelPricing)
      return { settings, allRows }
    },
  )
  const models = aiModelsOf(settings)
  const disabled = new Set(models.disabled ?? [])
  // A catalogue row in an added-model namespace is never a native model (A17).
  // Only chat models: the catalogue also prices non-model work (web search).
  const rows = allRows.filter(
    (r) =>
      isNativeModelId(r.modelId) && isChatModelProvider(r.provider) && !disabled.has(r.modelId),
  )
  // One resolution per PROVIDER, not per row: `isProviderUsable` is async now
  // (a demo org's licence to reach the box's key is a marker read), and the
  // catalog carries many models per provider.
  const configured = new Map<string, boolean>()
  for (const provider of new Set(rows.map((r) => r.provider))) {
    configured.set(provider, await isProviderUsable(orgId, provider, settings))
  }
  // A workspace pinned to one model (the reserved demo org) can run that one
  // and no other: offering the rest would let a person pick a model that is
  // then silently answered by the pin (walk N4).
  const pinned = await reservedDemoModelId(orgId)
  const native: AvailableModel[] = rows
    .filter((r) => configured.get(r.provider) === true && (!pinned || r.modelId === pinned))
    .map((r) => {
      const cap = getReasoningCapability(r.modelId, r.provider)
      return {
        key: r.modelId,
        modelId: r.modelId,
        provider: r.provider,
        providerLabel: providerLabelOf(r.provider),
        displayName: r.displayName,
        tierMinimum: r.tierMinimum,
        autoEligible: r.autoEligible,
        contextWindow: r.contextWindow,
        inputCostPerM: r.inputCostPerM,
        outputCostPerM: r.outputCostPerM,
        reasoning: { allowedLevels: cap.allowedLevels, defaultLevel: cap.defaultLevel },
        tools: true,
      }
    })
  if (pinned) return native
  if (
    (await isVisitorDemoOrg(orgId)) &&
    (await isModelKeyAvailable(orgId, demoVisitorModelKey(), settings))
  ) {
    // "Auto" is the pin (box key once verified, or the visitor's own
    // OpenRouter key), listed beside the models of the visitor's own keys,
    // and only once it can run: nothing is offered that would be refused.
    const pin = demoVisitorModelInfo(!isProviderConfigured("openrouter", settings))
    const autoLevel = pin.autoReasoningLevel ?? AUTO_REASONING_LEVEL
    native.unshift({
      key: pin.modelId,
      modelId: pin.modelId,
      provider: "openrouter",
      providerLabel: providerLabelOf("openrouter"),
      displayName: "Auto (demo)",
      tierMinimum: "starter",
      autoEligible: true,
      contextWindow: pin.contextWindow,
      inputCostPerM: pin.inputCostPerM,
      outputCostPerM: pin.outputCostPerM,
      // Auto runs at its own level (resolveTurnReasoningLevel), whatever is asked.
      reasoning: { allowedLevels: [autoLevel], defaultLevel: autoLevel },
      tools: true,
    })
  }
  const added: AvailableModel[] = []
  for (const entry of models.added ?? []) {
    if (!(await isModelKeyAvailable(orgId, entry.key, settings))) continue
    const server = (models.servers ?? []).find((sv) => sv.id === entry.serverId)
    const cap = getReasoningCapability(entry.key, entry.provider, entry)
    added.push({
      key: entry.key,
      modelId: entry.key,
      provider: entry.provider,
      providerLabel: providerLabelOf(entry.provider, server?.name),
      displayName: entry.displayName,
      tierMinimum: "starter",
      autoEligible: false,
      contextWindow: entry.contextWindow,
      inputCostPerM: entry.inputCostPerM,
      outputCostPerM: entry.outputCostPerM,
      reasoning: { allowedLevels: cap.allowedLevels, defaultLevel: cap.defaultLevel },
      tools: entry.tools,
    })
  }
  return [...native, ...added]
}

/** What Auto runs for this org right now: the pin, else the Auto setting or rule. */
export async function resolveAutoModelKey(orgId: string): Promise<string | null> {
  const pinned = await reservedDemoModelId(orgId)
  if (pinned) return pinned
  return (await selectAutoModelForOrg(orgId, "auto-resolved-key"))?.modelId ?? null
}

/**
 * The reasoning level Auto runs at for this org right now: the demo's level
 * when Auto is a visitor's pin on the box key, else the org's default level,
 * else `AUTO_REASONING_LEVEL`.
 * The model menu shows it (GET /credits/models), from the same `ModelInfo`
 * the turn runs on, so the two cannot disagree.
 */
export async function resolveAutoReasoningLevel(orgId: string): Promise<ReasoningLevel> {
  const settings = await withPrivilegedDb(orgId, "auto-reasoning-level", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const orgDefault = settings.ai?.models?.defaultReasoningLevel ?? null
  if ((await demoOrgKind(orgId)) !== "visitor") return orgDefault ?? AUTO_REASONING_LEVEL
  const info = await visitorModelFor(orgId, null, settings)
  return info.autoReasoningLevel ?? orgDefault ?? AUTO_REASONING_LEVEL
}

export interface PreCheckOptions {
  /**
   * A conversation turn, a sub-run or a routine tick (A5, A6): nothing picked
   * means the org's Auto setting, and a stored model that is no longer
   * available (switched off, key removed, entry deleted) runs on Auto instead
   * of failing the turn. Side calls and fixed internal ids leave this off.
   */
  turn?: boolean
}

/**
 * Carry the organization's default reasoning level onto the model a turn runs
 * (`settings.ai.models.defaultReasoningLevel`), so `resolveTurnReasoningLevel`
 * applies it to a turn that asks for no level.
 */
function withOrgReasoningDefault(model: ModelInfo, settings: OrgKernelSettings): ModelInfo {
  const level = settings.ai?.models?.defaultReasoningLevel
  return level ? { ...model, orgDefaultReasoningLevel: level } : model
}

export async function resolveModelForPreCheck(
  orgId: string,
  requestedModelId?: string | null,
  opts: PreCheckOptions = {},
): Promise<{ model: ModelInfo } | PreCheckFailure> {
  // A VISITOR demo org: a model on its own key, else the pin (from env, never
  // from its settings). "none" without a query on a normal deployment.
  if ((await demoOrgKind(orgId)) === "visitor") {
    const visitorSettings = await withPrivilegedDb(orgId, "pre-check-settings", (tx) =>
      getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    )
    return {
      model: withOrgReasoningDefault(
        await visitorModelFor(orgId, requestedModelId, visitorSettings),
        visitorSettings,
      ),
    }
  }
  // The reserved App Review org runs every paid model call on ONE model, the
  // one its token ceiling is priced for, whatever the thread, the agent's
  // `modelPreference` or a routine asked for. Every turn and every side call
  // resolves its model here, so this is the one place the pin can be applied
  // and not routed around. Null without a query on every normal deployment.
  const reservedModelId = await reservedDemoModelId(orgId)
  let settings = await withPrivilegedDb(orgId, "pre-check-settings", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  let modelId = reservedModelId ?? requestedModelId
  if (modelId && !reservedModelId && opts.turn) {
    if (!(await isModelKeyAvailable(orgId, modelId, settings))) {
      // Warn, not debug: a routine or thread pinned to a model an admin switched
      // off silently changes model, and only this line says so.
      log.warn(
        { orgId, requestedModelId: modelId },
        "stored model is not available to this org; the turn runs on Auto",
      )
      modelId = null
    }
  }
  if (modelId) {
    const row = reservedModelId
      ? await lookupModelInfo(orgId, reservedModelId, settings)
      : await lookupModelInfo(orgId, modelId, settings)
    if (!row) {
      return {
        allowed: false,
        status: 400,
        persistSystemMessage: false,
        reason: "Model not available",
      }
    }
    if (reservedModelId) {
      // The same org's STEP: its output is capped at what its ceiling is
      // priced on (demo-spend-ceiling.ts), enforced by the agent loop on each
      // request (providers/step-token-cap.ts). Its input is bounded by the
      // model's own context window.
      return {
        model: withOrgReasoningDefault(
          {
            ...row,
            ...(requestedModelId ? {} : { autoPicked: true }),
            stepTokenCap: { maxOutputTokens: RESERVED_STEP_OUTPUT_TOKENS },
          },
          settings,
        ),
      }
    }
    return { model: withOrgReasoningDefault(row, settings) }
  }

  // Auto mode
  let auto = opts.turn
    ? await selectAutoModelForOrg(orgId, "pre-check-auto", settings)
    : await selectSideCallModelForOrg(orgId, "pre-check-auto")
  if (!auto && opts.turn && !aiModelsOf(settings).autoModelKey) {
    // A managed org whose creation could not add the server's default models
    // (OpenRouter's catalogue was unreachable then): add them now. Imported
    // lazily, like the OpenRouter default below.
    const { ensureManagedDefaultModelsOnDemand } = await import("~/modules/cloud/default-models")
    if (await ensureManagedDefaultModelsOnDemand(orgId)) {
      settings = await withPrivilegedDb(orgId, "pre-check-settings", (tx) =>
        getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
      )
      auto = await selectAutoModelForOrg(orgId, "pre-check-auto", settings)
    }
  }
  if (!auto && opts.turn) {
    // A workspace whose only key is OpenRouter's, keyed before its key's save
    // made OpenRouter's default model Auto: do that now (openrouter-default.ts),
    // then resolve again. Imported lazily: that module imports this one.
    const { ensureOpenRouterAutoModel } = await import("~/modules/agent/credits/openrouter-default")
    if ((await ensureOpenRouterAutoModel(orgId)).status === "set") {
      settings = await withPrivilegedDb(orgId, "pre-check-settings", (tx) =>
        getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
      )
      auto = await selectAutoModelForOrg(orgId, "pre-check-auto", settings)
    }
  }
  if (!auto && opts.turn) {
    // The org switched off every model Auto could run: a plain error the
    // admin can act on, in the conversation, rather than a 500.
    return {
      allowed: false,
      status: 400,
      persistSystemMessage: true,
      reason: await noAutoModelReason(orgId, settings),
    }
  }
  if (!auto) {
    return {
      allowed: false,
      status: 500,
      persistSystemMessage: false,
      reason: await noAutoModelReason(orgId, settings),
    }
  }
  const row = await lookupModelInfo(orgId, auto.modelId, settings)
  if (!row) {
    return {
      allowed: false,
      status: 500,
      persistSystemMessage: false,
      reason: "Auto model pricing not found",
    }
  }
  return { model: withOrgReasoningDefault({ ...row, autoPicked: true }, settings) }
}

/** A refusal of the visitor gate, in `preCheck`'s own vocabulary. */
function demoRefusal(err: DemoSpendRefusedError): PreCheckFailure {
  return {
    allowed: false,
    status: err.httpStatus,
    persistSystemMessage: true,
    reason: err.message,
    code: err.code,
  }
}

/**
 * The visitor gate of one call on the box key: a turn slot (turns only),
 * then the step's reservation, then the key against it. Reservation BEFORE the
 * key: `resolveKey` refuses a visitor without a live one.
 */
async function visitorBoxKeyPreCheck(
  orgId: string,
  model: ModelInfo,
  opts: PreCheckOptions,
): Promise<PreCheckResult> {
  let slot: DemoTurnSlot | null = null
  let reservation: DemoReservation | null = null
  try {
    const identity = await visitorSpendIdentity(orgId)
    if (opts.turn) slot = await acquireVisitorTurnSlot(orgId, identity)
    reservation = await reserveVisitorStep(orgId, model.upstreamId, visitorStepBase(), identity)
    const key = await resolveKey(orgId, model, { reservation })
    const meter = new DemoStepMeter(orgId, identity, model, reservation, slot)
    // Every request of the call reports itself to the meter as it leaves.
    const cap = model.stepTokenCap
    const metered: ModelInfo = cap
      ? {
          ...model,
          stepTokenCap: {
            ...cap,
            onRequest: (estimatedInputTokens) => meter.requestLeaving(estimatedInputTokens),
            onCallEnd: (usage, providerMetadata) => meter.modelCallEnded(usage, providerMetadata),
          },
        }
      : model
    return {
      allowed: true,
      keySource: key.source,
      model: metered,
      providerKey: key.key,
      demo: meter,
      orgId,
    }
  } catch (err) {
    if (reservation) await releaseReservation(reservation)
    if (slot) await releaseTurnSlot(slot)
    if (err instanceof DemoSpendRefusedError) return demoRefusal(err)
    return {
      allowed: false,
      status: 500,
      persistSystemMessage: false,
      reason: (err as Error).message,
    }
  }
}

/**
 * An UNMETERED side call's model and key (a self-hosted title or extraction:
 * no credits, so no spend gate that could refuse it). The model is resolved
 * exactly as a turn's and a metered side call's are (`resolveModelForPreCheck`
 * then `lookupModelInfo`), so it carries the id the provider expects
 * (`upstreamId`: `deepseek/...` for the added model `openrouter/deepseek/...`)
 * and a custom server's address and key. Building the call from the bare Auto
 * selection ({ provider, modelId }) sent the org's model key upstream instead,
 * which OpenRouter refuses. Throws with the reason when there is no model or
 * no key.
 */
export async function resolveUnmeteredSideCall(
  orgId: string,
  modelId: string,
): Promise<{ model: ModelInfo; providerKey: string; orgId: string }> {
  const resolved = await resolveModelForPreCheck(orgId, modelId)
  if ("allowed" in resolved) throw new Error(resolved.reason)
  const { key } = await resolveKey(orgId, resolved.model)
  return { model: resolved.model, providerKey: key, orgId }
}

/** The refusal of a paid call while the org's renewal is unpaid. */
function paymentRequiredRefusal(err: PaymentRequiredError): PreCheckFailure {
  return {
    allowed: false,
    status: 402,
    persistSystemMessage: true,
    reason: err.message,
    billingCode: PAYMENT_REQUIRED_CODE,
  }
}

export async function preCheck(
  orgId: string,
  modelId?: string | null,
  opts: PreCheckOptions = {},
): Promise<PreCheckResult> {
  // 1. Resolve model
  const modelResult = await resolveModelForPreCheck(orgId, modelId, opts)
  if ("allowed" in modelResult) return modelResult
  const { model } = modelResult
  // A load org reaches no provider: no key, no spend, the load model.
  if (await isLoadOrg(orgId)) {
    return { allowed: true, keySource: "liaison", model, providerKey: "", loadOrgId: orgId }
  }

  // 1b. A visitor demo org on the box key (the pin, no BYOK for it): the
  //     reservation gate. Its own key runs unpinned through the path below.
  if (model.stepTokenCap?.visitor) return visitorBoxKeyPreCheck(orgId, model, opts)

  // 2. Resolve key — missing key is a provider misconfiguration (500), EXCEPT
  //    on a demo box, where "there is no key" is the expected state of a
  //    workspace whose owner has not pasted theirs yet. That is a 400 the
  //    visitor can act on, persisted into the conversation so the answer is
  //    where they are looking, rather than a 500 that reads as our outage.
  let keyResult: { key: string; source: "byok" | "liaison" }
  try {
    keyResult = await resolveKey(orgId, model)
  } catch (err) {
    if (err instanceof DemoSpendRefusedError) return demoRefusal(err)
    if (err instanceof PaymentRequiredError) return paymentRequiredRefusal(err)
    if (err instanceof DemoKeyRequiredError) {
      return {
        allowed: false,
        status: 400,
        persistSystemMessage: true,
        reason: err.message,
      }
    }
    return {
      allowed: false,
      status: 500,
      persistSystemMessage: false,
      reason: (err as Error).message,
    }
  }

  // 2b. A model with no fixed price never runs on the platform key: its usage
  //     would be metered at 0. The org's own key (BYOK) is unaffected, and so
  //     is a custom server (it is never unpriced).
  if (model.unpriced && keyResult.source === "liaison") {
    return {
      allowed: false,
      status: 400,
      persistSystemMessage: true,
      reason:
        "This model has no fixed price, so it runs only on your organization's own OpenRouter key. Add one in Settings, AI models, or pick another model.",
    }
  }

  // 3-6. The spend gate: demo ceiling, then (managed edition, platform key)
  //      the breaker, tier and balance.
  const block = await spendGate(orgId, keyResult.source, model.modelId)
  if (block) return block

  return { allowed: true, keySource: keyResult.source, model, providerKey: keyResult.key, orgId }
}

/**
 * THE SPEND GATE of a paid call, once its key is resolved: the demo ceiling,
 * then, only for the platform key on a managed edition, the deduction-failure
 * breaker, the tier rule and the balance. Null admits the call. `preCheck` runs
 * it for every model call; a paid call that is not a chat model (a
 * transcription) runs it directly, so the same gate applies in the same order.
 * When the demo ceiling admits the call it has taken a reservation, which
 * `finalizeUsage` (or `releaseDemoTurnReservation`) gives back.
 */
export async function spendGate(
  orgId: string,
  keySource: "byok" | "liaison",
  modelId: string,
): Promise<PreCheckFailure | null> {
  // 3. The DEMO ceiling, BEFORE the billing path is chosen — because which
  //    path a turn takes is exactly what a demo org must not be able to change.
  //    Sitting inside the "no credits to deduct" branch below, this was reached
  //    only for a BYOK key or a self-hosted instance; a managed edition using
  //    the platform key skipped it entirely, which is the one shape where the
  //    tokens cost real money. `checkDemoSpendCeiling` returns null (no query,
  //    no branch, no Redis round trip) unless LIAISON_DEMO_MODE is on AND this
  //    org is the reserved App Review org, the only demo org that spends the
  //    deployment's own key, so nothing about a real customer's turn
  //    changes here. When it admits the turn it has also taken a reservation,
  //    which `finalizeUsage` gives back.
  const demoBlock = await checkDemoSpendCeiling(orgId)
  if (demoBlock) return demoBlock

  // 3b. No billing gate for BYOK, or for ANY usage on a self-hosted instance —
  //    there are no credits outside a control plane. Usage is still recorded
  //    for monitoring by finalizeUsage; it is simply never deducted or gated.
  //
  //    The reserved demo org joins them, and it has to. Its budget rule is the
  //    TOKEN CEILING checked immediately above, and every demo org's credit
  //    balance is forced to zero on purpose, so on a managed edition this org
  //    fell through to step 6 and every reviewer's first turn came back 402
  //    "Out of agent usage" with the ceiling untouched. The org's usability must
  //    not rest on the box happening to be self hosted.
  //    `isReservedDemoOrg` returns false without a query on every normal
  //    deployment and for every org that is not the one reserved marker.
  // A demo VISITOR org likewise: its budget rule is the reservation its call
  // already holds (demo-budget.ts), and its balance is zero by design.
  if (
    keySource === "byok" ||
    !isManagedEdition() ||
    (await isReservedDemoOrg(orgId)) ||
    (await isVisitorDemoOrg(orgId))
  ) {
    return null
  }

  // 3b'. An unpaid renewal: no platform-key spend until the open invoice
  //      is paid. `resolveKey` refuses first on most paths; this keeps a caller
  //      that resolved its key earlier (a dictation's second model) from spending.
  if (await paymentRequired(orgId)) return paymentRequiredRefusal(new PaymentRequiredError())

  // 3c. Circuit breaker: if credit deduction has been failing persistently for
  //     this org, hard-block further turns rather than serve them free (silent
  //     revenue bypass). This is the natural enforcement point — the gate runs
  //     before any provider tokens are spent.
  if (await deductionBreakerTripped(orgId)) {
    log.error(
      { orgId, alert: "credit_deduction_breaker_open", threshold: DEDUCT_FAIL_THRESHOLD },
      "Agent turn blocked — credit deduction has failed repeatedly for this org",
    )
    return {
      allowed: false,
      status: 402,
      persistSystemMessage: true,
      reason:
        "Agent usage is temporarily unavailable due to a billing system issue. Please try again shortly or contact support.",
    }
  }

  // 3d. No pushed rate, no metered usage: refused, never billed at a
  //     guessed factor. `cellCreditPricing` logs the alert line.
  if (!(await cellCreditPricing("spend-gate"))) {
    return {
      allowed: false,
      status: 503,
      persistSystemMessage: true,
      reason: CREDIT_PRICING_MISSING_MESSAGE,
      billingCode: CREDIT_PRICING_MISSING,
    }
  }

  // 4. Check balance
  const balance = await withPrivilegedDb(orgId, "pre-check-balance", (tx) =>
    checkBalance(tx, orgId),
  )

  // 5. Tier-based model access: purchased_balance > 0 unlocks all models;
  //    otherwise org.tier must be at or above model.tierMinimum
  if (Number(balance.purchased) <= 0) {
    const accessInfo = await withPrivilegedDb(orgId, "pre-check-tier-access", async (tx) => {
      const [orgRow] = await tx
        .select({ tier: organizations.tier })
        .from(organizations)
        .where(eq(organizations.id, orgId))
      const [modelRow] = await tx
        .select({ tierMinimum: modelPricing.tierMinimum })
        .from(modelPricing)
        .where(eq(modelPricing.modelId, modelId))
      return {
        orgTier: orgRow?.tier ?? "starter",
        tierMinimum: modelRow?.tierMinimum ?? "starter",
      }
    })

    if (!tierAtLeast(accessInfo.orgTier, accessInfo.tierMinimum)) {
      return {
        allowed: false,
        status: 400,
        persistSystemMessage: false,
        reason: `This model requires ${accessInfo.tierMinimum} tier or higher. Upgrade your plan or add purchased usage.`,
      }
    }
  }

  // 6. Check total balance — zero balance is a billing failure (402), system message explains it to the user
  const total = Number(balance.included) + Number(balance.purchased)
  if (total <= 0) {
    return {
      allowed: false,
      status: 402,
      persistSystemMessage: true,
      reason: "Out of agent usage",
      billingCode: OUT_OF_CREDITS_CODE,
    }
  }

  return null
}

export async function checkMidStep(
  orgId: string,
  keySource: "liaison" | "byok",
): Promise<{ exhausted: boolean }> {
  // A demo org is re-checked between steps whatever the key source. The
  // pre-turn ceiling admits a turn on the numbers it can see at the start; a
  // long agentic turn outlives those numbers, and a concurrent turn finishing
  // beside it can push the org past the ceiling while this one is still
  // running. `demoSpendExhausted` is the same `used + reserved` comparison,
  // asked again, and returns false without a query on a normal deployment.
  if (await demoSpendExhausted(orgId)) return { exhausted: true }

  // BYOK keys and self-hosted instances have no balance to exhaust, and neither
  // does the reserved demo org: it is governed by the ceiling asked above and
  // its balance is zero by design.
  if (
    keySource === "byok" ||
    !isManagedEdition() ||
    (await isReservedDemoOrg(orgId)) ||
    (await isVisitorDemoOrg(orgId))
  )
    return { exhausted: false }

  const balance = await withPrivilegedDb(orgId, "mid-step-check", (tx) => checkBalance(tx, orgId))
  const total = Number(balance.included) + Number(balance.purchased)
  return { exhausted: total <= 0 }
}

/** What a visitor step cost, µEUR: OpenRouter's reported cost, else its tokens at worst prices. */
export function visitorCostMicroEur(u: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  providerCostUsd?: number | null
}): number {
  if (typeof u.providerCostUsd === "number" && Number.isFinite(u.providerCostUsd)) {
    return microEurOfUsd(u.providerCostUsd)
  }
  const cached = Math.min(Math.max(0, u.cachedInputTokens ?? 0), Math.max(0, u.inputTokens))
  return (
    microEurOfTokens(u.inputTokens - cached, VISITOR_INPUT_MICRO_EUR_PER_M) +
    microEurOfTokens(cached, VISITOR_CACHED_INPUT_MICRO_EUR_PER_M) +
    microEurOfTokens(u.outputTokens, VISITOR_OUTPUT_MICRO_EUR_PER_M)
  )
}

/** Settle a step's holds at `cost`: each up to its max, in order; the last takes the rest. */
async function settleHolds(holds: DemoReservation[], cost: number): Promise<void> {
  let rest = Math.max(0, cost)
  for (const [i, hold] of holds.entries()) {
    const part = i === holds.length - 1 ? rest : Math.min(rest, hold.maxMicroEur)
    rest -= part
    await settleStep(hold, part)
  }
}

/**
 * ONE VISITOR CALL'S RESERVATIONS, step by step. `preCheck` opens it with the
 * first step's reservation; each finished step is settled at its actual cost
 * and the next one reserved before it may run (a refusal ends the turn);
 * `finish` closes the open step and gives the turn slot back. A call has at
 * most `maxSteps` steps (LIAISON_DEMO_STEPS_PER_TURN, or the routine limit
 * once the call is known to be a routine run: `visitorStepsPerTurn`).
 *
 * A STEP IS HELD IN TWO PARTS (demo-spend-ceiling.ts, ONE STEP): its capped
 * output before it runs, and its input as its request leaves, at the
 * request's own estimate (`requestLeaving`, told by the step token cap,
 * step-token-cap.ts). A request whose input the budget cannot hold is refused
 * before it leaves.
 *
 * SENT IS BILLED. The step token cap tells the meter each time a request
 * leaves. A step whose request left and whose
 * usage never came back (a dropped connection aborting the stream, a stream
 * error, a thrown `generateText`) is settled at its RESERVED MAX: the
 * provider processed the prompt and may have run the completion to the end.
 * Only a step whose request never left is released.
 */
export class DemoStepMeter {
  private liveReservation: DemoReservation | null
  /** The open step's input holds, taken as its requests left. */
  private inputHolds: DemoReservation[] = []
  /** The open step's request has left. */
  private currentSent = false
  /** A request left while no step was open: the next one counts as sent. */
  private sentUnreserved = false
  /** Any request of this call left (false on a path that never reports one). */
  private everSent = false
  /** Steps settled through `stepFinished`. */
  private reported = 0
  private steps = 1
  private settled = 0
  private finished = false
  /** Why the meter refused the next step, when it did. */
  refusal: DemoSpendCode | null = null
  /** The most steps this call may take (a routine run raises it: `visitorStepsPerTurn`). */
  maxSteps: number = env.LIAISON_DEMO_STEPS_PER_TURN

  constructor(
    readonly orgId: string,
    readonly identity: DemoSpendIdentity,
    readonly model: ModelInfo,
    reservation: DemoReservation,
    private readonly slot: DemoTurnSlot | null,
  ) {
    this.liveReservation = reservation
  }

  /** The live reservation of the step about to run, if any. */
  get reservation(): DemoReservation | null {
    return this.liveReservation
  }

  /** Steps reserved so far (the first included). */
  get stepCount(): number {
    return this.steps
  }

  /**
   * A request of this call is about to leave with `estimatedInputTokens` of
   * input: hold what its input may cost beyond what the open step already
   * holds for it, then mark it sent. Throws the budget's refusal (nothing is
   * sent).
   */
  async requestLeaving(estimatedInputTokens: number): Promise<void> {
    if (this.liveReservation) {
      const need = visitorRequestInputMicroEur(estimatedInputTokens)
      const held = this.inputHolds.reduce((sum, h) => sum + h.maxMicroEur, 0)
      if (need > held) {
        try {
          this.inputHolds.push(
            await reserveVisitorStep(this.orgId, this.model.upstreamId, need - held, this.identity),
          )
        } catch (err) {
          this.refusal = err instanceof DemoSpendRefusedError ? err.code : "demo_unavailable"
          throw err
        }
      }
    }
    this.markSent()
  }

  /** A request of this call is being handed to the provider. */
  markSent(): void {
    this.everSent = true
    if (this.liveReservation) this.currentSent = true
    else this.sentUnreserved = true
  }

  /** Settle the open step at what its model call reported, and close it. */
  private async settleOpenStep(usage: unknown, providerMetadata: unknown): Promise<void> {
    const open = this.liveReservation
    if (!open) return
    // Closed first: a second report of the same step (the call's end, then
    // its step's end) finds nothing open and settles nothing twice.
    const holds = [open, ...this.inputHolds]
    this.liveReservation = null
    this.inputHolds = []
    this.currentSent = false
    const u = readStepUsage(usage)
    const cost = visitorCostMicroEur({
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cachedInputTokens: u.cacheReadTokens,
      providerCostUsd: readProviderCostUsd(providerMetadata) ?? null,
    })
    this.settled += cost
    this.reported += 1
    await settleHolds(holds, cost)
  }

  /**
   * The step's model call has answered in full (the agent loop's
   * `onLanguageModelCallEnd`, step-token-cap.ts `onCallEnd`): settle it now,
   * BEFORE the SDK runs the tools it asked for. Between here and the next
   * step's reservation (`stepFinished`, after the tools) this call holds
   * nothing, so a tool that waits on another agent's turn (`agents_ask`, up to
   * its wait bound) does not hold a step's worst cost beside the turn it waits
   * on, which only one of the two can be spending at a time. Never throws.
   */
  async modelCallEnded(usage: unknown, providerMetadata?: unknown): Promise<void> {
    await this.settleOpenStep(usage, providerMetadata)
  }

  /**
   * A step finished: settle it (unless its model call's end already did),
   * then reserve the next (unless `reserveNext` is false: the call is
   * ending). `exhausted` means the next step must not run (cap of steps, a
   * budget, or spend switched off).
   */
  async stepFinished(
    usage: unknown,
    providerMetadata?: unknown,
    opts: { reserveNext?: boolean } = {},
  ): Promise<{ exhausted: boolean }> {
    await this.settleOpenStep(usage, providerMetadata)
    if (opts.reserveNext === false) return { exhausted: true }
    if (this.steps >= this.maxSteps) {
      this.refusal = "demo_step_limit"
      return { exhausted: true }
    }
    try {
      this.liveReservation = await reserveVisitorStep(
        this.orgId,
        this.model.upstreamId,
        visitorStepBase(),
        this.identity,
      )
      this.currentSent = this.sentUnreserved
      this.sentUnreserved = false
      this.steps += 1
      return { exhausted: false }
    } catch (err) {
      this.refusal = err instanceof DemoSpendRefusedError ? err.code : "demo_unavailable"
      return { exhausted: true }
    }
  }

  /**
   * The call is over: close the open step and give the turn slot back.
   * `totalMicroEur` is the whole call's cost as its caller read it, when it
   * read one. The open step is settled at:
   *  - its share of that total, when it is the call's only step and the total
   *    covers it (a side call, or a turn whose one step finished);
   *  - its reserved max, when its request left and nothing reported it;
   *  - nothing (released), when its request never left.
   * Idempotent; never throws.
   */
  async finish(totalMicroEur?: number): Promise<void> {
    if (this.finished) return
    this.finished = true
    const open = this.liveReservation
    const holds = open ? [open, ...this.inputHolds] : []
    this.liveReservation = null
    this.inputHolds = []
    try {
      if (open) {
        const rest = totalMicroEur === undefined ? 0 : Math.max(0, totalMicroEur - this.settled)
        if (this.currentSent) {
          const covered = this.reported === 0 && rest > 0
          if (covered) await settleHolds(holds, rest)
          else for (const h of holds) await settleStep(h, h.maxMicroEur)
        } else if (!this.everSent && rest > 0) {
          // A path whose requests the meter is not told about: its total is all it has.
          await settleHolds(holds, rest)
        } else {
          for (const h of holds) await releaseReservation(h)
        }
      }
    } finally {
      if (this.slot) await releaseTurnSlot(this.slot)
    }
  }
}

/**
 * METER A SIDE CALL: a model call made for an org outside the agent loop (a
 * checkpoint brief, a memory flush, fact extraction, an episode summary, an
 * auto-title, a web extraction) that took a `preCheck`. The one place such a
 * call's usage reaches `finalizeUsage`; `model-call-metering.guard.test.ts` refuses a
 * file that calls a model without reaching a metering entry point.
 *
 * - Managed edition: every org's call is metered like a turn. On the cell's key
 *   that is a billed `usage` row (the org's allowance, and the daily usage
 *   report), attributed to the acting user or, with none, a real org user. These
 *   calls spend on the cell's key, so an unbilled one would leave the org's
 *   usage below what the provider bills the key.
 * - The reserved demo org: finalized too (an unbilled row its ceiling sums,
 *   and the reservation `preCheck` took released), or, when the call produced
 *   nothing, the reservation is simply released.
 * - A demo VISITOR org: finalized on either key (an unbilled usage row; on the
 *   box key its reservation settled at OpenRouter's reported cost).
 * - Any other org on a self-hosted instance: nothing to meter (no credits),
 *   and no query.
 */
export async function meterSideCall(
  orgId: string,
  credit: {
    model: FinalizeParams["model"]
    keySource: "liaison" | "byok"
    demo?: DemoStepMeter
  },
  usage: unknown,
  providerMetadata?: unknown,
  opts: {
    /** The acting user, when there is one. */
    userId?: string | null
    /** The call's reported USD cost summed over its steps (wins over `providerMetadata`). */
    providerCostUsd?: number
  } = {},
): Promise<void> {
  // A demo VISITOR's side call is metered like a turn, on either key: its reservation (box
  // key) is settled at what OpenRouter reported, and the org's usage gets its row. Settling
  // only the reservation left the org's usage short of the key's bill by every checkpoint
  // brief and brief extraction (live demo, 2026-10-24).
  const visitor = credit.demo !== undefined || (await isVisitorDemoOrg(orgId))
  if (visitor && !usage) {
    // Nothing came back: a sent request is billed at its reserved max, an unsent one released.
    await credit.demo?.finish()
    return
  }
  const managed = isManagedEdition()
  if (!visitor && !managed && !(await isReservedDemoOrg(orgId))) return
  if (!usage) {
    await releaseDemoTurnReservation(orgId)
    return
  }
  try {
    const u = readStepUsage(usage)
    const cost = opts.providerCostUsd ?? readProviderCostUsd(providerMetadata)
    const userId =
      opts.userId && UUID_RE.test(opts.userId)
        ? opts.userId
        : managed
          ? await (await import("~/modules/agent/credits/managed-side-call")).systemWorkUserId(
              orgId,
            )
          : null
    await finalizeUsage(orgId, {
      model: credit.model,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cachedInputTokens: u.cacheReadTokens,
      ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
      ...(u.cacheWrite5mTokens !== undefined ? { cacheWrite5mTokens: u.cacheWrite5mTokens } : {}),
      ...(cost !== undefined ? { providerCostUsd: cost } : {}),
      keySource: credit.keySource,
      userId: userId ?? "system",
      ...(credit.demo ? { demo: credit.demo } : {}),
    })
  } catch (err) {
    // Loud, and counted like a failed deduction: a lasting fault here leaves
    // every side call of the org free and unreported, so it trips the same
    // breaker (preCheck then refuses) instead of passing as a warning.
    const failures = await recordDeductionFailure(orgId)
    log.error(
      { err, orgId, model: credit.model.modelId, failures, alert: "side_call_meter_failed" },
      "Failed to meter a side call: its usage row was not written",
    )
    // The usage row failed; the reservation must still close (idempotent once settled).
    await credit.demo?.finish()
  }
}

interface FinalizeParams {
  model: {
    provider: string
    modelId: string
    inputCostPerM: string
    outputCostPerM: string
    updatedAt?: Date | string
    source?: string
  }
  inputTokens: number
  outputTokens: number
  /** Provider-reported prompt-cache-hit input tokens (see cachedInputCost). */
  cachedInputTokens?: number
  /**
   * Provider-reported cache WRITE tokens (Anthropic's cache creation). Absent
   * for a provider that does not report it, which is not the same as zero and
   * is logged as absent rather than as a 0 that reads like a measurement.
   */
  cacheWriteTokens?: number
  /** The 5-minute-TTL part of cacheWriteTokens (Anthropic reports the split). */
  cacheWrite5mTokens?: number
  /**
   * What the provider itself billed for the call or turn, in USD, when it reports it
   * (OpenRouter's usage accounting, summed over the turn's steps: step-usage.ts). For
   * provider "openrouter" it IS the raw cost, converted to EUR at the pricing sync's rate;
   * absent, the cost is estimated from the tokens as for every other provider.
   */
  providerCostUsd?: number
  /**
   * The cost of a call that is not priced by tokens (a transcription: seconds of
   * audio at the model's list price), computed by the caller in USD, for any
   * provider. Converted to EUR like a reported cost. A reported
   * `providerCostUsd` (OpenRouter) still wins over it.
   */
  fixedCostUsd?: number
  /**
   * A fixed-price item: on a billed managed call its credits are
   * `quantity` x the item's pushed credit price, never the raw cost x rate.
   * The row still keeps the raw cost. Ignored where nothing is billed.
   */
  unit?: { item: CloudUnitItem; quantity: number }
  /** Extra fields for the usage event (a transcription's seconds). */
  metadata?: Record<string, unknown>
  /** The usage row's description, when the model and tokens do not say what it was. */
  description?: string
  /**
   * False for a call that took no reservation of its own (the OpenRouter web
   * search, a tool call inside a turn): the turn's reservation is left alone.
   */
  releaseReservation?: boolean
  /** A visitor call's reservations (`preCheck`'s `demo`): settled here at the call's cost. */
  demo?: DemoStepMeter
  keySource: "liaison" | "byok"
  userId: string
}

// Prompt-cache-hit input is billed by every supported provider at ~10% of the
// normal input rate (Gemini implicit caching, OpenAI automatic caching,
// Mistral, Anthropic cache reads). The model_pricing catalog only carries the
// full input rate, so cached tokens are priced as rate * this factor.
const CACHED_INPUT_RATE_FACTOR = 0.1

// Providers whose usage we price with the cache split. For ALL of them the
// AI SDK's `inputTokens` is the WHOLE prompt: uncached + cache reads (+ cache
// writes for Anthropic, which reports them). Measured on the wire 2026-10-01
// (AI SDK 6 and 7 alike): Anthropic input_tokens 50 + cache_creation 100 +
// cache_read 800 arrives as inputTokens 950. The earlier rule treated
// Anthropic's inputTokens as EXCLUDING reads and added them on top, which
// billed every cache read at 1.1x instead of 0.1x, and billed cache writes at
// the plain rate instead of the write premium.
const CACHE_SPLIT_PROVIDERS = new Set(["anthropic", "google", "openai", "mistral"])

/**
 * Raw input cost with prompt caching. `inputTokens` is the whole prompt;
 * `cachedInputTokens` (reads) and `cacheWriteTokens` (Anthropic writes) are
 * parts of it. Reads cost 0.1x the input rate, writes the Anthropic premium
 * for their TTL (2x for 1h, 1.25x for 5m), the rest the plain rate. A request
 * mixes both TTLs (1h assembly breakpoints, 5m rolling step breakpoints), so
 * `cacheWrite5mTokens`, the 5m part Anthropic reports, is priced at 1.25x and
 * the remaining writes at the configured TTL's rate. Unknown providers: full
 * rate for everything (conservative).
 */
export function computeRawInputCost(
  provider: string,
  inputTokens: number,
  cachedInputTokens: number,
  inputCostPerM: number,
  cacheWriteTokens = 0,
  cacheWrite5mTokens = 0,
): number {
  const input = Math.max(0, inputTokens)
  if (!CACHE_SPLIT_PROVIDERS.has(provider)) return (input * inputCostPerM) / 1_000_000
  const read = Math.min(Math.max(0, cachedInputTokens), input)
  const write = provider === "anthropic" ? Math.min(Math.max(0, cacheWriteTokens), input - read) : 0
  const write5m = Math.min(Math.max(0, cacheWrite5mTokens), write)
  const plain = input - read - write
  const writeFactor = ANTHROPIC_CACHE_WRITE_RATE_FACTOR[resolveAnthropicCacheTtl()]
  return (
    (plain * inputCostPerM +
      read * inputCostPerM * CACHED_INPUT_RATE_FACTOR +
      write5m * inputCostPerM * ANTHROPIC_CACHE_WRITE_RATE_FACTOR["5m"] +
      (write - write5m) * inputCostPerM * writeFactor) /
    1_000_000
  )
}

// `credit_transactions.user_id` and event `actor_id` are uuid columns, but
// system-initiated usage (the ticket summarizer, scheduled jobs) attributes
// itself with a non-uuid sentinel like "system". Postgres rejects that with
// "invalid input syntax for type uuid", and on a self-hosted / BYOK instance —
// where every turn hits the non-deducting `byok_usage` insert below — that
// rejection aborts the whole job (ticket summaries were left stuck on
// 'generating' because the post-usage status update never ran).

/**
 * What share of this turn's prompt the provider served from its cache
 * (P4c-T48). `inputTokens` is the whole prompt for every provider (cache reads
 * are a part of it, see CACHE_SPLIT_PROVIDERS), so it is the denominator.
 * Zero, never NaN, for a turn that sent no prompt at all.
 */
export function cacheHitRatio(
  _provider: string,
  inputTokens: number,
  cachedInputTokens: number,
): number {
  const cached = Math.max(0, cachedInputTokens)
  if (inputTokens <= 0) return 0
  return Math.min(1, cached / inputTokens)
}

// Providers whose own reported cost is the raw cost. OpenRouter's usage accounting is what
// it charges, cache discounts and the upstream's rates applied; its catalogue's flat prompt
// price, which the estimate uses, overstated cache-heavy turns about fourfold.
const PROVIDER_REPORTED_COST = new Set(["openrouter"])

/** The USD per EUR rate now, or null when there is none (the cost is then estimated). */
async function usdEurRateOrNull(provider: string): Promise<number | null> {
  try {
    // Dollars divide by the rate (USD per EUR), as the catalogue's prices do.
    const rate = await currentUsdEurRate()
    return Number.isFinite(rate) && rate > 0 ? rate : null
  } catch (err) {
    log.warn({ err, provider }, "no USD to EUR rate: pricing the call from its tokens instead")
    return null
  }
}

/**
 * The provider's reported cost in USD (else the caller's fixed USD cost), or
 * null when the cost must be estimated from the tokens.
 */
function reportedCostUsd(
  provider: string,
  providerCostUsd: number | undefined,
  fixedCostUsd?: number,
): number | null {
  const reported = PROVIDER_REPORTED_COST.has(provider) ? usableUsd(providerCostUsd) : null
  return reported ?? usableUsd(fixedCostUsd)
}

function usableUsd(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

export async function finalizeUsage(
  orgId: string,
  params: FinalizeParams,
): Promise<{ creditCost: string }> {
  const { model, inputTokens, outputTokens, cachedInputTokens, keySource, userId } = params

  // Hand back the reservation `preCheck` took for this turn. This is the one
  // function every spending path reaches when it is done, so it is where the
  // in-flight estimate is replaced by the row about to be written below. A
  // no-op, with no Redis round trip, unless this box is a demo instance and
  // the org carries the marker. A call that took no reservation of its own (a
  // tool's paid call inside a turn) says so, or it would release the turn's.
  if (params.releaseReservation !== false) await releaseDemoTurnReservation(orgId)
  if (params.demo) {
    await params.demo.finish(
      visitorCostMicroEur({
        inputTokens,
        outputTokens,
        cachedInputTokens: cachedInputTokens ?? 0,
        providerCostUsd: params.providerCostUsd ?? null,
      }),
    )
  }

  // EVERY TURN. This is the one place every provider call's usage lands, so it
  // is the one place the prompt-cache numbers can be observed without a second
  // accounting path that could disagree with the billed one.
  log.info(
    {
      orgId,
      provider: model.provider,
      modelId: model.modelId,
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedInputTokens ?? 0,
      cacheWriteTokens: params.cacheWriteTokens ?? null,
      cacheWrite5mTokens: params.cacheWrite5mTokens ?? null,
      ratio: cacheHitRatio(model.provider, inputTokens, cachedInputTokens ?? 0),
    },
    "cache_hit_ratio",
  )

  // Coerce a non-uuid actor (e.g. "system") to null so the usage row records a
  // system actor instead of throwing on the uuid cast.
  const actorUserId = userId && UUID_RE.test(userId) ? userId : null

  const reportedUsd = reportedCostUsd(model.provider, params.providerCostUsd, params.fixedCostUsd)
  // The rate is looked up when it is needed: a reported USD cost to convert,
  // or the managed edition, whose rows all keep their USD cost.
  const usdEurRate =
    reportedUsd !== null || isManagedEdition() ? await usdEurRateOrNull(model.provider) : null
  const reported = reportedUsd !== null && usdEurRate !== null ? reportedUsd / usdEurRate : null
  const rawCost =
    reported ??
    computeRawInputCost(
      model.provider,
      inputTokens,
      cachedInputTokens ?? 0,
      Number(model.inputCostPerM),
      params.cacheWriteTokens ?? 0,
      params.cacheWrite5mTokens ?? 0,
    ) +
      (outputTokens * Number(model.outputCostPerM)) / 1_000_000
  const isStale =
    model.source === "litellm_sync" &&
    model.updatedAt &&
    Date.now() - new Date(model.updatedAt).getTime() > 7 * 24 * 60 * 60 * 1000
  // The row's USD cost: what the provider reported, else the EUR estimate back
  // in USD at the same rate. Null only when there is no rate at all.
  const rawCostUsd =
    reported !== null ? reportedUsd : usdEurRate !== null ? rawCost * usdEurRate : null
  const usdFields = {
    rawCostUsd: rawCostUsd === null ? null : rawCostUsd.toFixed(8),
    usdEurRate: usdEurRate === null ? null : usdEurRate.toFixed(6),
  }

  // Usage is metered-and-deducted only on a managed instance using a Liaison
  // key. BYOK keys — and ALL usage on a self-hosted instance — are recorded for
  // monitoring but never deducted: there are no credits outside a control plane.
  // The reserved demo org is never billed: it has no balance to deduct from (a
  // demo org's credit is zeroed by design) and `preCheck` deliberately let it
  // past the balance gate, so billing it would be a deduction failure per turn
  // and, after three, an open circuit breaker on the one org App Review uses.
  // Nor is a demo visitor org: its box-key spend lives in the demo ledger.
  const billed =
    isManagedEdition() &&
    keySource === "liaison" &&
    !(await isReservedDemoOrg(orgId)) &&
    !(await isVisitorDemoOrg(orgId))

  if (!billed) {
    // No balance deduction. Record a non-deducting `byok_usage` row so the
    // monitoring page (chart + history) has data, AND keep the durable audit
    // event. balanceAfter is "0" — this row never touches a balance.
    await withPrivilegedDb(orgId, "agent-byok-usage", async (tx) => {
      await tx.insert(creditTransactions).values({
        orgId,
        userId: actorUserId,
        type: "byok_usage",
        amount: (rawCost * -1).toFixed(8),
        balanceAfter: "0",
        model: model.modelId,
        inputTokens,
        outputTokens,
        rawCost: rawCost.toFixed(8),
        ...usdFields,
        ...(params.description ? { description: params.description } : {}),
      })
      await tx.queueEvent({
        app: "kernel",
        entity: "credit",
        action: "usage",
        entityId: orgId,
        orgId,
        actorId: actorUserId,
        actorType: actorUserId ? "agent" : "system",
        data: {
          model: model.modelId,
          inputTokens,
          outputTokens,
          cachedInputTokens: cachedInputTokens || undefined,
          rawCost,
          byok: keySource === "byok",
          billed: false,
          ...(params.metadata ?? {}),
        },
      })
    })
    return { creditCost: "0" }
  }

  // Billed: credits = raw EUR x the cell's credit rate, read per call so a
  // pushed rate applies without a restart (S21), x the stale factor; a
  // fixed-price item costs its pushed credit price. No pushed rate: the
  // gate refused the call, so reaching here means it vanished mid-call; that
  // counts as a failed deduction (the breaker) below, never a guessed factor.
  let creditCost = 0

  try {
    const pricing = await requireCellCreditPricing("finalize-usage")
    creditCost = params.unit
      ? creditsForUnits(pricing, params.unit.item, params.unit.quantity)
      : creditsForEur(rawCost, pricing.rate, Boolean(isStale))
    const { balanceAfter, transactionId } = await deductCredits(orgId, {
      model: model.modelId,
      inputTokens,
      outputTokens,
      rawCost: rawCost.toFixed(8),
      ...usdFields,
      creditCost: creditCost.toFixed(8),
      userId: actorUserId,
      ...(params.description ? { description: params.description } : {}),
    })

    // Successful deduction clears any prior consecutive-failure streak so the
    // circuit breaker only ever reflects a *persistent* problem.
    await resetDeductionFailures(orgId)
    await maybeRequestAutoTopUp({
      orgId,
      transactionId,
      balanceAfter: Number(balanceAfter),
      amount: creditCost,
    })

    // Low-balance threshold events
    // Approximate original balance as balanceAfter + creditCost
    const balAfter = Number(balanceAfter)
    const original = balAfter + creditCost
    if (balAfter <= 0) {
      await emitLowBalanceEvent(orgId, "0%", balanceAfter)
    } else if (original > 0 && balAfter / original <= 0.2) {
      await emitLowBalanceEvent(orgId, "20%", balanceAfter)
    }

    return { creditCost: creditCost.toFixed(8) }
  } catch (err) {
    // Deduction failure means the user got a free response for this turn. We do
    // NOT swallow it silently: increment the per-org consecutive-failure counter
    // so a persistent failure trips the pre-turn circuit breaker (preCheck) and
    // hard-blocks subsequent free turns instead of bleeding revenue unnoticed.
    const failures = await recordDeductionFailure(orgId)
    const tripped = failures >= DEDUCT_FAIL_THRESHOLD
    log.error(
      {
        err,
        orgId,
        alert: tripped ? "credit_deduction_breaker_open" : "credit_deduction_failure",
        consecutiveFailures: failures,
        threshold: DEDUCT_FAIL_THRESHOLD,
        breakerTripped: tripped,
        model: model.modelId,
        inputTokens,
        outputTokens,
      },
      tripped
        ? "Credit deduction failed — consecutive-failure threshold reached, agent turns for this org will now be blocked"
        : "Credit deduction failed — usage was not billed",
    )
    // Return "0" so the done event doesn't report a deduction that did not happen
    return { creditCost: "0" }
  }
}

async function emitLowBalanceEvent(
  orgId: string,
  threshold: string,
  balanceAfter: string,
): Promise<void> {
  await withPrivilegedDb(orgId, "agent-low-balance-audit", async (tx) => {
    await tx.queueEvent({
      app: "kernel",
      entity: "credit",
      action: "low_balance",
      entityId: orgId,
      orgId,
      data: { threshold, balanceAfter },
    })
  }).catch((err) => log.error({ err }, "Failed to emit low-balance event"))
}
