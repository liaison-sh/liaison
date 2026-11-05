// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The needed-template rule tools, driven through the real chat seam
// (buildToolSet's execute closure, then executeToolCore) with the real
// handlers: `document_rules_list` reads, `document_rules_upsert` and
// `document_rules_delete` park a card that spells out the conditions and the
// templates until a person approves (an auto-approve policy naming the tool
// runs them), a `when` with an unknown key is refused before anything parks,
// and a plain request finds the tools through tool search.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { autoApprovePolicies, documentTemplates } from "~/db/schema/kernel"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { decideApproval } from "~/modules/approvals/decide"
import {
  agentInstructionsRegistry,
  approvalSummarizerRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ORG = ""
let ADMIN = ""
let DM = ""
let TSCA = ""
let STEEL = ""
let actor: UserContext
const TYPE = "shipping:shipment"

function turnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function agentCall(
  sdkName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const frame = turnFrame()
  const tools = buildToolSet(ORG, actor, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

async function template(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(ORG, "test:document-template", (tx) =>
    tx.insert(documentTemplates).values({
      id,
      orgId: ORG,
      name,
      kind: "rich_text",
      recordType: TYPE,
      body: { blocks: [] },
    }),
  )
  return id
}

async function ruleRows(): Promise<Array<{ id: string; name: string; when: unknown }>> {
  return sql`SELECT id::text, name, "when" FROM kernel.document_template_rules
              WHERE org_id = ${ORG} ORDER BY created_at`
}

async function pending(
  tool: string,
): Promise<{ id: string; summary: { title: string; lines: string[] } }[]> {
  return sql`
    SELECT id::text, summary FROM kernel.approval_requests
     WHERE org_id = ${ORG} AND tool_name = ${`kernel:${tool}`} AND status = 'pending'
     ORDER BY created_at DESC`
}

async function approve(id: string): Promise<void> {
  await decideApproval({
    orgId: ORG,
    requestId: id,
    actor: { ...actor, scopes: ["*", "kernel:approve"] },
    decision: "approve",
  })
}

const plateRule = () => ({
  recordType: TYPE,
  name: "Plate to the US",
  when: { sku: ["ACC-PLATE-01"], countryIso2: ["us"] },
  templateIds: [STEEL, TSCA],
  note: "US import paperwork",
})

describe("needed-template rule tools", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    ADMIN = (await minimal.orgAdmin(ORG)).id
    actor = { actorType: "user", userId: ADMIN, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
    DM = await minimal.thread(ORG, ADMIN, { title: "Document rules" })
    STEEL = await template("Steel content statement")
    TSCA = await template("TSCA certificate")
    await ensureAppsForOrg(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await releaseTestLock()
  })

  it("registers the list read only and the writes gated, internal, auto-approvable, with cards", () => {
    const list = toolRegistry.get([ORG, "kernel", "document_rules_list"])
    expect(list?.readOnly).toBe(true)
    expect(list?.requiredScopes).toEqual(["kernel:org:admin"])
    for (const name of ["document_rules_upsert", "document_rules_delete"]) {
      const def = toolRegistry.get([ORG, "kernel", name])
      expect(def?.gated).toBe(true)
      expect(def?.approvalImpact).toBe("internal")
      expect(def?.noAutoApprove).toBeUndefined()
      expect(def?.requiredScopes).toEqual(["kernel:org:admin"])
      expect(def?.searchKeywords).toContain("certificate")
      expect(approvalSummarizerRegistry.get([ORG, "kernel", name])).toBeDefined()
    }
  })

  it("an agent's upsert parks a card naming the conditions and templates; approval saves it", async () => {
    const res = await agentCall("kernel__document_rules_upsert", plateRule())
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(await ruleRows()).toEqual([])
    const [req] = await pending("document_rules_upsert")
    expect(req?.summary.title).toBe('Add the document rule "Plate to the US"')
    expect(req?.summary.lines).toContain(`Applies to: ${TYPE}`)
    expect(req?.summary.lines).toContain(
      "When all of: Product SKU is ACC-PLATE-01; Destination country is US",
    )
    expect(req?.summary.lines).toContain("Needs: Steel content statement, TSCA certificate")
    await approve(req!.id)
    const rows = await ruleRows()
    expect(rows.map((r) => r.name)).toEqual(["Plate to the US"])
    expect(rows[0]?.when).toEqual({ sku: ["ACC-PLATE-01"], countryIso2: ["US"] })
  })

  it("refuses a `when` with an unknown key, or no condition, before anything parks", async () => {
    const before = (await pending("document_rules_upsert")).length
    for (const when of [{ material: ["steel"] }, {}]) {
      const res = await agentCall("kernel__document_rules_upsert", { ...plateRule(), when })
      expect(res.blocked).toBeUndefined()
      expect(JSON.stringify(res)).toMatch(/material|condition/i)
    }
    expect((await pending("document_rules_upsert")).length).toBe(before)
    expect((await ruleRows()).length).toBe(1)
  })

  it("a new rule missing its templates is refused at once, naming what is missing", async () => {
    const res = await agentCall("kernel__document_rules_upsert", {
      recordType: TYPE,
      name: "Half a rule",
      when: { countryIso2: ["CA"] },
    })
    expect(res.blocked).toBeUndefined()
    expect(JSON.stringify(res)).toContain("templateIds")
  })

  it("lists rules with their template names", async () => {
    const res = (await agentCall("kernel__document_rules_list", { recordType: TYPE })) as {
      rules?: { name: string; templates: { id: string; name: string | null }[] }[]
    }
    expect(res.rules?.map((r) => r.name)).toEqual(["Plate to the US"])
    expect(res.rules?.[0]?.templates).toEqual([
      { id: STEEL, name: "Steel content statement" },
      { id: TSCA, name: "TSCA certificate" },
    ])
  })

  it("registers the match read only under kernel:files:read, so any member's list can ask", () => {
    const def = toolRegistry.get([ORG, "kernel", "document_rules_match"])
    expect(def?.readOnly).toBe(true)
    expect(def?.gated).toBeUndefined()
    expect(def?.requiredScopes).toEqual(["kernel:files:read"])
  })

  it("matches a whole list in one call: only records some rule marks come back, with names", async () => {
    const res = (await agentCall("kernel__document_rules_match", {
      recordType: TYPE,
      records: [
        {
          id: "r-plate-us",
          skus: ["acc-plate-01", "OTHER"],
          countryIso2: "US",
          carrier_family: "ups",
        },
        { id: "r-plate-de", skus: ["ACC-PLATE-01"], countryIso2: "DE" },
        { id: "r-no-skus", countryIso2: "US" },
      ],
    })) as {
      matches?: {
        recordId: string
        rules: { id: string; name: string }[]
        templates: { id: string; name: string }[]
      }[]
    }
    expect(res.matches?.map((m) => m.recordId)).toEqual(["r-plate-us"])
    expect(res.matches?.[0]?.rules.map((r) => r.name)).toEqual(["Plate to the US"])
    expect(res.matches?.[0]?.templates).toEqual([
      { id: STEEL, name: "Steel content statement" },
      { id: TSCA, name: "TSCA certificate" },
    ])
  })

  it("refuses more than 500 records in one match call", async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({ id: `r${i}` }))
    const res = await agentCall("kernel__document_rules_match", { recordType: TYPE, records })
    expect(res.matches).toBeUndefined()
    expect(JSON.stringify(res)).toMatch(/500|too_big|records/i)
  })

  it("a policy naming the upsert runs it at once; the delete parks, then deletes on approval", async () => {
    await withPrivilegedDb(ORG, "test:auto-approve-policy", (tx) =>
      tx
        .insert(autoApprovePolicies)
        .values({ orgId: ORG, toolName: "kernel:document_rules_upsert", createdBy: ADMIN }),
    )
    const [rule] = await ruleRows()
    const res = await agentCall("kernel__document_rules_upsert", {
      ruleId: rule!.id,
      enabled: false,
    })
    expect(res.blocked).toBeUndefined()
    const [off] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM kernel.document_template_rules WHERE id = ${rule!.id}`
    expect(off?.enabled).toBe(false)
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`

    const del = await agentCall("kernel__document_rules_delete", { ruleId: rule!.id })
    expect(del).toMatchObject({ blocked: true, status: "pending_approval" })
    const [req] = await pending("document_rules_delete")
    expect(req?.summary.title).toBe('Delete the document rule "Plate to the US"')
    expect(req?.summary.lines).toContain("Needed: Steel content statement, TSCA certificate")
    await approve(req!.id)
    expect(await ruleRows()).toEqual([])
  })

  it("a delete of an unknown rule is refused before anything parks", async () => {
    const res = await agentCall("kernel__document_rules_delete", { ruleId: crypto.randomUUID() })
    expect(res.blocked).toBeUndefined()
    expect(JSON.stringify(res)).toContain("NOT_FOUND")
  })

  it("plain requests find the rule tools through tool search", async () => {
    for (const query of [
      "which documents does a shipment need",
      "require a customs certificate for US orders",
      "print a thank you note with every order of this product",
    ]) {
      const frame = { ...turnFrame(), discoveredTools: new Set<string>() }
      const res = await runContextStore.run(frame, () =>
        handleToolSearch(
          { query },
          { orgId: ORG, userId: ADMIN, scopes: ["kernel:threads:read", "kernel:org:admin"] },
        ),
      )
      const names = res.matches.map((m) => m.name)
      expect(names, query).toContain("kernel__document_rules_upsert")
    }
  })
})
