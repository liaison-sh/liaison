// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T2 — experiment ledger tools: experiment_open (ungated), experiment_update,
// experiment_close, experiment_list. Lifecycle tests via createMockDb (mirrors
// pause.test.ts pattern).

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AppCtx } from "../lib/ctx-types"
import { createMockDb } from "../test-db"
import {
  experiment_close,
  experiment_list,
  experiment_open,
  experiment_update,
} from "./experiments"

function makeCtx(db = createMockDb()): AppCtx {
  return { fetch: async () => ({}), connections: {}, db, actorId: "user_1" } as unknown as AppCtx
}

describe("experiment_open", () => {
  it("inserts a row with hypothesis/metric_tier/minimum_sample/decision_date and status defaults to draft", async () => {
    const ctx = makeCtx()
    const result = (await experiment_open(
      {
        title: "Brand vs non-brand split",
        hypothesis: "Splitting brand out lowers blended CPA",
        metric_tier: "purchase",
        primary_metric: "cpa",
        minimum_sample: 100,
        decision_date: "2026-08-01",
      },
      ctx,
    )) as Record<string, unknown>
    expect(result.id).toBeDefined()
    const row = result.row as Record<string, unknown>
    expect(row.title).toBe("Brand vs non-brand split")
    expect(row.hypothesis).toBe("Splitting brand out lowers blended CPA")
    expect(row.metric_tier).toBe("purchase")
    expect(row.minimum_sample).toBe(100)
    expect(row.decision_date).toBe("2026-08-01")
    expect(row.status).toBe("draft")
  })

  it("accepts an explicit status of running", async () => {
    const ctx = makeCtx()
    const result = (await experiment_open(
      {
        title: "Test",
        hypothesis: "H",
        metric_tier: "blended",
        primary_metric: "mer",
        status: "running",
      },
      ctx,
    )) as Record<string, unknown>
    expect((result.row as Record<string, unknown>).status).toBe("running")
  })

  it("throws when required fields are missing", async () => {
    const ctx = makeCtx()
    await expect(experiment_open({ title: "no hypothesis" }, ctx)).rejects.toThrow()
  })

  it("is NOT gated in the manifest (no summarizer required for approval)", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
    ) as { tools: Record<string, { gated?: boolean }> }
    expect(manifest.tools.experiment_open?.gated).not.toBe(true)
  })
})

describe("experiment_update", () => {
  it("mutates fields on an existing row", async () => {
    const ctx = makeCtx()
    const opened = (await experiment_open(
      { title: "T", hypothesis: "H", metric_tier: "purchase", primary_metric: "cpa" },
      ctx,
    )) as Record<string, unknown>
    const id = opened.id as string
    const updated = (await experiment_update(
      { experiment_id: id, status: "running", linked_campaign_ids: "camp_1,camp_2" },
      ctx,
    )) as Record<string, unknown>
    const row = updated.row as Record<string, unknown>
    expect(row.status).toBe("running")
    expect(row.linked_campaign_ids).toBe("camp_1,camp_2")
  })

  it("throws when experiment_id does not exist", async () => {
    const ctx = makeCtx()
    await expect(
      experiment_update({ experiment_id: "nope", status: "running" }, ctx),
    ).rejects.toThrow()
  })
})

describe("experiment_close", () => {
  it("sets status=decided and records verdict + learnings", async () => {
    const ctx = makeCtx()
    const opened = (await experiment_open(
      { title: "T", hypothesis: "H", metric_tier: "purchase", primary_metric: "cpa" },
      ctx,
    )) as Record<string, unknown>
    const id = opened.id as string
    const closed = (await experiment_close(
      {
        experiment_id: id,
        verdict: "winner: variant A",
        learnings: "consolidation wins at low volume",
      },
      ctx,
    )) as Record<string, unknown>
    const row = closed.row as Record<string, unknown>
    expect(row.status).toBe("decided")
    expect(row.verdict).toBe("winner: variant A")
    expect(row.learnings).toBe("consolidation wins at low volume")
  })
})

describe("experiment_list", () => {
  it("returns open + recent, ordered", async () => {
    const ctx = makeCtx()
    await experiment_open(
      { title: "A", hypothesis: "H", metric_tier: "purchase", primary_metric: "cpa" },
      ctx,
    )
    await experiment_open(
      { title: "B", hypothesis: "H", metric_tier: "blended", primary_metric: "mer" },
      ctx,
    )
    const result = (await experiment_list({}, ctx)) as Record<string, unknown>
    const rows = result.experiments as Array<Record<string, unknown>>
    expect(rows.length).toBe(2)
  })

  it("filters by status when provided", async () => {
    const ctx = makeCtx()
    const opened = (await experiment_open(
      { title: "A", hypothesis: "H", metric_tier: "purchase", primary_metric: "cpa" },
      ctx,
    )) as Record<string, unknown>
    await experiment_close({ experiment_id: opened.id as string, verdict: "done" }, ctx)
    await experiment_open(
      { title: "B", hypothesis: "H", metric_tier: "blended", primary_metric: "mer" },
      ctx,
    )

    const decided = (await experiment_list({ status: "decided" }, ctx)) as Record<string, unknown>
    expect((decided.experiments as unknown[]).length).toBe(1)

    const draft = (await experiment_list({ status: "draft" }, ctx)) as Record<string, unknown>
    expect((draft.experiments as unknown[]).length).toBe(1)
  })
})
