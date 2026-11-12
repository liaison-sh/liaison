// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stage-time refusal for the ads app's GATED tools.
//
// A gated call parks a pending approval for a human BEFORE the handler runs. A
// tool that validates its required data only inside the handler therefore fails
// after the approver has already clicked approve, with an error only the agent
// could have fixed (and, for create_custom_audience, only after an empty
// audience was already POSTed to the live ad account).
//
// These tests pin both halves of the fix:
//   - the manifest declares a `preflight` (so the kernel refuses BEFORE it
//     creates the approval), and the named export exists on the handler bundle;
//   - the preflight refuses each incomplete call with a typed error code, and
//     the handler reaches no outbound ad API call.
// Where the rule is plain presence or a static range it lives in the params
// schema instead, which the kernel validates before gating.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { google_pause, google_pause_preflight } from "./google-pause"
import {
  google_add_negative_keywords_preflight,
  google_create_campaign,
  google_create_campaign_preflight,
  google_set_status_preflight,
} from "./google-writes"
import * as handlers from "./handlers"
import { dealer_profile_upsert_preflight } from "./lab/dealer-profiles"
import type { AppCtx } from "./lib/ctx-types"
import { pause_preflight } from "./pause"
import { createMockDb } from "./test-db"
import {
  add_users_to_audience,
  add_users_to_audience_preflight,
  type CrossAppCtx,
  create_adset_preflight,
  create_custom_audience,
  create_custom_audience_preflight,
  update_budget_preflight,
} from "./writes"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  tools: Record<string, Record<string, unknown>>
}

interface ToolError {
  error?: { code?: string; message?: string }
}

function errorOf(result: unknown): { code?: string; message?: string } {
  return (result as ToolError).error ?? {}
}

/** Meta ctx whose fetch RECORDS every outbound call, so "never reached" is assertable. */
function makeMetaCtx(opts: { executeTool?: boolean } = {}): {
  ctx: CrossAppCtx
  calls: string[]
} {
  const calls: string[] = []
  const ctx = {
    fetch: async (url: string, o?: Record<string, unknown>) => {
      calls.push(`${String(o?.method ?? "GET")} ${url}`)
      return { status: 200, headers: {}, body: JSON.stringify({ id: "aud_should_not_exist" }) }
    },
    connections: {
      meta: {
        getCredentials: async () => ({
          accessToken: "test_token",
          adAccountId: "act_123456",
          defaultPageId: "page_1",
        }),
      },
    },
    ...(opts.executeTool
      ? { executeTool: async () => ({ status: "completed" as const, result: { customers: [] } }) }
      : {}),
  } as unknown as CrossAppCtx
  return { ctx, calls }
}

// ─── the manifest half: the kernel only preflights what the manifest declares ──

describe("ads gated tools declare a stage-time preflight", () => {
  const EXPECTED: Record<string, string> = {
    create_custom_audience: "create_custom_audience_preflight",
    add_users_to_audience: "add_users_to_audience_preflight",
    create_adset: "create_adset_preflight",
    update_budget: "update_budget_preflight",
    google_set_status: "google_set_status_preflight",
    google_add_negative_keywords: "google_add_negative_keywords_preflight",
    dealer_profile_upsert: "dealer_profile_upsert_preflight",
    pause: "pause_preflight",
    google_pause: "google_pause_preflight",
    google_create_campaign: "google_create_campaign_preflight",
  }

  for (const [toolName, exportName] of Object.entries(EXPECTED)) {
    it(`${toolName} declares preflight '${exportName}' and the export exists`, () => {
      const tool = manifest.tools[toolName]
      expect(tool, `tool ${toolName} must exist`).toBeDefined()
      expect(tool?.gated).toBe(true)
      expect(tool?.preflight).toBe(exportName)
      expect(typeof (handlers as Record<string, unknown>)[exportName]).toBe("function")
    })
  }
})

// ─── create_custom_audience: the orphan-audience case ─────────────────────────

describe("create_custom_audience stage-time refusal", () => {
  it("preflight refuses a CUSTOMER_LIST with no audience_purpose, with NO Meta call", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: true })
    const result = await create_custom_audience_preflight(
      { name: "Buyers", subtype: "CUSTOMER_LIST", shopify_customer_query: { query: "x" } },
      ctx,
    )
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/audience_purpose is required/)
    expect(calls).toEqual([])
  })

  it("preflight refuses a CUSTOMER_LIST with no shopify_customer_query, with NO Meta call", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: true })
    const result = await create_custom_audience_preflight(
      { name: "Buyers", subtype: "CUSTOMER_LIST", audience_purpose: "buyer" },
      ctx,
    )
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/shopify_customer_query is required/)
    expect(calls).toEqual([])
  })

  it("preflight refuses a CUSTOMER_LIST when cross-app calls are not enabled", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: false })
    const result = await create_custom_audience_preflight(
      {
        name: "Buyers",
        subtype: "CUSTOMER_LIST",
        audience_purpose: "buyer",
        shopify_customer_query: { query: "x" },
      },
      ctx,
    )
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/executeTool not available/)
    expect(calls).toEqual([])
  })

  it("preflight refuses a WEBSITE audience with no pixel_id", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: true })
    const result = await create_custom_audience_preflight(
      { name: "Visitors", subtype: "WEBSITE" },
      ctx,
    )
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/pixel_id is required/)
    expect(calls).toEqual([])
  })

  it("handler POSTs NO audience to Meta when cross-app calls are not enabled (no orphan)", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: false })
    const err = await create_custom_audience(
      {
        name: "Buyers",
        subtype: "CUSTOMER_LIST",
        audience_purpose: "buyer",
        shopify_customer_query: { query: "x" },
      },
      ctx,
    ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/executeTool not available/)
    // The load-bearing assertion: the audience POST never happened, so no empty
    // orphan audience is left behind on the live ad account.
    expect(calls).toEqual([])
  })

  it("preflight allows a complete CUSTOMER_LIST call", async () => {
    const { ctx } = makeMetaCtx({ executeTool: true })
    const result = await create_custom_audience_preflight(
      {
        name: "Buyers",
        subtype: "CUSTOMER_LIST",
        audience_purpose: "buyer",
        shopify_customer_query: { query: "x" },
      },
      ctx,
    )
    expect(result).toEqual({ ok: true })
  })
})

// ─── add_users_to_audience ────────────────────────────────────────────────────

describe("add_users_to_audience stage-time refusal", () => {
  it("preflight refuses a call with no audience_purpose, with NO Meta call", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: true })
    const result = await add_users_to_audience_preflight(
      { audience_id: "aud_1", shopify_customer_query: { query: "x" } },
      ctx,
    )
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/audience_purpose is required/)
    expect(calls).toEqual([])
  })

  it("handler uploads nothing when cross-app calls are not enabled", async () => {
    const { ctx, calls } = makeMetaCtx({ executeTool: false })
    const err = await add_users_to_audience(
      {
        audience_id: "aud_1",
        audience_purpose: "buyer",
        shopify_customer_query: { query: "x" },
      },
      ctx,
    ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(calls).toEqual([])
  })
})

// ─── update_budget ────────────────────────────────────────────────────────────

describe("update_budget stage-time refusal", () => {
  it("preflight refuses a call carrying neither daily_budget nor lifetime_budget", async () => {
    const result = await update_budget_preflight({
      level: "adset",
      object_id: "adset_1",
      currency: "EUR",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/provide daily_budget or lifetime_budget/)
  })

  it("preflight refuses a budget amount that is not a positive number", async () => {
    const result = await update_budget_preflight({
      level: "adset",
      object_id: "adset_1",
      currency: "EUR",
      daily_budget: "not-a-number",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/invalid daily_budget value/)
  })

  it("preflight allows a complete call", async () => {
    const result = await update_budget_preflight({
      level: "adset",
      object_id: "adset_1",
      currency: "EUR",
      daily_budget: "50",
    })
    expect(result).toEqual({ ok: true })
  })

  it("params schema REQUIRES currency, so a call without it never reaches the gate", () => {
    const params = manifest.tools.update_budget?.params as { required?: string[] }
    expect(params.required).toContain("currency")
  })
})

// ─── create_adset ─────────────────────────────────────────────────────────────

describe("create_adset stage-time refusal", () => {
  it("preflight refuses an unparseable daily_budget", async () => {
    const result = await create_adset_preflight({
      campaign_id: "camp_1",
      name: "Set",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      daily_budget: "fifty",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/invalid daily_budget value/)
  })

  it("preflight refuses a non-positive lifetime_budget", async () => {
    const result = await create_adset_preflight({
      campaign_id: "camp_1",
      name: "Set",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      lifetime_budget: "0",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/invalid lifetime_budget value/)
  })
})

// ─── pause ────────────────────────────────────────────────────────────────────

describe("pause stage-time refusal", () => {
  it("preflight refuses a pause naming no object at all", async () => {
    const result = await pause_preflight({ reason: "overspend" })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/provide object_id or object_ids/)
  })

  it("preflight refuses an object_ids array holding no usable id", async () => {
    const result = await pause_preflight({ object_ids: ["", ""] })
    expect(errorOf(result).code).toBe("invalid_params")
  })

  it("preflight allows a pause naming one object", async () => {
    expect(await pause_preflight({ object_id: "camp_1" })).toEqual({ ok: true })
  })
})

// ─── google_set_status ────────────────────────────────────────────────────────

describe("google_set_status stage-time refusal", () => {
  it("preflight refuses a campaign resume with no object_id", async () => {
    const result = await google_set_status_preflight({
      object_type: "campaign",
      status: "ENABLED",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/object_id is required/)
  })

  it("preflight refuses an ad resume with no composite id and no ad_group_id + ad_id", async () => {
    const result = await google_set_status_preflight({
      object_type: "ad",
      status: "ENABLED",
      object_id: "12345",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/composite adGroupAd resource id/)
  })

  it("preflight allows an ad resume built from ad_group_id + ad_id", async () => {
    const result = await google_set_status_preflight({
      object_type: "ad",
      status: "ENABLED",
      ad_group_id: "1",
      ad_id: "2",
    })
    expect((result as { ok?: boolean }).ok).toBe(true)
  })
})

// ─── google_add_negative_keywords ─────────────────────────────────────────────

describe("google_add_negative_keywords stage-time refusal", () => {
  it("preflight refuses a batch with neither ad_group_id nor campaign_id", async () => {
    const result = await google_add_negative_keywords_preflight({
      keywords: [{ text: "free" }],
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/provide ad_group_id or campaign_id/)
  })

  it("preflight refuses a keyword with empty text", async () => {
    const result = await google_add_negative_keywords_preflight({
      campaign_id: "camp_1",
      keywords: [{ text: "" }],
    })
    expect(errorOf(result).code).toBe("invalid_params")
  })

  it("preflight allows a campaign-level batch", async () => {
    const result = await google_add_negative_keywords_preflight({
      campaign_id: "camp_1",
      keywords: [{ text: "free" }],
    })
    expect(result).toEqual({ ok: true })
  })
})

// ─── dealer_profile_upsert ────────────────────────────────────────────────────

describe("dealer_profile_upsert stage-time refusal", () => {
  function makeDbCtx(): { ctx: AppCtx; db: ReturnType<typeof createMockDb> } {
    const db = createMockDb()
    const ctx = {
      fetch: async () => ({}),
      connections: {},
      db,
      actorId: "user_1",
    } as unknown as AppCtx
    return { ctx, db }
  }

  it("preflight refuses an update naming a dealer_id that does not exist, and writes nothing", async () => {
    const { ctx, db } = makeDbCtx()
    const result = await dealer_profile_upsert_preflight(
      { dealer_id: "missing_1", dealer_name: "Acme", dealer_type: "boutique" },
      ctx,
    )
    expect(errorOf(result).code).toBe("not_found")
    expect(errorOf(result).message).toMatch(/dealer missing_1 not found/)
    expect(db.__all("dealer_profiles").length).toBe(0)
  })

  it("preflight refuses an unknown dealer_type", async () => {
    const { ctx } = makeDbCtx()
    const result = await dealer_profile_upsert_preflight(
      { dealer_name: "Acme", dealer_type: "wholesale" },
      ctx,
    )
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/dealer_type must be one of/)
  })

  it("preflight allows an insert with the required fields, and still writes nothing", async () => {
    const { ctx, db } = makeDbCtx()
    const result = await dealer_profile_upsert_preflight(
      { dealer_name: "Acme", dealer_type: "boutique" },
      ctx,
    )
    expect(result).toEqual({ ok: true })
    expect(db.__all("dealer_profiles").length).toBe(0)
  })
})

// ─── google_pause ─────────────────────────────────────────────────────────────

/** Google ctx whose fetch RECORDS every outbound call, so "never reached" is assertable. */
function makeGoogleCtx(): { ctx: AppCtx; calls: string[] } {
  const calls: string[] = []
  const ctx = {
    fetch: async (url: string, o?: Record<string, unknown>) => {
      calls.push(`${String(o?.method ?? "GET")} ${url}`)
      return { status: 200, headers: {}, body: JSON.stringify([{ results: [] }]) }
    },
    connections: {
      google: { getToken: async () => "oauth_tok_abc" },
      "google-config": {
        getCredentials: async () => ({
          developerToken: "dev_tok_123",
          loginCustomerId: "9998887777",
          customerId: "1234567890",
        }),
      },
    },
    db: createMockDb(),
    actorId: "user_1",
  } as unknown as AppCtx
  return { ctx, calls }
}

describe("google_pause stage-time refusal", () => {
  it("preflight refuses an ad pause with no composite id and no ad_group_id + ad_id", async () => {
    const result = await google_pause_preflight({ object_type: "ad", object_id: "12345" })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/composite adGroupAd resource id/)
  })

  it("the refused ad pause reaches NO Google call in the handler either", async () => {
    const { ctx, calls } = makeGoogleCtx()
    await expect(
      google_pause({ object_type: "ad", object_id: "12345" } as never, ctx),
    ).rejects.toThrow(/composite adGroupAd resource id/)
    expect(calls).toEqual([])
  })

  it("preflight refuses an unknown object_type", async () => {
    const result = await google_pause_preflight({ object_type: "adgroup", object_id: "1" })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/object_type must be one of/)
  })

  it("preflight refuses a campaign pause with no object_id", async () => {
    const result = await google_pause_preflight({ object_type: "campaign" })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/object_id is required/)
  })

  it("preflight allows an ad pause built from ad_group_id + ad_id", async () => {
    const result = await google_pause_preflight({
      object_type: "ad",
      ad_group_id: "1",
      ad_id: "2",
    })
    expect((result as { ok?: boolean }).ok).toBe(true)
  })

  it("params schema documents ad_group_id + ad_id, the pair the refusal asks for", () => {
    const p = (
      manifest.tools.google_pause!.params as {
        properties: Record<string, Record<string, unknown>>
      }
    ).properties
    expect(p.ad_group_id?.type).toBe("string")
    expect(p.ad_id?.type).toBe("string")
  })
})

// ─── google_create_campaign ───────────────────────────────────────────────────

describe("google_create_campaign stage-time refusal", () => {
  it("preflight refuses a bidding_strategy carrying more than one field", async () => {
    const result = await google_create_campaign_preflight({
      name: "Brand",
      advertising_channel_type: "SEARCH",
      daily_budget: 50,
      currency: "EUR",
      bidding_strategy: { manualCpc: {}, targetRoas: { targetRoas: 3.5 } },
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(/exactly one recognized field/)
  })

  it("preflight refuses an unrecognized bidding strategy field", async () => {
    const result = await google_create_campaign_preflight({
      name: "Brand",
      advertising_channel_type: "SEARCH",
      daily_budget: 50,
      currency: "EUR",
      bidding_strategy: { targetImpressionShare: {} },
    })
    expect(errorOf(result).code).toBe("invalid_params")
  })

  it("preflight refuses a bidding_strategy that is not an object", async () => {
    const result = await google_create_campaign_preflight({
      name: "Brand",
      advertising_channel_type: "SEARCH",
      daily_budget: 50,
      currency: "EUR",
      bidding_strategy: "manualCpc",
    })
    expect(errorOf(result).code).toBe("invalid_params")
    expect(errorOf(result).message).toMatch(
      /must be an object with exactly one bidding strategy field/,
    )
  })

  it("the refused create reaches NO Google call, so no orphan campaign budget is created", async () => {
    const { ctx, calls } = makeGoogleCtx()
    await expect(
      google_create_campaign(
        {
          name: "Brand",
          advertising_channel_type: "SEARCH",
          daily_budget: 50,
          currency: "EUR",
          bidding_strategy: { manualCpc: {}, targetRoas: {} },
        },
        ctx as never,
      ),
    ).rejects.toThrow(/exactly one recognized field/)
    expect(calls).toEqual([])
  })

  it("preflight allows an omitted bidding_strategy (the handler defaults it per channel type)", async () => {
    const result = await google_create_campaign_preflight({
      name: "Brand",
      advertising_channel_type: "SEARCH",
      daily_budget: 50,
      currency: "EUR",
    })
    expect(result).toEqual({ ok: true })
  })
})

// ─── schema-enforced rules (validated before the gate, so no preflight needed) ─

describe("ads params schemas enforce the plain presence and static range rules", () => {
  const props = (tool: string): Record<string, Record<string, unknown>> =>
    (manifest.tools[tool]!.params as { properties: Record<string, Record<string, unknown>> })
      .properties

  it("google_create_ad pins the RSA minimums: 3 headlines, 2 descriptions, 1 final url", () => {
    const p = props("google_create_ad")
    expect(p.headlines?.minItems).toBe(3)
    expect(p.descriptions?.minItems).toBe(2)
    expect(p.final_urls?.minItems).toBe(1)
  })

  it("google_add_negative_keywords requires at least one keyword with non-empty text", () => {
    const p = props("google_add_negative_keywords")
    expect(p.keywords?.minItems).toBe(1)
    const items = p.keywords?.items as { properties: Record<string, Record<string, unknown>> }
    expect(items.properties.text?.minLength).toBe(1)
  })

  it("upload_image caps image_bytes at the base64 payload limit the handler enforces", () => {
    expect(props("upload_image").image_bytes?.maxLength).toBe(985_000)
  })

  it("create_creative requires at least 2 carousel cards", () => {
    const afs = props("create_creative").asset_feed_spec as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(afs.properties.child_attachments?.minItems).toBe(2)
  })

  it("google_create_campaign pins daily_budget to a positive amount", () => {
    expect(props("google_create_campaign").daily_budget?.exclusiveMinimum).toBe(0)
  })

  it("google_update_budget pins amount to a positive amount", () => {
    expect(props("google_update_budget").amount?.exclusiveMinimum).toBe(0)
  })

  it("create_lookalike_audience pins ratio to the 1 to 10 range and non-empty source and country", () => {
    const p = props("create_lookalike_audience")
    expect(p.ratio?.minimum).toBe(1)
    expect(p.ratio?.maximum).toBe(10)
    expect(p.source_audience_id?.minLength).toBe(1)
    expect(p.country?.minLength).toBe(1)
  })
})
