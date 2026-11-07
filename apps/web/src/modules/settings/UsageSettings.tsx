// SPDX-License-Identifier: FSL-1.1-ALv2

import { MODEL_PRICING_SEED } from "@liaison/shared"
import { A } from "@solidjs/router"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { currentLocale, tNow, useI18n } from "~/modules/i18n/i18n-context"
import { createBillingState, isManagedUnavailable } from "~/modules/settings/BillingState"
import { creditVersion } from "~/modules/settings/credit-store"
import { formatCreditAmount } from "~/modules/settings/credits-format"
import { usageAmountDisplay } from "~/modules/settings/usage-amount"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"

/** A managed cell's balance (S18): credits and the period's use, never money. */
interface BalanceData {
  mode: "managed"
  credits: { included: string; purchased: string; total: string }
  period: {
    start: string | null
    end: string | null
    availableThisPeriod: string
    usedThisPeriod: string
    usedPercent: number
  }
}

interface Transaction {
  id: string
  type: string
  amount: string
  model: string | null
  /** Self-hosted only: a managed cell serves no token counts (S18). */
  inputTokens?: number | null
  outputTokens?: number | null
  userId: string | null
  userName: string | null
  description: string | null
  createdAt: string
}

interface TransactionPage {
  items: Transaction[]
  cursor: string | null
  hasMore: boolean
}

interface UsageBucket {
  date: string
  total: string
  models: Record<string, string>
}

interface OrgUser {
  id: string
  name: string
  email: string
}

const TYPE_BADGES: Record<string, { label: string; class: string }> = {
  usage: {
    label: "kernel.settingsUi.txn.usage",
    class: "bg-surface-secondary text-text-secondary",
  },
  byok_usage: { label: "BYOK", class: "bg-surface-secondary text-text-secondary" },
  tool_usage: {
    label: "kernel.settingsUi.txn.tool",
    class: "bg-surface-secondary text-text-secondary",
  },
  top_up: { label: "kernel.settingsUi.txn.topUp", class: "bg-emerald-500/10 text-emerald-600" },
  monthly_reset: { label: "kernel.settingsUi.txn.reset", class: "bg-blue-500/10 text-blue-600" },
  refund: { label: "kernel.settingsUi.txn.refund", class: "bg-amber-500/10 text-amber-600" },
}

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Google" },
  { id: "mistral", name: "Mistral" },
  { id: "openrouter", name: "OpenRouter" },
]

// Unique model IDs from the pricing seed for the filter dropdown
const MODEL_OPTIONS = [
  ...new Map(
    MODEL_PRICING_SEED.filter((m) => m.provider !== "system").map((m) => [
      m.modelId,
      { id: m.modelId, label: m.displayName },
    ]),
  ).values(),
]

/** A chart figure (axis tick, tooltip) in the reader's locale and currency. */
export function chartMoney(value: number, cur = "EUR", maxFractionDigits = 2): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: cur,
    maximumFractionDigits: maxFractionDigits,
  }).format(Number.isFinite(value) ? value : 0)
}

const fmt = (val: string, cur = "EUR") => {
  const n = Number(val)
  return new Intl.NumberFormat(currentLocale(), { style: "currency", currency: cur }).format(n)
}

// Map each pricing-seed model to its provider for per-provider spend attribution.
const MODEL_PROVIDER = new Map(MODEL_PRICING_SEED.map((m) => [m.modelId, m.provider]))

// Resolve a model ID to its provider. Exact match first; if the ID is a
// dated/variant string not in the seed (e.g. "claude-haiku-4-5-20251001"),
// fall back to the longest seed modelId that is a prefix of it so the spend is
// still attributed instead of silently dropped.
function providerForModel(modelId: string): string | undefined {
  // Added models carry their provider in the key (S6): openrouter/<id>, and
  // custom/<server>/<name>, which costs nothing and so has no spend row.
  if (modelId.startsWith("openrouter/")) return "openrouter"
  if (modelId.startsWith("custom/")) return "custom"
  const exact = MODEL_PROVIDER.get(modelId)
  if (exact) return exact
  let best: { id: string; provider: string } | undefined
  for (const m of MODEL_PRICING_SEED) {
    if (modelId.startsWith(m.modelId) && (!best || m.modelId.length > best.id.length)) {
      best = { id: m.modelId, provider: m.provider }
    }
  }
  return best?.provider
}

const UsageSettings: Component = () => {
  const api = useApi()
  const { t } = useI18n()
  const isAdmin = () => hasScope("kernel:org:admin")

  // ─── Edition-conditional billing state ───
  // Lift this above the balance resource so self-hosted skips the /credits/balance
  // round trip entirely — the response is gated downstream by `isManaged()`, so
  // fetching it on every BYOK page load is wasted network.
  const [billingState, { refetch: refetchBillingState }] = createBillingState(api)
  const isManaged = () => billingState()?.mode === "managed"

  // ─── Balance (reactive to WS credit updates) ───
  // Source returns `false` on self-hosted so createResource never invokes the
  // fetcher; on managed it tracks the WS-driven creditVersion signal.
  const [balance] = createResource(
    () => (isManaged() ? creditVersion() : false),
    async () => api.get<BalanceData>("/credits/balance"),
  )

  // Self-hosted shows the real cost in EUR (S19); a managed cell shows credits (S18).
  const amount = (value: string | number) =>
    isManaged()
      ? t("kernel.usage.creditsAmount", { amount: formatCreditAmount(value) })
      : fmt(String(value), "EUR")
  const chartAmount = (value: number, maxFractionDigits: number) =>
    isManaged() ? formatCreditAmount(value) : chartMoney(value, "EUR", maxFractionDigits)

  // ─── Org members (admin-only, for user filter) ───
  const [orgUsers] = createResource(
    () => isAdmin(),
    async (admin) => {
      if (!admin) return []
      return api.get<OrgUser[]>("/admin/users")
    },
  )

  // ─── Usage Chart ───
  const [chartPeriod, setChartPeriod] = createSignal<"7d" | "30d" | "90d">("30d")
  let canvasRef: HTMLCanvasElement | undefined
  let chartInstance: any = null

  const usageDateRange = createMemo(() => {
    const now = new Date()
    const days = chartPeriod() === "7d" ? 7 : chartPeriod() === "30d" ? 30 : 90
    const from = new Date(now.getTime() - days * 86400000)
    return {
      period: days <= 30 ? ("daily" as const) : ("weekly" as const),
      from: from.toISOString().split("T")[0],
      to: now.toISOString().split("T")[0],
    }
  })

  const [usageData] = createResource(usageDateRange, async (range) => {
    return api.get<{ buckets: UsageBucket[]; totalCost?: string; totalCredits?: string }>(
      `/credits/usage?period=${range.period}&from=${range.from}&to=${range.to}`,
    )
  })

  createEffect(
    on(usageData, async (data) => {
      if (!data || !canvasRef) return
      const { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } =
        await import("chart.js")
      Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend)

      if (chartInstance) chartInstance.destroy()

      const allModels = new Set<string>()
      for (const bucket of data.buckets) {
        for (const model of Object.keys(bucket.models)) allModels.add(model)
      }
      const modelList = [...allModels]
      const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#ec4899"]

      // Map model IDs to display names
      const modelDisplayName = (id: string) => {
        const entry = MODEL_PRICING_SEED.find((m) => m.modelId === id)
        return entry?.displayName ?? id
      }

      const datasets = modelList.map((model, i) => ({
        label: modelDisplayName(model),
        data: data.buckets.map((b) => Number(b.models[model] ?? 0)),
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 3,
        maxBarThickness: 48,
      }))

      // Format date labels: "Apr 5" instead of "2026-04-05"
      const dateLabels = data.buckets.map((b) => {
        const d = new Date(`${b.date}T00:00:00`)
        return d.toLocaleDateString(currentLocale(), { month: "short", day: "numeric" })
      })

      const gridColor = "#1e1e24"
      const textColor = "#65656e"

      chartInstance = new Chart(canvasRef, {
        type: "bar",
        data: {
          labels: dateLabels,
          datasets,
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              stacked: true,
              grid: { display: false },
              ticks: { color: textColor, font: { size: 11 } },
              border: { display: false },
            },
            y: {
              stacked: true,
              beginAtZero: true,
              grid: { color: gridColor },
              border: { display: false },
              ticks: {
                color: textColor,
                font: { size: 11 },
                // The same locale formatter as the table beside it ("2,41 €"),
                // not a hand-glued "€2.5".
                callback: (v: any) => chartAmount(Number(v), 2),
              },
            },
          },
          plugins: {
            legend: {
              position: "bottom",
              labels: {
                color: textColor,
                usePointStyle: true,
                pointStyle: "circle",
                padding: 16,
                font: { size: 11 },
              },
            },
            tooltip: {
              callbacks: {
                label: (ctx: any) =>
                  `${ctx.dataset.label}${tNow("kernel.capabilities.separator")}${chartAmount(Number(ctx.raw), 4)}`,
              },
            },
          },
        },
      })
    }),
  )

  onCleanup(() => {
    if (chartInstance) chartInstance.destroy()
  })

  // ─── Transactions ───
  const [transactions, setTransactions] = createSignal<Transaction[]>([])
  // A managed org's models are its own (OpenRouter ids): offer what it actually used, not the
  // native list of a self-hosted server. Stays stable once a model has been seen.
  const seenModels = new Set<string>()
  const modelOptions = () => {
    if (!isManaged()) return MODEL_OPTIONS
    for (const row of transactions()) if (row.model) seenModels.add(row.model)
    return [...seenModels].sort().map((id) => ({ id, label: id.replace(/^openrouter\//, "") }))
  }
  const [txnCursor, setTxnCursor] = createSignal<string | null>(null)
  const [txnHasMore, setTxnHasMore] = createSignal(false)
  const [txnLoading, setTxnLoading] = createSignal(false)

  const [filterUserId, setFilterUserId] = createSignal<string | null>(null)
  const [filterModel, setFilterModel] = createSignal<string | null>(null)
  const [filterType, setFilterType] = createSignal<string | null>(null)
  const [filterDateFrom, setFilterDateFrom] = createSignal<string | null>(null)
  const [filterDateTo, setFilterDateTo] = createSignal<string | null>(null)

  async function loadTransactions(cursor?: string) {
    setTxnLoading(true)
    if (!cursor) setTransactions([])
    try {
      const params = new URLSearchParams({ limit: "20" })
      if (cursor) params.set("cursor", cursor)
      if (filterUserId()) params.set("userId", filterUserId()!)
      if (filterModel()) params.set("model", filterModel()!)
      if (filterType()) params.set("type", filterType()!)
      if (filterDateFrom()) params.set("dateFrom", filterDateFrom()!)
      if (filterDateTo()) params.set("dateTo", filterDateTo()!)
      const res = await api.get<TransactionPage>(`/credits/transactions?${params}`)
      setTransactions((prev) => (cursor ? [...prev, ...res.items] : res.items))
      setTxnCursor(res.cursor ?? null)
      setTxnHasMore(res.hasMore ?? false)
    } catch {
      addToast({ message: t("kernel.usage.couldNotLoadTransactions"), type: "error" })
    } finally {
      setTxnLoading(false)
    }
  }

  onMount(() => {
    loadTransactions()
  })

  // (billingState + isManaged hoisted above the balance resource.)

  // ─── Per-provider computed spend (derived from the chart's usage resource) ───
  const spendByProvider = createMemo(() => {
    const out: Record<string, number> = {}
    for (const bucket of usageData()?.buckets ?? []) {
      for (const [modelId, cost] of Object.entries(bucket.models)) {
        const prov = providerForModel(modelId)
        if (!prov) continue
        out[prov] = (out[prov] ?? 0) + Number(cost)
      }
    }
    return out
  })

  return (
    <div class="flex flex-col gap-8">
      <h1 data-testid="usage-title" class="text-lg font-semibold text-text">
        {t("kernel.usage.title")}
      </h1>

      <ErrorBoundary fallback={(err) => <p class="text-sm text-error">{err.message}</p>}>
        <Suspense
          fallback={
            <div class="flex gap-4">
              <Skeleton class="h-24 flex-1" />
              <Skeleton class="h-24 flex-1" />
            </div>
          }
        >
          {/* Section 1 — Credits left and the period's use (managed only;
              self-hosted BYOK has no credit balance). Plans and their prices
              are on the Billing page. */}
          <Show when={isManaged() && balance()?.mode === "managed" ? balance() : undefined}>
            {(b) => {
              const pct = () => Math.min(100, Math.max(0, b().period.usedPercent))
              const resetDays = () => {
                if (!b().period.end) return null
                const diff = new Date(b().period.end!).getTime() - Date.now()
                return Math.max(0, Math.ceil(diff / 86400000))
              }
              const isHigh = () => pct() > 80
              return (
                <div data-testid="usage-balance" class="grid gap-4 sm:grid-cols-2">
                  <div data-testid="balance-included" class="rounded-md border border-border p-4">
                    <p class="text-xs font-medium text-text-secondary">
                      {t("kernel.usage.creditsLeft")}
                    </p>
                    <p data-testid="credits-left" class="mt-1.5 text-2xl font-bold text-text">
                      {formatCreditAmount(b().credits.total)}
                    </p>
                    <p data-testid="credits-breakdown" class="mt-1 text-xs text-text-tertiary">
                      {t("kernel.usage.creditsBreakdown", {
                        included: formatCreditAmount(b().credits.included),
                        purchased: formatCreditAmount(b().credits.purchased),
                      })}
                    </p>
                  </div>
                  <div data-testid="balance-purchased" class="rounded-md border border-border p-4">
                    <p class="text-xs font-medium text-text-secondary">
                      {t("kernel.usage.includedUsage")}
                    </p>
                    <p
                      data-testid="credits-used-percent"
                      class="mt-1.5 text-2xl font-bold text-text"
                    >
                      {t("kernel.usage.periodUsed", { percent: Math.round(pct()) })}
                    </p>
                    <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-secondary">
                      <div
                        data-testid="credits-used-bar"
                        class={`h-2 rounded-full transition-all ${isHigh() ? (pct() >= 100 ? "bg-error" : "bg-amber-500") : "bg-accent"}`}
                        style={{ width: `${pct()}%` }}
                      />
                    </div>
                    <div class="mt-1.5 flex items-center justify-between">
                      <p data-testid="credits-period-used" class="text-xs text-text-tertiary">
                        {t("kernel.usage.periodAvailable", {
                          used: formatCreditAmount(b().period.usedThisPeriod),
                          available: formatCreditAmount(b().period.availableThisPeriod),
                        })}
                      </p>
                      <Show when={resetDays() !== null}>
                        <p data-testid="credits-resets-in" class="text-xs text-text-tertiary">
                          {t("kernel.usage.resetsInDays", { days: resetDays() ?? 0 })}
                        </p>
                      </Show>
                    </div>
                    <Show when={isHigh() && pct() < 100}>
                      <p data-testid="credits-running-low" class="mt-1 text-xs text-amber-500">
                        {t("kernel.usage.runningLow")}
                      </p>
                    </Show>
                    <Show when={pct() >= 100}>
                      <p data-testid="credits-depleted" class="mt-1 text-xs text-error">
                        {t("kernel.usage.depleted")}
                      </p>
                    </Show>
                  </div>
                </div>
              )
            }}
          </Show>
        </Suspense>

        {/* Section 3 — Managed-mode billing unavailability banner */}
        <Show when={billingState() && isManagedUnavailable(billingState()!)}>
          <div
            data-testid="billing-state-unavailable"
            class="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700"
          >
            <p class="font-medium">{t("kernel.usage.billingStateUnavailable")}</p>
            <p class="mt-1 text-xs text-amber-700/80">
              {t("kernel.usage.billingStateUnavailableHint")}
            </p>
            <div class="mt-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="billing-state-retry"
                onClick={() => refetchBillingState()}
              >
                {t("kernel.usage.retry")}
              </Button>
            </div>
          </div>
        </Show>

        {/* Section 4 — Usage Chart */}
        <div data-testid="usage-chart" class="rounded-md border border-border p-4">
          <div class="mb-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <span class="text-sm font-medium text-text">{t("kernel.usage.title")}</span>
              <div class="flex gap-0.5 rounded-md bg-surface-secondary p-0.5">
                <For each={["7d", "30d", "90d"] as const}>
                  {(p) => (
                    <button
                      type="button"
                      data-testid={`chart-period-${p}`}
                      aria-pressed={chartPeriod() === p}
                      class={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${chartPeriod() === p ? "bg-accent text-accent-foreground shadow-sm" : "text-text-secondary hover:text-text"}`}
                      onClick={() => setChartPeriod(p)}
                    >
                      {t(`kernel.settingsUi.usagePeriod.${p}`)}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={usageData()?.totalCredits ?? usageData()?.totalCost}>
              {(total) => (
                <span data-testid="usage-chart-total" class="text-xs text-text-secondary">
                  {t("kernel.usage.totalLabel")}{" "}
                  <span class="font-medium text-text">{amount(total())}</span>
                </span>
              )}
            </Show>
          </div>
          <Suspense fallback={<Skeleton class="h-52 w-full" />}>
            <Show
              when={usageData()?.buckets?.length}
              fallback={
                <p
                  data-testid="usage-chart-empty"
                  class="py-12 text-center text-sm text-text-tertiary"
                >
                  {t("kernel.usage.noUsageData")}
                </p>
              }
            >
              <div class="h-52">
                <canvas data-testid="usage-chart-canvas" ref={canvasRef} />
              </div>
            </Show>
          </Suspense>
          {/* Self-hosted: the chart is a BYOK computed estimate, not invoiced spend. */}
          <Show when={!isManaged()}>
            <p data-testid="computed-usage-disclaimer" class="mt-3 text-xs text-text-tertiary">
              {t("kernel.usage.computedUsageDisclaimer")}
            </p>
          </Show>
        </div>

        {/* Section 5 — Transaction History (managed) / Usage activity log (self-hosted) */}
        <div>
          <p data-testid="transactions-heading" class="mb-3 text-sm font-medium text-text">
            {isManaged() ? t("kernel.usage.transactions") : t("kernel.usage.activity")}
          </p>
          <div data-testid="transaction-filters" class="mb-3 flex flex-wrap items-center gap-2">
            {/* Admin-only: user filter */}
            <Show when={isAdmin()}>
              <select
                data-testid="filter-user"
                class="rounded border border-border bg-bg px-2 py-1 text-xs text-text"
                value={filterUserId() ?? ""}
                onChange={(e) => {
                  setFilterUserId(e.currentTarget.value || null)
                  loadTransactions()
                }}
              >
                <option value="">{t("kernel.usage.allUsers")}</option>
                <For each={orgUsers() ?? []}>{(u) => <option value={u.id}>{u.name}</option>}</For>
              </select>
            </Show>
            <select
              data-testid="filter-model"
              class="rounded border border-border bg-bg px-2 py-1 text-xs text-text"
              value={filterModel() ?? ""}
              onChange={(e) => {
                setFilterModel(e.currentTarget.value || null)
                loadTransactions()
              }}
            >
              <option value="">{t("kernel.usage.allModels")}</option>
              <For each={modelOptions()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
            </select>
            {/* Type filter only in managed mode — self-hosted rows are all byok_usage. */}
            <Show when={isManaged()}>
              <select
                data-testid="filter-type"
                class="rounded border border-border bg-bg px-2 py-1 text-xs text-text"
                value={filterType() ?? ""}
                onChange={(e) => {
                  setFilterType(e.currentTarget.value || null)
                  loadTransactions()
                }}
              >
                <option value="">{t("kernel.usage.allTypes")}</option>
                <option value="usage">{t("kernel.usage.typeUsage")}</option>
                <option value="top_up">{t("kernel.usage.typeTopUp")}</option>
                <option value="monthly_reset">{t("kernel.usage.typeReset")}</option>
                <option value="refund">{t("kernel.usage.typeRefund")}</option>
              </select>
            </Show>
            <input
              type="date"
              class="rounded border border-border bg-bg px-2 py-1 text-xs text-text"
              value={filterDateFrom() ?? ""}
              onInput={(e) => {
                setFilterDateFrom(e.currentTarget.value || null)
                loadTransactions()
              }}
            />
            <span class="text-xs text-text-tertiary">{t("kernel.usage.filterTo")}</span>
            <input
              type="date"
              class="rounded border border-border bg-bg px-2 py-1 text-xs text-text"
              value={filterDateTo() ?? ""}
              onInput={(e) => {
                setFilterDateTo(e.currentTarget.value || null)
                loadTransactions()
              }}
            />
          </div>

          <Show
            when={transactions().length > 0}
            fallback={
              <Show when={!txnLoading()} fallback={<Skeleton class="h-32 w-full" />}>
                <p
                  data-testid="transactions-empty"
                  class="py-4 text-center text-sm text-text-tertiary"
                >
                  {isManaged() ? t("kernel.usage.noTransactions") : t("kernel.usage.noActivity")}
                </p>
              </Show>
            }
          >
            <div
              data-testid="transaction-table"
              class="overflow-hidden rounded-md border border-border"
            >
              <table class="w-full text-left text-sm">
                <thead class="border-b border-border bg-surface-secondary text-xs text-text-secondary">
                  <tr>
                    <th class="px-3 py-2">{t("kernel.usage.colDate")}</th>
                    {/* Type column only in managed mode — self-hosted rows are all the same type. */}
                    <Show when={isManaged()}>
                      <th class="px-3 py-2">{t("kernel.usage.colType")}</th>
                    </Show>
                    <Show when={isAdmin()}>
                      <th data-testid="txn-col-user" class="px-3 py-2">
                        {t("kernel.usage.colUser")}
                      </th>
                    </Show>
                    <th class="px-3 py-2">{t("kernel.usage.colModel")}</th>
                    <th class="px-3 py-2 text-right">{t("kernel.usage.colAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={transactions()}>
                    {(txn) => {
                      const badge = TYPE_BADGES[txn.type] ?? TYPE_BADGES.usage
                      const shown = usageAmountDisplay(txn.amount, isManaged())
                      const isPositive = shown.credit
                      return (
                        <tr
                          data-testid="transaction-row"
                          data-type={txn.type}
                          class="border-b border-border-subtle last:border-0"
                        >
                          <td data-testid="txn-date" class="px-3 py-2 text-xs text-text-secondary">
                            {new Date(txn.createdAt).toLocaleDateString(currentLocale(), {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <Show when={isManaged()}>
                            <td class="px-3 py-2">
                              <span
                                data-testid="txn-type"
                                class={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${badge.class}`}
                              >
                                {badge.label.startsWith("kernel.") ? t(badge.label) : badge.label}
                              </span>
                            </td>
                          </Show>
                          <Show when={isAdmin()}>
                            <td class="px-3 py-2 text-xs text-text-secondary">
                              {txn.userName ?? "-"}
                            </td>
                          </Show>
                          <td class="px-3 py-2 text-xs text-text-secondary">{txn.model ?? "-"}</td>
                          <td
                            data-testid="txn-amount"
                            class={`px-3 py-2 text-right text-xs font-medium ${isPositive ? "text-emerald-600" : "text-text"}`}
                          >
                            {shown.prefix}
                            {isManaged()
                              ? t("kernel.usage.creditsAmount", {
                                  amount: formatCreditAmount(shown.value),
                                })
                              : fmt(shown.value, "EUR")}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={txnHasMore()}>
              <div class="mt-2 flex justify-center">
                <Button
                  data-testid="load-more-btn"
                  variant="ghost"
                  size="sm"
                  loading={txnLoading()}
                  onClick={() => loadTransactions(txnCursor() ?? undefined)}
                >
                  {t("kernel.usage.loadMore")}
                </Button>
              </div>
            </Show>
          </Show>
        </div>

        {/* Section 6 — Spend by provider (admin only, always visible). The keys
            themselves live on Settings -> AI models now; Usage keeps the spend. */}
        <Show when={isAdmin() && !isManaged()}>
          <div data-testid="providers-section">
            <p class="mb-1 text-sm font-medium text-text">{t("kernel.usage.providers")}</p>
            <p class="mb-3 text-xs text-text-tertiary">{t("kernel.usage.providersDisclaimer")}</p>
            <div class="flex flex-col gap-2">
              <For each={PROVIDERS}>
                {(prov) => (
                  <div
                    data-testid={`provider-card-${prov.id}`}
                    class="flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2.5"
                  >
                    <span class="flex-1 text-sm font-medium text-text">{prov.name}</span>
                    <span
                      data-testid={`provider-spend-${prov.id}`}
                      class="text-xs font-medium text-text"
                      title={t("kernel.usage.computedUsageDisclaimer")}
                    >
                      ~{fmt((spendByProvider()[prov.id] ?? 0).toFixed(8), "EUR")}
                    </span>
                  </div>
                )}
              </For>
            </div>
            <A
              href="/settings/ai-models"
              data-testid="usage-manage-keys"
              class="mt-3 inline-flex text-sm text-accent hover:underline"
            >
              {t("kernel.usage.manageKeys")}
            </A>
          </div>
        </Show>
      </ErrorBoundary>
    </div>
  )
}

export default UsageSettings
