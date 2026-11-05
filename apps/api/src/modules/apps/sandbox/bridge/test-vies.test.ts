// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { maybeTestViesResponse, testViesStubEnabled } from "~/modules/apps/sandbox/bridge/test-vies"

const VIES = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms"

async function answer(url: string): Promise<Record<string, unknown> | null> {
  const res = maybeTestViesResponse(url, true)
  return res ? ((await res.json()) as Record<string, unknown>) : null
}

describe("test VIES stand-in", () => {
  it("is on only under NODE_ENV test with LIAISON_TEST_VIES_STUB=1", () => {
    expect(testViesStubEnabled("test", "1")).toBe(true)
    expect(testViesStubEnabled("production", "1")).toBe(false)
    expect(testViesStubEnabled("development", "1")).toBe(false)
    expect(testViesStubEnabled("test", undefined)).toBe(false)
    expect(maybeTestViesResponse(`${VIES}/DE/vat/298765432`, false)).toBeNull()
  })

  it("answers a registered number valid, with its name", async () => {
    expect(await answer(`${VIES}/DE/vat/298765432`)).toMatchObject({
      isValid: true,
      name: "Klangwerk GmbH",
    })
  })

  it("answers any other number invalid, and the outage number unavailable", async () => {
    expect(await answer(`${VIES}/DE/vat/123456789`)).toMatchObject({
      isValid: false,
      userError: "INVALID",
    })
    expect(await answer(`${VIES}/FR/vat/000000001`)).toMatchObject({
      isValid: false,
      userError: "MS_UNAVAILABLE",
    })
  })

  it("leaves every other request alone", () => {
    expect(maybeTestViesResponse("https://ec.europa.eu/other/path", true)).toBeNull()
    expect(
      maybeTestViesResponse("https://example.com/taxation_customs/vies/rest-api/ms/DE/vat/1", true),
    ).toBeNull()
  })
})
