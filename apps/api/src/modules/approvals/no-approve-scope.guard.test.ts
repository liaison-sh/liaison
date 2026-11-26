// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approvals are for agents. A person is decided by the tool's own scope: whoever holds the scope
// a tool requires may do it, and nothing asks a person for an `<app>:approve` scope on top. A
// source scan: no code checks an approve scope, and the money code (invoices, advances,
// milestones, retainers, corrections, the reconcile card) names none at all.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")

/** Where product code lives. */
const SOURCE_ROOTS = ["apps", "bundled-apps", "packages"]

/** The code that bills: the invoicing app and the projects app. */
const MONEY_ROOTS = ["bundled-apps/invoicing/src", "apps/api/src/apps/projects"]

/**
 * The one place that reads an approve scope, and why it is not a person's check: the invoicing
 * screen asks whether the viewer may decide the approvals agents raise, to offer the Approve
 * button. Nothing a person does is refused by it.
 */
const ALLOWED = new Set(["bundled-apps/invoicing/src/reads.ts"])

/** A card naming its deciding scope: `approve_scope: "..."` or `approve_scope: x` (not a type). */
const NAMES_APPROVE_SCOPE = /\bapprove_scope:\s*[^\s]/

/**
 * Money cards that issue nothing and name their deciders, by their reviewed design: the daily
 * e-invoice send card (decided by whoever may send the documents) and the renewal of a stream's
 * standing e-invoice authorization (decided by the e-invoicing settings' deciders).
 */
const OWN_SCOPE_CARDS = new Set([
  "bundled-apps/invoicing/src/einvoicing/send-batch.ts",
  "bundled-apps/invoicing/src/einvoicing/standing.ts",
])

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "e2e", "tests"])

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.includes("/__tests__/") || path.includes("/tests/")
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.tsx?$/.test(name) && !isTest(path)) out.push(path)
  }
  return out
}

/** A scope-check call whose argument is a literal approve scope: `hasScope("mail:approve")`. */
const APPROVE_CHECK =
  /\b(?:hasScope|hasAnyScope|requireScope|scopeMatches|holds|includes|has)\(\s*["'`][a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*:approve["'`]/

/** Any literal approve scope: `"invoicing:approve"`. */
const APPROVE_SCOPE = /["'`][a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*:approve["'`]/

describe("no code asks a person for an approve scope", () => {
  it("no new code checks an approve scope", () => {
    const found = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(REPO, root)))
      .filter((path) => APPROVE_CHECK.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path))
      .filter((path) => !ALLOWED.has(path))
    expect(found).toEqual([])
  })

  it("the money code names no approve scope", () => {
    const found = MONEY_ROOTS.flatMap((root) => sourceFiles(join(REPO, root)))
      .filter((path) => APPROVE_SCOPE.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path))
      .filter((path) => !ALLOWED.has(path))
    expect(found).toEqual([])
  })

  it("the money code's cards are decided by their tool's own deciders: none names approve_scope", () => {
    // A card of an issuing tool decided by the tool's own required scope (documents:write) let a
    // person who may edit drafts, and nothing more, approve an invoice a job or an agent staged.
    // Omitting `approve_scope` keeps the tool's deciding scope. The exceptions are cards that
    // issue nothing, each decided as its reviewed design says.
    const found = MONEY_ROOTS.flatMap((root) => sourceFiles(join(REPO, root)))
      .filter((path) => NAMES_APPROVE_SCOPE.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path))
      .filter((path) => !OWN_SCOPE_CARDS.has(path))
    expect(found).toEqual([])
    expect(NAMES_APPROVE_SCOPE.test(`approve_scope: "invoicing:documents:write",`)).toBe(true)
    expect(NAMES_APPROVE_SCOPE.test(`approve_scope?: string`)).toBe(false)
  })

  it("the scan reads the money code and would see a check", () => {
    expect(sourceFiles(join(REPO, MONEY_ROOTS[0])).length).toBeGreaterThan(20)
    expect(sourceFiles(join(REPO, MONEY_ROOTS[1])).length).toBeGreaterThan(20)
    expect(APPROVE_CHECK.test(`await ctx.hasScope("invoicing:approve")`)).toBe(true)
    expect(APPROVE_SCOPE.test(`const s = "projects:approve"`)).toBe(true)
    expect(APPROVE_CHECK.test(`approve_scope: "invoicing:documents:write"`)).toBe(false)
  })
})
