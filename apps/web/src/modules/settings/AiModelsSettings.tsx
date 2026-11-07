// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Settings -> AI -> AI models (S9).
 *
 * The one place an admin decides what the organization's agents run on:
 * which model Auto runs, the provider keys, which models are switched on
 * (every picker shows exactly those), models added from OpenRouter's
 * catalogue and models served by the organization's own servers.
 *
 * Everything here talks to the admin API under `/settings/ai` (S7):
 *   GET    /settings/ai/models                       page data
 *   PATCH  /settings/ai/models                       { enable?, disable?, autoModelKey?, defaultReasoningLevel?, blockedHosts? }
 *   DELETE /settings/ai/models/:key                  an added model
 *   GET    /settings/ai/openrouter/catalogue?q=&toolsOnly=
 *   POST   /settings/ai/openrouter/models            { upstreamId } (test call, then added)
 *   POST   /settings/ai/servers                      { name, baseURL, apiKey? }
 *   DELETE /settings/ai/servers/:id
 *   POST   /settings/ai/servers/:id/models           { name, contextWindow? } (test call)
 *   POST   /settings/ai/keys, DELETE /settings/ai/keys/:provider
 *
 * After any change the pickers' served list is re-read
 * (`refreshAvailableModels`), so a model switched on here is in the composer
 * menu at once, not after a reload.
 */
import { type BlockedHostsView, REASONING_LEVELS, type ReasoningLevel } from "@liaison/shared"
import { type Component, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ApiError } from "~/lib/api-error"
import { noAutofill } from "~/lib/no-autofill"
import { refreshAvailableModels } from "~/modules/agent/credits/credits-store"
import { REASONING_LABEL_KEY } from "~/modules/agent/ReasoningLevelRow"
import { currentLocale, useI18n } from "~/modules/i18n/i18n-context"
import { billingMode } from "~/modules/settings/BillingState"
import { formatMultiplier } from "~/modules/settings/credits-format"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { Switch } from "~/ui/Switch"
import { Tooltip } from "~/ui/Tooltip"
import { BlockedHostsSection } from "./BlockedHostsSection"
import { HistorySection } from "./HistorySection"
import { VoiceDictationSection } from "./VoiceDictationSection"

interface AdminProvider {
  provider: string
  label: string
  /** The org's own key is stored. */
  keySet: boolean
  /** The org can run this provider's models: its own key, or the deployment's. */
  usable: boolean
  maskedHint?: string
}

interface AdminServer {
  id: string
  name: string
  baseURL: string
  addedAt?: string
}

interface AdminModel {
  key: string
  provider: string
  displayName: string
  enabled: boolean
  native: boolean
  contextWindow: number | null
  inputCostPerM?: string | null
  outputCostPerM?: string | null
  /** A managed cell's `≈ N×` against Auto, served instead of the prices (S18). */
  multiplier?: number | null
  tools: boolean
  reasoning?: { allowedLevels?: string[]; defaultLevel?: string }
  /** Set by the price job when OpenRouter stopped listing the model. */
  unavailableSince?: string | null
}

interface AdminModelsPayload {
  providers: AdminProvider[]
  servers: AdminServer[]
  auto: { modelKey: string | null; resolvedKey: string | null }
  /** The level of a turn that asks for none; null = the built-in default. */
  defaultReasoningLevel: ReasoningLevel | null
  /** The OpenRouter hosts the org's requests never reach; absent from an older server. */
  blockedHosts?: BlockedHostsView
  models: AdminModel[]
}

interface CatalogueRow {
  upstreamId: string
  displayName: string
  contextWindow: number | null
  inputCostPerM?: string | null
  outputCostPerM?: string | null
  /** A managed cell's `≈ N×` against Auto (S18). */
  multiplier?: number | null
  tools: boolean
  reasoningEfforts: string[]
  added: boolean
  /** False for a model OpenRouter gives no fixed price: it cannot be added. */
  addable?: boolean
}

type CatalogueState =
  | { status: "ready"; rows: CatalogueRow[] }
  | { status: "needs-key" }
  | { status: "unreachable" }

type ServerResult = { outcome: "tools" | "no-tools" } | { outcome: "error"; message: string }

const EMPTY: AdminModelsPayload = {
  providers: [],
  servers: [],
  auto: { modelKey: null, resolvedKey: null },
  defaultReasoningLevel: null,
  models: [],
}

const SEARCH_DEBOUNCE_MS = 250

/** The S7 payload with every list present, whatever the server left out. */
function normalize(raw: Partial<AdminModelsPayload> | null | undefined): AdminModelsPayload {
  return {
    providers: raw?.providers ?? [],
    servers: raw?.servers ?? [],
    auto: {
      modelKey: raw?.auto?.modelKey ?? null,
      resolvedKey: raw?.auto?.resolvedKey ?? null,
    },
    defaultReasoningLevel: REASONING_LEVELS.includes(raw?.defaultReasoningLevel as ReasoningLevel)
      ? (raw?.defaultReasoningLevel as ReasoningLevel)
      : null,
    ...(raw?.blockedHosts ? { blockedHosts: raw.blockedHosts } : {}),
    models: raw?.models ?? [],
  }
}

function catalogueRows(raw: unknown): CatalogueRow[] {
  if (Array.isArray(raw)) return raw as CatalogueRow[]
  const wrapped = raw as { models?: CatalogueRow[] } | null
  return wrapped?.models ?? []
}

/** The server id inside a custom model key, `custom/<serverId>/<name>`. */
function serverIdOf(key: string): string | null {
  if (!key.startsWith("custom/")) return null
  const rest = key.slice("custom/".length)
  const slash = rest.indexOf("/")
  return slash === -1 ? null : rest.slice(0, slash)
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).hostname || baseURL
  } catch {
    return baseURL
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : ""
}

function hasReasoning(levels: string[] | undefined): boolean {
  return (levels ?? []).some((l) => l !== "off")
}

const AiModelsSettings: Component = () => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()

  const [state, setState] = createStore<{ data: AdminModelsPayload; loaded: boolean }>({
    data: EMPTY,
    loaded: false,
  })
  const [loadFailed, setLoadFailed] = createSignal(false)

  const [, { refetch }] = createResource(async () => {
    try {
      const raw = await api.get<AdminModelsPayload>("/settings/ai/models")
      setState({ data: normalize(raw), loaded: true })
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
    return true
  })

  // Bumped on every change, so the voice dictation list follows the keys.
  const [version, setVersion] = createSignal(0)

  /** Re-read the page and the pickers' served list after a change. */
  function changed(): void {
    setVersion((v) => v + 1)
    void refetch()
    void refreshAvailableModels(api)
  }

  // ─── Formatting ───
  const money = (value: string | null) =>
    value === null
      ? ""
      : new Intl.NumberFormat(currentLocale(), {
          style: "currency",
          currency: "EUR",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(Number(value))
  // A managed cell shows no money: each model's cost against Auto (S18).
  const managed = () => billingMode() === "managed"
  const priceCell = (row: {
    inputCostPerM?: string | null
    outputCostPerM?: string | null
    multiplier?: number | null
  }) => {
    if (managed()) return formatMultiplier(row.multiplier)
    const input = row.inputCostPerM ?? null
    const output = row.outputCostPerM ?? null
    return input === null || output === null
      ? t("kernel.aiModels.tokensOnly")
      : `${money(input)} / ${money(output)}`
  }
  const contextCell = (tokens: number | null) => {
    if (!tokens) return ""
    if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
    return String(tokens)
  }

  // ─── Derived ───
  const provider = (id: string) => state.data.providers.find((p) => p.provider === id)
  const providerLabel = (m: AdminModel) => {
    if (m.provider === "custom") {
      const id = serverIdOf(m.key)
      return state.data.servers.find((s) => s.id === id)?.name ?? t("kernel.aiModels.ownServer")
    }
    return provider(m.provider)?.label ?? m.provider
  }
  /**
   * Whether the model's provider can run it: a key (the org's own or the
   * deployment's, as the API's `usable` says), or the org's own server.
   */
  const runnable = (m: AdminModel) =>
    m.provider === "custom" || provider(m.provider)?.usable === true
  const autoKey = () => state.data.auto.resolvedKey
  const modelByKey = (key: string | null) =>
    key ? state.data.models.find((m) => m.key === key) : undefined
  const nameOf = (key: string | null) => modelByKey(key)?.displayName ?? key ?? ""
  /**
   * Listed in the table (D18): what can run, plus an ADDED model or the model
   * chosen for Auto whose provider lost its key, flagged "Key removed". Native
   * models are on by default (an opt-out list), so a keyless provider's natives
   * fold into its locked row instead of filling the table with dead rows.
   */
  const listed = (m: AdminModel) => runnable(m) || !m.native || m.key === state.data.auto.modelKey
  const listedModels = () => state.data.models.filter(listed)
  const onCount = () => listedModels().filter((m) => m.enabled).length
  const usableProviders = () => state.data.providers.filter((p) => p.usable)
  /** Every provider without a usable key gets a row that takes one. */
  const lockedProviders = () => (managed() ? [] : state.data.providers.filter((p) => !p.usable))
  const hiddenCount = (p: AdminProvider) =>
    state.data.models.filter((m) => m.provider === p.provider && !listed(m)).length
  const lockedLabel = (p: AdminProvider) => {
    const count = hiddenCount(p)
    if (count === 0) return t("kernel.aiModels.providerLocked", { provider: p.label })
    return count === 1
      ? t("kernel.aiModels.providerLockedOne", { provider: p.label })
      : t("kernel.aiModels.providerLockedMany", { provider: p.label, count })
  }
  const autoChoices = () => state.data.models.filter((m) => m.enabled && runnable(m))
  const autoFellBack = () => {
    const chosen = state.data.auto.modelKey
    return chosen !== null && chosen !== state.data.auto.resolvedKey
  }

  // ─── Auto ───
  const [autoSaving, setAutoSaving] = createSignal(false)
  async function setAuto(value: string) {
    const next = value === "" ? null : value
    setAutoSaving(true)
    try {
      await api.patch("/settings/ai/models", { autoModelKey: next })
      setState("data", "auto", "modelKey", next)
      changed()
    } catch (err) {
      const conflict = err instanceof ApiError && err.code === "auto_model"
      addToast({
        message: conflict
          ? t("kernel.aiModels.autoNothingToRun")
          : errorMessage(err) || t("kernel.aiModels.autoSaveFailed"),
        type: "error",
      })
      void refetch()
    } finally {
      setAutoSaving(false)
    }
  }

  // ─── Default reasoning level ───
  const [reasoningSaving, setReasoningSaving] = createSignal(false)
  async function setDefaultReasoning(value: string) {
    const next = REASONING_LEVELS.includes(value as ReasoningLevel)
      ? (value as ReasoningLevel)
      : null
    setReasoningSaving(true)
    try {
      await api.patch("/settings/ai/models", { defaultReasoningLevel: next })
      setState("data", "defaultReasoningLevel", next)
      changed()
    } catch (err) {
      addToast({
        message: errorMessage(err) || t("kernel.aiModels.reasoningSaveFailed"),
        type: "error",
      })
      void refetch()
    } finally {
      setReasoningSaving(false)
    }
  }

  // ─── Switches ───
  const [switching, setSwitching] = createSignal<string | null>(null)
  async function toggleModel(m: AdminModel, next: boolean) {
    if (switching() || (!next && m.key === autoKey())) return
    const key = m.key
    setSwitching(key)
    setState("data", "models", (x) => x.key === key, "enabled", next)
    try {
      await api.patch("/settings/ai/models", next ? { enable: [key] } : { disable: [key] })
      changed()
    } catch (err) {
      setState("data", "models", (x) => x.key === key, "enabled", !next)
      const conflict = err instanceof ApiError && err.code === "auto_model"
      addToast({
        message: conflict
          ? t("kernel.aiModels.autoLocked")
          : errorMessage(err) || t("kernel.aiModels.toggleFailed"),
        type: "error",
      })
    } finally {
      setSwitching(null)
    }
  }

  // ─── Inline two-step removals (added models, servers, keys) ───
  const [confirming, setConfirming] = createSignal<string | null>(null)
  async function removeModel(key: string) {
    setConfirming(null)
    try {
      await api.delete(`/settings/ai/models/${encodeURIComponent(key)}`)
      changed()
    } catch (err) {
      addToast({ message: errorMessage(err) || t("kernel.aiModels.removeFailed"), type: "error" })
    }
  }
  async function removeServer(id: string) {
    setConfirming(null)
    try {
      await api.delete(`/settings/ai/servers/${encodeURIComponent(id)}`)
      changed()
    } catch (err) {
      addToast({ message: errorMessage(err) || t("kernel.aiModels.removeFailed"), type: "error" })
    }
  }

  // ─── Provider keys ───
  const [configuring, setConfiguring] = createSignal<string | null>(null)
  const [keyInput, setKeyInput] = createSignal("")
  const [keySaving, setKeySaving] = createSignal(false)
  const [keyError, setKeyError] = createSignal("")

  /** The inline key field of a provider card or a locked provider row. */
  const keyForm = (p: AdminProvider) => (
    <>
      <div class="flex flex-wrap items-center gap-1.5">
        <input
          type="password"
          {...noAutofill(`provider-api-key-${p.provider}`, { secret: true })}
          data-testid={`provider-key-input-${p.provider}`}
          aria-label={t("kernel.usage.apiKeyPlaceholder")}
          placeholder={t("kernel.usage.apiKeyPlaceholder")}
          value={keyInput()}
          onInput={(e) => setKeyInput(e.currentTarget.value)}
          class={`${field} min-w-0 flex-1 text-xs`}
        />
        <Button
          variant="outline"
          size="sm"
          loading={keySaving()}
          data-testid={`provider-key-save-${p.provider}`}
          onClick={() => void saveKey(p)}
        >
          {t("kernel.usage.save")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`provider-key-cancel-${p.provider}`}
          onClick={() => setConfiguring(null)}
        >
          {t("kernel.usage.cancel")}
        </Button>
      </div>
      <Show when={keyError()}>
        <span class="text-xs text-error">{keyError()}</span>
      </Show>
    </>
  )
  const openKeyForm = (p: AdminProvider) => {
    setConfiguring(p.provider)
    setKeyInput("")
    setKeyError("")
  }

  async function saveKey(p: AdminProvider) {
    if (!keyInput()) return
    setKeySaving(true)
    setKeyError("")
    try {
      await api.post("/settings/ai/keys", { provider: p.provider, apiKey: keyInput() })
      addToast({ message: t("kernel.usage.keySaved", { provider: p.label }), type: "success" })
      setConfiguring(null)
      setKeyInput("")
      changed()
    } catch (err) {
      setKeyError(errorMessage(err) || t("kernel.usage.failedSaveKey"))
    } finally {
      setKeySaving(false)
    }
  }

  const [rechecking, setRechecking] = createSignal<string | null>(null)
  async function recheckKey(p: AdminProvider) {
    setRechecking(p.provider)
    try {
      await api.post(`/settings/ai/keys/${p.provider}/validate`, {})
      addToast({
        message: t("kernel.usage.keyRevalidated", { provider: p.label }),
        type: "success",
      })
      changed()
    } catch (err) {
      addToast({ message: errorMessage(err) || t("kernel.aiModels.recheckFailed"), type: "error" })
    } finally {
      setRechecking(null)
    }
  }

  async function removeKey(p: AdminProvider) {
    setConfirming(null)
    try {
      await api.delete(`/settings/ai/keys/${p.provider}`)
      addToast({ message: t("kernel.usage.keyRemoved", { provider: p.label }), type: "success" })
      changed()
    } catch (err) {
      const conflict = err instanceof ApiError && err.code === "auto_model"
      addToast({
        message: conflict ? t("kernel.aiModels.keyRunsAuto") : t("kernel.usage.failedRemoveKey"),
        type: "error",
      })
    }
  }

  // ─── Panels ───
  const [panel, setPanel] = createSignal<"catalogue" | "server" | null>(null)
  const togglePanel = (which: "catalogue" | "server") =>
    setPanel((open) => (open === which ? null : which))

  // ─── OpenRouter catalogue ───
  const [search, setSearch] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [toolsOnly, setToolsOnly] = createSignal(true)
  const [adding, setAdding] = createSignal<string | null>(null)
  const [catalogueError, setCatalogueError] = createSignal("")
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(searchTimer))

  function onSearch(value: string) {
    setSearch(value)
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => setQuery(value.trim()), SEARCH_DEBOUNCE_MS)
  }

  // The OpenRouter key is part of the source: an admin who opens the
  // catalogue, is told to add a key and saves one sees the catalogue load in
  // place, instead of the "add a key" line until the panel is reopened.
  const openRouterKeySet = () =>
    state.data.providers.some((p) => p.provider === "openrouter" && p.keySet)
  const [catalogue] = createResource(
    () =>
      panel() === "catalogue"
        ? { q: query(), toolsOnly: toolsOnly(), keySet: openRouterKeySet() }
        : false,
    async ({ q, toolsOnly: only }): Promise<CatalogueState> => {
      const params = new URLSearchParams({ q, toolsOnly: String(only) })
      try {
        const raw = await api.get<unknown>(`/settings/ai/openrouter/catalogue?${params}`)
        return { status: "ready", rows: catalogueRows(raw) }
      } catch (err) {
        return err instanceof ApiError && err.status === 412
          ? { status: "needs-key" }
          : { status: "unreachable" }
      }
    },
  )

  /** The last catalogue answer, filtered as typed (the server's own search
   *  narrows what it sends; this keeps the list in step between requests). */
  const catalogueView = () => {
    const current = catalogue.latest
    if (current?.status !== "ready") return []
    const needle = search().trim().toLowerCase()
    return current.rows
      .filter((r) => !toolsOnly() || r.tools)
      .filter((r) => !needle || `${r.displayName} ${r.upstreamId}`.toLowerCase().includes(needle))
  }
  const alreadyAdded = (r: CatalogueRow) =>
    r.added || state.data.models.some((m) => m.key === `openrouter/${r.upstreamId}`)

  async function addFromCatalogue(r: CatalogueRow) {
    setAdding(r.upstreamId)
    setCatalogueError("")
    try {
      await api.post("/settings/ai/openrouter/models", { upstreamId: r.upstreamId })
      addToast({
        message: t("kernel.aiModels.added", { model: r.displayName }),
        type: "success",
      })
      changed()
    } catch (err) {
      setCatalogueError(errorMessage(err) || t("kernel.aiModels.catalogueAddFailed"))
    } finally {
      setAdding(null)
    }
  }

  // ─── Your own server ───
  const [address, setAddress] = createSignal("")
  const [serverKey, setServerKey] = createSignal("")
  const [serverModel, setServerModel] = createSignal("")
  const [serverContext, setServerContext] = createSignal("")
  const [testing, setTesting] = createSignal(false)
  const [serverResult, setServerResult] = createSignal<ServerResult | null>(null)

  async function testServer() {
    const baseURL = address().trim()
    const name = serverModel().trim()
    if (!baseURL || !name || testing()) return
    setTesting(true)
    setServerResult(null)
    try {
      let server = state.data.servers.find((s) => s.baseURL === baseURL)
      if (!server) {
        const body: { name: string; baseURL: string; apiKey?: string } = {
          name: hostOf(baseURL),
          baseURL,
        }
        if (serverKey().trim()) body.apiKey = serverKey().trim()
        server = await api.post<AdminServer>("/settings/ai/servers", body)
      }
      const body: { name: string; contextWindow?: number } = { name }
      const context = Number(serverContext())
      if (Number.isFinite(context) && context > 0) body.contextWindow = Math.round(context)
      const added = await api.post<{ tools?: boolean } | null>(
        `/settings/ai/servers/${encodeURIComponent(server.id)}/models`,
        body,
      )
      setServerResult({ outcome: added?.tools === true ? "tools" : "no-tools" })
      setServerModel("")
      changed()
    } catch (err) {
      setServerResult({
        outcome: "error",
        message: errorMessage(err) || t("kernel.aiModels.serverNoAnswer"),
      })
      // The server row may exist even when its first model did not answer.
      void refetch()
    } finally {
      setTesting(false)
    }
  }

  // ─── Rendering ───
  const chip = "rounded-full border px-1.5 text-[11px] whitespace-nowrap"
  const th =
    "border-b border-border-subtle bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-text-tertiary"
  const td = "border-b border-border-subtle px-2.5 py-2 align-middle"
  const num = "font-mono text-[12px] tabular-nums text-text-secondary whitespace-nowrap"
  const field =
    "rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent-muted"

  const capabilityChips = (tools: boolean, reasoning: boolean) => (
    <span class="flex flex-wrap gap-1">
      <span
        class={`${chip} ${tools ? "border-border text-text-secondary" : "border-border text-text-tertiary"}`}
        data-tools={tools ? "true" : "false"}
      >
        {tools ? t("kernel.aiModels.chipTools") : t("kernel.aiModels.chipNoTools")}
      </span>
      <Show when={reasoning}>
        <span class={`${chip} border-border text-text-secondary`}>
          {t("kernel.aiModels.chipReasoning")}
        </span>
      </Show>
    </span>
  )

  return (
    <div class="flex max-w-4xl flex-col gap-8" data-testid="ai-models-settings">
      <div>
        <h1 class="mb-1 text-lg font-semibold text-text">{t("kernel.aiModels.title")}</h1>
        <p class="max-w-prose text-sm text-text-secondary">{t("kernel.aiModels.lede")}</p>
      </div>

      <Show when={loadFailed() && !state.loaded}>
        <p class="text-sm text-error" data-testid="ai-models-load-failed">
          {t("kernel.aiModels.loadFailed")}
        </p>
      </Show>

      <Show
        when={state.loaded}
        fallback={
          <Show when={!loadFailed()}>
            <div class="flex flex-col gap-3" data-testid="ai-models-skeleton">
              <Skeleton class="h-10" />
              <Skeleton class="h-24" />
              <Skeleton class="h-40" />
            </div>
          </Show>
        }
      >
        {/* Auto */}
        <section class="flex flex-col gap-2" data-testid="ai-models-auto">
          <h2 class="text-sm font-semibold text-text">{t("kernel.aiModels.autoTitle")}</h2>
          <p class="text-[13px] text-text-secondary">{t("kernel.aiModels.autoDesc")}</p>
          <div class="flex flex-wrap items-center gap-2">
            <label for="ai-models-auto-select" class="text-[13px] text-text">
              {t("kernel.aiModels.autoLabel")}
            </label>
            <select
              id="ai-models-auto-select"
              data-testid="ai-models-auto-select"
              class={field}
              disabled={autoSaving()}
              value={state.data.auto.modelKey ?? ""}
              onChange={(e) => void setAuto(e.currentTarget.value)}
            >
              <option value="">
                {managed()
                  ? t("kernel.aiModels.autoDefaultOptionManaged")
                  : t("kernel.aiModels.autoDefaultOption")}
              </option>
              <For each={autoChoices()}>
                {(m) => (
                  <option value={m.key}>
                    {m.displayName} · {providerLabel(m)}
                  </option>
                )}
              </For>
              <Show
                when={
                  state.data.auto.modelKey &&
                  !autoChoices().some((m) => m.key === state.data.auto.modelKey)
                }
              >
                <option value={state.data.auto.modelKey ?? ""} disabled>
                  {nameOf(state.data.auto.modelKey)}
                </option>
              </Show>
            </select>
            <Show when={modelByKey(autoKey())}>
              {(m) => (
                <span class="text-[12px] text-text-tertiary" data-testid="ai-models-auto-runs">
                  {managed()
                    ? t("kernel.aiModels.autoRunsCredits", {
                        model: m().displayName,
                        multiplier: priceCell(m()),
                      })
                    : t("kernel.aiModels.autoRuns", {
                        model: m().displayName,
                        price: priceCell(m()),
                      })}
                </span>
              )}
            </Show>
          </div>
          <Show when={autoFellBack()}>
            <p class="text-[12px] text-text-secondary" data-testid="ai-models-auto-fallback">
              {t("kernel.aiModels.autoFallback", {
                resolved: nameOf(autoKey()),
                chosen: nameOf(state.data.auto.modelKey),
              })}
            </p>
          </Show>
        </section>

        {/* Default reasoning level */}
        <section class="flex flex-col gap-2" data-testid="ai-models-reasoning">
          <h2 class="text-sm font-semibold text-text">{t("kernel.aiModels.reasoningTitle")}</h2>
          <p class="text-[13px] text-text-secondary">{t("kernel.aiModels.reasoningDesc")}</p>
          <div class="flex flex-wrap items-center gap-2">
            <label for="ai-models-reasoning-select" class="text-[13px] text-text">
              {t("kernel.aiModels.reasoningLabel")}
            </label>
            <select
              id="ai-models-reasoning-select"
              data-testid="ai-models-reasoning-select"
              class={field}
              disabled={reasoningSaving()}
              value={state.data.defaultReasoningLevel ?? ""}
              onChange={(e) => void setDefaultReasoning(e.currentTarget.value)}
            >
              <option value="">{t("kernel.aiModels.reasoningDefaultOption")}</option>
              <For each={REASONING_LEVELS}>
                {(level) => <option value={level}>{t(REASONING_LABEL_KEY[level])}</option>}
              </For>
            </select>
          </div>
        </section>

        {/* Providers: keys are the org's own (BYOK), refused on a managed cell */}
        <Show when={!managed()}>
          <section class="flex flex-col gap-2" data-testid="ai-models-providers">
            <h2 class="text-sm font-semibold text-text">{t("kernel.aiModels.providersTitle")}</h2>
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <For each={usableProviders()}>
                {(p) => (
                  <div
                    data-testid={`provider-card-${p.provider}`}
                    data-key-set={p.keySet ? "true" : "false"}
                    class="flex flex-col gap-1.5 rounded-md border border-border-subtle px-3 py-2.5"
                  >
                    <div class="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        class={`h-1.5 w-1.5 rounded-full ${p.usable ? "bg-success" : "bg-border-strong"}`}
                      />
                      <span class="text-sm font-medium text-text">{p.label}</span>
                    </div>
                    <Show
                      when={configuring() === p.provider}
                      fallback={
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="flex-1 font-mono text-xs text-text-secondary">
                            {p.keySet
                              ? t("kernel.usage.connectedHint", { hint: p.maskedHint ?? "" })
                              : p.usable
                                ? t("kernel.aiModels.deploymentKey")
                                : t("kernel.usage.notConnected")}
                          </span>
                          <Show
                            when={p.keySet}
                            fallback={
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`provider-configure-${p.provider}`}
                                onClick={() => openKeyForm(p)}
                              >
                                {t("kernel.usage.configure")}
                              </Button>
                            }
                          >
                            <Show
                              when={confirming() === `key:${p.provider}`}
                              fallback={
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    data-testid={`provider-recheck-${p.provider}`}
                                    loading={rechecking() === p.provider}
                                    onClick={() => void recheckKey(p)}
                                  >
                                    {t("kernel.usage.revalidate")}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    data-testid={`provider-remove-${p.provider}`}
                                    onClick={() => setConfirming(`key:${p.provider}`)}
                                  >
                                    {t("kernel.usage.remove")}
                                  </Button>
                                </>
                              }
                            >
                              <span class="text-xs text-text-secondary">
                                {t("kernel.usage.removeConfirm")}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`provider-remove-confirm-${p.provider}`}
                                onClick={() => void removeKey(p)}
                              >
                                {t("kernel.usage.confirm")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`provider-remove-cancel-${p.provider}`}
                                onClick={() => setConfirming(null)}
                              >
                                {t("kernel.usage.cancel")}
                              </Button>
                            </Show>
                          </Show>
                        </div>
                      }
                    >
                      {keyForm(p)}
                    </Show>
                  </div>
                )}
              </For>
              <div
                data-testid="provider-card-custom"
                class="flex flex-col gap-1.5 rounded-md border border-border-subtle px-3 py-2.5"
              >
                <div class="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    class={`h-1.5 w-1.5 rounded-full ${state.data.servers.length > 0 ? "bg-success" : "bg-border-strong"}`}
                  />
                  <span class="text-sm font-medium text-text">
                    {t("kernel.aiModels.ownServer")}
                  </span>
                </div>
                <span class="truncate text-xs text-text-secondary">
                  {state.data.servers.length > 0
                    ? state.data.servers.map((s) => s.name).join(", ")
                    : t("kernel.aiModels.ownServerNone")}
                </span>
              </div>
            </div>
            <p class="text-[12px] text-text-tertiary">{t("kernel.aiModels.openRouterPolicy")}</p>
          </section>
        </Show>

        {/* OpenRouter hosts this organization's requests never reach */}
        <Show when={state.data.blockedHosts}>
          {(view) => (
            <BlockedHostsSection
              value={view()}
              onSaved={(next) => setState("data", "blockedHosts", next)}
            />
          )}
        </Show>

        {/* Voice dictation */}
        <VoiceDictationSection version={version()} />

        {/* Conversation history */}
        <HistorySection />

        {/* Models */}
        <section class="flex flex-col gap-3" data-testid="ai-models-models">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-semibold text-text">
              {t("kernel.aiModels.modelsTitle")}{" "}
              <span class="font-normal text-text-tertiary" data-testid="ai-models-on-count">
                ({onCount()})
              </span>
            </h2>
            <div class="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="ai-models-open-catalogue"
                aria-expanded={panel() === "catalogue"}
                onClick={() => togglePanel("catalogue")}
              >
                {t("kernel.aiModels.addFromOpenRouter")}
              </Button>
              <Show when={!managed()}>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="ai-models-open-server"
                  aria-expanded={panel() === "server"}
                  onClick={() => togglePanel("server")}
                >
                  {t("kernel.aiModels.addOwnServer")}
                </Button>
              </Show>
            </div>
          </div>

          {/* The OpenRouter catalogue, inline (the admin keeps the page) */}
          <Show when={panel() === "catalogue"}>
            <div
              class="flex flex-col gap-2.5 rounded-md border border-border bg-surface p-3"
              data-testid="ai-models-catalogue"
            >
              <div class="flex flex-wrap items-center gap-2">
                <input
                  type="search"
                  data-testid="catalogue-search"
                  aria-label={t("kernel.aiModels.catalogueSearch")}
                  placeholder={t("kernel.aiModels.catalogueSearch")}
                  value={search()}
                  onInput={(e) => onSearch(e.currentTarget.value)}
                  class={`${field} min-w-0 flex-1 basis-48`}
                />
                <label class="flex items-center gap-1.5 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    data-testid="catalogue-tools-only"
                    checked={toolsOnly()}
                    onChange={(e) => setToolsOnly(e.currentTarget.checked)}
                  />
                  {t("kernel.aiModels.toolsOnly")}
                </label>
              </div>
              <Show when={catalogue.latest?.status === "needs-key"}>
                <p class="text-[13px] text-text-secondary" data-testid="catalogue-needs-key">
                  {t("kernel.aiModels.catalogueNeedsKey")}
                </p>
              </Show>
              <Show when={catalogue.latest?.status === "unreachable"}>
                <p class="text-[13px] text-text-secondary" data-testid="catalogue-unreachable">
                  {t("kernel.aiModels.catalogueUnreachable")}
                </p>
              </Show>
              <Show when={catalogueError()}>
                <p class="text-[13px] text-error" data-testid="catalogue-error" role="alert">
                  {catalogueError()}
                </p>
              </Show>
              <Show
                when={catalogue.latest?.status === "ready"}
                fallback={
                  <Show when={catalogue.loading}>
                    <Skeleton class="h-24" />
                  </Show>
                }
              >
                <div class="max-h-96 overflow-auto rounded-md border border-border-subtle bg-bg">
                  <table class="w-full border-collapse text-[13px]">
                    <thead>
                      <tr>
                        <th class={th}>{t("kernel.aiModels.colModel")}</th>
                        <th class={th}>
                          {managed() ? t("kernel.aiModels.colCost") : t("kernel.aiModels.colPrice")}
                        </th>
                        <th class={th}>{t("kernel.aiModels.colContext")}</th>
                        <th class={th} />
                        <th class={th} />
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={catalogueView()}
                        fallback={
                          <tr>
                            <td class={`${td} text-text-tertiary`} colSpan={5}>
                              {t("kernel.aiModels.catalogueEmpty")}
                            </td>
                          </tr>
                        }
                      >
                        {(r) => (
                          <tr data-testid={`catalogue-row-${r.upstreamId}`}>
                            <td class={td}>
                              <div class="text-text">{r.displayName}</div>
                              <div class="text-[12px] text-text-tertiary">{r.upstreamId}</div>
                            </td>
                            <td class={`${td} ${num}`}>{priceCell(r)}</td>
                            <td class={`${td} ${num}`}>{contextCell(r.contextWindow)}</td>
                            <td class={td}>
                              {capabilityChips(r.tools, r.reasoningEfforts.length > 0)}
                            </td>
                            <td class={`${td} text-right`}>
                              <Show
                                when={!alreadyAdded(r)}
                                fallback={
                                  <span class="text-[12px] text-text-tertiary">
                                    {t("kernel.aiModels.catalogueAdded")}
                                  </span>
                                }
                              >
                                <div class="flex flex-col items-end gap-1">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    data-testid={`catalogue-add-${r.upstreamId}`}
                                    loading={adding() === r.upstreamId}
                                    disabled={adding() !== null || r.addable === false}
                                    onClick={() => void addFromCatalogue(r)}
                                  >
                                    {t("kernel.aiModels.catalogueAdd")}
                                  </Button>
                                  <Show when={r.addable === false}>
                                    <span
                                      class="max-w-[16rem] text-[12px] text-text-tertiary"
                                      data-testid={`catalogue-not-addable-${r.upstreamId}`}
                                    >
                                      {t("kernel.aiModels.catalogueNoFixedPrice")}
                                    </span>
                                  </Show>
                                </div>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              <p class="text-[12px] text-text-tertiary">
                {t("kernel.aiModels.catalogueToolsNote")}
              </p>
            </div>
          </Show>

          {/* The organization's own OpenAI-compatible server */}
          <Show when={panel() === "server" && !managed()}>
            <div
              class="flex flex-col gap-2.5 rounded-md border border-border bg-surface p-3"
              data-testid="ai-models-server"
            >
              <div class="flex flex-wrap items-center gap-2">
                <input
                  type="url"
                  data-testid="server-address"
                  aria-label={t("kernel.aiModels.serverAddress")}
                  placeholder="http://gpu-box.internal:8000/v1"
                  value={address()}
                  onInput={(e) => setAddress(e.currentTarget.value)}
                  class={`${field} min-w-0 flex-1 basis-56`}
                />
                <input
                  type="password"
                  data-testid="server-key"
                  aria-label={t("kernel.aiModels.serverKey")}
                  placeholder={t("kernel.aiModels.serverKey")}
                  value={serverKey()}
                  onInput={(e) => setServerKey(e.currentTarget.value)}
                  class={`${field} min-w-0 basis-36`}
                />
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  data-testid="server-model"
                  aria-label={t("kernel.aiModels.serverModel")}
                  placeholder={t("kernel.aiModels.serverModel")}
                  value={serverModel()}
                  onInput={(e) => setServerModel(e.currentTarget.value)}
                  class={`${field} min-w-0 flex-1 basis-40`}
                />
                <input
                  type="number"
                  min="1"
                  inputmode="numeric"
                  data-testid="server-context"
                  aria-label={t("kernel.aiModels.serverContext")}
                  placeholder={t("kernel.aiModels.serverContext")}
                  value={serverContext()}
                  onInput={(e) => setServerContext(e.currentTarget.value)}
                  class={`${field} w-40`}
                />
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="server-test"
                  loading={testing()}
                  disabled={!address().trim() || !serverModel().trim()}
                  onClick={() => void testServer()}
                >
                  {t("kernel.aiModels.serverTest")}
                </Button>
              </div>
              <p class="text-[12px] text-text-tertiary">{t("kernel.aiModels.serverHelp")}</p>
              <Show when={serverResult()}>
                {(result) => (
                  <div
                    class="flex flex-col gap-0.5 text-[13px]"
                    data-testid="server-result"
                    data-outcome={result().outcome}
                    role="status"
                  >
                    <Show
                      when={result().outcome !== "error"}
                      fallback={
                        <span class="text-error">
                          {t("kernel.aiModels.serverFailed", {
                            reason: (result() as { message: string }).message,
                          })}
                        </span>
                      }
                    >
                      <span class={result().outcome === "tools" ? "text-success" : "text-text"}>
                        {result().outcome === "tools"
                          ? t("kernel.aiModels.serverOkTools")
                          : t("kernel.aiModels.serverOkNoTools")}
                      </span>
                      <span class="text-[12px] text-text-tertiary">
                        {t("kernel.aiModels.serverAddedNote")}
                      </span>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={state.data.servers.length > 0}>
                <div class="flex flex-col gap-1" data-testid="ai-models-servers">
                  <span class="text-[12px] font-medium text-text-secondary">
                    {t("kernel.aiModels.serversTitle")}
                  </span>
                  <For each={state.data.servers}>
                    {(s) => (
                      <div
                        class="flex min-h-9 flex-wrap items-center gap-2 text-[13px]"
                        data-testid={`server-row-${s.id}`}
                      >
                        <span class="text-text">{s.name}</span>
                        <span class="flex-1 truncate font-mono text-[12px] text-text-tertiary">
                          {s.baseURL}
                        </span>
                        <Show
                          when={confirming() === `server:${s.id}`}
                          fallback={
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`server-remove-${s.id}`}
                              onClick={() => setConfirming(`server:${s.id}`)}
                            >
                              {t("kernel.aiModels.removeServer")}
                            </Button>
                          }
                        >
                          <span class="text-xs text-text-secondary">
                            {t("kernel.aiModels.removeServerConfirm")}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`server-remove-confirm-${s.id}`}
                            onClick={() => void removeServer(s.id)}
                          >
                            {t("kernel.usage.confirm")}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                            {t("kernel.usage.cancel")}
                          </Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <div class="overflow-x-auto rounded-md border border-border-subtle">
            <table class="w-full border-collapse text-[13px]" data-testid="ai-models-table">
              <thead>
                <tr>
                  <th class={th}>{t("kernel.aiModels.colOn")}</th>
                  <th class={th}>{t("kernel.aiModels.colModel")}</th>
                  <th class={th}>
                    {managed() ? t("kernel.aiModels.colCost") : t("kernel.aiModels.colPrice")}
                  </th>
                  <th class={th}>{t("kernel.aiModels.colContext")}</th>
                  <th class={th} />
                  <th class={th} />
                </tr>
              </thead>
              <tbody>
                <For each={listedModels()}>
                  {(m) => {
                    const isAuto = () => m.key === autoKey()
                    const control = () => (
                      <Switch
                        checked={m.enabled}
                        onChange={(next) => void toggleModel(m, next)}
                        label={t("kernel.aiModels.switchLabel", { model: m.displayName })}
                        disabled={isAuto() || switching() === m.key}
                        data-testid={`ai-model-switch-${m.key}`}
                      />
                    )
                    return (
                      <tr
                        data-testid={`ai-model-row-${m.key}`}
                        data-enabled={m.enabled ? "true" : "false"}
                        data-auto={isAuto() ? "true" : undefined}
                      >
                        <td class={td}>
                          <Show when={isAuto()} fallback={control()}>
                            <Tooltip content={t("kernel.aiModels.autoLocked")}>{control()}</Tooltip>
                          </Show>
                        </td>
                        <td class={td}>
                          <div class="flex flex-wrap items-center gap-1.5">
                            <span class={m.enabled ? "text-text" : "text-text-secondary"}>
                              {m.displayName}
                            </span>
                            <Show when={isAuto()}>
                              <span class={`${chip} border-accent-border text-accent`}>
                                {t("kernel.aiModels.chipAuto")}
                              </span>
                            </Show>
                            <Show when={!runnable(m)}>
                              <span
                                class={`${chip} border-border text-text-tertiary`}
                                data-testid={`ai-model-key-removed-${m.key}`}
                              >
                                {t("kernel.aiModels.keyRemoved")}
                              </span>
                            </Show>
                            <Show when={m.unavailableSince}>
                              <span class={`${chip} border-border text-text-tertiary`}>
                                {t("kernel.aiModels.chipGone")}
                              </span>
                            </Show>
                          </div>
                          <div class="text-[12px] text-text-tertiary">{providerLabel(m)}</div>
                        </td>
                        <td class={`${td} ${num}`}>{priceCell(m)}</td>
                        <td class={`${td} ${num}`}>{contextCell(m.contextWindow)}</td>
                        <td class={td}>
                          {capabilityChips(m.tools, hasReasoning(m.reasoning?.allowedLevels))}
                        </td>
                        <td class={`${td} text-right`}>
                          <Show when={!m.native && !isAuto()}>
                            <Show
                              when={confirming() === `model:${m.key}`}
                              fallback={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  data-testid={`ai-model-remove-${m.key}`}
                                  onClick={() => setConfirming(`model:${m.key}`)}
                                >
                                  {t("kernel.usage.remove")}
                                </Button>
                              }
                            >
                              <div class="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  data-testid={`ai-model-remove-confirm-${m.key}`}
                                  onClick={() => void removeModel(m.key)}
                                >
                                  {t("kernel.usage.confirm")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setConfirming(null)}
                                >
                                  {t("kernel.usage.cancel")}
                                </Button>
                              </div>
                            </Show>
                          </Show>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={lockedProviders().length > 0}>
            <div class="flex flex-col gap-1.5" data-testid="ai-models-locked-providers">
              <For each={lockedProviders()}>
                {(p) => (
                  <div
                    data-testid={`provider-card-${p.provider}`}
                    data-key-set="false"
                    data-locked="true"
                    class="flex flex-col gap-1.5 rounded-md border border-border-subtle px-3 py-2"
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-border-strong" />
                      <span
                        class="flex-1 text-[13px] text-text-secondary"
                        data-testid={`provider-locked-${p.provider}`}
                      >
                        {lockedLabel(p)}
                      </span>
                      <Show when={configuring() !== p.provider}>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`provider-configure-${p.provider}`}
                          aria-expanded="false"
                          onClick={() => openKeyForm(p)}
                        >
                          {t("kernel.usage.configure")}
                        </Button>
                      </Show>
                    </div>
                    <Show when={configuring() === p.provider}>{keyForm(p)}</Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <p class="text-[12px] text-text-tertiary">{t("kernel.aiModels.switchedOffNote")}</p>
        </section>
      </Show>
    </div>
  )
}

export default AiModelsSettings
