// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the ads app's contract fixtures (fixtures/ads/*.json). The Meta
// Marketing API, the Google Ads API and the Merchant API offer no sandbox
// account a recorder can use, so the provider side is the documented response
// shapes of the endpoints the app calls (fake-providers.test-helpers.ts), with
// a fictional ad account, campaigns and Merchant Center. The shopify and
// database apps the ads app reads across apps are not installed in the
// recording org: their answers are stand-ins in those apps' documented result
// shapes. Everything else (the database, the store, timers, the kernel) is the
// real bridge. Not part of any suite run (it skips unless CONTRACT_RECORD=1):
// run it by path when the app's bridge calls change, read what it wrote,
// commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-ads.recorder.test.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import type { ContractEntry } from "./entries"
import {
  type FakeProviders,
  type FakeRoute,
  graphPage,
  installFakeProviders,
  on,
} from "./fake-providers.test-helpers"
import {
  connectCredentials,
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "./replay-bridge"

const APP = "ads"
const META_TOKEN = "contract-meta-system-user-token-not-real"
const GOOGLE_TOKEN = "contract-google-ads-token-not-real"
const MERCHANT_TOKEN = "contract-merchant-token-not-real"

const ACCOUNT = "1234567890123456"
const ACT = `act_${ACCOUNT}`
const PAGE = "104857600000001"
const CAMPAIGN = "120210000000000101"
const CAMPAIGN_2 = "120210000000000102"
const ADSET = "120210000000000201"
const AD = "120210000000000301"
const CREATIVE = "120210000000000401"
const AUDIENCE = "120210000000000501"
const LOOKALIKE = "120210000000000502"
const REPORT_RUN = "1234000000000001"
const IMAGE_HASH = "7c3e4f5a6b7c8d9e0f1a2b3c4d5e6f70"
const CUSTOMER = "1234567890"
const LOGIN_CUSTOMER = "9876543210"
const MERCHANT = "5550001234"
const G_CAMPAIGN = "21000000001"
const G_ADGROUP = "152000000001"
const G_AD = "700000000001"
const G_BUDGET = "13000000001"

const campaigns = [
  {
    id: CAMPAIGN,
    name: "Bass traps – prospecting FR",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_SALES",
    daily_budget: "3500",
  },
  {
    id: CAMPAIGN_2,
    name: "Retargeting – cart abandoners",
    status: "ACTIVE",
    effective_status: "CAMPAIGN_PAUSED",
    objective: "OUTCOME_SALES",
    daily_budget: "1500",
  },
]
const adsets = [
  {
    id: ADSET,
    name: "FR 25-54 home studio interests",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign_id: CAMPAIGN,
    daily_budget: "3500",
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["FR"] }, age_min: 25, age_max: 54 },
  },
]
const ads = [
  {
    id: AD,
    name: "Bass trap carousel",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    adset_id: ADSET,
    campaign_id: CAMPAIGN,
    creative: { id: CREATIVE },
  },
]
const insightRow = (date: string, spend: string, extra: Record<string, unknown> = {}) => ({
  date_start: date,
  date_stop: date,
  spend,
  impressions: "18234",
  clicks: "412",
  cpm: "6.71",
  ctr: "2.26",
  account_currency: "EUR",
  ...extra,
})
const objects: Record<string, unknown> = {
  [ACT]: {
    id: ACT,
    account_id: ACCOUNT,
    name: "Resonant Audio Labs",
    currency: "EUR",
    timezone_name: "Europe/Paris",
    account_status: 1,
    amount_spent: "184520",
    spend_cap: "0",
  },
  [CAMPAIGN]: campaigns[0],
  [CAMPAIGN_2]: campaigns[1],
  [ADSET]: adsets[0],
  [AD]: ads[0],
  [CREATIVE]: {
    id: CREATIVE,
    name: "Bass trap carousel creative",
    object_story_spec: {
      page_id: PAGE,
      link_data: {
        link: "https://shop.example.com/bass-traps",
        message: "30 % less boom in small rooms.",
      },
    },
    thumbnail_url: "https://scontent.example.com/creative-thumb.jpg",
  },
  [REPORT_RUN]: { id: REPORT_RUN, async_status: "Job Completed", async_percent_completion: 100 },
}

function metaRoutes(): FakeRoute[] {
  const fb = "graph.facebook.com"
  return [
    on(
      "GET",
      `/${ACT}/insights`,
      (r) =>
        graphPage(
          r.query.time_increment === "1"
            ? [
                insightRow("2025-12-29", "48.20"),
                insightRow("2025-12-30", "51.75"),
                insightRow("2025-12-31", "47.10"),
              ]
            : [
                insightRow("2025-12-01", "1432.65", {
                  date_stop: "2025-12-31",
                  campaign_id: CAMPAIGN,
                  campaign_name: campaigns[0]?.name,
                }),
              ],
        ),
      fb,
    ),
    on("POST", `/${ACT}/insights`, () => ({ report_run_id: REPORT_RUN }), fb),
    on(
      "GET",
      `/${REPORT_RUN}/insights`,
      () =>
        graphPage([
          insightRow("2025-12-31", "31.40", { ad_id: AD, ad_name: ads[0]?.name, adset_id: ADSET }),
          insightRow("2025-12-31", "15.70", {
            ad_id: "120210000000000302",
            ad_name: "Studio tour video",
            adset_id: ADSET,
          }),
        ]),
      fb,
    ),
    on("GET", `/${ACT}/campaigns`, () => graphPage(campaigns), fb),
    on("GET", /^\/(act_\d+|\d+)\/adsets$/, () => graphPage(adsets), fb),
    on("GET", /^\/(act_\d+|\d+)\/ads$/, () => graphPage(ads), fb),
    on(
      "GET",
      "/search",
      (r) =>
        graphPage(
          r.query.type === "adgeolocation"
            ? [
                {
                  key: "BE",
                  name: "Belgium",
                  type: "country",
                  country_code: "BE",
                  supports_region: true,
                  supports_city: true,
                },
              ]
            : [
                {
                  id: "6003139266461",
                  name: "Home recording",
                  audience_size_lower_bound: 2400000,
                  audience_size_upper_bound: 2900000,
                  path: ["Interests", "Music", "Home recording"],
                },
              ],
        ),
      fb,
    ),
    on(
      "GET",
      `/${ACT}/adimages`,
      () =>
        graphPage([
          {
            hash: IMAGE_HASH,
            name: "bass-trap-hero.jpg",
            url: "https://scontent.example.com/bass-trap-hero.jpg",
            width: 1080,
            height: 1080,
            created_time: "2025-12-10T09:30:00+0000",
          },
        ]),
      fb,
    ),
    on(
      "GET",
      `/${ACT}/advideos`,
      () =>
        graphPage([
          {
            id: "1300000000000001",
            title: "Studio tour",
            length: 42.5,
            created_time: "2025-11-20T15:00:00+0000",
          },
        ]),
      fb,
    ),
    on(
      "GET",
      `/${ACT}/customaudiences`,
      () =>
        graphPage([
          {
            id: AUDIENCE,
            name: "Buyers – last 180 days",
            subtype: "CUSTOM",
            approximate_count_lower_bound: 1200,
            approximate_count_upper_bound: 1500,
            delivery_status: { code: 200, description: "This audience is ready for use." },
            operation_status: { code: 200, description: "Normal" },
          },
        ]),
      fb,
    ),
    on(
      "GET",
      "/me/accounts",
      () =>
        graphPage([
          { id: PAGE, name: "Resonant Audio Labs", category: "Musical instrument store" },
        ]),
      fb,
    ),
    on(
      "GET",
      /^\/(\d+)\/previews$/,
      () =>
        graphPage([
          {
            body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQ" width="540" height="690"></iframe>',
          },
        ]),
      fb,
    ),
    on("POST", `/${ACT}/campaigns`, () => ({ id: "120210000000000103" }), fb),
    on("POST", `/${ACT}/adsets`, () => ({ id: "120210000000000202" }), fb),
    on("POST", `/${ACT}/ads`, () => ({ id: "120210000000000303" }), fb),
    on("POST", `/${ACT}/adcreatives`, () => ({ id: "120210000000000402" }), fb),
    on(
      "POST",
      `/${ACT}/adimages`,
      () => ({
        images: {
          "bass-trap-square.png": {
            hash: IMAGE_HASH,
            url: "https://scontent.example.com/bass-trap-square.png",
          },
        },
      }),
      fb,
    ),
    on(
      "POST",
      `/${ACT}/customaudiences`,
      (r) => ({ id: r.form.subtype === "LOOKALIKE" ? LOOKALIKE : AUDIENCE }),
      fb,
    ),
    on(
      "POST",
      /^\/(\d+)\/users$/,
      () => ({
        audience_id: AUDIENCE,
        session_id: "4100000000000001",
        num_received: 3,
        num_invalid_entries: 0,
        invalid_entry_samples: {},
      }),
      fb,
    ),
    on(
      "DELETE",
      /^\/(\d+)\/users$/,
      () => ({
        audience_id: AUDIENCE,
        session_id: "4100000000000002",
        num_received: 1,
        num_invalid_entries: 0,
        invalid_entry_samples: {},
      }),
      fb,
    ),
    on("POST", /^\/(\d+)$/, () => ({ success: true }), fb),
    on("GET", /^\/(act_\d+|\d+)$/, (_r, m) => objects[m?.[1] ?? ""] ?? { id: m?.[1] }, fb),
  ]
}

/** One Google Ads searchStream batch for the query's FROM resource. */
function gaqlRows(query: string): unknown[] {
  const from = /\bFROM\s+(\w+)/i.exec(query)?.[1]?.toLowerCase()
  const campaign = {
    resourceName: `customers/${CUSTOMER}/campaigns/${G_CAMPAIGN}`,
    id: G_CAMPAIGN,
    name: "Search – acoustic panels FR",
    status: "ENABLED",
    advertisingChannelType: "SEARCH",
  }
  switch (from) {
    case "campaign":
      return [
        {
          campaign,
          campaignBudget: {
            resourceName: `customers/${CUSTOMER}/campaignBudgets/${G_BUDGET}`,
            amountMicros: "25000000",
          },
          metrics: { clicks: "318", impressions: "9120", costMicros: "214350000", conversions: 11 },
          segments: { date: "2025-12-31" },
        },
      ]
    case "ad_group":
      return [
        {
          adGroup: {
            resourceName: `customers/${CUSTOMER}/adGroups/${G_ADGROUP}`,
            id: G_ADGROUP,
            name: "Bass traps",
            status: "ENABLED",
          },
          campaign: { resourceName: campaign.resourceName, id: G_CAMPAIGN },
        },
      ]
    case "ad_group_ad":
      return [
        {
          adGroupAd: {
            resourceName: `customers/${CUSTOMER}/adGroupAds/${G_ADGROUP}~${G_AD}`,
            status: "ENABLED",
            ad: {
              id: G_AD,
              responsiveSearchAd: {
                headlines: [
                  { text: "Acoustic panels made in France" },
                  { text: "Free shipping over 150 €" },
                ],
              },
            },
          },
          adGroup: { id: G_ADGROUP },
          campaign: { id: G_CAMPAIGN },
        },
      ]
    case "customer":
      return [
        {
          customer: {
            resourceName: `customers/${CUSTOMER}`,
            id: CUSTOMER,
            currencyCode: "EUR",
            timeZone: "Europe/Paris",
          },
        },
      ]
    case "conversion_action":
      return [
        {
          conversionAction: {
            resourceName: `customers/${CUSTOMER}/conversionActions/9001`,
            id: "9001",
            name: "Purchase",
            type: "WEBPAGE",
            status: "ENABLED",
          },
        },
      ]
    case "search_term_view":
      return [
        {
          searchTermView: { searchTerm: "bass trap corner" },
          metrics: { clicks: "41", costMicros: "28700000", conversions: 3 },
        },
        {
          searchTermView: { searchTerm: "free acoustic foam" },
          metrics: { clicks: "17", costMicros: "9100000", conversions: 0 },
        },
      ]
    case "recommendation":
      return [
        {
          recommendation: {
            resourceName: `customers/${CUSTOMER}/recommendations/${G_CAMPAIGN}~KEYWORD~1`,
            type: "KEYWORD",
            campaign: campaign.resourceName,
            dismissed: false,
          },
        },
      ]
    default:
      return []
  }
}

function googleRoutes(): FakeRoute[] {
  const g = "googleads.googleapis.com"
  return [
    on(
      "POST",
      /^\/customers\/(\d+)\/googleAds:searchStream$/,
      (r) => {
        const results = gaqlRows(String((r.json as { query?: string } | null)?.query ?? ""))
        return [{ results, fieldMask: "", requestId: "contract-request-1" }]
      },
      g,
    ),
    // Customer Match job create (the erasure sweep): the documented answer is the job's resource name.
    on(
      "POST",
      /^\/customers\/(\d+)\/offlineUserDataJobs:create$/,
      (_r, m) => ({
        resourceName: `customers/${m?.[1]}/offlineUserDataJobs/8100000001`,
      }),
      g,
    ),
    on(
      "POST",
      /^\/customers\/(\d+)\/(\w+):mutate$/,
      (r, m) => {
        const resource = m?.[2] ?? "campaigns"
        const ops = ((r.json as { operations?: unknown[] } | null)?.operations ?? [{}]) as unknown[]
        const ids: Record<string, string> = {
          campaignBudgets: G_BUDGET,
          campaigns: G_CAMPAIGN,
          adGroups: G_ADGROUP,
          adGroupAds: `${G_ADGROUP}~${G_AD}`,
          adGroupCriteria: `${G_ADGROUP}~300000000001`,
          campaignCriteria: `${G_CAMPAIGN}~300000000002`,
          conversionActions: "9002",
        }
        return {
          results: ops.map(() => ({
            resourceName: `customers/${m?.[1]}/${resource}/${ids[resource] ?? "1"}`,
          })),
        }
      },
      g,
    ),
  ]
}

function merchantRoutes(): FakeRoute[] {
  const mh = "merchantapi.googleapis.com"
  return [
    on(
      "GET",
      `/issueresolution/v1/accounts/${MERCHANT}/aggregateProductStatuses`,
      () => ({
        aggregateProductStatuses: [
          {
            name: `accounts/${MERCHANT}/aggregateProductStatuses/SHOPPING_ADS~FR`,
            reportingContext: "SHOPPING_ADS",
            country: "FR",
            stats: {
              activeCount: "38",
              pendingCount: "1",
              disapprovedCount: "2",
              expiringCount: "0",
            },
            itemLevelIssues: [
              {
                code: "missing_gtin",
                severity: "DISAPPROVED",
                resolution: "MERCHANT_ACTION",
                attribute: "gtin",
                reportingContext: "SHOPPING_ADS",
                description: "Missing value [gtin]",
                detail: "Add a GTIN for this product",
                productCount: "2",
              },
            ],
          },
        ],
      }),
      mh,
    ),
    on(
      "GET",
      `/products/v1/accounts/${MERCHANT}/products`,
      () => ({
        products: [
          {
            name: `accounts/${MERCHANT}/products/en~FR~bt-120-anthracite`,
            offerId: "bt-120-anthracite",
            contentLanguage: "en",
            feedLabel: "FR",
            productAttributes: {
              title: "Bass trap 120 cm, anthracite",
              price: { amountMicros: "189000000", currencyCode: "EUR" },
            },
            productStatus: {
              destinationStatuses: [
                { reportingContext: "SHOPPING_ADS", disapprovedCountries: ["FR"] },
              ],
              itemLevelIssues: [
                {
                  code: "missing_gtin",
                  severity: "DISAPPROVED",
                  resolution: "merchant_action",
                  attribute: "gtin",
                  reportingContext: "SHOPPING_ADS",
                  description: "Missing value [gtin]",
                  applicableCountries: ["FR"],
                },
              ],
            },
          },
        ],
      }),
      mh,
    ),
  ]
}

const ORDERS = {
  results: [
    {
      id: "gid://shopify/Order/5800000000001",
      currency: "EUR",
      attributes: {
        totalAmount: "378.00",
        totalAmountShop: "378.00",
        shopCurrency: "EUR",
        tags: [],
        b2bOrder: { b2b: false },
        lineItems: [{ sku: "BT-120-ANT", quantity: 2 }],
      },
    },
    {
      id: "gid://shopify/Order/5800000000002",
      currency: "EUR",
      attributes: {
        totalAmount: "1240.00",
        totalAmountShop: "1240.00",
        shopCurrency: "EUR",
        tags: ["b2b"],
        b2bOrder: { b2b: true },
        lineItems: [{ sku: "BT-120-ANT-B2B", quantity: 8 }],
      },
    },
  ],
  nextCursor: null,
  totalCount: 2,
}
/** Stand-in people: example.com addresses and the fictional phone the fixture scrubber writes, so a replay hashes the same values. */
const CUSTOMERS = {
  customers: [
    {
      id: "gid://shopify/Customer/7100000000001",
      email: "camille.martin@example.com",
      phone: "+15550100000",
      emailMarketingConsent: { marketingState: "SUBSCRIBED" },
    },
    {
      id: "gid://shopify/Customer/7100000000002",
      email: "jonas.weber@example.com",
      phone: null,
      emailMarketingConsent: { marketingState: "SUBSCRIBED" },
    },
    {
      id: "gid://shopify/Customer/7100000000003",
      email: "lena.okafor@example.com",
      phone: "+15550100000",
      emailMarketingConsent: { marketingState: "SUBSCRIBED" },
    },
  ],
}
const ATTRIBUTION_ROWS = [
  {
    shopify_order_id: "5800000000001",
    ad_consent: "granted",
    utm_source_first: "facebook",
    utm_source_last: "facebook",
    fbclid: "IwAR0contract",
    gclid: null,
    conversion_value_minor: 37800,
    conversion_currency: "EUR",
    sku_class_breakdown: { dtc: 37800 },
    created_at: "2025-12-14T10:22:00Z",
  },
  {
    shopify_order_id: "5800000000002",
    ad_consent: "denied",
    utm_source_first: "google",
    utm_source_last: "direct",
    fbclid: null,
    gclid: "Cj0contract",
    conversion_value_minor: 124000,
    conversion_currency: "EUR",
    sku_class_breakdown: { b2b: 124000 },
    created_at: "2025-12-20T16:05:00Z",
  },
]
const CONSENT_ROWS = [
  { email: "camille.martin@example.com", ad_consent: "granted", marketing_consent: true },
]
const ERASURES = [
  {
    email_sha256: "5d41402abc4b2a76b9719d911017c592ae7b2b1e4b1b2a1f6e0b6b0b0c0d0e0f",
    reason: "gdpr_request",
    erased_at: "2025-12-28T09:00:00Z",
  },
]

/** The stand-in answer of another app's tool, in that app's result shape. */
function crossApp(target: string, args: Record<string, unknown>): unknown {
  switch (target) {
    case "shopify:orders_search":
      return ORDERS
    case "shopify:customers_search":
      return CUSTOMERS
    case "database:db_read":
      if (args.name === "pending_audience_erasures")
        return { rows: ERASURES, rowCount: ERASURES.length }
      if (args.name === "purchase_attribution_for_period")
        return { rows: ATTRIBUTION_ROWS, rowCount: ATTRIBUTION_ROWS.length }
      return { rows: CONSENT_ROWS, rowCount: CONSENT_ROWS.length }
    case "database:db_query":
      return { rows: ATTRIBUTION_ROWS, rowCount: ATTRIBUTION_ROWS.length }
    default:
      return undefined
  }
}

const TOKENS: Record<string, string> = { google: GOOGLE_TOKEN, merchant: MERCHANT_TOKEN }

/** OAuth tokens and other apps' tools answered by stand-ins; the rest is the live bridge. */
function withStandIns(bridge: AppBridge, _entry: ContractEntry): AppBridge {
  const realExecute = bridge.executeTool
  return {
    ...bridge,
    connections_getToken: async (connection: unknown) => {
      const token = TOKENS[String(connection)]
      if (!token) throw new Error(`no stand-in token for ${String(connection)}`)
      return token
    },
    executeTool: async (target: unknown, argsJson: unknown) => {
      const args = JSON.parse(typeof argsJson === "string" ? argsJson : "{}") as Record<
        string,
        unknown
      >
      const result = crossApp(String(target), args)
      if (result === undefined)
        return (realExecute as (...a: unknown[]) => unknown)(target, argsJson)
      return JSON.stringify({ status: "completed", result })
    },
  }
}

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })

interface AdsState extends RecordingState {
  values: { experimentId?: string; reportKey?: string }
}

const firstId = (a: unknown): string | undefined => {
  const seen: unknown[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Rec)) {
        if (k === "id" && typeof x === "string") seen.push(x)
        walk(x)
      }
    }
  }
  walk(a)
  return seen[0] as string | undefined
}

const SHOPIFY_BUYERS = { query: "orders_count:>0 AND accepts_marketing:true", limit: 250 }
const EXPERIMENT_NOTE = { id: "exp-bass-traps-q1", note: "Budget step for the Q1 prospecting test" }

const PLAN: RecordingStep<AdsState>[] = [
  // ─── Meta reads
  { entry: "tool:account_info", input: () => params({}) },
  {
    entry: "tool:campaigns_list",
    input: () =>
      params({
        fields: ["id", "name", "status", "effective_status", "objective", "daily_budget"],
        limit: 50,
      }),
  },
  { entry: "tool:adsets_list", input: () => params({ campaign_id: CAMPAIGN, limit: 50 }) },
  {
    entry: "tool:ads_list",
    input: () => params({ adset_id: ADSET, effective_status: ["ACTIVE", "PAUSED"], limit: 25 }),
  },
  {
    entry: "tool:insights_query",
    input: () =>
      params({
        level: "ad",
        time_increment: "1",
        date_preset: "last_7d",
        fields: ["spend", "impressions", "clicks", "ctr"],
        currency: "EUR",
      }),
  },
  {
    entry: "tool:targeting_search",
    input: () => params({ type: "adgeolocation", q: "Belgium", location_types: ["country"] }),
  },
  { entry: "tool:media_list", input: () => params({ type: "images", limit: 25 }) },
  { entry: "tool:audiences_list", input: () => params({ limit: 25 }) },
  { entry: "tool:pages_list", input: () => params({}) },
  {
    entry: "tool:graph_get",
    input: () => params({ path: `/${CAMPAIGN}`, fields: "id,name,status,daily_budget" }),
  },
  { entry: "tool:creative_get", input: () => params({ ad_id: AD }) },
  {
    entry: "tool:ad_preview",
    input: () => params({ ad_id: AD, ad_format: "MOBILE_FEED_STANDARD" }),
  },
  { entry: "tool:counts", input: () => params({}) },
  { entry: "tool:pending_approvals_list", input: () => params({ limit: 20 }) },
  // ─── Meta writes (the kernel gates them before the handler runs; the run is the approved one)
  {
    entry: "tool:create_campaign",
    input: () =>
      params({
        name: "Bass traps – prospecting BE",
        objective: "OUTCOME_SALES",
        special_ad_categories: [],
        status: "PAUSED",
      }),
  },
  {
    entry: "tool:create_adset",
    input: () =>
      params({
        campaign_id: CAMPAIGN,
        name: "BE 25-54 home studio interests",
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        daily_budget: "25.00",
        currency: "EUR",
        status: "PAUSED",
        targeting: {
          geo_locations: { countries: ["BE"] },
          age_min: 25,
          age_max: 54,
          interests: [{ id: "6003139266461", name: "Home recording" }],
        },
      }),
  },
  {
    entry: "tool:create_creative",
    input: () =>
      params({
        page_id: PAGE,
        object_story_spec: {
          page_id: PAGE,
          link_data: {
            link: "https://shop.example.com/bass-traps",
            message: "Now shipping to Belgium.",
            image_hash: IMAGE_HASH,
            call_to_action: { type: "SHOP_NOW" },
          },
        },
      }),
  },
  {
    entry: "tool:create_ad",
    input: () =>
      params({
        adset_id: ADSET,
        name: "Bass trap – BE launch",
        creative_id: CREATIVE,
        status: "PAUSED",
      }),
  },
  {
    entry: "tool:upload_image",
    input: () =>
      params({
        filename: "bass-trap-square.png",
        image_bytes:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      }),
  },
  {
    entry: "preflight:update_budget",
    input: () =>
      params({ level: "campaign", object_id: CAMPAIGN, daily_budget: "45.00", currency: "EUR" }),
  },
  {
    entry: "tool:update_budget",
    input: () =>
      params({
        level: "campaign",
        object_id: CAMPAIGN,
        daily_budget: "45.00",
        currency: "EUR",
        experiment: EXPERIMENT_NOTE,
      }),
  },
  { entry: "tool:set_status", input: () => params({ object_id: CAMPAIGN_2, status: "ACTIVE" }) },
  {
    entry: "preflight:pause",
    input: () => params({ object_ids: [CAMPAIGN_2], reason: "ROAS under 1.5 for 7 days" }),
  },
  {
    entry: "tool:pause",
    input: () => params({ object_ids: [CAMPAIGN_2], reason: "ROAS under 1.5 for 7 days" }),
  },
  {
    entry: "preflight:create_custom_audience",
    input: () =>
      params({
        name: "Buyers – newsletter consent",
        subtype: "CUSTOMER_LIST",
        customer_file_source: "USER_PROVIDED_ONLY",
        audience_purpose: "buyer",
        shopify_customer_query: SHOPIFY_BUYERS,
      }),
  },
  {
    entry: "tool:create_custom_audience",
    input: () =>
      params({
        name: "Buyers – newsletter consent",
        subtype: "CUSTOMER_LIST",
        customer_file_source: "USER_PROVIDED_ONLY",
        audience_purpose: "buyer",
        shopify_customer_query: SHOPIFY_BUYERS,
      }),
  },
  {
    entry: "tool:create_lookalike_audience",
    input: () => params({ source_audience_id: AUDIENCE, country: "BE", ratio: 2 }),
  },
  {
    entry: "preflight:add_users_to_audience",
    input: () =>
      params({
        audience_id: AUDIENCE,
        audience_purpose: "buyer",
        shopify_customer_query: SHOPIFY_BUYERS,
      }),
  },
  {
    entry: "tool:add_users_to_audience",
    input: () =>
      params({
        audience_id: AUDIENCE,
        audience_purpose: "buyer",
        shopify_customer_query: SHOPIFY_BUYERS,
      }),
  },
  {
    entry: "tool:audience_erasure_sweep",
    input: () => params({ managed_meta_audience_ids: [AUDIENCE] }),
  },
  // ─── Google Ads + Merchant Center
  { entry: "tool:google_account_info", input: () => params({}) },
  { entry: "tool:google_campaigns_list", input: () => params({ limit: 50 }) },
  { entry: "tool:google_adgroups_list", input: () => params({ campaign_id: G_CAMPAIGN }) },
  { entry: "tool:google_ads_list", input: () => params({ ad_group_id: G_ADGROUP }) },
  {
    entry: "tool:google_insights_query",
    input: () =>
      params({
        query:
          "SELECT campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions, segments.date FROM campaign WHERE segments.date DURING LAST_30_DAYS",
        currency: "EUR",
      }),
  },
  { entry: "tool:google_search_terms", input: () => params({}) },
  { entry: "tool:google_recommendations_list", input: () => params({}) },
  {
    entry: "preflight:google_pause",
    input: () =>
      params({
        object_type: "campaign",
        object_id: G_CAMPAIGN,
        reason: "Spend with no conversion for 14 days",
      }),
  },
  {
    entry: "tool:google_pause",
    input: () =>
      params({
        object_type: "campaign",
        object_id: G_CAMPAIGN,
        reason: "Spend with no conversion for 14 days",
      }),
  },
  {
    entry: "preflight:google_set_status",
    input: () => params({ object_type: "ad_group", object_id: G_ADGROUP, status: "ENABLED" }),
  },
  {
    entry: "tool:google_set_status",
    input: () => params({ object_type: "ad_group", object_id: G_ADGROUP, status: "ENABLED" }),
  },
  {
    entry: "tool:google_create_campaign",
    input: () =>
      params({
        name: "Search – bass traps BE",
        advertising_channel_type: "SEARCH",
        daily_budget: 30,
        currency: "EUR",
        bidding_strategy: { maximizeConversions: {} },
      }),
  },
  {
    entry: "tool:google_create_adgroup",
    input: () => params({ campaign_id: G_CAMPAIGN, name: "Corner bass traps" }),
  },
  {
    entry: "tool:google_create_ad",
    input: () =>
      params({
        ad_group_id: G_ADGROUP,
        headlines: ["Corner bass traps", "Made in France", "Free shipping over 150 €"],
        descriptions: ["Tame the boom in small rooms.", "Measured before it leaves the workshop."],
        final_urls: ["https://shop.example.com/bass-traps"],
      }),
  },
  {
    entry: "tool:google_update_budget",
    input: () =>
      params({
        budget_resource_name: `customers/${CUSTOMER}/campaignBudgets/${G_BUDGET}`,
        amount: 40,
        currency: "EUR",
      }),
  },
  {
    entry: "preflight:google_add_negative_keywords",
    input: () =>
      params({
        campaign_id: G_CAMPAIGN,
        keywords: [
          { text: "free", match_type: "BROAD" },
          { text: "diy foam", match_type: "PHRASE" },
        ],
      }),
  },
  {
    entry: "tool:google_add_negative_keywords",
    input: () =>
      params({
        campaign_id: G_CAMPAIGN,
        keywords: [
          { text: "free", match_type: "BROAD" },
          { text: "diy foam", match_type: "PHRASE" },
        ],
      }),
  },
  {
    entry: "tool:google_create_conversion_action",
    input: () => params({ name: "Newsletter sign-up", category: "SIGNUP", type: "WEBPAGE" }),
  },
  { entry: "tool:merchant_feed_status", input: () => params({}) },
  { entry: "tool:merchant_product_issues", input: () => params({ limit: 50 }) },
  // ─── Internal ledgers and metrics
  {
    entry: "tool:experiment_open",
    input: () =>
      params({
        title: "Belgium prospecting at 45 € a day",
        hypothesis:
          "Raising the BE prospecting budget to 45 € a day keeps the cost per purchase under 30 €.",
        platforms: "meta",
        metric_tier: "purchase",
        primary_metric: "cpa",
        variants: "control: 25 €/day; test: 45 €/day",
        start_date: "2026-01-05",
        decision_date: "2026-02-02",
        minimum_sample: 40,
        linked_campaign_ids: CAMPAIGN,
      }),
    after: (a, s) => {
      s.values.experimentId = firstId(a)
    },
  },
  {
    entry: "tool:experiment_update",
    input: (s) =>
      params({ experiment_id: s.values.experimentId ?? "", status: "running", minimum_sample: 50 }),
  },
  { entry: "tool:experiment_list", input: () => params({ status: "running", limit: 20 }) },
  {
    entry: "tool:experiment_close",
    input: (s) =>
      params({
        experiment_id: s.values.experimentId ?? "",
        verdict: "win",
        learnings: "CPA held at 26 € with the higher budget; keep 45 €/day.",
      }),
  },
  {
    entry: "tool:manual_spend_add",
    input: () =>
      params({
        channel: "print",
        site: "Studio magazine",
        period_start: "2025-12-01",
        period_end: "2025-12-31",
        amount: 450,
        currency: "EUR",
        notes: "Half-page ad, January issue",
      }),
  },
  { entry: "tool:manual_spend_list", input: () => params({ channel: "print", limit: 20 }) },
  {
    entry: "preflight:dealer_profile_upsert",
    input: () =>
      params({
        dealer_name: "Studio Shop Lyon",
        dealer_type: "boutique",
        coverage_area: "Auvergne-Rhône-Alpes",
        sku_match_hints: "BT-120, BT-60",
        reorder_cadence: "monthly",
      }),
  },
  {
    entry: "tool:dealer_profile_upsert",
    input: () =>
      params({
        dealer_name: "Studio Shop Lyon",
        dealer_type: "boutique",
        coverage_area: "Auvergne-Rhône-Alpes",
        sku_match_hints: "BT-120, BT-60",
        reorder_cadence: "monthly",
        notes: "Stocks the anthracite range only",
      }),
  },
  {
    entry: "tool:dealer_profiles_list",
    input: () => params({ dealer_name: "Studio Shop Lyon", limit: 20 }),
  },
  {
    entry: "tool:metrics_run",
    input: () =>
      params({
        formula_id: "blended_mer_total",
        period_start: "2025-12-01",
        period_end: "2025-12-31",
      }),
  },
  // ─── The insights report continuation, woken for the report insights_query started.
  {
    entry: "tool:insights_query",
    record: false,
    before: async () => {
      await sql`DELETE FROM ${sql(schemaRef("kernel"))}.app_documents
        WHERE org_id = ${CONTRACT_ORG_ID} AND app = ${APP} AND collection = 'insights_reports'`
      objects[REPORT_RUN] = {
        id: REPORT_RUN,
        async_status: "Job Running",
        async_percent_completion: 35,
      }
    },
    input: () =>
      params({
        level: "adset",
        time_increment: "1",
        date_preset: "last_30d",
        fields: ["spend", "clicks"],
      }),
    after: async (_a, s) => {
      const [doc] = await sql<
        { doc_id: string }[]
      >`SELECT doc_id FROM ${sql(schemaRef("kernel"))}.app_documents
        WHERE org_id = ${CONTRACT_ORG_ID} AND app = ${APP} AND collection = 'insights_reports' LIMIT 1`
      s.values.reportKey = doc?.doc_id
      objects[REPORT_RUN] = {
        id: REPORT_RUN,
        async_status: "Job Completed",
        async_percent_completion: 100,
      }
    },
  },
  { entry: "job:insights-report", input: (s) => params({ report: s.values.reportKey ?? "" }) },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record ads contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>
  let fakes: FakeProviders

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, {})
    const K = sql(schemaRef("kernel"))
    for (const table of [
      "experiments",
      "manual_spend",
      "dealer_profiles",
      "audience_erasure_log",
      "pause_ledger",
    ]) {
      await sql`DELETE FROM ${sql(`app_${APP}`)}.${sql(table)} WHERE org_id = ${CONTRACT_ORG_ID}`.catch(
        () => undefined,
      )
    }
    await sql`DELETE FROM ${K}.app_documents WHERE org_id = ${CONTRACT_ORG_ID} AND app = ${APP}`
    await connectCredentials(APP, "meta", ACT, {
      accessToken: META_TOKEN,
      adAccountId: ACT,
      defaultPageId: PAGE,
    })
    const googleConfig = {
      loginCustomerId: LOGIN_CUSTOMER,
      customerId: CUSTOMER,
      merchantId: MERCHANT,
    }
    await sql`INSERT INTO ${K}.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, display_name,
       credentials_encrypted, status, created_by)
      VALUES (${CONTRACT_ORG_ID}, ${APP}, 'google-config', 'org', 'credentials', ${CUSTOMER}, ${CUSTOMER},
       ${encryptSecret(JSON.stringify(googleConfig), env.ENCRYPTION_KEY, CryptoContext.connectedAccountCredentials)},
       'active', ${CONTRACT_USER_ID})`
    fakes = installFakeProviders(
      ["graph.facebook.com", "googleads.googleapis.com", "merchantapi.googleapis.com"],
      [...metaRoutes(), ...googleRoutes(), ...merchantRoutes()],
    )
  }, 300_000)

  afterAll(async () => {
    fakes?.uninstall()
    await uninstallAfterRecording(APP)
    await releaseTestLock()
  })

  it("records every planned entry", async () => {
    const secrets = [META_TOKEN, GOOGLE_TOKEN, MERCHANT_TOKEN]
    const report = await runRecordingPlan<AdsState>({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: PLAN,
      state: { values: {} },
      replacements: secrets.map((s, i) => ({ from: s, to: `ads-token-stand-in-${i + 1}` })),
      secrets,
      recordedFrom:
        "the contract org on a local stack with documented Meta Marketing, Google Ads and Merchant API answers (no sandbox account), record-ads.recorder.test.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: {},
      wrapBridge: withStandIns,
    })
    console.log(
      `\n${report.join("\n")}\n\nprovider misses:\n${[...new Set(fakes.misses)].join("\n")}\n`,
    )
    expect(report.filter((l) => !l.startsWith("ok ") && !l.startsWith("  (prereq)"))).toEqual([])
    expect(fakes.misses).toEqual([])
  }, 900_000)
})
