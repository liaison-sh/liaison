// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door of the issue date and number year. The instants through the real sandbox are proven
// in the api suite (`tests/integration/invoicing-issue-date.test.ts`); here, the rules around them
// and the guard that keeps every issuing path going through `issueDateParts`.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { onOrAfterCutover } from "./einvoicing/transmit"
import { checkIssuerTimezone, issueDateParts, issuerTimezoneUnset, normalizeIssuerTimezone } from "./issue-date"
import { einvoicingReadiness } from "./einvoicing/readiness"
import { settingsIssuerProfileUpdate } from "./mutations/issuer-profiles"
import type { MutationsCtx } from "./mutations/shared"
import { settingsIssuerProfileList } from "./reads"
import { pickIssuerSaveFields } from "./ui/settings"
import { createMockDb } from "./test-db"
import { testTime } from "./test-time"

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
    expect(await issueDateParts({ time: testTime() }, paris)).toMatchObject({ issued_at: "2026-09-01", year_of_issue: 2026 })
  })

  test("the night the clocks change", async () => {
    at("2027-03-28T01:30:00Z")
    expect(await issueDateParts({ time: testTime() }, paris)).toMatchObject({ issued_at: "2027-03-28" })
  })

  test("an issuer on the default follows its org, and UTC with no org zone", async () => {
    at("2026-12-31T23:20:00Z")
    for (const timezone of ["UTC", null, undefined, ""]) {
      expect(await issueDateParts({ time: testTime("Europe/Paris") }, { timezone })).toMatchObject({ issued_at: "2027-01-01" })
      expect(await issueDateParts({ time: testTime() }, { timezone })).toMatchObject({ issued_at: "2026-12-31" })
    }
  })

  test("UTC chosen on purpose does not follow the org", async () => {
    at("2026-12-31T23:20:00Z")
    expect(await issueDateParts({ time: testTime("Europe/Paris") }, { timezone: "Etc/UTC" })).toMatchObject({
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
      expect((await einvoicingReadiness({ db } as never, {})).issuer_time_zones_to_choose).toBeUndefined()
    }
  })

  test("an archived issuer is not asked", async () => {
    const db = createMockDb({
      seed: { issuer_profiles: [{ ...row, id: "i-2", timezone: "UTC", archived_at: "2026-01-01" }, { ...row, timezone: "Europe/Paris" }] },
    })
    expect((await einvoicingReadiness({ db } as never, {})).issuer_time_zones_to_choose).toBeUndefined()
  })

  test("the issuer list says which profile still needs a choice", async () => {
    const db = createMockDb({
      seed: { issuer_profiles: [{ ...row, timezone: "UTC" }, { ...row, id: "i-2", legal_name: "Bcme", timezone: "Asia/Tokyo" }] },
    })
    const { items } = await settingsIssuerProfileList({ db } as never)
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
    expect(((await db.findOne("issuer_profiles", "i-1")) as Record<string, unknown>).timezone).toBe("UTC")

    expect(await settingsIssuerProfileUpdate(ctx, { id: "i-1", timezone: "UTC" })).toMatchObject({ status: "completed" })
    expect(((await db.findOne("issuer_profiles", "i-1")) as Record<string, unknown>).timezone).toBe("Etc/UTC")

    // Saving something else leaves the zone alone: no choice is invented for anyone.
    await db.update("issuer_profiles", "i-1", { timezone: "UTC" })
    await settingsIssuerProfileUpdate(ctx, { id: "i-1", legal_name: "Acme SAS" })
    expect(((await db.findOne("issuer_profiles", "i-1")) as Record<string, unknown>).timezone).toBe("UTC")
  })

  test("a settings form save never turns the column default into a choice", () => {
    expect(pickIssuerSaveFields({ id: "i-1", legal_name: "Acme", timezone: "UTC" })).toEqual({ id: "i-1", legal_name: "Acme" })
    expect(pickIssuerSaveFields({ id: "i-1", timezone: "Etc/UTC" })).toEqual({ id: "i-1", timezone: "Etc/UTC" })
    expect(pickIssuerSaveFields({ id: "i-1", timezone: "Europe/Paris" })).toEqual({ id: "i-1", timezone: "Europe/Paris" })
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
        .flatMap((line, i) => (pattern.test(line) ? [`${path.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`] : [])),
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

  test("every builder of a draft takes both from issueDateParts", () => {
    const yearSites = offenders(/^\s*year_of_issue:\s*[^,\s]/).filter((l) => !/year_of_issue:\s*(number|null)\b/.test(l))
    expect(yearSites.length).toBeGreaterThanOrEqual(6)
    for (const site of yearSites) expect(site).toContain("when.year_of_issue")
    const dateSites = offenders(/^\s*issued_at:\s*[^,\s]/).filter((l) => /new Date|when\./.test(l))
    expect(dateSites.length).toBeGreaterThanOrEqual(6)
    for (const site of dateSites) expect(site).toContain("when.issued_at")
  })

  test("issueDocument is the only reader of draft.year_of_issue and draft.issued_at", () => {
    const readers = sources(SRC).flatMap((path) => {
      if (path.endsWith("/issue.ts")) return []
      return /\bdraft\.(year_of_issue|issued_at)\b/.test(readFileSync(path, "utf8")) ? [path.slice(SRC.length + 1)] : []
    })
    expect(readers).toEqual(["mutations/fx-issue.ts"])
  })
})
