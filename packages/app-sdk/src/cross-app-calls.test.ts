// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B7 — install-time resolve-targets pass on
// `cross_app_calls[]`. Verifies the validator catches typo'd targets at
// install time, accepts targets registered against the snapshot, and
// canonicalises `dependencies.tools` from `cross_app_calls` when only the
// latter is declared.

import { describe, expect, test } from "bun:test"
import { validateManifest } from "./package-format"

function fakeToolRegistry(tools: string[]): { has: (n: string) => boolean } {
  const set = new Set(tools)
  return { has: (n) => set.has(n) }
}

const baseManifest = {
  name: "invoicing",
  version: "0.1.0",
  packageFormat: 1 as const,
  license: "FSL-1.1-ALv2",
  scopes: [],
}

describe("K4 — cross_app_calls install-time validation with resolveTargets", () => {
  test("rejects target whose tool the target app does not expose", () => {
    const m = {
      ...baseManifest,
      cross_app_calls: [{ target: "mail:nonexistent", reason: "x" }],
    }
    expect(() =>
      validateManifest(m, { resolveTargets: true }, fakeToolRegistry(["mail:compose"])),
    ).toThrow(/not declared/i)
  })

  test("accepts when target is registered", () => {
    const m = {
      ...baseManifest,
      cross_app_calls: [{ target: "mail:compose", reason: "send PDFs" }],
    }
    expect(() =>
      validateManifest(m, { resolveTargets: true }, fakeToolRegistry(["mail:compose"])),
    ).not.toThrow()
  })

  test("derives dependencies.tools[] from cross_app_calls[] when latter present only", () => {
    const m = {
      ...baseManifest,
      cross_app_calls: [
        { target: "mail:compose", reason: "send PDFs" },
        { target: "shopify:orders.get", reason: "fetch order" },
      ],
    }
    const out = validateManifest(m) as { dependencies?: { tools?: string[] } }
    expect(out.dependencies?.tools?.sort()).toEqual(["mail:compose", "shopify:orders.get"])
  })

  test("resolveTargets without a tool registry argument throws", () => {
    const m = {
      ...baseManifest,
      cross_app_calls: [{ target: "mail:compose", reason: "x" }],
    }
    expect(() => validateManifest(m, { resolveTargets: true })).toThrow(/requires a toolRegistry/i)
  })
})
