// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A deployment with no Meta and no Google connection is a NORMAL state: every
// ads tool must answer it with the structured `{ error: { code, message } }`
// envelope the shopify app ships, never with a throw (which the tool route
// turns into HTTP 500 and the dashboard can only read as an outage).
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as handlers from "./handlers"
import {
  armConnections,
  dashboardCardError,
  deriveDashboardState,
  googleArmStatus,
  insightRows,
  isToolErrorEnvelope,
  merchantArmStatus,
  metaArmStatus,
  toolData,
  toolRows,
  weeklySpendTotal,
} from "./ui/ui-logic"

/** A ctx with nothing connected, and a fetch that must never be reached. */
function unconnectedCtx() {
  return {
    connections: {},
    fetch: () => {
      throw new Error("no tool may call the platform API when nothing is connected")
    },
  }
}

const META_TOOLS = [
  "account_info",
  "insights_query",
  "campaigns_list",
  "adsets_list",
  "ads_list",
  "audiences_list",
  "pages_list",
  "counts",
] as const

const GOOGLE_TOOLS = [
  "google_account_info",
  "google_insights_query",
  "google_campaigns_list",
  "google_adgroups_list",
  "google_search_terms",
  "google_recommendations_list",
] as const

type Handler = (params: Record<string, unknown>, ctx: unknown) => Promise<unknown>

/** A settled tool read, the shape the dashboard classifies its arms from. */
async function settle(call: () => Promise<unknown>) {
  try {
    return { ok: true as const, value: await call() }
  } catch (error) {
    return { ok: false as const, error }
  }
}

function envelopeCode(result: unknown): unknown {
  return (result as { error?: { code?: unknown } } | null)?.error?.code
}

describe("ads tools with nothing connected", () => {
  for (const name of META_TOOLS) {
    it(`${name} returns the meta_not_connected envelope instead of throwing`, async () => {
      const fn = (handlers as unknown as Record<string, Handler>)[name]!
      const result = await fn({ level: "account", date_preset: "last_7d" }, unconnectedCtx())
      expect(envelopeCode(result)).toBe("meta_not_connected")
      expect(String((result as { error: { message: string } }).error.message)).toContain(
        "not connected",
      )
    })
  }

  for (const name of GOOGLE_TOOLS) {
    it(`${name} returns the google_not_connected envelope instead of throwing`, async () => {
      const fn = (handlers as unknown as Record<string, Handler>)[name]!
      const result = await fn(
        { query: "SELECT campaign.id FROM campaign", campaign_id: "1" },
        unconnectedCtx(),
      )
      expect(envelopeCode(result)).toBe("google_not_connected")
    })
  }

  it("merchant_feed_status already answered with an envelope and still does", async () => {
    const result = await (handlers as unknown as Record<string, Handler>).merchant_feed_status!(
      {},
      unconnectedCtx(),
    )
    expect(["google_not_connected", "merchant_not_configured"]).toContain(
      String(envelopeCode(result)),
    )
  })
})

// The kernel half, mirrored here as the contract the dashboard sees: a
// not-connected envelope comes back as the tool's ANSWER with HTTP 200
// (execute-tool.ts isNotConnectedToolErrorCode), so the panels resolve with
// the envelope instead of rejecting. Answering 500 made every tile an error
// and painted "One or more panels could not load" over a workspace where
// nothing had ever been connected.
describe("an envelope delivered as a resolved 200 reads as not connected", () => {
  it("every arm is not_connected and no panel counts as failed", async () => {
    const ctx = unconnectedCtx()
    const h = handlers as unknown as Record<string, Handler>
    // What the tool route now returns: `{ ok: true, value: <envelope> }`.
    const asAnswer = (value: unknown) => ({ ok: true as const, value })
    const meta = metaArmStatus(asAnswer(await h.account_info!({}, ctx)))
    const google = googleArmStatus(asAnswer(await h.google_account_info!({}, ctx)))
    const merchant = merchantArmStatus(asAnswer(await h.merchant_feed_status!({}, ctx)))
    expect([meta, google, merchant]).toEqual(["not_connected", "not_connected", "not_connected"])

    const arms = armConnections({ meta, google, merchant })
    expect(arms.anyErrored).toBe(false)
    // The spend tiles resolved, so none of them is an errored tile.
    expect(dashboardCardError([false, false, false, false])).toBe(false)
    expect(
      deriveDashboardState({
        connected: arms.connected,
        loading: false,
        hasError: dashboardCardError([false, false, false, false]),
        connectionErrored: arms.anyErrored,
      }),
    ).toBe("empty")
  })

  it("a genuine platform error on the meta arm is still an outage", () => {
    expect(metaArmStatus({ ok: true, value: { error: { code: "upstream_unavailable" } } })).toBe(
      "errored",
    )
  })
})

// The dashboard half: what the tools now answer must read as "nothing
// connected", not as a platform outage with degraded tiles.
describe("the dashboard reads a deployment with no connection as not connected", () => {
  it("every arm resolves not_connected and the dashboard lands on its empty state", async () => {
    const ctx = unconnectedCtx()
    const h = handlers as unknown as Record<string, Handler>
    const meta = metaArmStatus(await settle(() => h.account_info!({}, ctx)))
    const google = googleArmStatus(await settle(() => h.google_account_info!({}, ctx)))
    const merchant = merchantArmStatus(await settle(() => h.merchant_feed_status!({}, ctx)))

    expect([meta, google, merchant]).toEqual(["not_connected", "not_connected", "not_connected"])

    const arms = armConnections({ meta, google, merchant })
    expect(arms.anyErrored).toBe(false)
    expect(
      deriveDashboardState({
        connected: arms.connected,
        loading: false,
        hasError: false,
        connectionErrored: arms.anyErrored,
      }),
    ).toBe("empty")
  })
})

// The crash half. 0.1.24 moved the not-connected answer from a REJECTION to a
// resolved 200 carrying `{ error: { code } }`, and only the arm-status helpers
// learned to read it: every data memo still read a list field straight off the
// envelope, so the dashboard threw "Cannot read properties of undefined
// (reading '0')" on both tiers instead of reaching its empty state.
describe("the dashboard data memos read an envelope as no data", () => {
  it("the KPI row, campaign rows and spend totals survive the envelope", async () => {
    const ctx = unconnectedCtx()
    const h = handlers as unknown as Record<string, Handler>
    const envelope = await h.insights_query!({ level: "account", date_preset: "last_7d" }, ctx)
    expect(envelopeCode(envelope)).toBe("meta_not_connected")

    // The exact expression that threw: first row of the KPI insights answer.
    expect(() => insightRows(envelope)[0] ?? null).not.toThrow()
    expect(insightRows(envelope)).toEqual([])
    expect(insightRows(envelope)[0] ?? null).toBeNull()
    // And the list-shaped reads beside it.
    expect(toolRows(await h.campaigns_list!({}, ctx))).toEqual([])
    expect(toolRows(await h.audiences_list!({}, ctx))).toEqual([])
    expect(toolRows(await h.ads_list!({}, ctx))).toEqual([])
    expect(
      toolRows(
        await h.google_insights_query!({ query: "SELECT campaign.id FROM campaign" }, ctx),
        "rows",
      ),
    ).toEqual([])
    expect(weeklySpendTotal(toolRows<Record<string, unknown>>(envelope), "spend")).toBeNull()
    // A field read off the envelope is a field read off an error object.
    expect(toolData(await h.account_info!({}, ctx))).toBeNull()
    expect(isToolErrorEnvelope(envelope)).toBe(true)
  })

  it("a split insights payload and a real payload still read normally", () => {
    expect(insightRows({ data: [{ spend: "1.00" }] })).toEqual([{ spend: "1.00" }])
    expect(
      insightRows({
        _split: true,
        data: [{ data: [{ spend: "2.00" }] }, { data: [{ spend: "3.00" }] }],
      }),
    ).toEqual([{ spend: "2.00" }, { spend: "3.00" }])
    expect(isToolErrorEnvelope({ data: [] })).toBe(false)
  })

  it("the whole board lands on its empty state with no errored panel", async () => {
    const ctx = unconnectedCtx()
    const h = handlers as unknown as Record<string, Handler>
    const asAnswer = (value: unknown) => ({ ok: true as const, value })
    const arms = armConnections({
      meta: metaArmStatus(asAnswer(await h.account_info!({}, ctx))),
      google: googleArmStatus(asAnswer(await h.google_account_info!({}, ctx))),
      merchant: merchantArmStatus(asAnswer(await h.merchant_feed_status!({}, ctx))),
    })
    expect(arms.anyErrored).toBe(false)
    expect(
      deriveDashboardState({
        connected: arms.connected,
        loading: false,
        hasError: dashboardCardError([false, false, false, false]),
        connectionErrored: arms.anyErrored,
      }),
    ).toBe("empty")
  })
})

// The guard that keeps the fix from rotting: no view file may read a list or a
// field straight off a tool answer again. Every one of them goes through
// toolRows / insightRows / toolData, which is where the envelope is handled.
describe("no view file reads a tool answer directly", () => {
  it("has no raw data-field read or InsightRow cast left in the ads UI", () => {
    const dir = join(import.meta.dir, "ui")
    const offenders: string[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".tsx") || file.includes(".test.")) continue
      const source = readFileSync(join(dir, file), "utf8")
      for (const [line, text] of source.split("\n").entries()) {
        if (
          /\.data\b/.test(text) ||
          /as\s+(?:InsightRow|CampaignRow|AdRow|AdSetRow)\[\]/.test(text)
        ) {
          offenders.push(`${file}:${line + 1}: ${text.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
