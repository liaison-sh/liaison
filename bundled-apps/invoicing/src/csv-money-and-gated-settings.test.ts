// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure-function regressions: CSV cells, currency exponents, manifest gating.

import { describe, expect, test } from "bun:test"
import manifest from "../app.manifest.json"
import { csvCell } from "./csv"
import { currencyExponent, formatMoneyMinor, majorDecimalToMinor } from "./money"
import { type DashboardColumn, toCsv } from "./ui/dashboards/columns"

type Tool = {
  gated?: boolean
  params?: { additionalProperties?: unknown; properties?: Record<string, unknown> }
}
const tools = (manifest as unknown as { tools: Record<string, Tool> }).tools

describe("gated configuration tools", () => {
  for (const t of [
    "settings_issuer_profile_create",
    "settings_issuer_profile_update",
    "settings_issuer_profile_delete",
    "documents_update",
  ]) {
    test(`${t} is gated`, () => expect(tools[t]?.gated).toBe(true))
  }
  test("issuer profile write params are an explicit allowlist", () => {
    for (const t of ["settings_issuer_profile_create", "settings_issuer_profile_update"]) {
      expect(tools[t]!.params!.additionalProperties).toBe(false)
      expect(Object.keys(tools[t]!.params!.properties!)).toContain("iban")
    }
  })
})

describe("issuer profile bank and control fields", () => {
  const m = manifest as unknown as {
    scopes: string[]
    roles?: Record<string, { scopes: string[] }>
    tools: Record<string, Tool & { preflight?: string }>
  }
  test("their scope is declared, so a role (C-level, finance) can be granted it", () => {
    expect(m.scopes).toContain("invoicing:issuer:admin")
  })
  test("no manifest role carries it, so the auto-maintained Full Member tier never does", () => {
    // Full Member is extended at registration with the app's member (or lowest non-admin) role.
    for (const role of Object.values(m.roles ?? {})) {
      expect(
        role.scopes.some((s) => s === "invoicing:issuer:admin" || s === "invoicing:issuer"),
      ).toBe(false)
    }
  })
  test("each issuer profile write tool checks it at stage time", () => {
    for (const t of [
      "settings_issuer_profile_create",
      "settings_issuer_profile_update",
      "settings_issuer_profile_delete",
    ]) {
      expect(m.tools[t]?.preflight).toBeTruthy()
    }
  })
})

describe("csv formula injection", () => {
  test.each(["=1+1", "+1", "-1+1", "@SUM(A1)", "\tx", "\rx"])("prefixes %j", (v) => {
    expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true)
  })
  test("plain negative numbers, text and quoting are untouched", () => {
    expect(csvCell("-5000")).toBe("-5000")
    expect(csvCell("hello")).toBe("hello")
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
    expect(csvCell("a\rb")).toBe('"a\rb"')
  })
  test("the dashboard download goes through the same escaper", () => {
    const cols: DashboardColumn<{ n: string }>[] = [
      { key: "n", label: "N", get: (r) => r.n, kind: "text", align: "right" },
    ]
    expect(toCsv(cols, [{ n: "=HYPERLINK(1)" }])).toContain("'=HYPERLINK(1)")
  })
})

describe("currency exponents", () => {
  test("ISO 4217 exponents", () => {
    expect(currencyExponent("KWD")).toBe(3)
    expect(currencyExponent("JPY")).toBe(0)
    expect(currencyExponent("CLF")).toBe(4)
    expect(currencyExponent("EUR")).toBe(2)
  })
  test("KWD keeps its third decimal and rounding is half-even", () => {
    expect(majorDecimalToMinor("1.234", "KWD")).toBe(1234n)
    expect(formatMoneyMinor(1234n, "KWD")).toBe("1.234 KWD")
    expect(majorDecimalToMinor("0.125", "EUR")).toBe(12n)
    expect(majorDecimalToMinor("0.135", "EUR")).toBe(14n)
    expect(majorDecimalToMinor("0.1251", "EUR")).toBe(13n)
    expect(majorDecimalToMinor("-12.50", "EUR")).toBe(-1250n)
  })
})
