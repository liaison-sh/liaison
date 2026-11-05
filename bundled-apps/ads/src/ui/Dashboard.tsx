// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ads dashboard — "the whole system at a glance" (SC 10). Four panels: spend +
// blended MER trend (both variants), active experiments with days-to-decision,
// health flags (learning-phase / disapproved products / zombie ACTIVE /
// connection issues), pending approvals. Four states: empty / loading / error /
// populated — each its own data-testid per the e2e guidelines. Composes ONLY
// the shared kit (bundling rule: explicit props, no `{...rest}` spread).
import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { app, navigate } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { Badge, Card, EmptyState, MetaIssueNote, Money, PageHeader, SectionLabel, Stat } from "./kit"
import {
  type ArmStatus,
  armChip,
  armConnections,
  dashboardCardError,
  daysToDecision,
  deriveDashboardState,
  googleArmStatus,
  healthFlags,
  insightRows,
  merchantArmStatus,
  metaArmStatus,
  type MetaIssue,
  metaIssueFromError,
  metaPendingIssue,
  toolData,
  toolRows,
  weeklySpendTotal,
  zombieCampaigns,
} from "./ui-logic"

// ── Types ──────────────────────────────────────────────────────────────────────

interface AccountInfo {
  id: string
  name: string
  currency: string
  account_status: number
}

interface MetricResult {
  value: string
  formulaId: string
  formulaVersion: string
  lineage: { inputs: unknown[]; period: { start: string; end: string } }
  caveats: string[]
  degraded?: boolean
}

interface InsightRow {
  spend?: string | number | null
  campaign_id?: string
  campaign_name?: string | null
  date_start?: string | null
  [key: string]: unknown
}
interface InsightsResult {
  data: InsightRow[]
  _split?: boolean
  // Set when a Meta async report job did not finish within the poll budget (a
  // transient race). The tile renders "data not ready yet" with a Retry, never
  // an error.
  _pending?: boolean
  currency?: string
}

interface ExperimentRow {
  id: string
  title: string
  metric_tier: string
  status: string
  decision_date?: string | null
}
interface ExperimentListResult {
  experiments: ExperimentRow[]
  count: number
}

interface CampaignRow {
  id: string
  name: string
  effective_status: string
  learning?: boolean
  [key: string]: unknown
}
interface CampaignsListResult {
  data: CampaignRow[]
}

interface MerchantFeedStatus {
  approved?: number
  disapproved?: number
  pending?: number
  expiring?: number
}

interface PendingApprovalsResult {
  count: number
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ── Tool-call concurrency limiter ────────────────────────────────────────────
//
// The dashboard mounts ~10 resources at once. Each sandboxed tool call holds
// one of the org's LIMITED sandbox pool slots (pool cap ~12, shared with
// every agent run and routine in the org). A mount-time burst of 10
// concurrent calls monopolizes the pool, starves concurrent work, and under
// load triggers the documented acquire-timeout module-leak spiral. Cap the
// dashboard's in-flight tool calls; queued calls run as slots free. 3 keeps
// first paint fast while never taking more than a quarter of the pool.
const MAX_INFLIGHT_TOOL_CALLS = 3
let inflightToolCalls = 0
const toolCallQueue: Array<() => void> = []

export function limitedInvoke<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const run = (): Promise<T> =>
    app.invokeTool<T>(name, params).finally(() => {
      inflightToolCalls--
      const next = toolCallQueue.shift()
      if (next) next()
    })
  if (inflightToolCalls < MAX_INFLIGHT_TOOL_CALLS) {
    inflightToolCalls++
    return run()
  }
  return new Promise<T>((resolve, reject) => {
    toolCallQueue.push(() => {
      inflightToolCalls++
      run().then(resolve, reject)
    })
  })
}

// ── RetryButton — inline retry for a single failed tile ─────────────────────
// Re-invokes JUST that tile's tool (via the resource's refetch, whose fetcher
// goes through limitedInvoke, so retries respect the concurrency cap too).
const RetryButton: Component<{ onClick: () => void; testid?: string }> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    onClick={props.onClick}
    class="text-[11px] text-accent underline hover:text-accent-hover"
  >
    Retry
  </button>
)

// ── AdsDashboard ─────────────────────────────────────────────────────────────

export const AdsDashboard: Component = () => {
  // ── Platform account reads (drive the empty/error/connection-chip state) ──
  // Each arm is classified with the Settings page's meaning (ui-logic.ts):
  // not set up is `not_connected`, only a real failure is `errored`. The
  // rejection never reaches createResource's error path (which Solid rethrows
  // on read and would crash the whole tab): the fetcher records the arm status
  // and resolves null.
  const [metaArm, setMetaArm] = createSignal<ArmStatus>("not_connected")
  const [metaAcct] = app.createResource(() =>
    limitedInvoke<AccountInfo>("account_info", {})
      .then((r) => { setMetaArm(metaArmStatus({ ok: true, value: r })); return r })
      .catch((e) => { setMetaArm(metaArmStatus({ ok: false, error: e })); return null }),
  )
  const [googleArm, setGoogleArm] = createSignal<ArmStatus>("not_connected")
  const [googleAcct] = app.createResource(() =>
    limitedInvoke<AccountInfo>("google_account_info", {})
      .then((r) => { setGoogleArm(googleArmStatus({ ok: true, value: r })); return r })
      .catch((e) => { setGoogleArm(googleArmStatus({ ok: false, error: e })); return null }),
  )
  const [merchantArm, setMerchantArm] = createSignal<ArmStatus>("not_connected")
  const [merchantFeed] = app.createResource(() =>
    limitedInvoke<MerchantFeedStatus>("merchant_feed_status", {})
      .then((r) => { setMerchantArm(merchantArmStatus({ ok: true, value: r })); return r })
      .catch((e) => { setMerchantArm(merchantArmStatus({ ok: false, error: e })); return null }),
  )

  // ── Spend + blended MER trend ───────────────────────────────────────────────
  //
  // Every resource read via `()` in this component must never throw on
  // access — the whole app is mounted inside a host-level ErrorBoundary
  // (PluginMountBoundary), so an uncaught resource-read exception crashes the
  // ENTIRE tab, not just one panel (violates the "a platform API outage
  // degrades only that arm" requirement). Each fetcher below therefore
  // catches and reports its own error via a side-channel signal instead of
  // relying on the resource's built-in `.error` (which Solid rethrows on
  // read) — mirrors the merchantFeed pattern above.
  const period = { period_start: daysAgo(7), period_end: today() }
  // Side-signal errored flags for the delivery-data fetchers feeding the
  // Health/zombie panel: a bare `.catch(() => null)` here (matching the
  // resource-read-safety pattern above) would make a delivery-data outage
  // indistinguishable from "confirmed zero spend" — zombieRows/flags would
  // read an empty spend array either way and report a confident "0
  // zombies". These track WHICH fetch failed so the panel can render a
  // degraded state instead of a false-confident zero.
  const [metaSpendErrored, setMetaSpendErrored] = createSignal(false)
  // WHY the Meta read failed (throttled, refused, rejected), so the tile says
  // it in plain words instead of a bare "Unavailable".
  const [metaSpendIssue, setMetaSpendIssue] = createSignal<MetaIssue | null>(null)
  const [metaSpend, { refetch: refetchMetaSpend }] = app.createResource(() =>
    limitedInvoke<InsightsResult>("insights_query", { level: "account", date_preset: "last_7d" })
      .then((r) => { setMetaSpendErrored(false); setMetaSpendIssue(null); return r })
      .catch((e) => { setMetaSpendErrored(true); setMetaSpendIssue(metaIssueFromError(e)); return null }),
  )
  const [googleSpendErrored, setGoogleSpendErrored] = createSignal(false)
  const [googleSpend, { refetch: refetchGoogleSpend }] = app.createResource(() =>
    limitedInvoke<InsightsResult>("google_insights_query", {
        query:
          "SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
      })
      .then((r) => { setGoogleSpendErrored(false); return r })
      .catch(() => { setGoogleSpendErrored(true); return null }),
  )

  // ── Performance detail (merged in from the former Performance tab) ──────────
  // 30-day account KPIs, 30-day by-campaign breakdown, and the daily-spend
  // series that drives the chart. Each catches its own error so a slow/failed
  // report degrades that panel only (never crashes the tab).
  const [kpiIssue, setKpiIssue] = createSignal<MetaIssue | null>(null)
  const [kpi, { refetch: refetchKpi }] = app.createResource(() =>
    limitedInvoke<InsightsResult>("insights_query", { level: "account", date_preset: "last_30d" })
      .then((r) => { setKpiIssue(metaPendingIssue(r)); return r })
      .catch((e) => { setKpiIssue(metaIssueFromError(e)); return null }),
  )
  // campaign_name/campaign_id are requested explicitly: the default insights
  // field set carries only metrics, so every by-campaign row would render a
  // nameless placeholder. Meta supports both fields at level campaign.
  const [campaignInsights] = app.createResource(() =>
    limitedInvoke<InsightsResult>("insights_query", {
      level: "campaign",
      date_preset: "last_30d",
      fields: ["campaign_id", "campaign_name", "spend", "impressions", "clicks"],
    }).catch(() => null),
  )
  // The daily series is read by the chart effect (`on(daily, ...)`), so a bare
  // rejection here rethrows on that read and crashes the whole tab.
  const [dailyErrored, setDailyErrored] = createSignal(false)
  const [dailyIssue, setDailyIssue] = createSignal<MetaIssue | null>(null)
  const [daily, { refetch: refetchDaily }] = app.createResource(() =>
    limitedInvoke<InsightsResult>("insights_query", { level: "account", time_increment: "1", date_preset: "last_30d" })
      .then((r) => { setDailyErrored(false); setDailyIssue(null); return r })
      .catch((e) => { setDailyErrored(true); setDailyIssue(metaIssueFromError(e)); return null }),
  )

  const [merDtcErrored, setMerDtcErrored] = createSignal(false)
  const [merDtc, { refetch: refetchMerDtc }] = app.createResource(() =>
    limitedInvoke<MetricResult>("metrics_run", { formula_id: "blended_mer_dtc", ...period })
      .then((r) => { setMerDtcErrored(false); return r })
      .catch(() => { setMerDtcErrored(true); return null }),
  )
  const [merTotalErrored, setMerTotalErrored] = createSignal(false)
  const [merTotal, { refetch: refetchMerTotal }] = app.createResource(() =>
    limitedInvoke<MetricResult>("metrics_run", { formula_id: "blended_mer_total", ...period })
      .then((r) => { setMerTotalErrored(false); return r })
      .catch(() => { setMerTotalErrored(true); return null }),
  )

  // ── Experiments ──────────────────────────────────────────────────────────────
  // Filtered to status: "running" — the dashboard's "Active Experiments"
  // panel is for tests currently in flight, not the full experiment history.
  // An unfiltered experiment_list({}) would also return "decided" and
  // "abandoned" experiments (and "draft", not yet in flight), cluttering
  // the panel with tests that aren't actually active.
  const [experimentsErrored, setExperimentsErrored] = createSignal(false)
  const [experiments, { refetch: refetchExperiments }] = app.createResource(() =>
    limitedInvoke<ExperimentListResult>("experiment_list", { status: "running" })
      .then((r) => { setExperimentsErrored(false); return r })
      .catch(() => { setExperimentsErrored(true); return null }),
  )

  // ── Health flags: campaigns × spend × merchant × connections ────────────────
  const [metaCampaignsErrored, setMetaCampaignsErrored] = createSignal(false)
  const [metaCampaigns] = app.createResource(() =>
    limitedInvoke<CampaignsListResult>("campaigns_list", {})
      .then((r) => { setMetaCampaignsErrored(false); return r })
      .catch(() => { setMetaCampaignsErrored(true); return null }),
  )
  const [googleCampaignsErrored, setGoogleCampaignsErrored] = createSignal(false)
  const [googleCampaigns] = app.createResource(() =>
    limitedInvoke<CampaignsListResult>("google_campaigns_list", {})
      .then((r) => { setGoogleCampaignsErrored(false); return r })
      .catch(() => { setGoogleCampaignsErrored(true); return null }),
  )

  // Delivery-data outage for the Health/zombie panel: true when ANY of the
  // campaigns/spend fetchers that feed zombieRows/flags.zombieCount failed.
  // Gates the panel into a "delivery data unavailable" degraded state
  // instead of rendering a confident zombieCount of 0 built from partial
  // (or entirely missing) data.
  const deliveryDataErrored = createMemo(
    () => metaCampaignsErrored() || googleCampaignsErrored() || metaSpendErrored() || googleSpendErrored(),
  )

  // ── Pending approvals ────────────────────────────────────────────────────────
  // The ads app owns a `pending_approvals_list` read (reads.ts) that prefixes
  // the kernel approvals affordance on "ads:" and returns a { count }. If it is
  // ever unavailable the tile still degrades to a nav-affordance count via the
  // fallback below (a failed widget never blanks its siblings).
  const [pendingApprovals] = app.createResource(() =>
    limitedInvoke<PendingApprovalsResult>("pending_approvals_list", {}).catch(() => null),
  )

  // ── Spend + currency derivations ────────────────────────────────────────────
  const metaCurrency = createMemo(
    () => toolData(metaAcct())?.currency ?? toolData(kpi())?.currency ?? "USD",
  )
  const googleCurrency = createMemo(
    () => toolData(googleAcct())?.currency ?? toolData(googleSpend())?.currency ?? "USD",
  )

  // Last-7-days spend per platform. Meta rows carry `spend`; Google rows carry
  // `cost` (already micros-converted to major by google_insights_query). Both
  // are major units — weeklySpendTotal never rescales.
  const metaWeekSpend = createMemo(() =>
    weeklySpendTotal(toolRows<Record<string, unknown>>(metaSpend()), "spend"),
  )
  const googleWeekSpend = createMemo(() => {
    return weeklySpendTotal(toolRows<Record<string, unknown>>(googleSpend(), "rows"), "cost")
  })

  // Every read of a tool answer goes through insightRows/toolRows/toolData:
  // a deployment with nothing connected gets `{ error: { code } }` back as the
  // tool's own 200 answer, and reading a list field off that is a read off an
  // error object, not a list.
  const kpiRow = createMemo(() => insightRows(kpi())[0] ?? null)
  const campaignRows = createMemo<InsightRow[]>(() => insightRows(campaignInsights()))

  // Fallback id -> name map from campaigns_list (already fetched for the
  // Health panel) for the rare insights row that still lacks campaign_name.
  const metaCampaignNames = createMemo(() => {
    const map = new Map<string, string>()
    for (const c of toolRows<CampaignRow>(metaCampaigns())) {
      if (c.id && c.name) map.set(c.id, c.name)
    }
    return map
  })
  const campaignRowName = (r: InsightRow): string => {
    if (r.campaign_name) return String(r.campaign_name)
    if (r.campaign_id) return metaCampaignNames().get(r.campaign_id) ?? String(r.campaign_id)
    return "Unnamed campaign"
  }

  // ── Derived state ────────────────────────────────────────────────────────────
  const arms = createMemo(() => armConnections({ meta: metaArm(), google: googleArm(), merchant: merchantArm() }))
  const connected = createMemo(() => arms().connected)

  const anyLoading = createMemo(
    () => metaAcct.loading || googleAcct.loading || merDtc.loading || merTotal.loading || experiments.loading,
  )
  // Banner-worthy error: ONLY when EVERY tile of the Spend & Blended MER
  // header card failed (or, inside deriveDashboardState, when every platform
  // arm's account read errored with nothing connected). A lone transient tile
  // failure (e.g. one metrics_run timeout) stays inline: that tile renders its
  // own degraded state with a Retry affordance, and the global banner stays
  // hidden.
  const anyError = createMemo(() =>
    dashboardCardError([merDtcErrored(), merTotalErrored(), metaSpendErrored(), googleSpendErrored()]),
  )

  // Single source of truth for the four-state resolution — reuses the
  // unit-tested pure derivation from ui-logic.ts instead of re-deriving the
  // same empty/loading/error/populated logic inline in the component.
  const dashboardState = createMemo(() =>
    deriveDashboardState({
      connected: connected(),
      loading: anyLoading(),
      hasError: anyError(),
      // A platform account read that ERRORED (vs never-connected) must resolve
      // to `error` when nothing else is connected -- never `empty`/"no spend".
      connectionErrored: arms().anyErrored,
    }),
  )

  const zombieRows = createMemo(() => {
    const campaigns = [
      ...toolRows<CampaignRow>(metaCampaigns()),
      ...toolRows<CampaignRow>(googleCampaigns()),
    ]
    const spendRows = [
      ...toolRows<InsightRow>(metaSpend()),
      ...toolRows<InsightRow>(googleSpend()),
    ]
    return zombieCampaigns(campaigns, spendRows)
  })

  const flags = createMemo(() =>
    healthFlags({
      campaigns: [
        ...toolRows<CampaignRow>(metaCampaigns()),
        ...toolRows<CampaignRow>(googleCampaigns()),
      ],
      spend: [...toolRows<InsightRow>(metaSpend()), ...toolRows<InsightRow>(googleSpend())],
      merchantDisapprovedCount: toolData(merchantFeed())?.disapproved ?? 0,
      connectionErrors: arms().errored,
    }),
  )

  // ── Chart (chart.js dynamic import, mirrors Performance.tsx) ────────────────
  let canvasRef: HTMLCanvasElement | undefined
  // biome-ignore lint/suspicious/noExplicitAny: chart.js dynamic import
  let chartInstance: any = null

  createEffect(
    on(daily, async (data) => {
      if (!data || !canvasRef) return
      const rows = insightRows(data)
      if (rows.length === 0) return
      try {
        // biome-ignore lint/suspicious/noExplicitAny: chart.js types not needed at runtime
        const mod: any = await import("chart.js")
        const { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend } = mod
        Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend)
        chartInstance?.destroy()
        chartInstance = new Chart(canvasRef, {
          type: "line",
          data: {
            labels: rows.map((r) => r.date_start ?? ""),
            datasets: [
              {
                label: `Spend (${metaCurrency()})`,
                data: rows.map((r) => Number(r.spend ?? 0)),
                tension: 0.3,
                borderColor: "rgb(99, 102, 241)",
                backgroundColor: "rgba(99, 102, 241, 0.1)",
                fill: true,
              },
            ],
          },
          options: {
            responsive: true,
            animation: { duration: 800 },
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: { x: { display: true }, y: { display: true } },
          },
        })
      } catch (err) {
        console.error("[ads] dashboard chart.js failed to render:", err)
      }
    }),
  )

  onCleanup(() => {
    chartInstance?.destroy()
    chartInstance = null
  })

  return (
    <div data-testid="ads-dashboard" class="flex min-h-full flex-col">
      <PageHeader title="Dashboard" subtitle="Spend, blended MER, experiments, and health at a glance" />

      <Show when={dashboardState() === "empty"}>
        <div data-testid="ads-dash-empty">
          <EmptyState title="Nothing connected yet">
            Connect Meta, Google or Merchant Center in Settings to see spend, MER, experiments, and health flags here.
          </EmptyState>
        </div>
      </Show>

      <Show when={dashboardState() === "loading"}>
        <div data-testid="ads-dash-skeleton" class="flex flex-col gap-4 p-4">
          <For each={[0, 1, 2, 3]}>
            {() => (
              <Card class="p-4">
                <div class="flex items-center gap-2 text-[12.5px] text-text-tertiary">
                  <span
                    class="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"
                    aria-hidden="true"
                  />
                  <span>Loading…</span>
                </div>
              </Card>
            )}
          </For>
        </div>
      </Show>

      <Show when={dashboardState() === "error"}>
        <div data-testid="ads-dash-error" class="px-4 pt-3">
          <Card class="p-4 text-[12.5px] text-error">
            One or more panels could not load. Connection-specific errors are shown per panel below.
          </Card>
        </div>
      </Show>

      <Show when={dashboardState() === "populated" || dashboardState() === "error"}>
        <div class="flex flex-col gap-4 p-4">
          {/* ── Spend + blended MER header row ────────────────────────────── */}
          {/* Compact: MER (DTC) + MER (total) side by side with last-7-days
              spend per platform (Meta + Google), all in one dense row.
              Single column below 640 px (the shell's phone tier, the same
              breakpoint CardTable switches to cards at): two columns at 390 px
              ran a long value under its status chip and clipped the next one. */}
          <Card class="p-4" testid="ads-dash-mer-trend">
            <SectionLabel>Spend &amp; Blended MER</SectionLabel>
            <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
              <Stat label="MER (DTC)" testid="ads-dash-mer-dtc">
                <Show
                  when={merDtc()}
                  fallback={
                    <span class="text-[12.5px] text-text-tertiary">
                      Unavailable{" "}
                      <Show when={merDtcErrored()}>
                        <RetryButton testid="ads-dash-retry-mer-dtc" onClick={() => void refetchMerDtc()} />
                      </Show>
                    </span>
                  }
                >
                  {(m) => (
                    <>
                      <span class="font-mono tabular-nums text-text" title={(m().caveats ?? []).join(" ")}>
                        {m().value}
                      </span>
                      <Show when={m().degraded}>
                        <Badge tone="warning">degraded</Badge>
                      </Show>
                    </>
                  )}
                </Show>
              </Stat>
              <Stat label="MER (Total, incl. B2B)" testid="ads-dash-mer-total">
                <Show
                  when={merTotal()}
                  fallback={
                    <span class="text-[12.5px] text-text-tertiary">
                      Unavailable{" "}
                      <Show when={merTotalErrored()}>
                        <RetryButton testid="ads-dash-retry-mer-total" onClick={() => void refetchMerTotal()} />
                      </Show>
                    </span>
                  }
                >
                  {(m) => (
                    <>
                      <span class="font-mono tabular-nums text-text" title={(m().caveats ?? []).join(" ")}>
                        {m().value}
                      </span>
                      <Show when={m().degraded}>
                        <Badge tone="warning">degraded</Badge>
                      </Show>
                    </>
                  )}
                </Show>
              </Stat>
              <Stat label="Meta spend (7d)" testid="ads-dash-spend-meta">
                <Show
                  when={!metaSpendErrored()}
                  fallback={
                    <MetaIssueNote
                      testid="ads-dash-spend-meta-issue"
                      class="leading-snug"
                      issue={metaSpendIssue() ?? metaIssueFromError(null)}
                      onRetry={() => void refetchMetaSpend()}
                    />
                  }
                >
                  <Show
                    when={metaWeekSpend() !== null}
                    fallback={<span class="text-[12.5px] text-text-tertiary">Unavailable</span>}
                  >
                    <Money value={metaWeekSpend()} currency={metaCurrency()} emphasis />
                  </Show>
                </Show>
              </Stat>
              <Stat label="Google spend (7d)" testid="ads-dash-spend-google">
                <Show
                  when={!googleSpendErrored()}
                  fallback={
                    <span class="text-[12.5px] text-text-tertiary">
                      Unavailable{" "}
                      <RetryButton testid="ads-dash-retry-spend-google" onClick={() => void refetchGoogleSpend()} />
                    </span>
                  }
                >
                  <Show
                    when={googleWeekSpend() !== null}
                    fallback={<span class="text-[12.5px] text-text-tertiary">Unavailable</span>}
                  >
                    <Money value={googleWeekSpend()} currency={googleCurrency()} emphasis />
                  </Show>
                </Show>
              </Stat>
            </div>
          </Card>

          {/* ── Performance detail (merged from the former Performance tab) ── */}
          <Card class="p-4" testid="ads-dash-performance">
            <SectionLabel>Performance (Last 30 Days)</SectionLabel>
            <Show when={!kpi.loading && kpiIssue()}>
              {(issue) => (
                <MetaIssueNote
                  testid="ads-dash-kpi-issue"
                  class="mt-2"
                  issue={issue()}
                  onRetry={() => void refetchKpi()}
                />
              )}
            </Show>
            <Show when={kpiRow()}>
              {(row) => (
                <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-5">
                  <Stat label="Spend" testid="ads-dash-kpi-spend">
                    <Money value={Number(row().spend ?? 0)} currency={metaCurrency()} emphasis />
                  </Stat>
                  <Stat label="Impressions">
                    <span class="font-mono tabular-nums text-text">{Number(row().impressions ?? 0).toLocaleString()}</span>
                  </Stat>
                  <Stat label="Clicks">
                    <span class="font-mono tabular-nums text-text">{Number(row().clicks ?? 0).toLocaleString()}</span>
                  </Stat>
                  <Stat label="CPM">
                    <Money value={Number(row().cpm ?? 0)} currency={metaCurrency()} emphasis />
                  </Stat>
                  <Stat label="CTR">
                    <span class="font-mono tabular-nums text-text">{Number(row().ctr ?? 0).toFixed(2)}%</span>
                  </Stat>
                </div>
              )}
            </Show>

            <div class="mt-4">
              <SectionLabel>Daily Spend</SectionLabel>
              <Show when={daily.loading}>
                <div data-testid="ads-insights-skeleton" class="flex items-center gap-2 py-8 text-[12.5px] text-text-tertiary">
                  <span class="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
                  <span>Building report…</span>
                </div>
              </Show>
              <Show when={!daily.loading && dailyErrored()}>
                <MetaIssueNote
                  testid="ads-dash-spend-error"
                  class="py-4"
                  issue={dailyIssue() ?? metaIssueFromError(null)}
                  onRetry={() => void refetchDaily()}
                />
              </Show>
              <Show when={!daily.loading && !dailyErrored() ? metaPendingIssue(daily()) : null}>
                {(issue) => (
                  <MetaIssueNote
                    testid="ads-dash-spend-pending"
                    class="py-4"
                    issue={issue()}
                    onRetry={() => void refetchDaily()}
                  />
                )}
              </Show>
              <Show when={!daily.loading && !dailyErrored() && !daily()?._pending}>
                <canvas data-testid="ads-dash-spend-chart" ref={(el) => { canvasRef = el }} class="max-h-[240px] w-full" />
              </Show>
            </div>

            <div class="mt-4">
              <SectionLabel>By Campaign</SectionLabel>
              <div class="mt-1" data-testid="ads-insights-table">
                <CardTable
                  rows={campaignRows()}
                  rowKey={(r) => r.campaign_id ?? String(campaignRows().indexOf(r))}
                  emptyState={<div class="px-2 py-4 text-center text-text-tertiary">No data</div>}
                  columns={
                    [
                      { key: "campaign", header: "Campaign", role: "anchor", cell: (r) => campaignRowName(r) },
                      {
                        key: "spend",
                        header: "Spend",
                        role: "meta",
                        numeric: true,
                        align: "right",
                        cell: (r) => <Money value={Number(r.spend ?? 0)} currency={metaCurrency()} />,
                      },
                      {
                        key: "impressions",
                        header: "Impressions",
                        role: "meta",
                        numeric: true,
                        align: "right",
                        cell: (r) => Number(r.impressions ?? 0).toLocaleString(),
                      },
                      {
                        key: "clicks",
                        header: "Clicks",
                        role: "meta",
                        numeric: true,
                        align: "right",
                        cell: (r) => Number(r.clicks ?? 0).toLocaleString(),
                      },
                    ] as Array<CardTableColumn<InsightRow>>
                  }
                />
              </div>
            </div>
          </Card>

          {/* ── Active experiments ────────────────────────────────────────── */}
          <Card class="p-4" testid="ads-dash-experiments">
            <SectionLabel>Active Experiments</SectionLabel>
            {/* An errored fetch renders its own degraded state + Retry; the
                "no open experiments" copy is reserved for a confirmed-empty
                result (never a false empty on failure). */}
            <Show when={experimentsErrored()}>
              <div class="mt-2 text-[12.5px] text-text-tertiary" data-testid="ads-dash-experiments-error">
                Experiments could not load.{" "}
                <RetryButton testid="ads-dash-retry-experiments" onClick={() => void refetchExperiments()} />
              </div>
            </Show>
            <Show
              when={!experimentsErrored() && (experiments()?.experiments?.length ?? 0) > 0}
              fallback={
                <Show when={!experimentsErrored()}>
                  <div class="mt-2 text-[12.5px] text-text-tertiary">No open experiments.</div>
                </Show>
              }
            >
              <ul class="mt-2 flex flex-col gap-2">
                <For each={experiments()?.experiments ?? []}>
                  {(exp) => {
                    const dtd = createMemo(() => daysToDecision(exp.decision_date, today()))
                    const pastDue = createMemo(() => dtd() !== null && (dtd() as number) < 0)
                    return (
                      <li data-testid={`ads-dash-experiment-${exp.id}`} class="flex items-center justify-between gap-2 text-[12.5px]">
                        <span class="text-text">{exp.title}</span>
                        <div class="flex items-center gap-2">
                          <Badge tone="neutral">{exp.metric_tier}</Badge>
                          <Show
                            when={dtd() !== null}
                            fallback={<span class="text-text-tertiary">no decision date</span>}
                          >
                            <Badge tone={pastDue() ? "error" : "muted"}>
                              {pastDue() ? `${Math.abs(dtd() as number)}d past due` : `${dtd()}d to decision`}
                            </Badge>
                          </Show>
                        </div>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </Show>
          </Card>

          {/* ── Health flags ──────────────────────────────────────────────── */}
          <Card class="p-4" testid="ads-dash-health">
            <SectionLabel>Health</SectionLabel>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <Show
                when={!deliveryDataErrored()}
                fallback={
                  <Badge testid="ads-dash-health-zombie" tone="warning">
                    delivery data unavailable
                  </Badge>
                }
              >
                <Badge testid="ads-dash-health-zombie" tone={flags().zombieCount > 0 ? "warning" : "success"}>
                  {flags().zombieCount} zombie ACTIVE campaign{flags().zombieCount === 1 ? "" : "s"}
                </Badge>
              </Show>
              <Badge testid="ads-dash-health-learning" tone={flags().learningPhaseCount > 0 ? "neutral" : "success"}>
                {flags().learningPhaseCount} in learning phase
              </Badge>
              <Badge
                testid="ads-dash-health-disapproved"
                tone={flags().disapprovedProductsCount > 0 ? "error" : "success"}
              >
                {flags().disapprovedProductsCount} disapproved products
              </Badge>
              {/* Same meaning as the Settings page: OK only for a connected arm. */}
              <Badge testid="ads-dash-health-conn-meta" tone={armChip(metaArm()).tone}>
                Meta {armChip(metaArm()).label}
              </Badge>
              <Badge testid="ads-dash-health-conn-google" tone={armChip(googleArm()).tone}>
                Google {armChip(googleArm()).label}
              </Badge>
              <Badge testid="ads-dash-health-conn-merchant" tone={armChip(merchantArm()).tone}>
                Merchant {armChip(merchantArm()).label}
              </Badge>
            </div>
            <Show when={!deliveryDataErrored() && zombieRows().length > 0}>
              <ul class="mt-2 flex flex-col gap-1">
                <For each={zombieRows()}>
                  {(c) => (
                    <li data-testid={`ads-dash-zombie-${c.id}`} class="text-[11.5px] text-text-tertiary">
                      {c.name} (ACTIVE, no spend this week)
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Card>

          {/* ── Pending approvals ─────────────────────────────────────────── */}
          <Card class="p-4" testid="ads-dash-approvals">
            <SectionLabel>Pending Approvals</SectionLabel>
            <Show
              when={toolData(pendingApprovals())}
              fallback={
                <div class="mt-2 flex items-center justify-between gap-2">
                  <span class="text-[12.5px] text-text-tertiary">Approval count unavailable here.</span>
                  <button
                    type="button"
                    data-testid="ads-dash-approvals-link"
                    class="text-[12.5px] text-accent underline"
                    onClick={() => navigate("/")}
                  >
                    Open approvals
                  </button>
                </div>
              }
            >
              {(res) => (
                <div class="mt-2 flex items-center justify-between gap-2">
                  <span class="text-[12.5px] text-text" data-testid="ads-dash-approvals-count">
                    {res().count} pending
                  </span>
                  <button
                    type="button"
                    data-testid="ads-dash-approvals-link"
                    class="text-[12.5px] text-accent underline"
                    onClick={() => navigate("/")}
                  >
                    Open approvals
                  </button>
                </div>
              )}
            </Show>
          </Card>
        </div>
      </Show>
    </div>
  )
}
