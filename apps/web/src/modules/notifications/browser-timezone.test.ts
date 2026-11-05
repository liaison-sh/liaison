// SPDX-License-Identifier: FSL-1.1-ALv2
// Rule 8: the client reports its browser's zone once per session, as
// `detectedTimezone`, which the server saves only while none is known.
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  browserTimezone,
  reportBrowserTimezone,
  resetBrowserTimezoneReport,
} from "~/modules/notifications/browser-timezone"

afterEach(() => {
  resetBrowserTimezoneReport()
  vi.restoreAllMocks()
})

describe("reportBrowserTimezone", () => {
  it("sends the browser's IANA zone as detectedTimezone, once per session", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Europe/Paris",
    } as Intl.ResolvedDateTimeFormatOptions)
    const patch = vi.fn(async () => ({}))
    await reportBrowserTimezone({ patch })
    await reportBrowserTimezone({ patch })
    expect(browserTimezone()).toBe("Europe/Paris")
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith("/notifications/settings", {
      detectedTimezone: "Europe/Paris",
    })
  })

  it("a failed report is retried on the next call", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "America/New_York",
    } as Intl.ResolvedDateTimeFormatOptions)
    const patch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({})
    await reportBrowserTimezone({ patch })
    await reportBrowserTimezone({ patch })
    expect(patch).toHaveBeenCalledTimes(2)
  })
})
