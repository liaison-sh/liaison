// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it, mock } from "bun:test"

type Mod = typeof import("./preferences-service")
let mod: Mod

beforeAll(async () => {
  mod = await import("./preferences-service")
})

const USER = "00000000-0000-0000-0000-000000000aaa"
const ORG = "00000000-0000-0000-0000-000000000111"

function makeRlsTx(rows: any[]) {
  let call = 0
  return {
    execute: mock(async () => {
      const next = rows[Math.min(call, rows.length - 1)]
      call += 1
      return next
    }),
  } as any
}

describe("isValidIanaTimezone", () => {
  it("accepts UTC", () => {
    expect(mod.isValidIanaTimezone("UTC")).toBe(true)
  })
  it("accepts America/New_York", () => {
    expect(mod.isValidIanaTimezone("America/New_York")).toBe(true)
  })
  it("rejects gibberish", () => {
    expect(mod.isValidIanaTimezone("Mars/Olympus")).toBe(false)
  })
})

describe("getOrCreatePreferences", () => {
  it("returns existing row when present", async () => {
    const row = {
      user_id: USER,
      digest_cadence: "hourly",
      work_hours_start: "09:00:00",
      work_hours_end: "17:00:00",
      work_days: [1, 2, 3, 4, 5],
      timezone: "America/Los_Angeles",
      last_daily_sent_at: null,
    }
    const rlsTx = makeRlsTx([[row]])
    const result = await mod.getOrCreatePreferences(USER, ORG, { rlsTx })
    expect(result.digestCadence).toBe("hourly")
    expect(result.timezone).toBe("America/Los_Angeles")
    expect(result.workHoursStart).toBe("09:00")
    expect(result.workHoursEnd).toBe("17:00")
    expect(result.workDays).toEqual([1, 2, 3, 4, 5])
  })

  it("creates a default row when absent, copying org timezone", async () => {
    const orgTzRow = [{ timezone: "America/New_York" }]
    const insertedRow = [
      {
        user_id: USER,
        digest_cadence: "daily",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "America/New_York",
        last_daily_sent_at: null,
      },
    ]
    const rlsTx = makeRlsTx([[], orgTzRow, insertedRow])
    const result = await mod.getOrCreatePreferences(USER, ORG, { rlsTx })
    expect(result.digestCadence).toBe("daily")
    expect(result.timezone).toBe("America/New_York")
    expect(result.workDays).toEqual([1, 2, 3, 4, 5])
  })

  // Falsifies the L117 INSERT literal itself, not just the mapped result --
  // the fixture above returns a canned row regardless of what SQL ran, so it
  // cannot catch a stale 'off' literal in the query text. Inspect the actual
  // compiled SQL passed to rlsTx.execute for the INSERT call.
  it("the INSERT statement's literal cadence is 'daily', not 'off'", async () => {
    const orgTzRow = [{ timezone: "UTC" }]
    const insertedRow = [
      {
        user_id: USER,
        digest_cadence: "daily",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "UTC",
        last_daily_sent_at: null,
      },
    ]
    const calls: unknown[] = []
    const rlsTx = {
      execute: mock(async (query: unknown) => {
        calls.push(query)
        const rows = [[], orgTzRow, insertedRow]
        return rows[Math.min(calls.length - 1, rows.length - 1)]
      }),
    } as any
    await mod.getOrCreatePreferences(USER, ORG, { rlsTx })
    // Call 3 (index 2) is the INSERT — SELECT existing (empty), SELECT org tz,
    // then INSERT ... VALUES (...). The literal 'daily'/'off' is written
    // directly in the template (not a bound param), so it lands in the
    // compiled query's raw SQL text.
    const insertQuery = calls[2] as { queryChunks?: unknown[]; toString?: () => string }
    const sqlText = JSON.stringify(insertQuery)
    expect(sqlText).toContain("daily")
    expect(sqlText).not.toContain("'off'")
  })
})

describe("updatePreferences", () => {
  const VALID_INPUT = {
    digestCadence: "daily" as const,
    workHoursStart: "09:00",
    workHoursEnd: "17:00",
    workDays: [1, 2, 3, 4, 5],
    timezone: "UTC",
  }

  it("rejects empty workDays array", async () => {
    await expect(
      mod.updatePreferences(USER, { ...VALID_INPUT, workDays: [] }, { rlsTx: makeRlsTx([[]]) }),
    ).rejects.toMatchObject({ code: "INVALID_WORK_DAYS" })
  })

  it("rejects duplicate workDays", async () => {
    await expect(
      mod.updatePreferences(
        USER,
        { ...VALID_INPUT, workDays: [1, 2, 2, 3] },
        { rlsTx: makeRlsTx([[]]) },
      ),
    ).rejects.toMatchObject({ code: "INVALID_WORK_DAYS" })
  })

  it("rejects out-of-range workDays", async () => {
    await expect(
      mod.updatePreferences(
        USER,
        { ...VALID_INPUT, workDays: [0, 1, 2] },
        { rlsTx: makeRlsTx([[]]) },
      ),
    ).rejects.toMatchObject({ code: "INVALID_WORK_DAYS" })
  })

  it("rejects invalid IANA timezone", async () => {
    await expect(
      mod.updatePreferences(
        USER,
        { ...VALID_INPUT, timezone: "Mars/Olympus" },
        { rlsTx: makeRlsTx([[]]) },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TIMEZONE" })
  })

  it("accepts identical start/end (means 'all 24 hours')", async () => {
    const stored = [
      {
        user_id: USER,
        digest_cadence: "hourly",
        work_hours_start: "00:00:00",
        work_hours_end: "00:00:00",
        work_days: [1, 2, 3, 4, 5, 6, 7],
        timezone: "UTC",
        last_daily_sent_at: null,
      },
    ]
    const rlsTx = makeRlsTx([stored])
    const result = await mod.updatePreferences(
      USER,
      {
        digestCadence: "hourly",
        workHoursStart: "00:00",
        workHoursEnd: "00:00",
        workDays: [1, 2, 3, 4, 5, 6, 7],
        timezone: "UTC",
      },
      { rlsTx },
    )
    expect(result.workHoursStart).toBe("00:00")
    expect(result.workHoursEnd).toBe("00:00")
    expect(result.workDays).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  // A user who never chose a language has NO language: the org default locale
  // decides (then, on the web, the browser). The column used to default to
  // 'en', which beat a French org's default for every such user.
  it("a row with no language reports no explicit choice and resolves to the org default", async () => {
    const row = {
      user_id: USER,
      digest_cadence: "daily",
      work_hours_start: "09:00:00",
      work_hours_end: "17:00:00",
      work_days: [1, 2, 3, 4, 5],
      timezone: "UTC",
      language: null,
      org_default_locale: "fr-FR",
      last_daily_sent_at: null,
    }
    const result = await mod.getOrCreatePreferences(USER, ORG, {
      rlsTx: makeRlsTx([[row]]),
    })
    expect(result.language).toBeNull()
    expect(result.orgDefaultLocale).toBe("fr")
    expect(result.effectiveLanguage).toBe("fr")
  })

  it("an explicit choice beats the org default", async () => {
    const row = {
      user_id: USER,
      digest_cadence: "daily",
      work_hours_start: "09:00:00",
      work_hours_end: "17:00:00",
      work_days: [1, 2, 3, 4, 5],
      timezone: "UTC",
      language: "en",
      org_default_locale: "fr",
      last_daily_sent_at: null,
    }
    const result = await mod.getOrCreatePreferences(USER, ORG, { rlsTx: makeRlsTx([[row]]) })
    expect(result.language).toBe("en")
    expect(result.effectiveLanguage).toBe("en")
  })

  it("the full preferences save never writes a language it was not given", async () => {
    // Settings > Attention saves without a language. That save used to write
    // 'en', resetting a French user to English.
    const rlsTx = makeRlsTx([
      [
        {
          user_id: USER,
          digest_cadence: "daily",
          work_hours_start: "09:00:00",
          work_hours_end: "17:00:00",
          work_days: [1, 2, 3, 4, 5],
          timezone: "UTC",
          language: "fr",
          last_daily_sent_at: null,
        },
      ],
    ])
    await mod.updatePreferences(USER, VALID_INPUT, { rlsTx })
    const query = (rlsTx.execute as any).mock.calls[0][0]
    const params: unknown[] = []
    const walk = (chunk: any) => {
      if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
        for (const c of chunk.queryChunks) walk(c)
      } else if (
        chunk &&
        typeof chunk === "object" &&
        "value" in chunk &&
        !Array.isArray(chunk.value)
      ) {
        params.push(chunk.value)
      } else if (typeof chunk !== "object") {
        params.push(chunk)
      }
    }
    walk(query)
    expect(params).not.toContain("en")
  })

  it("round-trips a switch to French and clamps an unshipped persisted value to 'en'", async () => {
    const frRow = [
      {
        user_id: USER,
        digest_cadence: "daily",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "UTC",
        language: "fr",
        last_daily_sent_at: null,
      },
    ]
    const fr = await mod.updatePreferences(
      USER,
      { ...VALID_INPUT, language: "fr" },
      { rlsTx: makeRlsTx([frRow]) },
    )
    expect(fr.language).toBe("fr")

    const bogusRow = [{ ...frRow[0], language: "de" }]
    const clamped = await mod.getOrCreatePreferences(USER, ORG, {
      rlsTx: makeRlsTx([bogusRow]),
    })
    expect(clamped.language).toBeNull()
    expect(clamped.effectiveLanguage).toBe("en")
  })

  it("persists valid Mon–Fri 09:00–17:00 schedule", async () => {
    const stored = [
      {
        user_id: USER,
        digest_cadence: "daily",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "Europe/Paris",
        last_daily_sent_at: null,
      },
    ]
    const rlsTx = makeRlsTx([stored])
    const result = await mod.updatePreferences(
      USER,
      { ...VALID_INPUT, timezone: "Europe/Paris" },
      { rlsTx },
    )
    expect(result.workHoursStart).toBe("09:00")
    expect(result.workHoursEnd).toBe("17:00")
    expect(result.workDays).toEqual([1, 2, 3, 4, 5])
    expect(result.timezone).toBe("Europe/Paris")
  })
})

describe("updateTheme", () => {
  it("writes theme and returns mapped row", async () => {
    const seedExisting = [
      {
        user_id: USER,
        digest_cadence: "hourly",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "Europe/Paris",
        language: "en",
        theme: "system",
        last_daily_sent_at: null,
      },
    ]
    const updated = [{ ...seedExisting[0], theme: "light" }]
    // updateTheme calls getOrCreatePreferences (1 select) then UPDATE (1 returning).
    const rlsTx = makeRlsTx([seedExisting, updated])
    const result = await mod.updateTheme(USER, ORG, "light", { rlsTx })
    expect(result.theme).toBe("light")
    expect(result.digestCadence).toBe("hourly")
    expect(result.timezone).toBe("Europe/Paris")
    expect(result.workDays).toEqual([1, 2, 3, 4, 5])
  })

  it("clamps a corrupted persisted theme to 'system' on read", async () => {
    const corrupted = [
      {
        user_id: USER,
        digest_cadence: "daily",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "UTC",
        language: "en",
        theme: "rainbow", // not a valid enum value (defensive read)
        last_daily_sent_at: null,
      },
    ]
    const result = await mod.getOrCreatePreferences(USER, ORG, {
      rlsTx: makeRlsTx([corrupted]),
    })
    expect(result.theme).toBe("system")
  })

  it("defaults to 'system' when row carries no theme (null)", async () => {
    const noTheme = [
      {
        user_id: USER,
        digest_cadence: "daily",
        work_hours_start: "09:00:00",
        work_hours_end: "17:00:00",
        work_days: [1, 2, 3, 4, 5],
        timezone: "UTC",
        language: "en",
        theme: null,
        last_daily_sent_at: null,
      },
    ]
    const result = await mod.getOrCreatePreferences(USER, ORG, {
      rlsTx: makeRlsTx([noTheme]),
    })
    expect(result.theme).toBe("system")
  })
})
