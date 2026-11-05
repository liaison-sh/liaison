// SPDX-License-Identifier: FSL-1.1-ALv2

import { MODEL_PRICING_SEED, TIER_ALLOWANCE } from "@liaison/shared"
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
import {
  createBillingState,
  isManagedAvailable,
  isManagedUnavailable,
} from "~/modules/settings/BillingState"
import { creditVersion } from "~/modules/settings/credit-store"
import { usageAmountDisplay } from "~/modules/settings/usage-amount"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Skeleton } from "~/ui/Skeleton"

interface BalanceData {
  included: string
  purchased: string
  currency: string
  tier: string
  includedAllowance: string
  resetDate: string | null
}

interface Transaction {
  id: string
  type: string
  amount: string
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
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

const TIER_LABELS: Record<string, string> = {
  starter: "Starter",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
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

const PLAN_TIERS = [
  {
    id: "starter",
    name: "Starter",
    allowance: TIER_ALLOWANCE.starter,
    features: ["3 users", "Basic AI models", "Community support"],
  },
  {
    id: "team",
    name: "Team",
    allowance: TIER_ALLOWANCE.team,
    features: ["10 users", "All AI models", "Priority support"],
  },
  {
    id: "business",
    name: "Business",
    allowance: TIER_ALLOWANCE.business,
    features: ["Unlimited users", "All AI models", "Dedicated support", "SSO & audit logs"],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    allowance: null,
    features: [
      "Unlimited users",
      "All AI models",
      "24/7 support",
      "SSO & audit logs",
      "Custom SLA",
    ],
  },
]

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

  const currency = () => balance()?.currency ?? "EUR"

  // ─── Org members (admin-only, for user filter) ───
  const [orgUsers] = createResource(
    () => isAdmin(),
    async (admin) => {
      if (!admin) return []
      return api.get<OrgUser[]>("/admin/users")
    },
  )

  // ─── Plan Dialog ───
  const [planDialogOpen, setPlanDialogOpen] = createSignal(false)

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
    return api.get<{ buckets: UsageBucket[]; totalCost: string }>(
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
                callback: (v: any) => chartMoney(Number(v), currency()),
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
                  `${ctx.dataset.label}${tNow("kernel.capabilities.separator")}${chartMoney(Number(ctx.raw), currency(), 4)}`,
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
      <h1 class="text-lg font-semibold text-text">{t("kernel.usage.title")}</h1>

      <ErrorBoundary fallback={(err) => <p class="text-sm text-error">{err.message}</p>}>
        <Suspense
          fallback={
            <div class="flex gap-4">
              <Skeleton class="h-24 flex-1" />
              <Skeleton class="h-24 flex-1" />
            </div>
          }
        >
          {/* Section 1 — Plan / Tier (managed mode only; self-hosted hides
              the entire plan-management surface per spec Track D). */}
          <Show when={billingState()?.mode === "managed" && balance()}>
            {(b) => {
              const currentTier = () => PLAN_TIERS.find((t) => t.id === b().tier)
              const isTopTier = () => b().tier === "enterprise"
              return (
                <>
                  <div data-testid="plan-tier" class="rounded-md border border-border p-4">
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-3">
                        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10">
                          <svg viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5 text-accent">
                            <path
                              fill-rule="evenodd"
                              d="M9.674 2.075a.75.75 0 01.652 0l7.25 3.5A.75.75 0 0117.75 6.5v-.75a.75.75 0 00-.75-.75h-14a.75.75 0 00-.75.75v.75a.75.75 0 01.174-.675l7.25-3.5zM10 4.768L5.354 7h9.292L10 4.768zM4.25 8.5h11.5v5h.25a.75.75 0 010 1.5H4a.75.75 0 010-1.5h.25v-5zm2 0v5h2v-5h-2zm4 0v5h2v-5h-2zm4 5v-5h1.5v5h-1.5zM3 16.75a.75.75 0 01.75-.75h12.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75z"
                              clip-rule="evenodd"
                            />
                          </svg>
                        </div>
                        <div>
                          <p class="text-sm font-semibold text-text">
                            {TIER_LABELS[b().tier] ?? b().tier} {t("kernel.usage.planSuffix")}
                          </p>
                          <p class="text-xs text-text-secondary">
                            {fmt(b().includedAllowance, b().currency)}{" "}
                            {t("kernel.usage.includedPerMonth")}
                          </p>
                        </div>
                      </div>
                      <Show
                        when={!isTopTier()}
                        fallback={
                          <span class="rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
                            {t("kernel.usage.currentPlan")}
                          </span>
                        }
                      >
                        <Button
                          data-testid="change-plan-btn"
                          variant="outline"
                          size="sm"
                          onClick={() => setPlanDialogOpen(true)}
                        >
                          {t("kernel.usage.changePlan")}
                        </Button>
                      </Show>
                    </div>
                    <Show when={currentTier()?.features}>
                      <div class="mt-3 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
                        <For each={currentTier()!.features}>
                          {(f) => (
                            <span class="flex items-center gap-1 text-xs text-text-secondary">
                              <svg
                                viewBox="0 0 16 16"
                                fill="currentColor"
                                class="h-3.5 w-3.5 text-emerald-500"
                              >
                                <path
                                  fill-rule="evenodd"
                                  d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z"
                                  clip-rule="evenodd"
                                />
                              </svg>
                              {f}
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>

                  {/* Plan comparison dialog */}
                  <Dialog open={planDialogOpen()} onOpenChange={setPlanDialogOpen}>
                    <Dialog.Content class="max-w-2xl">
                      <Dialog.Title>{t("kernel.usage.changePlan")}</Dialog.Title>
                      <Dialog.Description>
                        {t("kernel.usage.changePlanDescription")}
                      </Dialog.Description>
                      <div class="mt-5 grid grid-cols-2 gap-3">
                        <For each={PLAN_TIERS.filter((t) => t.id !== "enterprise")}>
                          {(tier) => {
                            const isCurrent = () => tier.id === b().tier
                            return (
                              <div
                                data-testid={`plan-option-${tier.id}`}
                                class={`rounded-lg border p-4 transition-colors ${isCurrent() ? "border-accent bg-accent/5" : "border-border hover:border-text-tertiary"}`}
                              >
                                <div class="flex items-center justify-between">
                                  <p class="text-sm font-semibold text-text">{tier.name}</p>
                                  <Show when={isCurrent()}>
                                    <span class="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                                      {t("kernel.usage.current")}
                                    </span>
                                  </Show>
                                </div>
                                <p class="mt-1 text-lg font-bold text-text">
                                  {fmt(tier.allowance!, b().currency)}
                                  <span class="text-xs font-normal text-text-secondary">
                                    {" "}
                                    {t("kernel.usage.perMonth")}
                                  </span>
                                </p>
                                <ul class="mt-3 flex flex-col gap-1.5">
                                  <For each={tier.features}>
                                    {(f) => (
                                      <li class="flex items-center gap-1.5 text-xs text-text-secondary">
                                        <svg
                                          viewBox="0 0 16 16"
                                          fill="currentColor"
                                          class="h-3 w-3 shrink-0 text-emerald-500"
                                        >
                                          <path
                                            fill-rule="evenodd"
                                            d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z"
                                            clip-rule="evenodd"
                                          />
                                        </svg>
                                        {f}
                                      </li>
                                    )}
                                  </For>
                                </ul>
                                <Show when={!isCurrent()}>
                                  <Button
                                    class="mt-4 w-full"
                                    variant={tier.id === "business" ? "default" : "outline"}
                                    size="sm"
                                    onClick={() => {
                                      setPlanDialogOpen(false)
                                      addToast({
                                        message: t("kernel.usage.contactSupportChangePlan"),
                                        type: "info",
                                      })
                                    }}
                                  >
                                    {PLAN_TIERS.findIndex((t) => t.id === tier.id) >
                                    PLAN_TIERS.findIndex((t) => t.id === b().tier)
                                      ? t("kernel.usage.upgrade")
                                      : t("kernel.usage.downgrade")}
                                  </Button>
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                      {/* Enterprise banner */}
                      <div class="mt-3 flex items-center justify-between rounded-lg border border-border bg-surface-secondary/50 px-4 py-3">
                        <div>
                          <p class="text-sm font-semibold text-text">
                            {t("kernel.usage.enterprise")}
                          </p>
                          <p class="text-xs text-text-secondary">
                            {t("kernel.usage.enterpriseTagline")}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setPlanDialogOpen(false)
                            addToast({
                              message: t("kernel.usage.contactSupportEnterprise"),
                              type: "info",
                            })
                          }}
                        >
                          {t("kernel.usage.contactSales")}
                        </Button>
                      </div>
                      <div class="mt-4 flex justify-end">
                        <Dialog.Close class="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-secondary">
                          {t("kernel.usage.close")}
                        </Dialog.Close>
                      </div>
                    </Dialog.Content>
                  </Dialog>
                </>
              )
            }}
          </Show>

          {/* Section 2 — Balance Cards + Top-up CTA (managed mode only;
              self-hosted BYOK has no credit balance) */}
          <Show when={isManaged() && balance()}>
            {(b) => {
              const allow = () => Number(b().includedAllowance)
              const remaining = () => Number(b().included)
              const used = () => allow() - remaining()
              const usedPct = () =>
                allow() > 0 ? Math.min(100, Math.max(0, (used() / allow()) * 100)) : 0
              const resetDays = () => {
                if (!b().resetDate) return null
                const diff = new Date(b().resetDate!).getTime() - Date.now()
                return Math.max(0, Math.ceil(diff / 86400000))
              }
              const isHigh = () => usedPct() > 80
              return (
                <div data-testid="usage-balance" class="grid gap-4 sm:grid-cols-2">
                  <div data-testid="balance-included" class="rounded-md border border-border p-4">
                    <div class="flex items-center justify-between">
                      <p class="text-xs font-medium text-text-secondary">
                        {t("kernel.usage.includedUsage")}
                      </p>
                      <p class="text-xs text-text-tertiary">
                        {fmt(b().includedAllowance, b().currency)} {t("kernel.usage.monthSuffix")}
                      </p>
                    </div>
                    <p class="mt-1.5 text-2xl font-bold text-text">
                      {Math.round(usedPct())}%
                      <span class="ml-1 text-sm font-normal text-text-tertiary">
                        {t("kernel.usage.used")}
                      </span>
                    </p>
                    <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-secondary">
                      <div
                        class={`h-2 rounded-full transition-all ${isHigh() ? (usedPct() >= 100 ? "bg-error" : "bg-amber-500") : "bg-accent"}`}
                        style={{ width: `${usedPct()}%` }}
                      />
                    </div>
                    <div class="mt-1.5 flex items-center justify-between">
                      <Show when={resetDays() !== null}>
                        <p class="text-xs text-text-tertiary">
                          {t("kernel.usage.resetsInDays", { days: resetDays() ?? 0 })}
                        </p>
                      </Show>
                      <Show when={isHigh() && usedPct() < 100}>
                        <p class="text-xs text-amber-500">{t("kernel.usage.runningLow")}</p>
                      </Show>
                      <Show when={usedPct() >= 100}>
                        <p class="text-xs text-error">{t("kernel.usage.depleted")}</p>
                      </Show>
                    </div>
                  </div>
                  <div data-testid="balance-purchased" class="rounded-md border border-border p-4">
                    <p class="text-xs font-medium text-text-secondary">
                      {t("kernel.usage.purchasedCredits")}
                    </p>
                    <p class="mt-1.5 text-2xl font-bold text-text">
                      {fmt(b().purchased, b().currency)}
                    </p>
                    <Show when={isAdmin() && billingState()}>
                      {(bs) => (
                        <Show when={isManagedAvailable(bs())}>
                          {(_) => {
                            const managed = bs() as Extract<
                              ReturnType<typeof billingState>,
                              { mode: "managed"; tier: string }
                            >
                            return (
                              <Show when={managed.checkoutUrl}>
                                <a
                                  data-testid="add-credits-link"
                                  href={managed.checkoutUrl}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  class="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
                                >
                                  {t("kernel.usage.addCredits")}
                                </a>
                              </Show>
                            )
                          }}
                        </Show>
                      )}
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
                      class={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${chartPeriod() === p ? "bg-accent text-accent-foreground shadow-sm" : "text-text-secondary hover:text-text"}`}
                      onClick={() => setChartPeriod(p)}
                    >
                      {t(`kernel.settingsUi.usagePeriod.${p}`)}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={usageData()?.totalCost}>
              <span class="text-xs text-text-secondary">
                {t("kernel.usage.totalLabel")}{" "}
                <span class="font-medium text-text">{fmt(usageData()!.totalCost, currency())}</span>
              </span>
            </Show>
          </div>
          <Suspense fallback={<Skeleton class="h-52 w-full" />}>
            <Show
              when={usageData()?.buckets?.length}
              fallback={
                <p class="py-12 text-center text-sm text-text-tertiary">
                  {t("kernel.usage.noUsageData")}
                </p>
              }
            >
              <div class="h-52">
                <canvas ref={canvasRef} />
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
          <p class="mb-3 text-sm font-medium text-text">
            {isManaged() ? t("kernel.usage.transactions") : t("kernel.usage.activity")}
          </p>
          <div data-testid="transaction-filters" class="mb-3 flex flex-wrap items-center gap-2">
            {/* Admin-only: user filter */}
            <Show when={isAdmin()}>
              <select
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
              class="rounded border border-border bg-bg px-2 py-1 text-xs text-text"
              value={filterModel() ?? ""}
              onChange={(e) => {
                setFilterModel(e.currentTarget.value || null)
                loadTransactions()
              }}
            >
              <option value="">{t("kernel.usage.allModels")}</option>
              <For each={MODEL_OPTIONS}>{(m) => <option value={m.id}>{m.label}</option>}</For>
            </select>
            {/* Type filter only in managed mode — self-hosted rows are all byok_usage. */}
            <Show when={isManaged()}>
              <select
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
                <p class="py-4 text-center text-sm text-text-tertiary">
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
                      <th class="px-3 py-2">{t("kernel.usage.colUser")}</th>
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
                        <tr class="border-b border-border-subtle last:border-0">
                          <td class="px-3 py-2 text-xs text-text-secondary">
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
                            class={`px-3 py-2 text-right text-xs font-medium ${isPositive ? "text-emerald-600" : "text-text"}`}
                          >
                            {shown.prefix}
                            {fmt(shown.value, currency())}
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
        <Show when={isAdmin()}>
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
                      ~{fmt((spendByProvider()[prov.id] ?? 0).toFixed(8), currency())}
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
