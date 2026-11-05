// SPDX-License-Identifier: FSL-1.1-ALv2
import { generateAccountKey } from "@liaison/mailbox-crypto/src/client"
import { describe, expect, it, vi } from "vitest"
import { TEST_USER_ID } from "~/modules/mailbox/mailbox-fixtures"
import {
  buildPasskeyWrap,
  evaluatePrfSecret,
  registerPasskeyForPrf,
} from "~/modules/mailbox/passkey-ceremony"

function credentialsMock(input: {
  prfEnabled?: boolean
  prfFirst?: Uint8Array | null
  rawId?: Uint8Array
}) {
  const rawId = input.rawId ?? new Uint8Array([1, 2, 3, 4])
  return {
    create: vi.fn(async () => ({
      rawId: rawId.buffer,
      getClientExtensionResults: () => ({ prf: { enabled: input.prfEnabled ?? false } }),
    })),
    get: vi.fn(async () => ({
      rawId: rawId.buffer,
      getClientExtensionResults: () =>
        input.prfFirst ? { prf: { results: { first: input.prfFirst.buffer } } } : {},
    })),
  }
}

describe("passkey PRF ceremony", () => {
  it("refuses to mint a wrap row when the authenticator did not enable PRF", async () => {
    const credentials = credentialsMock({ prfEnabled: false })
    vi.stubGlobal("navigator", { credentials })
    const result = await registerPasskeyForPrf({ userId: TEST_USER_ID, userName: "a@example.com" })
    expect(result.kind).toBe("no-wrap-row")
    if (result.kind === "no-wrap-row") expect(result.reason).toMatch(/PRF/)
    expect(credentials.get).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("runs the second ceremony to obtain the PRF secret when PRF is enabled", async () => {
    const credentials = credentialsMock({
      prfEnabled: true,
      prfFirst: new Uint8Array(32).fill(7),
    })
    vi.stubGlobal("navigator", { credentials })
    const registration = await registerPasskeyForPrf({
      userId: TEST_USER_ID,
      userName: "a@example.com",
    })
    expect(registration.kind).toBe("eligible")
    if (registration.kind !== "eligible") return
    const secret = await evaluatePrfSecret({
      credentialId: registration.credentialId,
      salt: new Uint8Array(32).fill(9),
    })
    expect(secret).toBeInstanceOf(Uint8Array)
    expect(credentials.get).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it("persists a wrap only after the PRF secret actually unwrapped a test blob", async () => {
    const accountKey = generateAccountKey()
    const secret = new Uint8Array(32).fill(3)
    const wrap = await buildPasskeyWrap({
      accountKey,
      prfSecret: secret,
      userId: TEST_USER_ID,
      credentialId: new Uint8Array([9, 9, 9, 9]),
    })
    expect(wrap.proven).toBe(true)

    await expect(
      buildPasskeyWrap({
        accountKey,
        prfSecret: secret,
        userId: TEST_USER_ID,
        credentialId: new Uint8Array([9, 9, 9, 9]),
        // A secret that differs between wrap and proof is exactly the broken
        // row this check exists to refuse.
        proofSecret: new Uint8Array(32).fill(4),
      }),
    ).rejects.toThrow(/could not be reproduced/)
  })
})
