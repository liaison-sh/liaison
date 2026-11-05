// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MAX_EMAIL_BODY_BYTES } from "~/lib/email/email-body"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createPlatformMethods } from "./platform"

const codec = createPlatformMethods({} as BridgeContext).codec_markdownToEmail as (
  markdown: string,
) => Promise<string>

describe("codec_markdownToEmail", () => {
  it("converts a body into email HTML and text", async () => {
    const body = JSON.parse(await codec("Merci **beaucoup**"))
    expect(body.html).toContain("<strong>beaucoup</strong>")
    expect(body.text).toBe("Merci beaucoup")
  })

  // The conversion runs on the host's main thread: a body no mail could
  // carry is refused before it is parsed.
  it("refuses a body over the mail size budget", async () => {
    await expect(codec("a".repeat(MAX_EMAIL_BODY_BYTES + 1))).rejects.toThrow(/email body over/)
    // Counted in bytes: two-byte characters reach the limit at half the length.
    await expect(codec("é".repeat(MAX_EMAIL_BODY_BYTES / 2 + 1))).rejects.toThrow()
    expect(await codec("a".repeat(MAX_EMAIL_BODY_BYTES))).toContain('"html"')
  })
})
