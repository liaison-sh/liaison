// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bundled app ships to every organisation, so the text an agent reads from its manifest
// (agentInstructions, tool descriptions, skill bodies, routine prompts) must not carry one
// organisation's business policy as if it were product behaviour: a refund amount above which a
// second person signs off, a dealer discount percentage above which a rep needs approval, the
// day counts of a reminder cadence. Those numbers live in the org skill `escalation-contacts`
// next to the approvers, and the instructions ask the requesting user when the skill is absent.
//
// The check is deliberately pragmatic: a clause (sentence or semicolon part) that talks about a
// threshold, a tier, an approval, an escalation or overdue reminders AND carries a currency
// amount, a non-zero percentage or a day count is a hit. Genuine product constants and worked
// format examples that happen to match sit in ALLOWED with the reason each one is not policy; an
// allowlist entry that no longer matches anything fails too, so the list cannot rot.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const BUNDLED_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

const POLICY_WORDS =
  /threshold|\btiers?\b|two-eyes|sign-off|approv|authority|escalat|overdue|dunning|reminder|\bbands?\b/i

/** A currency amount, a non-zero percentage, or a day count. */
const POLICY_QUANTITY =
  /(?<![\d.,])(?!0\s?%)\d[\d.,]*\s?(?:%|€|\b(?:EUR|USD|GBP)\b|days?\b)|[€$£]\s?\d|\b(?:EUR|USD|GBP)\s?\d/i

interface Allowed {
  app: string
  /** Substring of the offending clause. */
  text: string
  reason: string
}

const ALLOWED: readonly Allowed[] = [
  {
    app: "boxtal",
    text: "a >10% drift rejects the buy",
    reason: "product guard enforced in code: the label buy re-checks the quoted price at execution",
  },
  {
    app: "boxtal",
    text: "threshold (e.g. >7 days)",
    reason: "an example of the N the user states ('flag any RMA over N days old'), not a default",
  },
  {
    app: "ads",
    text: "cut that ad set's budget by about 20%",
    reason:
      "advertising playbook heuristic with cited industry sources, relative to the org's own target CPA",
  },
  {
    app: "ads",
    text: "**Cut budget by about 20%**",
    reason:
      "advertising playbook heuristic with cited industry sources, relative to the org's own target CPA",
  },
  {
    app: "shopify",
    text: "'over 1000 EUR'",
    reason:
      "an example of a threshold the USER states in a customer search, used to explain currency handling",
  },
  {
    app: "invoicing",
    text: "(a -6,744€ correction gates exactly like a +6,744€ invoice would)",
    reason:
      "illustrates the absolute-value comparison against the issuer profile's configured threshold",
  },
]

/** Every string value in a JSON tree, with its JSON path. */
function strings(node: unknown, path: string, out: Array<{ path: string; text: string }>) {
  if (typeof node === "string") out.push({ path, text: node })
  else if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) strings(v, `${path}[${i}]`, out)
  } else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out)
  return out
}

/** Sentences and semicolon parts; "e.g." and "i.e." do not end a clause. */
function clauses(text: string): string[] {
  return text.split(/(?<=[.;!?])(?<!\be\.g\.)(?<!\bi\.e\.)\s+|\n+/)
}

function policyNumberHits(
  app: string,
  manifest: unknown,
  used: Set<Allowed> = new Set(),
): string[] {
  const hits: string[] = []
  for (const { path, text } of strings(manifest, "$", [])) {
    for (const clause of clauses(text)) {
      if (!POLICY_WORDS.test(clause) || !POLICY_QUANTITY.test(clause)) continue
      const allowed = ALLOWED.find((a) => a.app === app && clause.includes(a.text))
      if (allowed) {
        used.add(allowed)
        continue
      }
      hits.push(`${path}: "${clause.slice(0, 200)}"`)
    }
  }
  return hits
}

function bundledApps(): string[] {
  return readdirSync(BUNDLED_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(join(BUNDLED_DIR, name, "app.manifest.json"))
        return true
      } catch {
        return false
      }
    })
    .sort()
}

function loadManifest(app: string): unknown {
  return JSON.parse(readFileSync(join(BUNDLED_DIR, app, "app.manifest.json"), "utf8"))
}

describe("bundled app agent text carries no organisation policy numbers", () => {
  const apps = bundledApps()

  it("fires on a planted refund threshold, tier percentage and reminder cadence, not on generic text", () => {
    expect(apps).toContain("shopify")
    expect(apps).toContain("invoicing")
    expect(
      policyNumberHits("x", {
        agentInstructions: "A refund above the 200€ two-eyes threshold needs sign-off.",
      }),
    ).toHaveLength(1)
    expect(
      policyNumberHits("x", { d: "tier-3 (40%) is the standard top tier; apply it." }),
    ).toHaveLength(1)
    expect(
      policyNumberHits("x", { d: "+14 band (≈14–29 days) = a FIRMER reminder." }),
    ).toHaveLength(1)
    expect(policyNumberHits("x", { d: "threshold (e.g. >7 days) for returns" })).toHaveLength(1)
    // no number, a zero rate, or a number with no policy wording: not a hit
    expect(
      policyNumberHits("x", {
        a: "Read the refund threshold from the org skill 'escalation-contacts'.",
        b: "Export is zero-rated (0% VAT) and needs approval.",
        c: "Budgets are in minor units (3500 = 35.00 EUR).",
      }),
    ).toEqual([])
  })

  const used = new Set<Allowed>()
  for (const app of apps) {
    it(`${app}: no threshold, tier or cadence number in agent-facing manifest text`, () => {
      expect(policyNumberHits(app, loadManifest(app), used)).toEqual([])
    })
  }

  it("every allowlist entry still matches a clause and states a reason", () => {
    for (const app of apps) policyNumberHits(app, loadManifest(app), used)
    for (const a of ALLOWED) {
      expect(a.reason.length, `${a.app}: ${a.text}`).toBeGreaterThan(20)
      expect(used.has(a), `stale allowlist entry ${a.app}: ${a.text}`).toBe(true)
    }
  })
})
