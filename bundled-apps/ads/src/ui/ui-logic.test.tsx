// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TDD unit tests for meta-ads UI pure-function helpers.
// Runs in bun:test without a browser or kernel — no DOM, no SolidJS rendering.
//
// Key invariants guarded:
//   1. budgetMinorToMajor: raw minor units ÷ by 10^exponent — NOT always ÷100
//   2. effectiveStatusTone: uses effective_status, never status
//   3. flattenInsights: _split flag is actually read
//   4. audienceCountLabel: null check comes BEFORE numeric comparison
//   5. adFormatLabel: known placements return human labels
//   6. kit primitives (StatusBadge, ConfirmDialog, AdPreviewDrawer) are functions

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { APP_VERSION, APP_VERSION_LABEL, CAMPAIGN_COLUMNS, phoneCellClass } from "./ui-logic"
import { StatusBadge, ConfirmDialog, AdPreviewDrawer } from "./kit"
import { AdsDashboard } from "./index"
import {
  budgetMinorToMajor,
  effectiveStatusTone,
  flattenInsights,
  audienceCountLabel,
  adFormatLabel,
  formatMoney,
  deriveDashboardState,
  zombieCampaigns,
  daysToDecision,
  healthFlags,
  weeklySpendTotal,
  dashboardCardError,
  type ToolRead,
  armChip,
  armConnections,
  googleArmStatus,
  merchantArmStatus,
  metaArmStatus,
} from "./ui-logic"

// ─── budgetMinorToMajor ────────────────────────────────────────────────────────

describe("budgetMinorToMajor — footgun: NOT always ÷100", () => {
  test("EUR (2-decimal): 5000 minor → 50 major", () => {
    expect(budgetMinorToMajor("5000", "EUR")).toBe(50)
  })
  test("JPY (0-decimal): 5000 minor → 5000 major (no division)", () => {
    expect(budgetMinorToMajor("5000", "JPY")).toBe(5000)
  })
  test("null → null", () => {
    expect(budgetMinorToMajor(null, "EUR")).toBeNull()
  })
  test("empty string → null", () => {
    expect(budgetMinorToMajor("", "EUR")).toBeNull()
  })
  test("VND (0-decimal): 1000 minor → 1000 major", () => {
    expect(budgetMinorToMajor("1000", "VND")).toBe(1000)
  })
  test("BHD (3-decimal): 1000 minor → 1 major", () => {
    expect(budgetMinorToMajor("1000", "BHD")).toBe(1)
  })
  test("USD (2-decimal): 500 minor → 5 major", () => {
    expect(budgetMinorToMajor("500", "USD")).toBe(5)
  })
  test("numeric input: 5000 (number) → 50 for EUR", () => {
    expect(budgetMinorToMajor(5000, "EUR")).toBe(50)
  })
})

// ─── effectiveStatusTone ────────────────────────────────────────────────────────

describe("effectiveStatusTone — footgun: must use effective_status, not status", () => {
  test("ACTIVE → success", () => {
    expect(effectiveStatusTone("ACTIVE")).toBe("success")
  })
  test("CAMPAIGN_PAUSED → NOT success (the footgun: status may be ACTIVE but tone is not)", () => {
    expect(effectiveStatusTone("CAMPAIGN_PAUSED")).not.toBe("success")
  })
  test("CAMPAIGN_PAUSED → muted", () => {
    expect(effectiveStatusTone("CAMPAIGN_PAUSED")).toBe("muted")
  })
  test("PAUSED → muted", () => {
    expect(effectiveStatusTone("PAUSED")).toBe("muted")
  })
  test("ADSET_PAUSED → muted", () => {
    expect(effectiveStatusTone("ADSET_PAUSED")).toBe("muted")
  })
  test("AD_PAUSED → muted", () => {
    expect(effectiveStatusTone("AD_PAUSED")).toBe("muted")
  })
  test("ARCHIVED → muted", () => {
    expect(effectiveStatusTone("ARCHIVED")).toBe("muted")
  })
  test("DELETED → muted", () => {
    expect(effectiveStatusTone("DELETED")).toBe("muted")
  })
  test("DISAPPROVED → error", () => {
    expect(effectiveStatusTone("DISAPPROVED")).toBe("error")
  })
  test("WITH_ISSUES → error", () => {
    expect(effectiveStatusTone("WITH_ISSUES")).toBe("error")
  })
  test("PENDING_REVIEW → warning", () => {
    expect(effectiveStatusTone("PENDING_REVIEW")).toBe("warning")
  })
  test("IN_PROCESS → warning", () => {
    expect(effectiveStatusTone("IN_PROCESS")).toBe("warning")
  })
  test("PREAPPROVED → warning", () => {
    expect(effectiveStatusTone("PREAPPROVED")).toBe("warning")
  })
  test("PENDING_BILLING_INFO → warning", () => {
    expect(effectiveStatusTone("PENDING_BILLING_INFO")).toBe("warning")
  })
  test("unknown → neutral", () => {
    expect(effectiveStatusTone("SOMETHING_ELSE")).toBe("neutral")
  })
})

// ─── flattenInsights ────────────────────────────────────────────────────────────

describe("flattenInsights — footgun: _split flag must be read", () => {
  test("_split:false → data returned unchanged", () => {
    const r1 = { impressions: "100" }
    const r2 = { impressions: "200" }
    const result = flattenInsights({ data: [r1, r2], _split: false })
    expect(result).toEqual([r1, r2])
  })

  test("_split:true with 2 sub-groups × 3 rows = 6 total rows", () => {
    const fixture = {
      _split: true as const,
      data: [
        {
          breakdowns: ["age"],
          data: [
            { age: "18-24", impressions: "10" },
            { age: "25-34", impressions: "20" },
            { age: "35-44", impressions: "30" },
          ],
        },
        {
          breakdowns: ["gender"],
          data: [
            { gender: "male", impressions: "15" },
            { gender: "female", impressions: "25" },
            { gender: "unknown", impressions: "5" },
          ],
        },
      ],
    }
    const rows = flattenInsights(fixture)
    expect(rows.length).toBe(6)
  })

  test("_split:true — returned items do NOT have a 'breakdowns' property", () => {
    const fixture = {
      _split: true as const,
      data: [
        {
          breakdowns: ["age"],
          data: [{ age: "18-24", impressions: "10" }],
        },
      ],
    }
    const rows = flattenInsights(fixture)
    for (const row of rows) {
      expect(row).not.toHaveProperty("breakdowns")
    }
  })

  test("_split:true — returned items do NOT have a 'data' property", () => {
    const fixture = {
      _split: true as const,
      data: [
        {
          breakdowns: ["age"],
          data: [{ age: "18-24", impressions: "10" }],
        },
      ],
    }
    const rows = flattenInsights(fixture)
    for (const row of rows) {
      expect(row).not.toHaveProperty("data")
    }
  })

  test("_split:true — no _split flag (undefined) → treat as flat", () => {
    const r = { impressions: "50" }
    const result = flattenInsights({ data: [r] })
    expect(result).toEqual([r])
  })
})

// ─── audienceCountLabel ────────────────────────────────────────────────────────

describe("audienceCountLabel — footgun: null check BEFORE numeric comparison", () => {
  test("null lower → unavailable", () => {
    expect(audienceCountLabel(null, null)).toBe("unavailable")
  })
  test("-1 lower → unavailable", () => {
    expect(audienceCountLabel(-1, 5000)).toBe("unavailable")
  })
  test("500 lower (< 1000) → unavailable", () => {
    expect(audienceCountLabel(500, 5000)).toBe("unavailable")
  })
  test("0 lower → unavailable", () => {
    expect(audienceCountLabel(0, 5000)).toBe("unavailable")
  })
  test("1000 lower, 5000 upper → range string", () => {
    const label = audienceCountLabel(1000, 5000)
    expect(label).toContain("1,000")
    expect(label).toContain("5,000")
    expect(label).toContain("-")
  })
  test("10000 lower, 50000 upper → range string with thousand separators", () => {
    const label = audienceCountLabel(10000, 50000)
    expect(label).toContain("10,000")
    expect(label).toContain("50,000")
  })
  test("null upper → uses lower for both bounds", () => {
    const label = audienceCountLabel(5000, null)
    expect(label).toContain("5,000")
  })
})

// ─── adFormatLabel ────────────────────────────────────────────────────────────

describe("adFormatLabel — placement enum to human label", () => {
  test("DESKTOP_FEED_STANDARD → Desktop Feed", () => {
    expect(adFormatLabel("DESKTOP_FEED_STANDARD")).toBe("Desktop Feed")
  })
  test("MOBILE_FEED_STANDARD → Mobile Feed", () => {
    expect(adFormatLabel("MOBILE_FEED_STANDARD")).toBe("Mobile Feed")
  })
  test("INSTAGRAM_STANDARD → Instagram Feed", () => {
    expect(adFormatLabel("INSTAGRAM_STANDARD")).toBe("Instagram Feed")
  })
  test("INSTAGRAM_STORY → Instagram Story", () => {
    expect(adFormatLabel("INSTAGRAM_STORY")).toBe("Instagram Story")
  })
  test("unknown → title-cased fallback", () => {
    const label = adFormatLabel("RIGHT_HAND_COLUMN")
    expect(label).toBe("Right Hand Column")
  })
})

// ─── formatMoney ────────────────────────────────────────────────────────────────

describe("formatMoney", () => {
  test("null → -", () => {
    expect(formatMoney(null)).toBe("-")
  })
  test("non-finite → -", () => {
    expect(formatMoney(NaN)).toBe("-")
  })
  test("number with USD currency → formatted string", () => {
    const result = formatMoney(50, "USD")
    expect(result).toContain("50")
    expect(result).toContain("$")
  })
  test("JPY (0-decimal) → no cents", () => {
    const result = formatMoney(5000, "JPY")
    expect(result).not.toContain(".")
    expect(result).toContain("5,000")
  })
  test("string value → parsed correctly", () => {
    const result = formatMoney("50.00", "EUR")
    expect(result).toContain("50")
  })
})

// ─── manifest-named surfaces + kit are functions ───────────────────────────────
// Component-is-callable contract — no DOM rendering needed in bun:test.
// The freeze bundler requires every views component to be a function.

describe("manifest-named surfaces + kit are functions", () => {
  test("kit primitives are functions", () => {
    expect(typeof StatusBadge).toBe("function")
    expect(typeof ConfirmDialog).toBe("function")
    expect(typeof AdPreviewDrawer).toBe("function")
  })

  test("barrel exports AdsDashboard as a function (P6 dashboard tab)", () => {
    expect(typeof AdsDashboard).toBe("function")
  })
})

// ─── Platform arms: the real tool contracts ──────────────────────────────────
//
// Shapes are the handlers' own: account_info rejects with meta_not_connected
// (lib/get-client.ts), google_account_info returns customer_id or a
// google_not_connected envelope (google-reads.ts), merchant_feed_status returns
// a feed summary or a merchant_not_configured / google_not_connected envelope
// (merchant-reads.ts).

const rejectedWith = (code?: string): ToolRead => {
  const error = new Error("rejected") as Error & { code?: string }
  if (code) error.code = code
  return { ok: false, error }
}
const resolved = (value: unknown): ToolRead => ({ ok: true, value })

describe("platform arm status follows the real tool contracts", () => {
  test("Meta: an account with an id is connected", () => {
    expect(metaArmStatus(resolved({ id: "act_1", name: "Shop", currency: "EUR" }))).toBe("connected")
  })

  test("Meta: a meta_not_connected rejection is not connected, not an outage", () => {
    expect(metaArmStatus(rejectedWith("meta_not_connected"))).toBe("not_connected")
  })

  test("Meta: any other rejection is an outage", () => {
    expect(metaArmStatus(rejectedWith("tool_error"))).toBe("errored")
    expect(metaArmStatus(rejectedWith())).toBe("errored")
  })

  test("Google: customer_id is connected; an object without it is not", () => {
    expect(googleArmStatus(resolved({ customer_id: "1234567890", currency: "EUR" }))).toBe("connected")
    expect(googleArmStatus(resolved({ id: "1234567890", currency: "EUR" }))).toBe("not_connected")
  })

  test("Google: the google_not_connected envelope is not connected; another envelope or a rejection is an outage", () => {
    expect(googleArmStatus(resolved({ error: { code: "google_not_connected", message: "x" } }))).toBe("not_connected")
    expect(googleArmStatus(resolved({ error: { code: "PERMISSION_DENIED", message: "x" } }))).toBe("errored")
    expect(googleArmStatus(rejectedWith("tool_error"))).toBe("errored")
  })

  test("Merchant: a feed summary is connected; a not-set-up envelope is NOT connected", () => {
    expect(merchantArmStatus(resolved({ approved: 4, disapproved: 0, pending: 0, expiring: 0 }))).toBe("connected")
    expect(merchantArmStatus(resolved({ error: { code: "merchant_not_configured", message: "x" } }))).toBe("not_connected")
    expect(merchantArmStatus(resolved({ error: { code: "google_not_connected", message: "x" } }))).toBe("not_connected")
  })

  test("Merchant: an unexpected envelope or a rejection is an outage", () => {
    expect(merchantArmStatus(resolved({ error: { code: "UNAUTHENTICATED", message: "x" } }))).toBe("errored")
    expect(merchantArmStatus(rejectedWith())).toBe("errored")
  })

  test("a fresh install (every arm not set up) resolves the dashboard to empty", () => {
    const arms = armConnections({
      meta: metaArmStatus(rejectedWith("meta_not_connected")),
      google: googleArmStatus(resolved({ error: { code: "google_not_connected", message: "x" } })),
      merchant: merchantArmStatus(resolved({ error: { code: "google_not_connected", message: "x" } })),
    })
    expect(
      deriveDashboardState({ connected: arms.connected, loading: false, hasError: false, connectionErrored: arms.anyErrored }),
    ).toBe("empty")
  })

  test("nothing connected and one arm in outage resolves to error, never empty", () => {
    const arms = armConnections({ meta: "errored", google: "not_connected", merchant: "not_connected" })
    expect(
      deriveDashboardState({ connected: arms.connected, loading: false, hasError: false, connectionErrored: arms.anyErrored }),
    ).toBe("error")
  })

  test("health chips: OK only when connected", () => {
    expect(armChip("connected")).toEqual({ tone: "success", label: "OK" })
    expect(armChip("not_connected")).toEqual({ tone: "neutral", label: "not connected" })
    expect(armChip("errored")).toEqual({ tone: "error", label: "error" })
  })
})

// ─── deriveDashboardState ──────────────────────────────────────────────────────

describe("deriveDashboardState — four states, pure derivation from resource tuples", () => {
  test("empty: no connections at all (every resource resolved to a 'not connected' shape)", () => {
    const state = deriveDashboardState({
      connected: { meta: false, google: false, merchant: false },
      loading: false,
      hasError: false,
    })
    expect(state).toBe("empty")
  })

  test("loading: at least one resource still loading, none connected yet is irrelevant — loading wins while in flight", () => {
    const state = deriveDashboardState({
      connected: { meta: false, google: false, merchant: false },
      loading: true,
      hasError: false,
    })
    expect(state).toBe("loading")
  })

  test("error: a connected platform's read threw — error state even if others are fine", () => {
    const state = deriveDashboardState({
      connected: { meta: true, google: false, merchant: false },
      loading: false,
      hasError: true,
    })
    expect(state).toBe("error")
  })

  test("populated: at least one platform connected, not loading, no error", () => {
    const state = deriveDashboardState({
      connected: { meta: true, google: false, merchant: false },
      loading: false,
      hasError: false,
    })
    expect(state).toBe("populated")
  })

  test("loading takes precedence over error (still resolving)", () => {
    const state = deriveDashboardState({
      connected: { meta: true, google: false, merchant: false },
      loading: true,
      hasError: true,
    })
    expect(state).toBe("loading")
  })

  test("every platform arm ERRORED with nothing connected -> error, NOT empty (all-arms outage must not read as no-spend)", () => {
    const state = deriveDashboardState({
      connected: { meta: false, google: false, merchant: false },
      loading: false,
      hasError: false,
      connectionErrored: true,
    })
    expect(state).toBe("error")
  })

  test("nothing connected and nothing errored -> empty (genuine fresh install, connectionErrored false)", () => {
    const state = deriveDashboardState({
      connected: { meta: false, google: false, merchant: false },
      loading: false,
      hasError: false,
      connectionErrored: false,
    })
    expect(state).toBe("empty")
  })

  test("connectionErrored does NOT override a still-working arm (partial degradation stays populated)", () => {
    // Meta works, Google account read errored: the board stays populated with an
    // inline error chip -- a single-arm outage must not blank the whole dashboard.
    const state = deriveDashboardState({
      connected: { meta: true, google: false, merchant: false },
      loading: false,
      hasError: false,
      connectionErrored: true,
    })
    expect(state).toBe("populated")
  })
})

// ─── zombieCampaigns ────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string
  name: string
  effective_status: string
  [key: string]: unknown
}
interface SpendRow {
  campaign_id?: string
  campaign_name?: string
  spend?: string | number | null
  [key: string]: unknown
}

describe("zombieCampaigns — ACTIVE effective_status × near-zero spend", () => {
  test("ACTIVE campaign with zero spend is flagged zombie", () => {
    const campaigns: CampaignRow[] = [{ id: "c1", name: "Zombie Camp", effective_status: "ACTIVE" }]
    const spend: SpendRow[] = [{ campaign_id: "c1", spend: "0" }]
    const result = zombieCampaigns(campaigns, spend)
    expect(result.map((r) => r.id)).toEqual(["c1"])
  })

  test("ACTIVE campaign with real spend is NOT flagged (both-directions)", () => {
    const campaigns: CampaignRow[] = [{ id: "c2", name: "Healthy Camp", effective_status: "ACTIVE" }]
    const spend: SpendRow[] = [{ campaign_id: "c2", spend: "154.20" }]
    const result = zombieCampaigns(campaigns, spend)
    expect(result).toEqual([])
  })

  test("PAUSED campaign with zero spend is NOT a zombie (zombie requires ACTIVE effective_status)", () => {
    const campaigns: CampaignRow[] = [{ id: "c3", name: "Paused Camp", effective_status: "CAMPAIGN_PAUSED" }]
    const spend: SpendRow[] = [{ campaign_id: "c3", spend: "0" }]
    const result = zombieCampaigns(campaigns, spend)
    expect(result).toEqual([])
  })

  test("ACTIVE campaign with no matching spend row at all is treated as zero spend (zombie)", () => {
    const campaigns: CampaignRow[] = [{ id: "c4", name: "No Data Camp", effective_status: "ACTIVE" }]
    const spend: SpendRow[] = []
    const result = zombieCampaigns(campaigns, spend)
    expect(result.map((r) => r.id)).toEqual(["c4"])
  })

  test("matches spend rows by campaign_name fallback when campaign_id is absent", () => {
    const campaigns: CampaignRow[] = [{ id: "c5", name: "Named Camp", effective_status: "ACTIVE" }]
    const spend: SpendRow[] = [{ campaign_name: "Named Camp", spend: "42" }]
    const result = zombieCampaigns(campaigns, spend)
    expect(result).toEqual([])
  })
})

// ─── daysToDecision ─────────────────────────────────────────────────────────────

describe("daysToDecision — decision_date minus today, incl. past-due negative", () => {
  test("decision date 5 days in the future → 5", () => {
    expect(daysToDecision("2026-07-12", "2026-07-07")).toBe(5)
  })

  test("decision date today → 0", () => {
    expect(daysToDecision("2026-07-07", "2026-07-07")).toBe(0)
  })

  test("decision date 3 days in the past → -3 (past-due, negative)", () => {
    expect(daysToDecision("2026-07-04", "2026-07-07")).toBe(-3)
  })

  test("null decision_date → null (unknown/undecided)", () => {
    expect(daysToDecision(null, "2026-07-07")).toBeNull()
  })
})

// ─── healthFlags ────────────────────────────────────────────────────────────────

describe("healthFlags — aggregation incl. per-connection error", () => {
  test("aggregates learning-phase, disapproved products, zombie campaigns, and connection errors", () => {
    const flags = healthFlags({
      campaigns: [
        { id: "c1", name: "Zombie", effective_status: "ACTIVE" },
        { id: "c2", name: "Learning", effective_status: "ACTIVE", learning: true },
      ],
      spend: [{ campaign_id: "c1", spend: "0" }, { campaign_id: "c2", spend: "50" }],
      merchantDisapprovedCount: 3,
      connectionErrors: { meta: false, google: true, merchant: false },
    })
    expect(flags.zombieCount).toBe(1)
    expect(flags.learningPhaseCount).toBe(1)
    expect(flags.disapprovedProductsCount).toBe(3)
    expect(flags.connectionErrors.google).toBe(true)
    expect(flags.connectionErrors.meta).toBe(false)
  })

  test("count-0 anti-rubber-stamp: zero disapproved + zero zombie + no connection errors all report zero/false, not omitted", () => {
    const flags = healthFlags({
      campaigns: [{ id: "c1", name: "Healthy", effective_status: "ACTIVE" }],
      spend: [{ campaign_id: "c1", spend: "99" }],
      merchantDisapprovedCount: 0,
      connectionErrors: { meta: false, google: false, merchant: false },
    })
    expect(flags.zombieCount).toBe(0)
    expect(flags.disapprovedProductsCount).toBe(0)
    expect(flags.connectionErrors.meta).toBe(false)
    expect(flags.connectionErrors.google).toBe(false)
    expect(flags.connectionErrors.merchant).toBe(false)
  })
})

// ─── weeklySpendTotal ──────────────────────────────────────────────────────────

describe("weeklySpendTotal — sums a money field, never rescales (both feeds are major units)", () => {
  test("Meta rows: sums the `spend` field (major-unit decimal strings)", () => {
    const rows = [{ spend: "12.34" }, { spend: "7.66" }]
    expect(weeklySpendTotal(rows, "spend")).toBeCloseTo(20, 5)
  })

  test("Google rows: sums the `cost` field (already micros-converted to major)", () => {
    const rows = [{ cost: 10 }, { cost: 5.5 }]
    expect(weeklySpendTotal(rows, "cost")).toBeCloseTo(15.5, 5)
  })

  test("null/undefined/empty rows → null (distinguishes 'no data yet' from zero)", () => {
    expect(weeklySpendTotal(null, "spend")).toBeNull()
    expect(weeklySpendTotal(undefined, "cost")).toBeNull()
    expect(weeklySpendTotal([], "spend")).toBeNull()
  })

  test("rows present but the field is missing everywhere → null, not a false zero", () => {
    expect(weeklySpendTotal([{ impressions: 100 }], "spend")).toBeNull()
  })

  test("all-zero rows → 0 (a genuine confirmed zero, not null)", () => {
    expect(weeklySpendTotal([{ spend: "0" }, { spend: 0 }], "spend")).toBe(0)
  })

  test("skips non-finite values but still sums the valid ones", () => {
    const rows = [{ cost: 3 }, { cost: "not-a-number" }, { cost: 4 }]
    expect(weeklySpendTotal(rows, "cost")).toBeCloseTo(7, 5)
  })
})

// ─── dashboardCardError ────────────────────────────────────────────────────────

describe("dashboardCardError — global banner only when EVERY tile in a card failed", () => {
  test("one failed tile among live siblings -> false (inline degradation, no banner)", () => {
    // Live case: one transient metrics_run timeout (MER DTC) while MER total
    // and both spend tiles loaded fine must NOT raise the global banner.
    expect(dashboardCardError([true, false, false, false])).toBe(false)
  })

  test("all but one tile failed -> still false", () => {
    expect(dashboardCardError([true, true, true, false])).toBe(false)
  })

  test("every tile failed -> true (whole card down, banner-worthy)", () => {
    expect(dashboardCardError([true, true, true, true])).toBe(true)
  })

  test("no tiles failed -> false", () => {
    expect(dashboardCardError([false, false, false, false])).toBe(false)
  })

  test("empty tile list -> false (vacuous every() must not read as an outage)", () => {
    expect(dashboardCardError([])).toBe(false)
  })
})

// ─── per-widget degradation: one widget failing never blanks its siblings ───────

describe("dashboard per-widget isolation — a single widget failure keeps the tab rendering", () => {
  // The whole-tab regression: one failed tool call (e.g. insights_query 500 on
  // the Meta async race) previously crashed the entire dashboard into
  // "Something went wrong in this tab" while 12 sibling calls succeeded. The
  // contract that prevents it: (1) an errored tile does NOT raise the global
  // banner unless EVERY tile in its card errored (dashboardCardError), and
  // (2) with anything connected the dashboard resolves to a RENDERING state
  // ("populated"), never "error", so the surviving tiles paint.

  test("one insights tile errored, siblings fine, an account connected -> renders (populated), no banner", () => {
    // A single metaSpend/insights failure among four header tiles.
    const hasError = dashboardCardError([/* merDtc */ false, /* merTotal */ false, /* metaSpend */ true, /* googleSpend */ false])
    expect(hasError).toBe(false) // global banner stays hidden
    const state = deriveDashboardState({
      connected: { meta: true, google: false, merchant: false },
      loading: false,
      hasError,
      connectionErrored: false,
    })
    // The grid renders (populated) so the 3 healthy sibling tiles are visible;
    // the one failed tile shows its own inline Unavailable + Retry.
    expect(state).toBe("populated")
  })

  test("many tiles errored but at least one live -> still no banner, still renders", () => {
    const hasError = dashboardCardError([true, true, true, false])
    expect(hasError).toBe(false)
    const state = deriveDashboardState({
      connected: { meta: true, google: false, merchant: false },
      loading: false,
      hasError,
      connectionErrored: false,
    })
    expect(state).toBe("populated")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Phone width (spec-responsive.md): the campaigns table is a comparison
// table, so it declares which columns survive 390 px; the rest stay in the
// row and paint once the row's own accordion expand is open.
// ─────────────────────────────────────────────────────────────────────────
describe("campaigns phone columns", () => {
  const campaignsSource = readFileSync(join(import.meta.dir, "Campaigns.tsx"), "utf8")

  test("declares the surviving campaign columns explicitly", () => {
    expect(CAMPAIGN_COLUMNS.map((c) => c.key)).toEqual([
      "expand",
      "name",
      "objective",
      "status",
      "budget",
      "actions",
    ])
    expect(CAMPAIGN_COLUMNS.filter((c) => c.survivesPhone).map((c) => c.key)).toEqual([
      "expand",
      "name",
      "status",
      "actions",
    ])
  })

  test("paints a survivor at every width and hides the rest until the row expands", () => {
    expect(phoneCellClass("name", CAMPAIGN_COLUMNS, false)).toBe("")
    expect(phoneCellClass("budget", CAMPAIGN_COLUMNS, false)).toBe("hidden md:table-cell")
    expect(phoneCellClass("budget", CAMPAIGN_COLUMNS, true)).toBe("block md:table-cell")
  })

  test("renders the campaigns table through the shared CardTable, which handles the phone card story itself", () => {
    expect(campaignsSource).toContain('import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"')
    expect(campaignsSource).toContain("<CardTable")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Phone width (spec-responsive.md): the dashboard's stat grids. At 390 px a
// two-column grid ran the "Unavailable" value under its amber status chip and
// clipped the next chip, so every stat grid starts at ONE column and takes its
// second column at 640 px, the shell's phone tier and CardTable's own switch
// point.
//
// Asserted on the source, the way the campaigns phone columns above are: a
// bundled app has no DOM harness (bun test carries no Solid JSX transform).
// ─────────────────────────────────────────────────────────────────────────
describe("dashboard stat grids at phone width", () => {
  const dashboardSource = readFileSync(join(import.meta.dir, "Dashboard.tsx"), "utf8")
  const gridClasses = [...dashboardSource.matchAll(/class="[^"]*\bgrid\b[^"]*"/g)].map((m) => m[0])

  test("the Spend and blended MER grid is single column below 640 px", () => {
    expect(dashboardSource).toContain(
      '<div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">',
    )
  })

  test("no stat grid keeps two or more columns at phone width", () => {
    // Unprefixed only: `sm:grid-cols-2` applies from 640 px up, which is fine.
    const multiColumnAtPhone = gridClasses.filter((cls) => /(?<![:-])grid-cols-[2-9]\b/.test(cls))
    expect(multiColumnAtPhone).toEqual([])
  })
})

// ── Sidebar footer build stamp ───────────────────────────────────────────────
//
// The footer read "Ads v0.1" while the shipped bundle was 0.1.25: a hand typed
// prefix that stopped tracking the app at its first patch, so the one thing
// the footer exists to tell you (which bundle is this) it could not tell you.
describe("sidebar version stamp", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
  ) as { version: string }

  test("carries the manifest's FULL version, patch included", () => {
    expect(APP_VERSION).toBe(manifest.version)
    expect(APP_VERSION_LABEL).toBe(`Ads v${manifest.version}`)
    // A two segment stamp is the bug: 0.1 is not a version this app ever had.
    expect(APP_VERSION_LABEL.split(" v")[1]?.split(".")).toHaveLength(3)
  })

  test("the sidebar renders the stamp rather than a literal of its own", () => {
    const src = readFileSync(join(import.meta.dir, "sidebar.tsx"), "utf8")
    expect(src).toContain("APP_VERSION_LABEL")
    expect(src).not.toMatch(/Ads v\d/)
  })
})

// ── Phone chrome ─────────────────────────────────────────────────────────────
//
// At phone width the kernel shell draws the pane's name in its header bar, so
// a pane that also draws it says "Dashboard" twice down the screen. The rule
// belongs to @liaison/app-ui's PageHeader, which every pane here builds on;
// this pins that the app keeps building on it instead of rolling its own.
describe("phone page chrome", () => {
  test("every pane titles itself through the shared PageHeader", () => {
    for (const file of ["Dashboard.tsx", "Campaigns.tsx", "Ads.tsx", "Audiences.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8")
      expect({ file, header: src.includes("<PageHeader") }).toEqual({ file, header: true })
      // A hand rolled <h1> would sit outside the rule and duplicate again.
      expect({ file, ownTitle: /<h1[\s>]/.test(src) }).toEqual({ file, ownTitle: false })
    }
  })

  test("the shared PageHeader hides the duplicated title below the phone tier", () => {
    const kit = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "packages", "app-ui", "src", "kit.tsx"),
      "utf8",
    )
    expect(kit).toContain("data-page-title")
    expect(kit).toContain("max-sm:hidden")
  })
})

// ─── Meta report still building / throttled while building ─────────────────
import { metaPendingIssue as pendingIssue } from "./ui-logic"

describe("metaPendingIssue: a pending insights answer is a notice, not an error", () => {
  test("still building -> 'Meta is still preparing this report' with Retry", () => {
    const issue = pendingIssue({ data: [], _pending: true, _pending_reason: "not_ready" })
    expect(issue).toEqual({
      kind: "pending",
      text: "Meta is still preparing this report. Try again in a moment.",
      retry: true,
      tone: "notice",
    })
  })
  test("throttled while polling -> the throttle sentence", () => {
    expect(pendingIssue({ data: [], _pending: true, _pending_reason: "rate_limited" })?.text).toBe(
      "Meta is limiting requests right now. Try again in a few minutes.",
    )
  })
  test("rows -> no issue", () => {
    expect(pendingIssue({ data: [{ spend: 1 }] })).toBeNull()
  })
})
