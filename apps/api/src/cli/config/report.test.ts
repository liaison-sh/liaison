// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Pure unit test for the report builder + formatter (Task 13).
 *
 * Coverage:
 * - JSON shape matches spec §4 (keys present, types correct);
 * - `formatEnv` quoting: a value with a SPACE survives a real `eval "$(…)"`
 *   round-trip (asserted by spawning bash);
 * - echo policy + precedence (correction #15): supplied key → `apiKeys[].key`
 *   absent, `env.LIAISON_API_KEY` absent without echoSupplied, the supplied
 *   plaintext with it; generated key → `key` present once + always in env; the
 *   first emittable entry wins;
 * - no-secret: a report built with a supplied-but-not-echoed key has no secret
 *   substring on the JSON or env output.
 */

import { describe, expect, test } from "bun:test"
import { buildReport, formatEnv, formatJson, type ReportInput } from "~/cli/config/report"

const baseInput: ReportInput = {
  org: { id: "11111111-1111-1111-1111-111111111111", slug: "fabrikam", created: false },
  admin: {
    id: "22222222-2222-2222-2222-222222222222",
    email: "pat@fabrikam.example",
    created: true,
  },
  byok: { anthropic: { set: true, validated: true } },
  email: { from: "Fabrikam Support <support@fabrikam.example>", set: true },
  pending: [
    { kind: "oauth", app: "mail", connection: "gmail", action: "liaison connect mail/gmail" },
  ],
  changed: ["admin.created"],
  unchanged: ["org", "email"],
}

describe("buildReport — JSON shape (spec §4)", () => {
  test("carries the expected top-level keys with the right types", () => {
    const report = buildReport(baseInput, { echoSupplied: false })
    expect(report.ok).toBe(true)
    expect(report.org).toEqual(baseInput.org)
    expect(report.admin).toEqual(baseInput.admin)
    expect(report.byok).toEqual({ anthropic: { set: true, validated: true } })
    expect(report.email).toEqual({ from: "Fabrikam Support <support@fabrikam.example>", set: true })
    expect(Array.isArray(report.pending)).toBe(true)
    expect(report.env.LIAISON_ORG_ID).toBe("11111111-1111-1111-1111-111111111111")
    expect(report.changed).toEqual(["admin.created"])
    expect(report.unchanged).toEqual(["org", "email"])
  })

  test("formatJson round-trips to an equivalent object", () => {
    const report = buildReport(baseInput, { echoSupplied: false })
    const parsed = JSON.parse(formatJson(report))
    expect(parsed.org.slug).toBe("fabrikam")
    expect(parsed.env.LIAISON_ORG_ID).toBe("11111111-1111-1111-1111-111111111111")
  })
})

describe("echo policy + precedence (correction #15)", () => {
  test("generated key: plaintext present once + always in env", () => {
    const report = buildReport(
      {
        ...baseInput,
        apiKeys: [
          {
            label: "hub-sync",
            created: true,
            keyPrefix: "K7QF3A2B",
            key: "GENERATED-PLAINTEXT-XYZ",
          },
        ],
      },
      { echoSupplied: false },
    )
    expect(report.apiKeys?.[0].key).toBe("GENERATED-PLAINTEXT-XYZ")
    expect(report.env.LIAISON_API_KEY).toBe("GENERATED-PLAINTEXT-XYZ")
  })

  test("supplied key: apiKeys[].key absent always; env absent without echoSupplied", () => {
    const report = buildReport(
      {
        ...baseInput,
        apiKeys: [
          {
            label: "hub-sync",
            created: true,
            keyPrefix: "SUPPLIED1",
            suppliedKey: "SUPPLIED-SECRET-ABC",
          },
        ],
      },
      { echoSupplied: false },
    )
    expect(report.apiKeys?.[0].key).toBeUndefined()
    expect(report.env.LIAISON_API_KEY).toBeUndefined()
  })

  test("supplied key with echoSupplied: env carries the supplied value; JSON still omits key", () => {
    const report = buildReport(
      {
        ...baseInput,
        apiKeys: [
          {
            label: "hub-sync",
            created: false,
            keyPrefix: "SUPPLIED1",
            suppliedKey: "SUPPLIED-SECRET-ABC",
          },
        ],
      },
      { echoSupplied: true },
    )
    expect(report.apiKeys?.[0].key).toBeUndefined()
    expect(report.env.LIAISON_API_KEY).toBe("SUPPLIED-SECRET-ABC")
  })

  test("precedence: the FIRST emittable entry wins (supplied-not-echoed skipped, generated next wins)", () => {
    const report = buildReport(
      {
        ...baseInput,
        apiKeys: [
          { label: "supplied", created: false, keyPrefix: "SUP12345", suppliedKey: "SUP-SECRET" },
          { label: "gen", created: true, keyPrefix: "GEN12345", key: "GEN-PLAINTEXT" },
        ],
      },
      { echoSupplied: false },
    )
    // supplied is not emittable (no echo) → the generated one wins.
    expect(report.env.LIAISON_API_KEY).toBe("GEN-PLAINTEXT")
  })

  test("precedence: no emittable entry → LIAISON_API_KEY omitted", () => {
    const report = buildReport(
      {
        ...baseInput,
        apiKeys: [
          { label: "supplied", created: false, keyPrefix: "SUP12345", suppliedKey: "SUP-SECRET" },
        ],
      },
      { echoSupplied: false },
    )
    expect(report.env.LIAISON_API_KEY).toBeUndefined()
  })
})

describe("formatEnv — sourceable, survives eval", () => {
  test("a value with a SPACE survives a real bash eval round-trip", async () => {
    // Use an org id whose value contains a space + shell metachars to prove the
    // quoting survives `eval "$(…)"`. (The org name "Fabrikam Support <…>" shape.)
    const trickyValue = 'Fabrikam Support <support@fabrikam.example> $HOME "quoted" `cmd`'
    const report = buildReport(
      { org: { id: trickyValue, slug: "fabrikam", created: false } },
      { echoSupplied: false },
    )
    const envOutput = formatEnv(report)
    expect(envOutput.startsWith('LIAISON_ORG_ID="')).toBe(true)

    // Spawn bash, eval the env output, echo the captured variable back.
    const proc = Bun.spawn(["bash", "-c", `eval "$(cat)"; printf '%s' "$LIAISON_ORG_ID"`], {
      stdin: new TextEncoder().encode(envOutput),
      stdout: "pipe",
    })
    const captured = await new Response(proc.stdout).text()
    await proc.exited
    expect(captured).toBe(trickyValue)
  })

  test('formatEnv emits ONLY the env map, one KEY="VALUE" per line', () => {
    const report = buildReport(
      {
        org: { id: "org-1", slug: "fabrikam", created: false },
        apiKeys: [{ label: "gen", created: true, keyPrefix: "GEN12345", key: "GEN-PLAINTEXT" }],
      },
      { echoSupplied: false },
    )
    const lines = formatEnv(report).split("\n")
    expect(lines).toContain('LIAISON_ORG_ID="org-1"')
    expect(lines).toContain('LIAISON_API_KEY="GEN-PLAINTEXT"')
    expect(lines.length).toBe(2)
    // No JSON / human text leaks into the env output.
    expect(formatEnv(report).includes("{")).toBe(false)
  })
})

describe("no-secret on output", () => {
  test("a supplied-not-echoed key leaves NO secret substring on JSON or env", () => {
    const secret = "SUPPLIED-SECRET-MUST-NOT-LEAK-123"
    const report = buildReport(
      {
        ...baseInput,
        apiKeys: [
          { label: "hub-sync", created: false, keyPrefix: "SUPPLIED1", suppliedKey: secret },
        ],
      },
      { echoSupplied: false },
    )
    expect(formatJson(report).includes(secret)).toBe(false)
    expect(formatEnv(report).includes(secret)).toBe(false)
  })
})
