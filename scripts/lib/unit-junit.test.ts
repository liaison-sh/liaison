// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { decodeXml, formatFailures, parseJunitSuites } from "./unit-junit"

// Shape of bun 1.4's junit report for a batch of two files.
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="1" failures="2" skipped="0" time="0.02">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="1" failures="2" skipped="0" time="0" hostname="h">
    <testsuite name="grp" file="a.test.ts" line="2" tests="2" assertions="1" failures="1" skipped="0" time="0" hostname="h">
      <testcase name="boom" classname="grp" time="0.25" file="a.test.ts" line="2" assertions="1">
        <failure type="AssertionError" message="expect(received).toBe(expected)">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;      at a.test.ts:2:56&#10;</failure>
      </testcase>
      <testcase name="ok" classname="grp" time="0.5" file="a.test.ts" line="2" assertions="0" />
    </testsuite>
    <testcase name="throws" classname="" time="0.25" file="a.test.ts" line="3" assertions="0">
      <failure type="Error" message="kaput &lt;x&gt; &amp; &quot;q&quot;"></failure>
    </testcase>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" assertions="0" failures="0" skipped="0" time="0" hostname="h">
    <testcase name="fine" classname="" time="1" file="b.test.ts" line="2" assertions="0" />
  </testsuite>
</testsuites>`

describe("parseJunitSuites", () => {
  test("keeps each failing test's name and failure body, per file", () => {
    const suites = parseJunitSuites(REPORT)
    const a = suites.get("a.test.ts")
    expect(a?.failed).toBe(true)
    expect(a?.seconds).toBe(1)
    expect(a?.failures.map((f) => f.name)).toEqual(["grp > boom", "throws"])
    expect(a?.failures[0]?.message).toContain("Expected: 2\nReceived: 1")
    // An empty failure body falls back to the message attribute.
    expect(a?.failures[1]?.message).toBe('kaput <x> & "q"')
    expect(suites.get("b.test.ts")).toEqual({ failed: false, seconds: 1, failures: [] })
  })

  test("a file the report never reached is absent", () => {
    expect(parseJunitSuites(REPORT).has("c.test.ts")).toBe(false)
  })
})

test("decodeXml handles named and numeric entities", () => {
  expect(decodeXml("&lt;a&gt; &amp;&#10;&#x41;")).toBe("<a> &\nA")
})

test("formatFailures caps each message", () => {
  const out = formatFailures([{ name: "t", message: "1\n2\n3" }], 2)
  expect(out).toBe("    (fail) t\n      1\n      2\n      … (1 more lines)")
})
