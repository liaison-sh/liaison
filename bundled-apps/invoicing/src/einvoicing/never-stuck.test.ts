// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Never stuck" for the person who issues B2B invoices: every refusal the e-invoicing gate can
// return, and every blocker the readiness list can report, names a tool that fixes it, and that
// tool is one this person can actually use. Checked against the shipped manifest: the tool
// exists, the agent can see it, its scopes are within the issuer's role, and every table it reads
// or writes is reachable by that role under row-level security. A gated fix tool additionally
// needs the role to be able to approve it.
import { describe, expect, it } from "bun:test"
import {
  rlsScopeEntityForTable,
  scopeEntityReachableByGrant,
} from "../../../../apps/api/src/modules/permissions/rls-generator"
import manifest from "../../app.manifest.json"
import { GATE_BLOCKER_TOOLS, GATE_CODES, importedOriginalMissing } from "./gate"
import { READINESS_TAXONOMY } from "./readiness"

/** The issuer's role: what the person who issues B2B invoices holds (never admin). */
const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
] as const

/** The kernel's built-in invoicing alias adds read access to the app's internal tables (parks)
 *  for any invoicing holder (runtime-helpers.ts): reads only. */
const READ_ALIAS = "invoicing:internal:read"

/** Tables each fix tool touches, from its handler: `write` must be reachable for writing,
 *  `read` for reading. Kept explicit so a new fix tool must be added here (asserted below). */
const FIX_TOOL_TABLES: Record<string, { write: string[]; read: string[] }> = {
  counterparty_identity_set: { write: ["counterparty_identities", "documents"], read: ["documents", "deferred_events"] },
  counterparty_identity_lookup: { write: [], read: ["counterparty_identities", "documents", "deferred_events"] },
  counterparty_territory_set: { write: ["counterparty_identities"], read: [] },
  drafts_update: { write: ["documents", "document_lines"], read: ["issuer_profiles", "tax_regimes"] },
  documents_update: { write: ["documents"], read: ["documents"] },
  einvoicing_backfill_legacy_originals: { write: ["legal_originals", "documents"], read: ["documents"] },
}

type ToolDef = {
  requiredScopes?: string[]
  agentVisible?: boolean
  gated?: boolean
  conditionalGate?: boolean
  writesToTable?: string
  readOnly?: boolean
}
const m = manifest as unknown as {
  name: string
  tools: Record<string, ToolDef>
  schema: Record<string, { rlsScope?: unknown }>
}

function reachable(table: string, scopes: readonly string[]): boolean {
  const entity = rlsScopeEntityForTable(table, m.schema[table])
  return scopes.some((g) => scopeEntityReachableByGrant(m.name, entity, g))
}

/** Every (code, fix tool) pair a refusal or a readiness item can carry. */
const PAIRS: Array<{ code: string; tool: string; from: string }> = [
  ...GATE_BLOCKER_TOOLS.map((g) => ({ code: g.code, tool: g.fix_tool, from: `gate:${g.key}` })),
  ...importedOriginalMissing().missing.map((i) => ({ code: "imported_original_missing", tool: i.fix_tool, from: "gate:imported_original" })),
  ...READINESS_TAXONOMY.map((t) => ({ code: t.blocker_code, tool: t.tool, from: `readiness:${t.key}` })),
]

describe("e-invoicing never stuck (S22)", () => {
  it("every gate code has at least one blocker with a fix tool, and readiness lists every code", () => {
    // red: a gate code with no blocker entry -> a refusal the readiness list cannot show.
    const codes = new Set(PAIRS.map((p) => p.code))
    for (const c of GATE_CODES) expect({ code: c, covered: codes.has(c) }).toEqual({ code: c, covered: true })
    const readinessCodes = new Set(READINESS_TAXONOMY.map((t) => t.blocker_code))
    for (const c of GATE_CODES) expect({ code: c, inReadiness: readinessCodes.has(c) }).toEqual({ code: c, inReadiness: true })
  })

  for (const p of PAIRS) {
    it(`${p.from} (${p.code}) -> ${p.tool} exists, is agent-visible and usable by the issuer's role`, () => {
      const t = m.tools[p.tool]
      expect(t).toBeDefined()
      expect(t!.agentVisible).not.toBe(false)
      const required = t!.requiredScopes ?? []
      expect(required.length).toBeGreaterThan(0)
      for (const s of required) expect({ tool: p.tool, scope: s, held: (CEO_ROLE_SCOPES as readonly string[]).includes(s) }).toEqual({ tool: p.tool, scope: s, held: true })
      if (t!.gated || t!.conditionalGate) expect(CEO_ROLE_SCOPES).toContain("invoicing:approve")

      const tables = FIX_TOOL_TABLES[p.tool]
      expect({ tool: p.tool, tablesKnown: !!tables }).toEqual({ tool: p.tool, tablesKnown: true })
      if (t!.writesToTable) expect(tables!.write).toContain(t!.writesToTable.replace(/^app_invoicing\./, ""))
      for (const table of tables!.write) {
        expect(m.schema[table]).toBeDefined()
        expect({ tool: p.tool, write: table, reachable: reachable(table, CEO_ROLE_SCOPES) }).toEqual({ tool: p.tool, write: table, reachable: true })
      }
      for (const table of tables!.read) {
        expect(m.schema[table]).toBeDefined()
        expect({ tool: p.tool, read: table, reachable: reachable(table, [...CEO_ROLE_SCOPES, READ_ALIAS]) }).toEqual({
          tool: p.tool,
          read: table,
          reachable: true,
        })
      }
    })
  }

  it("the readiness tool and the classify tool are readable by the issuer's role", () => {
    for (const name of ["einvoicing_readiness", "einvoicing_classify", "counterparty_identity_get"]) {
      const t = m.tools[name]!
      expect(t.agentVisible).not.toBe(false)
      for (const s of t.requiredScopes ?? []) expect(CEO_ROLE_SCOPES as readonly string[]).toContain(s)
    }
    // Readiness reads the parks (internal) only through the kernel's read alias.
    expect(reachable("deferred_events", CEO_ROLE_SCOPES)).toBe(false)
    expect(reachable("deferred_events", [...CEO_ROLE_SCOPES, READ_ALIAS])).toBe(true)
  })

  it("a refusal's message names every fix tool it lists (the agent reads the message)", () => {
    const r = importedOriginalMissing()
    for (const item of r.missing) expect(r.message).toContain(item.fix_tool)
  })
})
