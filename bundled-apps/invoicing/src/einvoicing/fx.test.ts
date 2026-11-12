// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ECB reference-rate fetch, the `fx_rates` cache and the warm-up job against recorded ECB
// answers (no live network). Rates are foreign units per 1 EUR; EUR = amount / rate, half-up.
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { cachedRate, eurMinor, fetchEcbRate, parseEcbCsv, warmFxRate } from "./fx"
import { ECB_EMPTY_200, ECB_USD_CSV } from "./fx.fixtures"

const NOW = new Date("2026-10-02T09:00:00Z")

function okFetch(body: string = ECB_USD_CSV) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return { status: 200, headers: {}, body }
  }
  return { fetch, calls }
}

describe("parseEcbCsv", () => {
  test("takes the last observation: OBS_VALUE and TIME_PERIOD by header name", () => {
    expect(parseEcbCsv(ECB_USD_CSV)).toEqual({ rate: "1.1225", rate_date: "2026-10-02" })
  })
  test("an empty body is no data", () => {
    expect(parseEcbCsv(ECB_EMPTY_200.body)).toBeNull()
  })
  test("a body without the columns is no data", () => {
    expect(parseEcbCsv("A,B\n1,2\n")).toBeNull()
  })
  test("a non-positive or non-numeric rate is no data", () => {
    expect(parseEcbCsv("TIME_PERIOD,OBS_VALUE\n2026-10-02,0\n")).toBeNull()
    expect(parseEcbCsv("TIME_PERIOD,OBS_VALUE\n2026-10-02,abc\n")).toBeNull()
  })
})

describe("fetchEcbRate", () => {
  test("asks for the last observation on or before the date", async () => {
    const { fetch, calls } = okFetch()
    const r = await fetchEcbRate({ fetch }, "USD", "2026-10-03")
    expect(r).toEqual({ ok: true, rate: "1.1225", rate_date: "2026-10-02" })
    expect(calls).toHaveLength(1)
    const u = new URL(calls[0]!)
    expect(u.host).toBe("data-api.ecb.europa.eu")
    expect(u.pathname).toBe("/service/data/EXR/D.USD.EUR.SP00.A")
    expect(u.searchParams.get("endPeriod")).toBe("2026-10-03")
    expect(u.searchParams.get("lastNObservations")).toBe("1")
    expect(u.searchParams.get("format")).toBe("csvdata")
  })
  test("an empty 200 is retried once, then fx_rate_unavailable", async () => {
    const { fetch, calls } = okFetch("")
    const r = await fetchEcbRate({ fetch }, "USD", "2026-10-03")
    expect(r).toEqual({ ok: false, code: "fx_rate_unavailable" })
    expect(calls).toHaveLength(2)
  })
  test("a transport error is unavailable, never thrown", async () => {
    const r = await fetchEcbRate(
      {
        fetch: async () => {
          throw new Error("down")
        },
      },
      "USD",
      "2026-10-03",
    )
    expect(r).toEqual({ ok: false, code: "fx_rate_unavailable" })
  })
  test("no fetch in the context is unavailable", async () => {
    expect(await fetchEcbRate({}, "USD", "2026-10-03")).toEqual({
      ok: false,
      code: "fx_rate_unavailable",
    })
  })
  test("a malformed currency code never reaches the network", async () => {
    const { fetch, calls } = okFetch()
    expect(await fetchEcbRate({ fetch }, "US/D", "2026-10-03")).toEqual({
      ok: false,
      code: "fx_rate_unavailable",
    })
    expect(calls).toHaveLength(0)
  })
  test("a JSON-string envelope is understood", async () => {
    const fetch = async () => JSON.stringify({ status: 200, body: ECB_USD_CSV })
    expect((await fetchEcbRate({ fetch }, "USD", "2026-10-03")).ok).toBe(true)
  })
})

describe("eurMinor", () => {
  test("direction: USD 100.00 at 1.0850 is EUR 92.17", () => {
    expect(eurMinor(10000n, "1.0850", 2)).toBe(9217n)
  })
  test("half-up at two decimals", () => {
    expect(eurMinor(3n, "2", 2)).toBe(2n) // 0.015 -> 0.02
    expect(eurMinor(1n, "3", 2)).toBe(0n) // 0.0033 -> 0.00
    expect(eurMinor(100n, "3", 2)).toBe(33n)
  })
  test("zero stays zero (a zero-VAT document)", () => {
    expect(eurMinor(0n, "1.1225", 2)).toBe(0n)
  })
  test("a zero-decimal currency: JPY 10000 at 160.00 is EUR 62.50", () => {
    expect(eurMinor(10000n, "160.00", 0)).toBe(6250n)
  })
  test("negative amounts (credit notes) round half away from zero", () => {
    expect(eurMinor(-3n, "2", 2)).toBe(-2n)
  })
})

describe("cachedRate", () => {
  const seed = [
    { id: "r1", currency: "USD", rate_date: "2026-10-01", rate: "1.1298", fetched_at: NOW },
    { id: "r2", currency: "USD", rate_date: "2026-10-02", rate: "1.1225", fetched_at: NOW },
    { id: "r3", currency: "GBP", rate_date: "2026-10-02", rate: "0.8700", fetched_at: NOW },
  ]
  test("latest rate on or before the date", async () => {
    const db = createMockDb({ seed: { fx_rates: seed } })
    expect(await cachedRate(db, "USD", "2026-10-03")).toEqual({
      rate: "1.1225",
      rate_date: "2026-10-02",
    })
    expect(await cachedRate(db, "USD", "2026-10-01")).toEqual({
      rate: "1.1298",
      rate_date: "2026-10-01",
    })
  })
  test("nothing on or before the date, or older than 7 days, is a miss (never a stale guess)", async () => {
    const db = createMockDb({ seed: { fx_rates: seed } })
    expect(await cachedRate(db, "USD", "2026-09-30")).toBeNull()
    expect(await cachedRate(db, "USD", "2026-10-09")).toEqual({
      rate: "1.1225",
      rate_date: "2026-10-02",
    })
    expect(await cachedRate(db, "USD", "2026-10-10")).toBeNull()
    expect(await cachedRate(db, "JPY", "2026-10-02")).toBeNull()
  })
  test("finds the right rate among more than 500 cached rows, oldest stored first", async () => {
    const rows: Array<Record<string, unknown>> = []
    const start = Date.parse("2024-12-01T00:00:00Z")
    for (let i = 0; i < 700; i++) {
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
      rows.push({
        id: `u${String(i).padStart(4, "0")}`,
        currency: "USD",
        rate_date: d,
        rate: `1.${String(1000 + i)}`,
        fetched_at: NOW,
      })
    }
    const last = rows[699] as { rate_date: string; rate: string }
    const db = createMockDb({ seed: { fx_rates: rows } })
    // The newest rate is the 700th row stored: a capped unordered scan never reaches it.
    expect(await cachedRate(db, "USD", last.rate_date)).toEqual({
      rate: last.rate,
      rate_date: last.rate_date,
    })
    // A back-dated document takes the rate of its own date, never a later one.
    const mid = rows[400] as { rate_date: string; rate: string }
    expect(await cachedRate(db, "USD", mid.rate_date)).toEqual({
      rate: mid.rate,
      rate_date: mid.rate_date,
    })
    // Past the 7-day window of the newest row: a miss.
    const late = new Date(Date.parse(`${last.rate_date}T00:00:00Z`) + 8 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    expect(await cachedRate(db, "USD", late)).toBeNull()
  })
  test("reads ordered by rate_date, newest first, a page at a time", async () => {
    const seen: Array<Record<string, unknown>> = []
    const inner = createMockDb({ seed: { fx_rates: seed } })
    const db = {
      findMany: async (entity: string, opts?: Record<string, unknown>) => {
        seen.push(opts ?? {})
        return inner.findMany(entity, opts as Parameters<typeof inner.findMany>[1])
      },
    }
    expect(await cachedRate(db, "USD", "2026-10-03")).toEqual({
      rate: "1.1225",
      rate_date: "2026-10-02",
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ where: { currency: "USD" }, orderBy: { rate_date: "desc" } })
    expect(Number(seen[0]?.limit)).toBeLessThanOrEqual(50)
  })
})

describe("warmFxRate", () => {
  test("stores the fetched rate once; a second warm-up adds nothing", async () => {
    const db = createMockDb()
    const { fetch } = okFetch()
    await warmFxRate({ db, fetch }, "USD", "2026-10-03", NOW)
    await warmFxRate({ db, fetch }, "USD", "2026-10-03", NOW)
    const rows = db.__all("fx_rates")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ currency: "USD", rate_date: "2026-10-02", rate: "1.1225" })
  })
  test("never throws and stores nothing when the rate is unavailable", async () => {
    const db = createMockDb()
    await warmFxRate({ db, fetch: okFetch("").fetch }, "USD", "2026-10-03", NOW)
    expect(db.__all("fx_rates")).toHaveLength(0)
  })
  test("EUR needs no rate", async () => {
    const db = createMockDb()
    const { fetch, calls } = okFetch()
    await warmFxRate({ db, fetch }, "EUR", "2026-10-03", NOW)
    expect(calls).toHaveLength(0)
  })
})
