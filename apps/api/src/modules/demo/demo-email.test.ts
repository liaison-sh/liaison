// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One mailbox, one identity: the address rules, as a table.
import { describe, expect, it } from "bun:test"
import {
  demoDomainCapKey,
  isDisposableDomain,
  isRelayDomain,
  maskDemoEmail,
  normalizeDemoEmail,
  registrableDomain,
} from "~/modules/demo/demo-email"

describe("normalizeDemoEmail", () => {
  it.each([
    ["Jane@Example.com", "jane@example.com"],
    ["  jane@example.com ", "jane@example.com"],
    ["jane+demo@example.com", "jane@example.com"],
    ["jane+a+b@company.example", "jane@company.example"],
    ["J.a.n.e@gmail.com", "jane@gmail.com"],
    ["j.ane+x@googlemail.com", "jane@gmail.com"],
    ["jane@protonmail.com", "jane@proton.me"],
    ["jane@protonmail.ch", "jane@proton.me"],
    ["jane+1@pm.me", "jane@proton.me"],
    ["j.ane@outlook.com", "j.ane@outlook.com"],
    ["jane@bücher.example", "jane@xn--bcher-kva.example"],
    ["jane@BÜCHER.example", "jane@xn--bcher-kva.example"],
    // Yahoo disposable addresses are `base-keyword@`: one mailbox.
    ["jane-shop@yahoo.com", "jane@yahoo.com"],
    ["jane-a-b@yahoo.fr", "jane@yahoo.fr"],
    ["jane-x@ymail.com", "jane@ymail.com"],
    ["jane-x@example.com", "jane-x@example.com"],
    // Fastmail subdomain addressing: any local part at user.fastmail.com.
    ["anything@jane.fastmail.com", "jane@fastmail.com"],
    ["other+t@jane.fastmail.fm", "jane@fastmail.fm"],
    ["jane@fastmail.com", "jane@fastmail.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDemoEmail(input)).toBe(expected)
  })
})

describe("registrableDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["a.evil.example.com", "example.com"],
    ["mail.company.co.uk", "company.co.uk"],
    ["a.b.company.co.uk", "company.co.uk"],
    ["company.fr", "company.fr"],
    ["co.uk", "co.uk"],
  ])("%s → %s", (input, expected) => {
    expect(registrableDomain(input)).toBe(expected)
  })
})

describe("lists", () => {
  it("knows disposable inboxes, including their subdomains", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true)
    expect(isDisposableDomain("x.mailinator.com")).toBe(true)
    expect(isDisposableDomain("example.com")).toBe(false)
    expect(isDisposableDomain("gmail.com")).toBe(false)
  })

  it("knows alias relays", () => {
    for (const d of [
      "privaterelay.appleid.com",
      "duck.com",
      "mozmail.com",
      "simplelogin.com",
      "slmail.me",
      "addy.io",
    ]) {
      expect(isRelayDomain(d)).toBe(true)
    }
    expect(isRelayDomain("gmail.com")).toBe(false)
    // iCloud is a mailbox provider; only Hide My Email is a relay.
    expect(isRelayDomain("icloud.com")).toBe(false)
  })
})

describe("demoDomainCapKey", () => {
  it("caps a small domain on its registrable domain, shared by subdomains", () => {
    expect(demoDomainCapKey("a@one.evil.example")).toBe(demoDomainCapKey("b@two.evil.example"))
    expect(demoDomainCapKey("a@x.company.co.uk")).toBe("company.co.uk")
  })

  it("never caps a major provider, always caps a relay on the relay host", () => {
    expect(demoDomainCapKey("jane@gmail.com")).toBeNull()
    expect(demoDomainCapKey("jane@outlook.com")).toBeNull()
    expect(demoDomainCapKey("x@privaterelay.appleid.com")).toBe("privaterelay.appleid.com")
    // iCloud is a major mailbox provider (never capped by domain).
    expect(demoDomainCapKey("x@icloud.com")).toBeNull()
    expect(demoDomainCapKey("x@me.com")).toBeNull()
    expect(demoDomainCapKey("x@duck.com")).toBe("duck.com")
  })
})

describe("maskDemoEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskDemoEmail("jane@example.com")).toBe("j•••@example.com")
  })
})
