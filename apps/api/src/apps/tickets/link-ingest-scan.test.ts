// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { extractWhitelistedTransferLinks } from "~/apps/tickets/link-ingest-scan"

const WHITELIST = ["wetransfer.com", "we.tl", "swisstransfer.com"]

describe("extractWhitelistedTransferLinks", () => {
  it("returns exactly the whitelisted links, deduped + hashed", () => {
    const body = [
      "Here are the files: https://wetransfer.com/downloads/abc123",
      "and a backup https://www.swisstransfer.com/d/uuid-1.",
      "ignore this https://dropbox.com/s/xyz and a random link http://example.com",
      "duplicate https://wetransfer.com/downloads/abc123 again",
    ].join("\n")
    const out = extractWhitelistedTransferLinks(body, WHITELIST)
    const urls = out.map((l) => l.url).sort()
    expect(urls).toEqual(
      ["https://wetransfer.com/downloads/abc123", "https://www.swisstransfer.com/d/uuid-1"].sort(),
    )
    // each has a stable non-empty hash
    for (const l of out) expect(l.urlHash.length).toBeGreaterThan(0)
  })

  it("returns [] for an empty / no-link body", () => {
    expect(extractWhitelistedTransferLinks("", WHITELIST)).toEqual([])
    expect(extractWhitelistedTransferLinks("just some text, no urls", WHITELIST)).toEqual([])
  })
})
