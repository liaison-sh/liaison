// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { type ClipLedger, clipStaleToolResults } from "~/modules/agent/runtime/stale-result-clipper"
import { SHORT_WEB_FETCH_HINT } from "./kernel-result-hints"
import { normalizeFetchUrl, REPEAT_FETCH_NOTE, repeatFetchResult } from "./web-fetch-repeat"

type Frame = Pick<RunContext, "clipLedger" | "fetchedPages">
const page = (content: string, url = "https://docs.test/page") => ({
  content,
  url,
  hint: "live hint",
})

describe("a repeat fetch of the same page in one run", () => {
  it("returns a short reference to the earlier result, and pins that result whole", () => {
    const ledger: ClipLedger = new Map()
    const frame: Frame = { clipLedger: ledger }
    const first = page("<page body>".repeat(500))
    expect(repeatFetchResult(frame, { url: "https://docs.test/page" }, first, "call-1")).toBe(first)
    const second = repeatFetchResult(
      frame,
      { url: "HTTPS://DOCS.test/page/#section" },
      page("<page body>".repeat(500)),
      "call-2",
    )
    expect(second).toEqual({
      url: "https://docs.test/page",
      sameAsEarlierFetch: true,
      note: REPEAT_FETCH_NOTE,
      hint: SHORT_WEB_FETCH_HINT,
    })
    expect(JSON.stringify(second).length).toBeLessThan(500)
    // Pinned: the clipper never clips call-1 for the rest of the run.
    expect(ledger.get("call-1")).toBeNull()
    const old = { type: "json", value: { content: "x".repeat(60_000) } }
    const messages = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", output: old }] },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `later-${i}`,
            output: { type: "json", value: { content: "y".repeat(30_000) } },
          },
        ],
      })),
    ]
    const clipped = clipStaleToolResults(messages, ledger)
    expect(clipped.clippedCount).toBeGreaterThan(0)
    expect(
      (clipped.messages[0] as { content: Array<{ output: unknown }> }).content[0]?.output,
    ).toBe(old)
  })

  it("returns the full page when the content changed, the mode differs, or the earlier result was clipped", () => {
    const ledger: ClipLedger = new Map()
    const frame: Frame = { clipLedger: ledger }
    repeatFetchResult(frame, { url: "https://a.test/p" }, page("v1"), "c1")
    const changed = page("v2")
    expect(repeatFetchResult(frame, { url: "https://a.test/p" }, changed, "c2")).toBe(changed)
    const extract = page("v2")
    expect(
      repeatFetchResult(frame, { url: "https://a.test/p", mode: "extract" }, extract, "c3"),
    ).toBe(extract)
    // c2 is now clipped by the run: a repeat returns the page again.
    ledger.set("c2", { type: "json", value: { content: "v" } })
    const again = page("v2")
    expect(repeatFetchResult(frame, { url: "https://a.test/p" }, again, "c4")).toBe(again)
  })

  it("leaves errors and runs without a clip ledger alone", () => {
    const err = { error: "HTTP 404: Not Found" }
    expect(repeatFetchResult({ clipLedger: new Map() }, { url: "https://a.test" }, err, "c")).toBe(
      err,
    )
    const r = page("x")
    expect(repeatFetchResult({}, { url: "https://a.test" }, r, "c")).toBe(r)
    expect(repeatFetchResult(undefined, { url: "https://a.test" }, r, "c")).toBe(r)
  })

  it("normalises the URL it compares", () => {
    expect(normalizeFetchUrl("HTTPS://Example.COM:443/a/b/?q=1#frag")).toBe(
      "https://example.com/a/b?q=1",
    )
    expect(normalizeFetchUrl("https://example.com/")).toBe("https://example.com/")
    expect(normalizeFetchUrl("not a url")).toBe("not a url")
  })
})
