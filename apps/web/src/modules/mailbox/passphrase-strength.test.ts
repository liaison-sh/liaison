// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { checkPassphrase, PASSPHRASE_MIN_LENGTH } from "~/modules/mailbox/passphrase-strength"

describe("mailbox password check", () => {
  it("accepts a long, uncommon passphrase", async () => {
    for (const value of ["correct horse battery staple", "lune-orange-bateau-72", "Xk9!vQ2#mLp8"]) {
      expect(await checkPassphrase(value)).toEqual({ ok: true, reasons: [] })
    }
  })

  it("refuses an empty password", async () => {
    const verdict = await checkPassphrase("")
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toEqual(["Type a mailbox password."])
  })

  it("refuses a password shorter than the floor", async () => {
    expect(PASSPHRASE_MIN_LENGTH).toBe(12)
    for (const value of ["1234", "a", "password", "Xk9!vQ2#mLp"]) {
      const verdict = await checkPassphrase(value)
      expect(verdict.ok, value).toBe(false)
      expect(verdict.reasons[0]).toContain("at least 12 characters")
    }
  })

  it("refuses common and patterned passwords however they are padded", async () => {
    for (const value of [
      "Password-1234!!",
      "PASSWORD123456",
      "qwertyuiopas",
      "aaaaaaaaaaaaaa",
      "abcabcabcabcabc",
      "1212121212121212",
      "azertyuiopqsdf",
      "motdepasse1234",
    ]) {
      const verdict = await checkPassphrase(value)
      expect(verdict.ok, value).toBe(false)
      expect(verdict.reasons[0]).toContain("too easy to guess")
    }
  })

  it("never sends the password, or any hash of it, over the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await checkPassphrase("1234")
    await checkPassphrase("a perfectly fine passphrase")
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
