// SPDX-License-Identifier: FSL-1.1-ALv2
//
// INFRA — host-mock interceptor for the Ads dashboard UI surfaces.
//
// Copied verbatim from the Social Ground Control `installSocialHostMock` pattern
// (`social-ground-control/helpers/social-visual-mocks.ts`): a `page.addInitScript`
// that wraps `window.__liaisonHost.invokeTool` so ads read tools return
// CANNED shapes per state — no live tool round-trips, deterministic pixels.
// The host splits the combined tool name on the first colon, so the interceptor
// key is `ads:<toolName>` (underscore-named, `.`↔`_` normalized exactly as
// Social / Boxtal).
//
// SCOPE: wraps ONLY `__liaisonHost.invokeTool`, which the ads app's own
// surfaces (Campaigns / Performance / Ads / Audiences / Settings / sidebar) read
// through.
import type { Page } from "@playwright/test"

// ─────────────────────────────────────────────────────────────────────────────
// Canned tool shapes
// ─────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_INFO = {
  id: "act_FIXTURE",
  name: "Tessera — Global",
  currency: "EUR",
  timezone_name: "Europe/Paris",
  account_status: 1,
  spend_cap: "500000",
  amount_spent: "12345",
}

export const CAMPAIGNS_LIST = {
  data: [
    {
      id: "camp_RAL44",
      name: "RAL-44 Launch — EU",
      status: "ACTIVE",
      effective_status: "CAMPAIGN_PAUSED",
      objective: "OUTCOME_SALES",
      daily_budget: "5000",
      lifetime_budget: null,
    },
    {
      id: "camp_dealer_eu",
      name: "Dealer Network EU",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      objective: "OUTCOME_LEADS",
      daily_budget: "2000",
      lifetime_budget: null,
    },
    {
      id: "camp_retargeting",
      name: "Retargeting — Visitors",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      objective: "OUTCOME_TRAFFIC",
      daily_budget: null,
      lifetime_budget: "100000",
    },
  ],
}

export const ADSETS_LIST = {
  data: [
    {
      id: "adset_1",
      name: "EU Lookalike 18-45",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      daily_budget: "1000",
      lifetime_budget: null,
    },
    {
      id: "adset_2",
      name: "Website Visitors 30d",
      status: "PAUSED",
      effective_status: "PAUSED",
      daily_budget: null,
      lifetime_budget: "30000",
    },
  ],
}

export const ADS_LIST = {
  data: [
    {
      id: "ad_1",
      name: "RAL-44 Hero Video",
      effective_status: "ACTIVE",
      creative: { id: "cr_1" },
    },
    {
      id: "ad_2",
      name: "Dealer CTA — Desktop",
      effective_status: "ACTIVE",
      creative: { id: "cr_2" },
    },
    {
      id: "ad_3",
      name: "Retargeting Carousel",
      effective_status: "PAUSED",
      creative: { id: "cr_3" },
    },
  ],
}

/** Populated insights — used for Performance tab (aggregate) */
export const INSIGHTS_QUERY_AGGREGATE = {
  data: [
    {
      spend: "1234.56",
      impressions: "98765",
      clicks: "1542",
      cpm: "12.50",
      ctr: "1.56",
      campaign_name: "All campaigns",
      date_start: "2026-06-01",
    },
  ],
  _split: false,
  currency: "EUR",
}

/** Daily series — used for the chart. Produces a 7-day sequence. */
export const INSIGHTS_QUERY_DAILY = {
  data: [
    { date_start: "2026-06-22", spend: "155.00", impressions: "12000", clicks: "190" },
    { date_start: "2026-06-23", spend: "178.50", impressions: "13500", clicks: "215" },
    { date_start: "2026-06-24", spend: "142.00", impressions: "11200", clicks: "176" },
    { date_start: "2026-06-25", spend: "201.00", impressions: "15800", clicks: "248" },
    { date_start: "2026-06-26", spend: "189.75", impressions: "14900", clicks: "231" },
    { date_start: "2026-06-27", spend: "210.31", impressions: "16200", clicks: "260" },
    { date_start: "2026-06-28", spend: "158.00", impressions: "13165", clicks: "222" },
  ],
  _split: false,
  currency: "EUR",
}

export const AUDIENCES_LIST = {
  data: [
    {
      id: "aud_1",
      name: "EU Website Visitors 30d",
      subtype: "WEBSITE",
      description: "All visitors from EU countries in the last 30 days",
      approximate_count_lower_bound: 15000,
      approximate_count_upper_bound: 20000,
      delivery_status: { code: 200, description: "This audience is ready." },
      operation_status: { code: 200, description: "Normal" },
      retention_days: 30,
      data_source: { type: "PIXEL", sub_type: null },
    },
    {
      id: "aud_2",
      name: "Lookalike — EU Buyers",
      subtype: "LOOKALIKE",
      description: null,
      approximate_count_lower_bound: -1,
      approximate_count_upper_bound: -1,
      delivery_status: { code: 400, description: "Audience too small" },
      operation_status: { code: 200, description: "Normal" },
      retention_days: null,
      data_source: { type: null, sub_type: null },
    },
  ],
}

export const CREATIVE_GET = {
  creative_id: "cr_1",
  thumbnail_url: "https://example.com/ral44-thumb.jpg",
  image_urls: ["https://example.com/ral44-hero.jpg"],
  video_id: null,
  headline: "Meet RAL-44",
  body: "The next-gen field recorder from Tessera. Pre-order now.",
}

export const AD_PREVIEW = {
  previews: [
    {
      ad_format: "DESKTOP_FEED_STANDARD",
      body: '<iframe src="https://www.facebook.com/ads/api/preview/iframe/?d=preview_data_stub"></iframe>',
    },
    {
      ad_format: "MOBILE_FEED_STANDARD",
      body: '<iframe src="https://www.facebook.com/ads/api/preview/iframe/?d=preview_mobile_stub"></iframe>',
    },
  ],
  ad_format: "DESKTOP_FEED_STANDARD",
}

export const COUNTS = {
  active: 2,
  paused: 1,
  total: 3,
}

// ─────────────────────────────────────────────────────────────────────────────
// P6 Dashboard mocks — metrics_run (both MER variants), experiment_list,
// merchant_feed_status, google_account_info/campaigns/insights, pending
// approvals. Each has an empty-variant and an error-variant per the four-state
// dashboard tests.
// ─────────────────────────────────────────────────────────────────────────────

// The real google_account_info shape (bundled-apps/ads/src/google-reads.ts):
// a connected account carries customer_id, not id.
export const GOOGLE_ACCOUNT_INFO = {
  customer_id: "1234567890",
  currency: "EUR",
  time_zone: "Europe/Paris",
  conversion_actions: [],
}

// The real not-set-up shapes: google_account_info and merchant_feed_status
// answer with a structured envelope, they do not throw.
export const GOOGLE_NOT_CONNECTED = {
  error: { code: "google_not_connected", message: "Google Ads is not connected" },
}
export const MERCHANT_NOT_CONNECTED = {
  error: { code: "google_not_connected", message: "Google Ads is not connected" },
}

export const METRICS_RUN_DTC = {
  value: "3.4200",
  formulaId: "blended_mer_dtc",
  formulaVersion: "1.0.0",
  lineage: { inputs: [], period: { start: "2026-06-01", end: "2026-06-07" } },
  caveats: [
    "Blended MER (total real revenue / total ad spend) is a rear-view directional efficiency ratio, NOT an incrementality measure.",
    "It cannot separate demand you created from demand you merely captured, and must NEVER by itself justify cutting continuity or brand budget.",
    "Excludes B2B/wholesale revenue -- DTC channel only.",
  ],
}

export const METRICS_RUN_TOTAL = {
  value: "3.8900",
  formulaId: "blended_mer_total",
  formulaVersion: "1.0.0",
  lineage: { inputs: [], period: { start: "2026-06-01", end: "2026-06-07" } },
  caveats: [
    "Blended MER (total real revenue / total ad spend) is a rear-view directional efficiency ratio, NOT an incrementality measure.",
    "It cannot separate demand you created from demand you merely captured, and must NEVER by itself justify cutting continuity or brand budget.",
    "Includes B2B/wholesale revenue in the numerator -- any brand halo from wholesale presence is not measurable at low volume and is not implied by this figure.",
  ],
}

export const METRICS_RUN_UNAVAILABLE = {
  value: "unavailable",
  formulaId: "blended_mer_dtc",
  formulaVersion: "1.0.0",
  lineage: { inputs: [], period: { start: "2026-06-01", end: "2026-06-07" } },
  caveats: [
    "Blended MER (total real revenue / total ad spend) is a rear-view directional efficiency ratio, NOT an incrementality measure.",
  ],
  degraded: true,
}

export const EXPERIMENT_LIST = {
  experiments: [
    {
      id: "exp_1",
      title: "Brand vs non-brand split",
      metric_tier: "purchase",
      status: "running",
      decision_date: "2026-07-14",
    },
    {
      id: "exp_2",
      title: "Creative refresh — RAL-44",
      metric_tier: "blended",
      status: "running",
      decision_date: "2026-07-01",
    },
  ],
  count: 2,
  note: "Consult this list before proposing a new test.",
}

export const EXPERIMENT_LIST_EMPTY = {
  experiments: [],
  count: 0,
  note: "Consult this list before proposing a new test.",
}

export const MERCHANT_FEED_STATUS = {
  approved: 42,
  disapproved: 3,
  pending: 1,
  expiring: 0,
  by_destination: [],
}

export const MERCHANT_FEED_STATUS_CLEAN = {
  approved: 42,
  disapproved: 0,
  pending: 0,
  expiring: 0,
  by_destination: [],
}

export const GOOGLE_CAMPAIGNS_LIST_EMPTY = { data: [] }
export const GOOGLE_INSIGHTS_QUERY_EMPTY = { data: [], _split: false }

export const PENDING_APPROVALS = { count: 2 }
export const PENDING_APPROVALS_EMPTY = { count: 0 }

/**
 * A mocked-tool sentinel: when a canned value is `{ __mockError: string }`,
 * the interceptor THROWS instead of resolving, so a test can force a
 * specific tool's read to fail deterministically (e.g. the dashboard's
 * error state) without depending on an unmocked real round-trip. An optional
 * `code` rides on the thrown error the way the host's ApiError carries the
 * tool envelope's code (e.g. `meta_not_connected`).
 */
export function mockError(
  message: string,
  code?: string,
): { __mockError: string; __mockErrorCode?: string } {
  return code ? { __mockError: message, __mockErrorCode: code } : { __mockError: message }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interceptor — wraps window.__liaisonHost.invokeTool with canned shapes.
// Keyed `ads:<tool>`, `.`↔`_` normalized, exactly as Social / Boxtal.
// ─────────────────────────────────────────────────────────────────────────────

export async function installAdsHostMock(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const mocks = { ...overrides }
  await page.addInitScript((m: Record<string, unknown>) => {
    const norm = (k: string) => k.replace(/\./g, "_")
    const lookup = (key: string): { hit: boolean; value: unknown } => {
      if (Object.hasOwn(m, key)) return { hit: true, value: m[key] }
      const n = norm(key)
      for (const mk of Object.keys(m)) {
        if (norm(mk) === n) return { hit: true, value: m[mk] }
      }
      return { hit: false, value: undefined }
    }
    let real: unknown
    Object.defineProperty(window as unknown as Record<string, unknown>, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const { hit, value } = lookup(`${appName}:${toolName}`)
            if (hit) {
              if (
                value &&
                typeof value === "object" &&
                "__mockError" in (value as Record<string, unknown>)
              ) {
                const spec = value as Record<string, unknown>
                const err = new Error(String(spec.__mockError)) as Error & { code?: string }
                if (typeof spec.__mockErrorCode === "string") err.code = spec.__mockErrorCode
                throw err
              }
              return value
            }
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${appName}:${toolName}`)
          },
        }
      },
    })
  }, mocks)
}
