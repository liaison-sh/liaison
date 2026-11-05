// SPDX-License-Identifier: FSL-1.1-ALv2
// Byte sizes speak the reader's language: French says Ko/Mo/Go with a decimal
// comma, English KB/MB/GB.
import { describe, expect, it } from "vitest"
import { formatBytes } from "~/modules/files/file-icons"

describe("formatBytes", () => {
  it("English units and decimals", () => {
    expect(formatBytes(0, "en")).toBe("0 B")
    expect(formatBytes(1000, "en")).toBe("1000 B")
    expect(formatBytes(397_845, "en")).toBe("389 KB")
    expect(formatBytes(1.5 * 1024 ** 2, "en")).toBe("1.5 MB")
    expect(formatBytes(3 * 1024 ** 3, "en")).toBe("3 GB")
  })

  it("French units (octets) and a decimal comma", () => {
    expect(formatBytes(0, "fr")).toBe("0 o")
    expect(formatBytes(397_845, "fr")).toBe("389 Ko")
    expect(formatBytes(1.5 * 1024 ** 2, "fr")).toBe("1,5 Mo")
    expect(formatBytes(3 * 1024 ** 3, "fr")).toBe("3 Go")
  })

  it("follows the active locale when none is given (English without a provider)", () => {
    expect(formatBytes(397_845)).toBe("389 KB")
  })
})
