// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bundle-registration smoke test. Every handler name referenced in the
// app.manifest.json (tools[].handler, tools[].summarizer, events.subscribes values)
// must be a callable export of handlers.ts — otherwise the install service
// rejects the package at registration time.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as handlers from "./handlers"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

function collectHandlerNames(): string[] {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    tools?: Record<string, { handler?: string; summarizer?: string }>
    events?: { subscribes?: Record<string, string> }
  }
  const names = new Set<string>()
  for (const t of Object.values(m.tools ?? {})) {
    if (t.handler) names.add(t.handler)
    if (t.summarizer) names.add(t.summarizer)
  }
  for (const handlerName of Object.values(m.events?.subscribes ?? {})) {
    names.add(handlerName)
  }
  return [...names]
}

describe("ads handler bundle", () => {
  it("every manifest handler/summarizer/subscribe reference resolves to a callable export", () => {
    const r = handlers as Record<string, unknown>
    const missing: string[] = []
    for (const name of collectHandlerNames()) {
      if (typeof r[name] !== "function") missing.push(name)
    }
    if (missing.length > 0) {
      console.error("Missing exports:", missing)
    }
    expect(missing).toEqual([])
  })

  it("exports 10 read tool handlers", () => {
    const r = handlers as Record<string, unknown>
    const readTools = [
      "insights_query",
      "campaigns_list",
      "adsets_list",
      "ads_list",
      "targeting_search",
      "media_list",
      "audiences_list",
      "pages_list",
      "account_info",
      "graph_get",
    ]
    for (const name of readTools) {
      expect(typeof r[name], `read handler '${name}' not exported`).toBe("function")
    }
  })

  it("exports 10 write tool handlers", () => {
    const r = handlers as Record<string, unknown>
    const writeTools = [
      "create_campaign",
      "create_adset",
      "create_ad",
      "create_creative",
      "upload_image",
      "update_budget",
      "set_status",
      "create_custom_audience",
      "create_lookalike_audience",
      "add_users_to_audience",
    ]
    for (const name of writeTools) {
      expect(typeof r[name], `write handler '${name}' not exported`).toBe("function")
    }
  })

  it("exports 10 summarizers", () => {
    const r = handlers as Record<string, unknown>
    const summarizers = [
      "summarizeCampaign",
      "summarizeAdset",
      "summarizeAd",
      "summarizeCreative",
      "summarizeUploadImage",
      "summarizeBudget",
      "summarizeSetStatus",
      "summarizeCustomAudience",
      "summarizeLookalike",
      "summarizeAddUsers",
    ]
    for (const name of summarizers) {
      expect(typeof r[name], `summarizer '${name}' not exported`).toBe("function")
    }
  })

  it("exports pause and google_pause (gated pause tools) plus their summarizers", () => {
    const r = handlers as Record<string, unknown>
    expect(typeof r.pause).toBe("function")
    expect(typeof r.google_pause).toBe("function")
    expect(typeof r.summarizePause).toBe("function")
    expect(typeof r.summarizeGooglePause).toBe("function")
  })

  it("no longer exports the removed stock-aware auto-pause surface", () => {
    const r = handlers as Record<string, unknown>
    expect(r.onShopifyInventoryLow).toBeUndefined()
    expect(r.map_product_ads).toBeUndefined()
    expect(r.list_product_ads).toBeUndefined()
    expect(r.findResumeCandidates).toBeUndefined()
  })
})
