// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture delivery: in a demo org a send whose every recipient is on a reserved
// domain is recorded as delivered; one real address anywhere refuses the whole
// send; a regular org never takes this path.
import { describe, expect, it } from "bun:test"
import { DemoOrgTestAccess } from "~/modules/demo/demo-org"
import { isDemoFixtureDelivery, isReservedAddress } from "~/modules/demo/fixture-delivery"

describe("isReservedAddress", () => {
  it.each([
    ["lena.hart@kestrel-fans.example", true],
    ["visitor-abc@visitor.demo.invalid", true],
    ["qa@host.test", true],
    ["someone@example.com", true],
    ["someone@sub.example.org", true],
    ["Someone@EXAMPLE.NET", true],
    ["someone@gmail.com", false],
    ["someone@example.com.evil.io", false],
    ["someone@notexample.com", false],
    ["no-at-sign", false],
    ["someone@", false],
  ])("%s → %p", (address, reserved) => {
    expect(isReservedAddress(address)).toBe(reserved)
  })
})

describe("isDemoFixtureDelivery", () => {
  const demo = crypto.randomUUID()
  const plain = crypto.randomUUID()
  DemoOrgTestAccess.prime(demo, {
    variant: "visitor",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  DemoOrgTestAccess.prime(plain, null)

  it("a demo org, every recipient reserved: delivered as a fixture", async () => {
    expect(
      await isDemoFixtureDelivery(demo, [
        "lena.hart@kestrel-fans.example",
        { email: "ops@resonantaudiolabs.example" },
      ]),
    ).toBe(true)
  })

  it("one real address in to, cc, bcc or reply-to refuses the whole send", async () => {
    for (const real of ["a@gmail.com", { email: "b@outlook.com" }]) {
      expect(await isDemoFixtureDelivery(demo, ["lena.hart@kestrel-fans.example", real])).toBe(
        false,
      )
    }
  })

  it("no recipient, or a regular org: never", async () => {
    expect(await isDemoFixtureDelivery(demo, [])).toBe(false)
    expect(await isDemoFixtureDelivery(demo, [null, undefined])).toBe(false)
    expect(await isDemoFixtureDelivery(plain, ["lena.hart@kestrel-fans.example"])).toBe(false)
  })
})
