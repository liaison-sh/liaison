// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bundle-registration smoke test. Every handler name referenced in the
// app.manifest.json must be a callable export of `handlers.ts` — otherwise
// the install service rejects the package at registration time. This test
// pins the contract early.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as handlers from "./handlers"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

function collectHandlerNames(): string[] {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    tools?: Record<string, { handler?: string }>
    jobs?: Record<string, { handler?: string }>
    webhooks?: Record<string, { handler?: string; verify?: string }>
    search?: { handler?: string }
    attention?: { handler?: string }
  }
  const names = new Set<string>()
  for (const t of Object.values(m.tools ?? {})) if (t.handler) names.add(t.handler)
  for (const j of Object.values(m.jobs ?? {})) if (j.handler) names.add(j.handler)
  for (const w of Object.values(m.webhooks ?? {})) {
    if (w.handler) names.add(w.handler)
    if (w.verify) names.add(w.verify)
  }
  if (m.search?.handler) names.add(m.search.handler)
  if (m.attention?.handler) names.add(m.attention.handler)
  return [...names]
}

describe("Shopify handler bundle", () => {
  it("exports `searchHandler` (consumed by manifest.search.handler)", () => {
    expect(typeof (handlers as Record<string, unknown>).searchHandler).toBe("function")
  })

  it("exports every declared backfill / reconcile / scan job", () => {
    const r = handlers as Record<string, unknown>
    // Phase 16 ships customer backfill only; orders/products backfill jobs were
    // removed from the manifest (they were notImplemented stubs) and so are NOT
    // exported here.
    for (const name of [
      "backfillCustomersJob",
      "scopeSeedJob",
      "reconcileCustomersJob",
      "scanUnfulfilledOrdersJob",
      "pruneWebhookDeliveriesJob",
    ]) {
      expect(typeof r[name]).toBe("function")
    }
  })

  it("does NOT export the removed orders/products backfill stubs", () => {
    const r = handlers as Record<string, unknown>
    expect(r.backfillOrdersJob).toBeUndefined()
    expect(r.backfillProductsJob).toBeUndefined()
  })

  it("every manifest handler reference resolves to a callable export", () => {
    const r = handlers as Record<string, unknown>
    const missing: string[] = []
    for (const name of collectHandlerNames()) {
      if (typeof r[name] !== "function") missing.push(name)
    }
    expect(missing).toEqual([])
  })

})
