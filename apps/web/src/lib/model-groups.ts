// SPDX-License-Identifier: FSL-1.1-ALv2
// THE MODEL LIST IS THE SERVER'S. `GET /credits/models` answers every model
// this org can run (native ones minus those an admin switched off, plus the
// ones it added from OpenRouter or its own servers), each with its provider's
// display label, tier minimum and reasoning capability. Nothing here lists a
// model: a static registry here drifted from the catalogue every time an admin
// switched a model on or off. The backend still enforces access; this is the
// picker's view of it.

import { getReasoningCapability, REASONING_LEVELS, type ReasoningLevel } from "@liaison/shared"
import { createSignal } from "solid-js"

/** One entry of `GET /credits/models` (S6). `modelId` is the legacy alias of
 *  `key`, served for one release. */
export interface ServedModel {
  key: string
  provider: string
  providerLabel: string
  displayName: string
  tierMinimum: string
  contextWindow: number | null
  inputCostPerM: string | null
  outputCostPerM: string | null
  /** A managed cell's `≈ N×` against Auto (S18), served instead of the prices; null elsewhere. */
  multiplier: number | null
  reasoning: { allowedLevels: ReasoningLevel[]; defaultLevel: ReasoningLevel }
  tools: boolean
}

/** The whole `GET /credits/models` answer (S6). */
export interface ServedModels {
  /** The admin's Auto choice, null when Auto follows the default rule. */
  autoModelKey: string | null
  /** The model Auto actually runs right now. */
  autoResolvedKey: string | null
  /** The reasoning level Auto runs it at (a demo box key's Low), null when not served. */
  autoReasoningLevel: ReasoningLevel | null
  /** The org's level for a turn that asks for none, null when unset (the model's default). */
  defaultReasoningLevel: ReasoningLevel | null
  models: ServedModel[]
}

export interface ModelEntry {
  id: string | null
  label: string
  tierMinimum: string
  /** `≈ N×` against Auto on a managed cell (S18). */
  multiplier?: number | null
}

export interface ModelGroup {
  provider: string
  models: ModelEntry[]
}

/** Provider labels the server is expected to send, for an answer that predates
 *  `providerLabel` (the one-release legacy shape). */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  openrouter: "OpenRouter",
}

/** S6 group order: Auto, then these providers, then each custom server. */
const PROVIDER_ORDER = ["anthropic", "openai", "google", "mistral", "openrouter"]

const REASONING_LEVEL_SET = new Set<string>(["off", "low", "medium", "high"])

function asLevels(value: unknown): ReasoningLevel[] | null {
  if (!Array.isArray(value)) return null
  const levels = value.filter(
    (v): v is ReasoningLevel => typeof v === "string" && REASONING_LEVEL_SET.has(v),
  )
  return levels.length > 0 ? levels : null
}

/**
 * Read one served entry. Tolerates the legacy shape (`modelId`, no
 * `providerLabel`, no `reasoning`) for the release the server keeps both, and
 * drops an entry with no key at all rather than inventing one.
 */
function parseServedModel(raw: unknown): ServedModel | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as Record<string, unknown>
  const key = typeof m.key === "string" ? m.key : typeof m.modelId === "string" ? m.modelId : null
  if (!key) return null
  const provider = typeof m.provider === "string" ? m.provider : ""
  const served = m.reasoning as { allowedLevels?: unknown; defaultLevel?: unknown } | undefined
  const allowed = asLevels(served?.allowedLevels)
  const fallback = getReasoningCapability(key, provider || undefined)
  const defaultLevel =
    typeof served?.defaultLevel === "string" && REASONING_LEVEL_SET.has(served.defaultLevel)
      ? (served.defaultLevel as ReasoningLevel)
      : fallback.defaultLevel
  return {
    key,
    provider,
    providerLabel:
      typeof m.providerLabel === "string" && m.providerLabel
        ? m.providerLabel
        : (PROVIDER_LABELS[provider] ?? provider),
    displayName: typeof m.displayName === "string" && m.displayName ? m.displayName : key,
    tierMinimum: typeof m.tierMinimum === "string" ? m.tierMinimum : "starter",
    contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
    inputCostPerM: typeof m.inputCostPerM === "string" ? m.inputCostPerM : null,
    outputCostPerM: typeof m.outputCostPerM === "string" ? m.outputCostPerM : null,
    multiplier: typeof m.multiplier === "number" ? m.multiplier : null,
    reasoning: allowed
      ? { allowedLevels: allowed, defaultLevel }
      : { allowedLevels: fallback.allowedLevels, defaultLevel: fallback.defaultLevel },
    tools: m.tools !== false,
  }
}

/** Parse a `GET /credits/models` body into the served list. */
export function parseServedModels(body: unknown): ServedModels {
  const b = (body ?? {}) as Record<string, unknown>
  const list = Array.isArray(b.models) ? b.models : Array.isArray(body) ? (body as unknown[]) : []
  return {
    autoModelKey: typeof b.autoModelKey === "string" ? b.autoModelKey : null,
    autoResolvedKey: typeof b.autoResolvedKey === "string" ? b.autoResolvedKey : null,
    autoReasoningLevel: REASONING_LEVELS.includes(b.autoReasoningLevel as ReasoningLevel)
      ? (b.autoReasoningLevel as ReasoningLevel)
      : null,
    defaultReasoningLevel: REASONING_LEVELS.includes(b.defaultReasoningLevel as ReasoningLevel)
      ? (b.defaultReasoningLevel as ReasoningLevel)
      : null,
    models: list.map(parseServedModel).filter((m): m is ServedModel => m !== null),
  }
}

const [servedModels, setServedModelsSignal] = createSignal<ServedModels | null>(null)

/** The served list, or null while it has not been read this session. */
export { servedModels }

/** Install the served list (the credits store's one read; tests). */
export function setServedModels(value: ServedModels | null): void {
  setServedModelsSignal(value)
}

/** One served model by key, or undefined when the org is not served it. */
export function servedModel(key: string | null | undefined): ServedModel | undefined {
  if (!key) return undefined
  return servedModels()?.models.find((m) => m.key === key)
}

/** The label of the Auto entry: names the model Auto runs, once known. */
export function autoEntryLabel(): string {
  const resolved = servedModels()?.autoResolvedKey
  if (!resolved) return "Auto"
  return `Auto · ${servedModel(resolved)?.displayName ?? resolved}`
}

function providerRank(provider: string): number {
  const i = PROVIDER_ORDER.indexOf(provider)
  return i === -1 ? PROVIDER_ORDER.length : i
}

/**
 * The picker's groups: Auto first, then the served models grouped by
 * `providerLabel` in the S6 order (Anthropic, OpenAI, Google, Mistral,
 * OpenRouter, then each custom server in the order the server lists them).
 * Before the list is read only Auto is offered: nothing is invented.
 */
export function modelGroups(): ModelGroup[] {
  const groups: ModelGroup[] = [
    { provider: "Auto", models: [{ id: null, label: "Auto", tierMinimum: "starter" }] },
  ]
  const byLabel = new Map<string, { rank: number; first: number; group: ModelGroup }>()
  const models = servedModels()?.models ?? []
  models.forEach((m, index) => {
    let slot = byLabel.get(m.providerLabel)
    if (!slot) {
      slot = {
        rank: providerRank(m.provider),
        first: index,
        group: { provider: m.providerLabel, models: [] },
      }
      byLabel.set(m.providerLabel, slot)
    }
    slot.group.models.push({
      id: m.key,
      label: m.displayName,
      tierMinimum: m.tierMinimum,
      ...(m.multiplier !== null ? { multiplier: m.multiplier } : {}),
    })
  })
  const ordered = [...byLabel.values()].sort((a, b) => a.rank - b.rank || a.first - b.first)
  return [...groups, ...ordered.map((s) => s.group)]
}

/**
 * The reasoning capability the picker shows for a model: the served one when
 * the org is served the model, else the shared per-provider rule (a model the
 * org can no longer run, the legacy answer).
 */
export function modelReasoning(modelId: string | null): {
  supportsReasoning: boolean
  allowedLevels: ReasoningLevel[]
  defaultLevel: ReasoningLevel
} {
  if (!modelId) return { supportsReasoning: false, allowedLevels: ["off"], defaultLevel: "off" }
  const served = servedModel(modelId)
  if (served) {
    const levels = served.reasoning.allowedLevels
    return {
      supportsReasoning: levels.some((l) => l !== "off"),
      allowedLevels: levels,
      defaultLevel: served.reasoning.defaultLevel,
    }
  }
  const cap = getReasoningCapability(modelId)
  return {
    supportsReasoning: cap.supportsReasoning,
    allowedLevels: cap.allowedLevels,
    defaultLevel: cap.defaultLevel,
  }
}

/**
 * Whether the current org is allowed to change the agent's model at all.
 * Self-hosted (BYOK) has no credit/tier gating — billing is a managed-only
 * concept — so the full menu is always unlocked there regardless of
 * purchased credits. Managed orgs unlock the picker once they have
 * purchased credits (`hasPurchasedCredits`); ModelSelector additionally
 * unlocks on a high-enough plan tier, which it checks itself.
 *
 * Single source of truth for this gate — both ModelSelector (the composer's
 * model picker) and AgentMessageMenu (the per-message "change model" menu)
 * call this so the two surfaces cannot drift out of sync again.
 */
export function canChangeModel(
  billingMode: "self_hosted" | "managed" | null,
  hasPurchasedCredits: boolean,
): boolean {
  return billingMode === "self_hosted" || hasPurchasedCredits
}

/**
 * Whether a model may be OFFERED in a picker given the org's configured
 * provider keys (from GET /credits/models). Auto (id null) is never
 * provider-keyed so it is always allowed; while the list is still loading
 * (undefined/null) nothing is hidden so menus don't flash empty.
 *
 * Shared by ModelSelector (composer picker) and AgentMessageMenu (per-message
 * menu) so a model without a registered key can never appear on one surface
 * and not the other.
 */
export function modelAllowedByKey(
  model: ModelEntry,
  availableModelIds: Set<string> | null | undefined,
): boolean {
  return model.id == null || availableModelIds == null || availableModelIds.has(model.id)
}

/**
 * The widest a phone composer will let the model control be, in CSS pixels.
 *
 * It was 44, which bought exactly two letters, because the chip shared one
 * row with the message field and every pixel it took came out of the draft.
 * The field has a line of its own now and the chip sits on the control line
 * with the `+` and send, so it can afford to say which model is answering.
 * Past this the control line wraps, which is why there is still a cap.
 */
export const COMPACT_MODEL_CHIP_MAX_PX = 132

/**
 * A SHORT NAME THAT IS STILL A NAME, for the phone composer's chip.
 *
 * "GF" is not a model: two initials beside a send button read as an unlabeled
 * code, which is what card 104 caught. This drops the family word when the
 * label carries one ("Gemini Flash-Lite" -> "Flash-Lite", "Claude Opus 4.6" ->
 * "Opus 4.6") and keeps everything else whole, so a one word label ("Auto")
 * and a label whose first token is the model itself ("GPT-5.4 Nano") come back
 * untouched. A "Default (<model>)" label shortens to whatever is inside it.
 */
export function modelShortLabel(modelId: string | null): string {
  const label = getModelLabel(modelId)
  const inner = modelNameWithoutProvider(/\(([^)]+)\)\s*$/.exec(label)?.[1] ?? label)
  const tokens = inner.split(/\s+/).filter((t) => t.length > 0)
  // Only a purely alphabetic first token is a family name worth dropping:
  // "GPT-5.4" is the model, not its maker. A version right after it keeps the
  // family ("Gemini 3.1 Flash Lite", never "3.1 Flash Lite").
  if (tokens.length >= 2 && /^[A-Za-z]+$/.test(tokens[0]) && /^[A-Za-z]/.test(tokens[1])) {
    return tokens.slice(1).join(" ")
  }
  return inner
}

/**
 * The model's own name out of a "<Provider>: <Model>" label (the names a
 * router serves: "Google: Gemini 3.1 Flash Lite"). A narrow chip shows this,
 * ellipsized; the full label stays its title and the menu's entry.
 */
export function modelNameWithoutProvider(label: string): string {
  return /^[A-Z][\w.&'-]*(?: [\w.&'-]+){0,2}: (?=\S)/.exec(label)
    ? label.slice(label.indexOf(": ") + 2)
    : label
}

export function getModelLabel(modelId: string | null): string {
  if (modelId === null) return "Auto"
  return servedModel(modelId)?.displayName ?? modelId
}

/**
 * THE MODELS A SETTINGS PICKER OFFERS (an agent's default, a routine's model):
 * the catalog filtered by what the org can actually run (GET /credits/models),
 * so a model whose provider has no key here, or that a workspace pin
 * replaces, is never chosen and then silently run on something else (walk N4:
 * an agent "on Claude Haiku 4.5" answered on Gemini Flash-Lite). The current
 * choice stays listed when it is no longer offered, marked unavailable, so the
 * form shows the truth instead of jumping to another model.
 */
export function pickableModels(
  availableModelIds: Set<string> | null | undefined,
  current: string | null | undefined,
): Array<ModelEntry & { unavailable?: boolean }> {
  return pickableModelGroups(availableModelIds, current).flatMap((g) => g.models)
}

/** `pickableModels`, grouped by provider label in the S6 order. The kept,
 *  unavailable current choice comes last, in a group of its own. */
export function pickableModelGroups(
  availableModelIds: Set<string> | null | undefined,
  current: string | null | undefined,
): Array<{ provider: string; models: Array<ModelEntry & { unavailable?: boolean }> }> {
  const groups = modelGroups()
    .filter((g) => g.provider !== "Auto")
    .map((g) => ({
      provider: g.provider,
      models: g.models.filter((m) => modelAllowedByKey(m, availableModelIds)),
    }))
    .filter((g) => g.models.length > 0)
  if (current && !groups.some((g) => g.models.some((m) => m.id === current))) {
    return [
      ...groups,
      {
        provider: "",
        // While the list is still being read nothing is known to be missing:
        // the choice is listed as is, not flagged.
        models: [
          {
            id: current,
            label: getModelLabel(current),
            tierMinimum: "starter",
            unavailable: servedModels() !== null,
          },
        ],
      },
    ]
  }
  return groups
}
