// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The account type picks the connect path: a personal Gmail address is known
// without a lookup, a company domain is read from its MX records, and a lookup
// that fails says `unknown` (the agent then asks), never a guess.
import { describe, expect, test } from "bun:test"
import { detectMailAccountType, type MxResolver } from "./account-type"

const mx =
  (...hosts: string[]): MxResolver =>
  async () =>
    hosts.map((exchange) => ({ exchange }))

const never: MxResolver = () => {
  throw new Error("no lookup expected")
}

describe("detectMailAccountType", () => {
  test("gmail.com and googlemail.com are personal Google accounts, without DNS", async () => {
    for (const email of ["ana@gmail.com", "Ana@GoogleMail.com"]) {
      const r = await detectMailAccountType(email, { resolver: never })
      expect(r.accountType).toBe("google_consumer")
      expect(r.imapProvider).toBe("gmail")
    }
  })

  test("Microsoft, iCloud and Fastmail consumer domains, without DNS", async () => {
    expect((await detectMailAccountType("a@outlook.com", { resolver: never })).accountType).toBe(
      "microsoft",
    )
    const icloud = await detectMailAccountType("a@me.com", { resolver: never })
    expect(icloud).toMatchObject({ accountType: "other", imapProvider: "icloud" })
    const fm = await detectMailAccountType("a@fastmail.com", { resolver: never })
    expect(fm).toMatchObject({ accountType: "other", imapProvider: "fastmail" })
    const yahoo = await detectMailAccountType("a@yahoo.fr", { resolver: never })
    expect(yahoo.accountType).toBe("other")
    expect(yahoo.imapProvider).toBeUndefined()
  })

  test("a company domain on Google's mail servers is Google Workspace", async () => {
    const r = await detectMailAccountType("ana@acme.example", {
      resolver: mx("ASPMX.L.GOOGLE.COM.", "alt1.aspmx.l.google.com"),
    })
    expect(r).toEqual({
      accountType: "google_workspace",
      imapProvider: "gmail",
      domain: "acme.example",
    })
    const legacy = await detectMailAccountType("a@acme.example", {
      resolver: mx("aspmx2.googlemail.com"),
    })
    expect(legacy.accountType).toBe("google_workspace")
  })

  test("Microsoft 365, iCloud custom domains, Fastmail and others by MX", async () => {
    expect(
      (
        await detectMailAccountType("a@contoso.example", {
          resolver: mx("contoso-example.mail.protection.outlook.com"),
        })
      ).accountType,
    ).toBe("microsoft")
    expect(
      await detectMailAccountType("a@c.example", { resolver: mx("mx01.mail.icloud.com") }),
    ).toMatchObject({ accountType: "other", imapProvider: "icloud" })
    expect(
      await detectMailAccountType("a@c.example", { resolver: mx("in1-smtp.messagingengine.com") }),
    ).toMatchObject({ accountType: "other", imapProvider: "fastmail" })
    const other = await detectMailAccountType("a@c.example", { resolver: mx("mx.ovh.net") })
    expect(other.accountType).toBe("other")
    expect(other.imapProvider).toBeUndefined()
  })

  test("a lookalike host is not Google", async () => {
    const r = await detectMailAccountType("a@c.example", { resolver: mx("mx.notgoogle.com") })
    expect(r.accountType).toBe("other")
  })

  test("a failed, empty or slow lookup is unknown", async () => {
    const failing: MxResolver = async () => {
      throw new Error("ENOTFOUND")
    }
    expect((await detectMailAccountType("a@c.example", { resolver: failing })).accountType).toBe(
      "unknown",
    )
    expect((await detectMailAccountType("a@c.example", { resolver: mx() })).accountType).toBe(
      "unknown",
    )
    const slow: MxResolver = () => new Promise(() => {})
    const r = await detectMailAccountType("a@c.example", { resolver: slow, timeoutMs: 20 })
    expect(r.accountType).toBe("unknown")
  })

  test("not an address: unknown, no lookup", async () => {
    for (const email of ["", "ana", "@acme.example", "ana@localhost"]) {
      expect((await detectMailAccountType(email, { resolver: never })).accountType).toBe("unknown")
    }
  })
})
