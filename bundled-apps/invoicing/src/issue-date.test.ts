// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door of the issue date and number year. The instants through the real sandbox are proven
// in the api suite (`tests/integration/invoicing-issue-date.test.ts`); here, the rules around them
// and the guard that keeps every issuing path going through `issueDateParts`.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { draftFromCard, harness, linesRead, type Row } from "./__tests__/from-reconcile-harness"
import { latestIssueLine } from "./approval-cards"
import { einvoicingReadiness } from "./einvoicing/readiness"
import { onOrAfterCutover } from "./einvoicing/transmit"
import {
  checkIssuerTimezone,
  civilDateOf,
  issueDateParts,
  issueLateness,
  issuerTimezoneUnset,
  normalizeIssuerTimezone,
} from "./issue-date"
import { invoiceIssue } from "./mutations"
import { settingsIssuerProfileUpdate } from "./mutations/issuer-profiles"
import { draftIssuePreview } from "./mutations/quote-proforma-po"
import type { MutationsCtx } from "./mutations/shared"
import { draftOrderDateRefusal } from "./mutations/stated-issue-date"
import { settingsIssuerProfileList } from "./reads"
import { summarizeInvoiceIssue } from "./summarizers"
import { createMockDb } from "./test-db"
import { testTime } from "./test-time"
import { pickIssuerSaveFields } from "./ui/settings"

afterEach(() => setSystemTime())

describe("issueDateParts", () => {
  const paris = { timezone: "Europe/Paris" }
  const at = (iso: string) => setSystemTime(new Date(iso))

  test("00:20 on 1 January in Paris is 2027", async () => {
    at("2026-12-31T23:20:00Z")
    expect(await issueDateParts({ time: testTime() }, paris)).toEqual({
      ok: true,
      year_of_issue: 2027,
      issued_at: "2027-01-01",
    })
  })

  test("00:20 on 1 September in Paris, summer time", async () => {
    at("2026-08-31T22:20:00Z")
    expect(await issueDateParts({ time: testTime() }, paris)).toMatchObject({
      issued_at: "2026-09-01",
      year_of_issue: 2026,
    })
  })

  test("the night the clocks change", async () => {
    at("2027-03-28T01:30:00Z")
    expect(await issueDateParts({ time: testTime() }, paris)).toMatchObject({
      issued_at: "2027-03-28",
    })
  })

  test("an issuer on the default follows its org, and UTC with no org zone", async () => {
    at("2026-12-31T23:20:00Z")
    for (const timezone of ["UTC", null, undefined, ""]) {
      expect(await issueDateParts({ time: testTime("Europe/Paris") }, { timezone })).toMatchObject({
        issued_at: "2027-01-01",
      })
      expect(await issueDateParts({ time: testTime() }, { timezone })).toMatchObject({
        issued_at: "2026-12-31",
      })
    }
  })

  test("UTC chosen on purpose does not follow the org", async () => {
    at("2026-12-31T23:20:00Z")
    expect(
      await issueDateParts({ time: testTime("Europe/Paris") }, { timezone: "Etc/UTC" }),
    ).toMatchObject({
      issued_at: "2026-12-31",
      year_of_issue: 2026,
    })
  })

  test("an unknown zone is the typed refusal, not a date", async () => {
    const res = await issueDateParts({ time: testTime() }, { timezone: "Europe/Atlantis" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.error.code).toBe("issuer_timezone_invalid")
  })

  test("a host failure that is not about the zone is not dressed up as one", async () => {
    const time = { civil: async () => Promise.reject(new Error("bridge down")) }
    await expect(issueDateParts({ time }, paris)).rejects.toThrow("bridge down")
  })
})

describe("draftOrderDateRefusal", () => {
  const paris = { timezone: "Europe/Paris" }

  test("nothing stated, or today in the issuer's zone, is no date to refuse", async () => {
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    expect(await draftOrderDateRefusal({ time: testTime() }, paris, null)).toBeNull()
    expect(await draftOrderDateRefusal({ time: testTime() }, paris, "2027-01-01")).toBeNull()
  })

  test("another day is refused", async () => {
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const refused = await draftOrderDateRefusal({ time: testTime() }, paris, "2026-12-31")
    expect(refused?.error.code).toBe("issue_date_set_by_draft_order")
  })
})

describe("civilDateOf", () => {
  const paris = { timezone: "Europe/Paris" }
  const ctx = { time: testTime() }

  test("an instant reads as the issuer's date, whatever offset it was written with", async () => {
    setSystemTime(new Date("2026-06-15T12:00:00Z"))
    for (const at of ["2026-12-31T23:20:00Z", "2026-12-31T18:20:00-05:00"]) {
      expect(await civilDateOf(ctx, paris, at)).toEqual({ ok: true, date: "2027-01-01" })
    }
    expect(await civilDateOf(ctx, { timezone: "Etc/UTC" }, "2026-12-31T23:20:00Z")).toEqual({
      ok: true,
      date: "2026-12-31",
    })
  })

  test("a bare date is already civil and stays as it is", async () => {
    expect(await civilDateOf(ctx, paris, "2026-12-31")).toEqual({ ok: true, date: "2026-12-31" })
  })

  test("nothing, or a value that names no instant, reads as now", async () => {
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    for (const at of [null, undefined, "", "not a date"]) {
      expect(await civilDateOf(ctx, paris, at)).toEqual({ ok: true, date: "2027-01-01" })
    }
  })

  test("an unknown zone is the typed refusal", async () => {
    const res = await civilDateOf(ctx, { timezone: "Europe/Atlantis" })
    expect(res).toMatchObject({ ok: false, error: { error: { code: "issuer_timezone_invalid" } } })
  })
})

describe("the cut-over reads the stored civil date", () => {
  test("midnight UTC of the stored date is that day, in either form the row comes back in", () => {
    for (const stored of ["2026-09-01", "2026-09-01T00:00:00.000Z", "2026-09-01 00:00:00+00"]) {
      expect(onOrAfterCutover(stored, "2026-09-01")).toBe(true)
      expect(onOrAfterCutover(stored, "2026-09-02")).toBe(false)
    }
  })
})

describe("the zone is asked once per issuer", () => {
  const row = { id: "i-1", legal_name: "Acme", country: "FR", archived_at: null }

  test("only the column default reads as unset; UTC someone sends is stored as chosen", () => {
    expect(issuerTimezoneUnset({ timezone: "UTC" })).toBe(true)
    expect(issuerTimezoneUnset({ timezone: null })).toBe(true)
    expect(issuerTimezoneUnset({ timezone: "Etc/UTC" })).toBe(false)
    expect(issuerTimezoneUnset({ timezone: "Europe/Paris" })).toBe(false)
    expect(normalizeIssuerTimezone("UTC")).toBe("Etc/UTC")
    expect(normalizeIssuerTimezone("Europe/Paris")).toBe("Europe/Paris")
  })

  test("the readiness line names the fixing tool, blocks nothing, and clears once chosen", async () => {
    const db = createMockDb({ seed: { issuer_profiles: [{ ...row, timezone: "UTC" }] } })
    const before = await einvoicingReadiness({ db } as never, {})
    expect(before.items).toEqual([])
    expect(before.issuer_time_zones_to_choose).toEqual([
      expect.objectContaining({
        issuer_profile_id: "i-1",
        action: expect.objectContaining({ tool: "settings_issuer_profile_update" }),
      }),
    ])
    for (const timezone of ["Etc/UTC", "Europe/Paris"]) {
      await db.update("issuer_profiles", "i-1", { timezone })
      expect(
        (await einvoicingReadiness({ db } as never, {})).issuer_time_zones_to_choose,
      ).toBeUndefined()
    }
  })

  test("an archived issuer is not asked", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [
          { ...row, id: "i-2", timezone: "UTC", archived_at: "2026-01-01" },
          { ...row, timezone: "Europe/Paris" },
        ],
      },
    })
    expect(
      (await einvoicingReadiness({ db } as never, {})).issuer_time_zones_to_choose,
    ).toBeUndefined()
  })

  test("the issuer list says which profile still needs a choice", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [
          { ...row, timezone: "UTC" },
          { ...row, id: "i-2", legal_name: "Bcme", timezone: "Asia/Tokyo" },
        ],
      },
    })
    const { items } = await settingsIssuerProfileList({ db, time: testTime() } as never)
    expect(items.map((i) => [i.id, i.timezone_choice_needed])).toEqual([
      ["i-1", true],
      ["i-2", false],
    ])
  })

  test("saving: UTC becomes the choice, an unknown zone changes nothing", async () => {
    const db = createMockDb({ seed: { issuer_profiles: [{ ...row, timezone: "UTC" }] } })
    const ctx = { db, time: testTime(), emit: async () => {} } as unknown as MutationsCtx

    const bad = await settingsIssuerProfileUpdate(ctx, { id: "i-1", timezone: "Europe/Atlantis" })
    expect(bad).toMatchObject({ status: "error", error: { code: "issuer_timezone_invalid" } })
    expect(((await db.findOne("issuer_profiles", "i-1")) as Record<string, unknown>).timezone).toBe(
      "UTC",
    )

    expect(await settingsIssuerProfileUpdate(ctx, { id: "i-1", timezone: "UTC" })).toMatchObject({
      status: "completed",
    })
    expect(((await db.findOne("issuer_profiles", "i-1")) as Record<string, unknown>).timezone).toBe(
      "Etc/UTC",
    )

    // Saving something else leaves the zone alone: no choice is invented for anyone.
    await db.update("issuer_profiles", "i-1", { timezone: "UTC" })
    await settingsIssuerProfileUpdate(ctx, { id: "i-1", legal_name: "Acme SAS" })
    expect(((await db.findOne("issuer_profiles", "i-1")) as Record<string, unknown>).timezone).toBe(
      "UTC",
    )
  })

  test("a settings form save never turns the column default into a choice", () => {
    expect(pickIssuerSaveFields({ id: "i-1", legal_name: "Acme", timezone: "UTC" })).toEqual({
      id: "i-1",
      legal_name: "Acme",
    })
    expect(pickIssuerSaveFields({ id: "i-1", timezone: "Etc/UTC" })).toEqual({
      id: "i-1",
      timezone: "Etc/UTC",
    })
    expect(pickIssuerSaveFields({ id: "i-1", timezone: "Europe/Paris" })).toEqual({
      id: "i-1",
      timezone: "Europe/Paris",
    })
  })

  test("checkIssuerTimezone answers null for a known zone", async () => {
    expect(await checkIssuerTimezone({ time: testTime() }, "Europe/Paris")).toBeNull()
    expect(await checkIssuerTimezone({ time: testTime() }, "UTC")).toBeNull()
  })
})

// Every builder takes its date from `issueDateParts`. A date computed on the spot in a
// handler is UTC, whatever the code around it says: the sandbox has no time zones.
describe("guard: one door for the issue date", () => {
  const SRC = import.meta.dir
  const SCANNED = ["mutations", "handlers", "recurring"]

  function sources(dir: string): string[] {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return [] // A scanned directory this version does not have yet.
    }
    return names.flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  }

  const files = SCANNED.flatMap((d) => sources(join(SRC, d)))
  const offenders = (pattern: RegExp) =>
    files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          pattern.test(line) ? [`${path.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`] : [],
        ),
    )

  test("it scans real code", () => {
    expect(files.some((p) => p.endsWith("mutations/invoice-issue.ts"))).toBe(true)
    expect(files.some((p) => p.endsWith("handlers/shopify-order-paid.ts"))).toBe(true)
  })

  test("no UTC year, no UTC date assigned to issued_at, no yearInTimezone", () => {
    expect(offenders(/getUTCFullYear/)).toEqual([])
    expect(offenders(/yearInTimezone/)).toEqual([])
    expect(offenders(/\bissued_at\s*[:=].*toISOString\(\)\.slice\(0,\s*10\)/)).toEqual([])
  })

  // Mutation caught: dropping `recurring` from the scanned folders, or the pattern that refuses a UTC year.
  test("the guard scans the recurring folder and the Stripe handlers, and refuses a UTC year or date there", () => {
    expect(SCANNED).toContain("recurring")
    expect(files.some((p) => p.endsWith("recurring/schedule.ts"))).toBe(true)
    // Stripe handlers live in `handlers/`, which is scanned whole: a file named for them is covered.
    expect(SCANNED).toContain("handlers")
    const refused = [
      "const year = new Date(x).getUTCFullYear()",
      "issued_at: new Date().toISOString().slice(0, 10),",
      "const y = yearInTimezone(now, zone)",
    ]
    const patterns = [
      /getUTCFullYear/,
      /\bissued_at\s*[:=].*toISOString\(\)\.slice\(0,\s*10\)/,
      /yearInTimezone/,
    ]
    for (const [i, line] of refused.entries()) expect(patterns[i]?.test(line)).toBe(true)
  })

  test("no UTC date and no bare slice of an instant assigned to a paid date", () => {
    expect(offenders(/paid_?at\b.*(toISOString\(\)|dateOnly\()/i)).toEqual([])
  })

  test("the editor's default date is not a UTC date", () => {
    const editor = readFileSync(join(SRC, "ui", "Editor.tsx"), "utf8")
    expect(editor).not.toMatch(/\bissued_at\s*[:=].*toISOString\(\)/)
  })

  test("every builder of a draft takes both from issueDateParts", () => {
    // A filter on an existing document's own year (`where: { ..., year_of_issue: doc.year_of_issue }`,
    // one key per line once formatted) builds no draft.
    const yearSites = offenders(/^\s*year_of_issue:\s*[^,\s]/).filter(
      (l) => !/year_of_issue:\s*(number|null|doc\.year_of_issue)\b/.test(l),
    )
    expect(yearSites.length).toBeGreaterThanOrEqual(6)
    for (const site of yearSites) expect(site).toContain("when.year_of_issue")
    const dateSites = offenders(/^\s*issued_at:\s*[^,\s]/).filter((l) => /new Date|when\./.test(l))
    expect(dateSites.length).toBeGreaterThanOrEqual(6)
    for (const site of dateSites) expect(site).toContain("when.issued_at")
  })

  test("issueDocument is the only reader of draft.year_of_issue and draft.issued_at", () => {
    const readers = sources(SRC).flatMap((path) => {
      if (path.endsWith("/issue.ts")) return []
      return /\bdraft\.(year_of_issue|issued_at)\b/.test(readFileSync(path, "utf8"))
        ? [path.slice(SRC.length + 1)]
        : []
    })
    expect(readers).toEqual([])
  })
})

describe("the latest issue day of a draft from planned vs done", () => {
  const REC_NOV = "7a1d2c3e-0000-4000-8000-0000000000ad"
  const REC_DEC = "7a1d2c3e-0000-4000-8000-0000000000ae"
  // Noon UTC on a civil day: the same day in UTC and in Paris.
  const onDay = (y: number, m: number, d: number) =>
    setSystemTime(new Date(Date.UTC(y, m - 1, d, 12)))
  const docOf = (h: ReturnType<typeof harness>, id: string) =>
    h.db.__all("documents").find((d) => d.id === id) as Row
  const cardLines = (h: ReturnType<typeof harness>) =>
    (h.approvals.at(-1)?.summary_detail as { lines: string[] } | undefined)?.lines ?? []

  test("a draft issued after its latest day takes today's date and shows late, and dates never go back in the series", async () => {
    const h = harness()
    // October reconciled on 3 November: born late, its latest day was 31 October.
    onDay(2026, 11, 3)
    const oct = await draftFromCard(h)
    expect(issueLateness(String(docOf(h, oct).latest_issue_on), "2026-11-03")).toBe("late")
    const card = await summarizeInvoiceIssue({ draft_id: oct }, undefined, {
      context: { ...docOf(h, oct), latest_issue_on: "2026-10-31", lines: [] },
    })
    expect(card.lines).toContain(
      "Late: the latest issue date was 2026-10-31; it issues with the date of the day it is issued",
    )
    // November reconciled on 30 November, issued first; October issued after, on 4 December.
    onDay(2026, 11, 30)
    h.read.byRec.set(REC_NOV, linesRead({ from: "2026-11-01", to: "2026-11-30" }, REC_NOV))
    const nov = await draftFromCard(h, REC_NOV)
    expect((await invoiceIssue(h.ctx, { draft_id: nov })).status).toBe("completed")
    onDay(2026, 12, 4)
    const issuedOct = await invoiceIssue(h.ctx, { draft_id: oct })
    expect(issuedOct).toMatchObject({ status: "completed" })
    const issued = h.db
      .__all("documents")
      .filter((d) => d.type === "invoice" && d.status === "issued")
      .sort((a, b) => Number(a.number_int) - Number(b.number_int))
    expect(issued.map((d) => String(d.issued_at).slice(0, 10))).toEqual([
      "2026-11-30",
      "2026-12-04",
    ])
    // The late one keeps its service month and took the day of its issue, not its latest day.
    const lateDoc = docOf(h, String((issuedOct as { document_id?: string }).document_id))
    expect(String(lateDoc.service_period_end).slice(0, 10)).toBe("2026-10-31")
    const dates = issued.map((d) => String(d.issued_at).slice(0, 10))
    expect([...dates].sort()).toEqual(dates)
  })

  test("a draft created after its latest day is late from creation", async () => {
    const cases: Array<{ period: { from: string; to: string }; on: [number, number, number] }> = [
      { period: { from: "2026-11-01", to: "2026-11-30" }, on: [2026, 11, 30] },
      { period: { from: "2026-11-01", to: "2026-11-30" }, on: [2026, 12, 1] },
      { period: { from: "2026-12-01", to: "2026-12-31" }, on: [2026, 12, 31] },
      { period: { from: "2026-12-01", to: "2026-12-31" }, on: [2027, 1, 2] },
    ]
    const seen: string[] = []
    for (const [i, c] of cases.entries()) {
      const h = harness()
      onDay(...c.on)
      h.read.value = linesRead(c.period, i % 2 === 0 ? REC_NOV : REC_DEC)
      const id = await draftFromCard(h, i % 2 === 0 ? REC_NOV : REC_DEC)
      const latest = String(docOf(h, id).latest_issue_on).slice(0, 10)
      expect(latest).toBe(c.period.to)
      const today = new Date().toISOString().slice(0, 10)
      seen.push(`${issueLateness(latest, today)} ${cardLines(h).at(-1)}`)
      // One approval only: it is the draft's one money item, late or not.
      expect(h.approvals).toHaveLength(1)
    }
    expect(seen).toEqual([
      "ends_today Latest issue date: 2026-11-30",
      "late Late: the latest issue date was 2026-11-30; it issues with the date of the day it is issued",
      "ends_today Latest issue date: 2026-12-31",
      "late Late: the latest issue date was 2026-12-31; it issues with the date of the day it is issued",
    ])
    expect(latestIssueLine(null, "2026-12-01")).toBeNull()
    expect(issueLateness("2026-11-30", "2026-11-29")).toBe("on_time")
  })

  test("the issue approval of a draft from planned vs done carries its latest day, for Home", async () => {
    const h = harness()
    onDay(2026, 11, 26)
    h.read.value = linesRead({ from: "2026-11-01", to: "2026-11-30" }, REC_NOV)
    await draftFromCard(h, REC_NOV)
    const detail = h.approvals.at(-1)?.summary_detail as { latest_on?: string } | undefined
    expect(detail?.latest_on).toBe("2026-11-30")
  })

  test("a card's late line reads the org's day, not the sandbox's UTC day", async () => {
    // 00:30 on 1 December in Paris is still 30 November in UTC.
    setSystemTime(new Date(Date.UTC(2026, 10, 30, 23, 30)))
    const h = harness()
    h.read.value = linesRead({ from: "2026-11-01", to: "2026-11-30" }, REC_NOV)
    const id = await draftFromCard(h, REC_NOV)
    const ctx = { ...h.ctx, time: testTime("Europe/Paris") } as unknown as Parameters<
      typeof draftIssuePreview
    >[0]
    const preview = (await draftIssuePreview(ctx, { draft_id: id })) as Row
    expect(preview.today).toBe("2026-12-01")
    const card = await summarizeInvoiceIssue({ draft_id: id }, undefined, { context: preview })
    expect(card.lines).toContain(
      "Late: the latest issue date was 2026-11-30; it issues with the date of the day it is issued",
    )
    expect(card.latestOn).toBe("2026-11-30")
  })
})
