// SPDX-License-Identifier: FSL-1.1-ALv2
// The QA seed seals the sendable mailbox's credentials itself; the API opens
// them bound to their column (AES-GCM AAD). Sealed without that binding, the
// QA mailbox could not send at all.
import { describe, expect, it } from "bun:test"

describe("seed-qa: QA mailbox credentials", () => {
  it("are sealed with the AAD the API decrypts connected-account credentials with", async () => {
    const crypto = await Bun.file(new URL("../apps/api/src/lib/crypto.ts", import.meta.url)).text()
    const context = /connectedAccountCredentials:\s*"([^"]+)"/.exec(crypto)?.[1]
    expect(context).toBeDefined()
    const seed = await Bun.file(new URL("./seed-qa.ts", import.meta.url)).text()
    expect(seed).toContain(`const CONNECTED_ACCOUNT_CREDENTIALS = "${context}"`)
    expect(seed).toContain("cipher.setAAD(Buffer.from(CONNECTED_ACCOUNT_CREDENTIALS")
  })
})
