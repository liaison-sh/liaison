// SPDX-License-Identifier: FSL-1.1-ALv2
// A huge recipient list is refused on its length, with one issue, not one
// validation issue per bad element (a 1 MB body would otherwise allocate a
// couple of hundred MB of issue objects).
import { describe, expect, it } from "bun:test"
import { sendDraftBody } from "~/modules/mail/routes"

describe("mail send body: recipient arrays are capped", () => {
  it("refuses 200 000 bad recipients with a single length issue", () => {
    const bad = Array.from({ length: 200_000 }, () => 0)
    const started = performance.now()
    const result = sendDraftBody.safeParse({ to: bad, htmlBody: "", textBody: "" })
    const ms = performance.now() - started
    expect(result.success).toBe(false)
    expect(result.error?.issues.length).toBe(1)
    expect(result.error?.issues[0]?.code).toBe("too_big")
    expect(ms).toBeLessThan(50)
  })

  it("accepts a legitimate recipient list", () => {
    const to = Array.from({ length: 50 }, (_, i) => ({ email: `p${i}@example.com` }))
    expect(sendDraftBody.safeParse({ to, htmlBody: "", textBody: "" }).success).toBe(true)
  })
})
