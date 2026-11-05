// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { parseSeedTier, runSeedCli, tierArgs } from "~/cli/seed/run"

describe("liaison seed", () => {
  it("reads the tier in both flag spellings, and nothing else", () => {
    expect(parseSeedTier(["--tier", "demo"])).toBe("demo")
    expect(parseSeedTier(["--slug", "acme", "--tier=demo"])).toBe("demo")
    expect(parseSeedTier(["--tier", "lively"])).toBe("lively")
    expect(parseSeedTier(["--tier", "load"])).toBe("load")
    expect(parseSeedTier(["--tier", "standard"])).toBe("standard")
    expect(parseSeedTier(["--tier", "loud"])).toBeNull()
    expect(parseSeedTier(["--tier"])).toBeNull()
    expect(parseSeedTier([])).toBeNull()
  })

  it("hands the tier its own flags, without --tier", () => {
    expect(tierArgs(["--tier", "demo", "--no-reset", "--slug", "acme"])).toEqual([
      "--no-reset",
      "--slug",
      "acme",
    ])
    expect(tierArgs(["--tier=demo", "--variant", "visitor"])).toEqual(["--variant", "visitor"])
  })

  it("answers a missing or unknown tier with its usage and exit 2, seeding nothing", async () => {
    for (const argv of [[], ["--tier", "nope"]]) {
      const res = await runSeedCli(argv)
      expect(res.exitCode).toBe(2)
      expect(res.message).toStartWith("usage: liaison seed --tier demo|lively|load|standard")
    }
  })
})
