// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { threadMapPlainText } from "~/ui/thread-map-model"

describe("threadMapPlainText", () => {
  it("drops tags and raw blocks, keeps line breaks and decodes the common entities", () => {
    for (const [html, want] of [
      [null, ""],
      ["plain", "plain"],
      ["<p>one</p><p>two</p>", "one\ntwo\n"],
      ["a<br>b<BR/>c<br />d", "a\nb\nc\nd"],
      ["<div>Tom &amp; Lina&nbsp;&lt;3&#39;</div>", "Tom & Lina <3'\n"],
      ["<style>p { color: red }</style>hi", "hi"],
      ["<STYLE type=x>a</style>hi", "hi"],
      ["<title>a</title>x<title>b</TITLE>y", "xy"],
      ["<head><title>a</title></head>hi", "hi"],
      ["<style><script></style>x</script>y", "xy"],
      ["<script>a</style>b</script>c", "c"],
      ["<style>never closed", "never closed"],
      ["<style>a<script>b</script>c", "ac"],
      ["<style>open</style><style>open again", "open again"],
      ["<header>x</header>", "x"],
      ["<titles>x</titles>", "x"],
      ["1 < 2 and 3 > 2", "1  2"],
      ["a < b", "a < b"],
      ["<<b>x", "x"],
      ["<b", "<b"],
      ["x>y", "x>y"],
    ] as const) {
      expect(threadMapPlainText(html)).toBe(want)
    }
  })

  it("stays fast on a long body, whatever it holds", () => {
    const size = 1_000_000
    const started = performance.now()
    threadMapPlainText("<".repeat(size))
    threadMapPlainText("<style".repeat(size / 6))
    threadMapPlainText("<style></title>".repeat(size / 15))
    threadMapPlainText("<style<script<head<title".repeat(size / 24))
    expect(performance.now() - started).toBeLessThan(500)
  })
})
