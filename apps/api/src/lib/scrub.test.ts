// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { scrubText, truncateLine } from "./scrub"

// Table-driven vectors. These SAME vectors are reused verbatim in
// ops/monitor/src/scrub.test.ts (monorepo) and tessera-platform apps/api/src/lib/scrub.test.ts
// -- keep all three in sync.
const vectors: Array<{ name: string; input: string; expected: string }> = [
  {
    name: "plain text unchanged",
    input: "everything is fine, nothing to scrub here",
    expected: "everything is fine, nothing to scrub here",
  },
  {
    name: "error string embedding an email plus an sk_live key plus a 64-char hex",
    input:
      "Error: insert failed for email=alice@example.com apikey=sk_live_abcdefghijklmnopqrstuvwx hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
    expected: "Error: insert failed for email=[email] apikey=[key] hash=[hex]",
  },
  {
    name: "postgres error echoing a connection string with credentials",
    input: "connection failed: postgres://user:secret@host:5432/db",
    expected: "connection failed: postgres://[redacted]@host:5432/db",
  },
  {
    name: "a JWT in a stack line",
    input:
      "at authorize (auth.ts:12) token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnopqrstuvwxyz012345",
    expected: "at authorize (auth.ts:12) token=[token]",
  },
  {
    name: "several matches of different kinds in one string",
    input:
      "user bob@example.com used Bearer abc123token failed against sk_test_zzzzzzzzzzzzzzzzzzzzzzzz",
    expected: "user [email] used [token] failed against [key]",
  },
  {
    name: "empty string",
    input: "",
    expected: "",
  },
]

describe("scrubText", () => {
  for (const v of vectors) {
    test(v.name, () => {
      expect(scrubText(v.input)).toBe(v.expected)
    })
  }
})

describe("truncateLine", () => {
  test("a 70 KB line is truncated to 64 KB", () => {
    const line = "x".repeat(70 * 1024)
    const result = truncateLine(line)
    expect(result.length).toBeLessThanOrEqual(65536)
  })

  test("a short line is left unchanged", () => {
    expect(truncateLine("hello")).toBe("hello")
  })

  test("respects a custom max", () => {
    expect(truncateLine("hello world", 5)).toBe("hello")
  })
})
