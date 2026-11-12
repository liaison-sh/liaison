// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  fetchInsightsReport,
  INSIGHTS_REPORT_JOB,
  INSIGHTS_REPORTS,
  insightsReportJob,
  insightsReportKey,
  REPORT_MAX_AGE_MS,
} from "./insights-report"
import { createMemoryStore, createRecordingTimers } from "./test-store"

type Resp = { status: number; body: string }

function makeCtx(responses: Resp[]) {
  const urls: Array<{ url: string; method: string }> = []
  let i = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    urls.push({ url, method: String(opts?.method ?? "GET") })
    const r = responses[i++]
    if (!r) throw new Error(`no response for ${url}`)
    return { status: r.status, headers: {}, body: r.body }
  }
  const store = createMemoryStore()
  const timers = createRecordingTimers()
  const connections = {
    meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
  }
  return { ctx: { fetch, store, timers, connections }, urls, store, timers }
}

const REQ = {
  path: "/act_1/insights",
  params: { level: "ad", time_increment: 1 },
  accessToken: "t",
}
const status = (s: string) => ({
  status: 200,
  body: JSON.stringify({ id: "RUN_1", async_status: s }),
})
const rows = (r: unknown[]) => ({
  status: 200,
  body: JSON.stringify({ data: r, paging: { cursors: {} } }),
})

describe("insights report continuation", () => {
  it("the key is stable across param key order", async () => {
    expect(await insightsReportKey("/p", { a: 1, b: { c: 2, d: 3 } })).toBe(
      await insightsReportKey("/p", { b: { d: 3, c: 2 }, a: 1 }),
    )
  })

  it("first call starts the run, stores its id and arms one deduplicated wake-up", async () => {
    const { ctx, store, timers } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_1" }) },
      status("Job Running"),
    ])
    const out = await fetchInsightsReport(ctx, REQ)
    expect(out).toEqual({ _pending: true, report_run_id: "RUN_1", reason: "still_running" })
    const key = await insightsReportKey(REQ.path, REQ.params)
    expect((await store.get(INSIGHTS_REPORTS, key))?.data).toMatchObject({
      reportRunId: "RUN_1",
      wakes: 0,
    })
    expect(timers.wakes).toEqual([
      {
        seconds: 15,
        job: INSIGHTS_REPORT_JOB,
        payload: { report: key },
        jobId: `insights-report-${key}`,
      },
    ])
  })

  it("the job parks finished rows; the next call answers them without asking Meta", async () => {
    const { ctx, store, urls } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_1" }) },
      status("Job Running"),
      status("Job Completed"),
      rows([{ spend: "3.00" }]),
    ])
    await fetchInsightsReport(ctx, REQ)
    const key = await insightsReportKey(REQ.path, REQ.params)
    expect(await insightsReportJob({ report: key }, ctx)).toEqual({ state: "parked" })
    const before = urls.length
    expect(await fetchInsightsReport(ctx, REQ)).toEqual([{ spend: "3.00" }])
    expect(urls.length).toBe(before)
    expect(store.docs.size).toBe(0)
  })

  it("the job re-arms itself with a growing delay while the report builds", async () => {
    const { ctx, store, timers } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_1" }) },
      status("Job Running"),
      status("Job Running"),
      status("Job Running"),
    ])
    await fetchInsightsReport(ctx, REQ)
    const key = await insightsReportKey(REQ.path, REQ.params)
    expect(await insightsReportJob({ report: key }, ctx)).toEqual({ state: "still_running" })
    expect(await insightsReportJob({ report: key }, ctx)).toEqual({ state: "still_running" })
    expect(timers.wakes.map((w) => w.seconds)).toEqual([15, 30, 60])
    expect((await store.get(INSIGHTS_REPORTS, key))?.data).toMatchObject({ wakes: 2 })
  })

  it("the job parks a terminal failure; the next call throws it once and forgets the run", async () => {
    const { ctx, store } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_1" }) },
      status("Job Running"),
      status("Job Failed"),
    ])
    await fetchInsightsReport(ctx, REQ)
    const key = await insightsReportKey(REQ.path, REQ.params)
    expect(await insightsReportJob({ report: key }, ctx)).toEqual({ state: "failed" })
    const err = await fetchInsightsReport(ctx, REQ).catch((e: Error) => e)
    expect((err as Error).message).toContain("Job Failed")
    expect(store.docs.size).toBe(0)
  })

  it("a record past its age is dropped: the job stops, the call starts a fresh run", async () => {
    const { ctx, store, urls } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_2" }) },
      status("Job Running"),
    ])
    const key = await insightsReportKey(REQ.path, REQ.params)
    const old = new Date(Date.now() - REPORT_MAX_AGE_MS - 1000).toISOString()
    await store.set(INSIGHTS_REPORTS, key, { reportRunId: "RUN_OLD", startedAt: old, wakes: 3 })
    expect(await insightsReportJob({ report: key }, ctx)).toEqual({ state: "expired" })
    await store.set(INSIGHTS_REPORTS, key, { reportRunId: "RUN_OLD", startedAt: old, wakes: 3 })
    const out = await fetchInsightsReport(ctx, REQ)
    expect(out).toMatchObject({ _pending: true, report_run_id: "RUN_2" })
    expect(urls[0]?.method).toBe("POST")
  })

  it("the job ends quietly when the record is gone", async () => {
    const { ctx } = makeCtx([])
    expect(await insightsReportJob({ report: "nope" }, ctx)).toEqual({ state: "gone" })
    expect(await insightsReportJob({}, ctx)).toEqual({ state: "no_key" })
  })
})
