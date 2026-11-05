// SPDX-License-Identifier: FSL-1.1-ALv2
// The org cap refusals (SEAT_LIMIT_REACHED, MAILBOX_LIMIT_REACHED) are shown in
// the reader's language, from their code, never the server's English text.
import { describe, expect, it } from "vitest"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { atLimit } from "~/modules/settings/OrgUsageSection"

const t = (key: string) => `t:${key}`

describe("capLimitMessage", () => {
  it("maps the two cap codes to their i18n keys, anything else to null", () => {
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:kernel.orgUsage.seatLimitReached")
    expect(capLimitMessage(t, "MAILBOX_LIMIT_REACHED")).toBe(
      "t:kernel.orgUsage.mailboxLimitReached",
    )
    expect(capLimitMessage(t, "INVITE_PENDING")).toBeNull()
    expect(capLimitMessage(t, undefined)).toBeNull()
  })
})

describe("atLimit", () => {
  it("never says the limit is reached for an unlimited cap, nor for a cap under 1", () => {
    expect(atLimit({ used: 5, limit: null })).toBe(false)
    expect(atLimit({ used: 0, limit: 0 })).toBe(false)
    expect(atLimit({ used: 3, limit: 3 })).toBe(true)
    expect(atLimit({ used: 2, limit: 3 })).toBe(false)
  })
})
