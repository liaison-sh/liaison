// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN AGENT DESIGNS, PREVIEWS, SAVES AND PRINTS A DOCUMENT TEMPLATE BY TOOL
// CALLS ALONE, through the real chat seam (buildToolSet's execute closure,
// then executeToolCore) with the real handlers, on real Postgres and object
// storage.
//
// A test app declares a printable entity (a contact stands in for the record)
// whose record tool returns the record JSON. The round trip: list the record
// types, preview a draft body with SAMPLE values (no record), create it
// (gated: auto-approved by a policy), update it, print a real record. Also:
// without a policy the create parks a card that names the template, the record
// type and the block count; an invalid body is refused before any card with
// the schema's message; documents_print has no way to pass values; and tool
// search finds the tools by the words people use, and does not put them above
// the invoicing and notes tools for "create an invoice" or "create a note".
// Reading a record for a preview or a print taints the turn with the record
// tool's own scopes, so the PDF cannot then be posted to people who lack them;
// the record types list shows only the types whose record tool the caller may
// call; and the approval cards quote the blocks they add or change.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { DocumentToolParams } from "~/modules/agent/tools/document-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import {
  agentInstructionsRegistry,
  approvalSummarizerRegistry,
  entityRegistry,
  initializedOrgRuntimes,
  manifestFileParentRegistry,
  type PrintDeclaration,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "docfixture"
const ENTITY = "parcel"
const RECORD_TYPE = `${APP}:${ENTITY}`
/** The record tool's own scope: what reading a parcel reads. */
const RECORD_SCOPE = `${APP}:parcels:read`

const DECLARATION: PrintDeclaration = {
  recordTool: "record_get",
  idParam: "parcel_id",
  label: "Parcel",
  fields: [
    { path: "customer.name", label: "Customer name", type: "string" },
    { path: "tracking_number", label: "Tracking number", type: "string" },
    { path: "lines.description", label: "Description", type: "string", repeat: "lines" },
    { path: "lines.quantity", label: "Quantity", type: "number", repeat: "lines" },
  ],
}

const DRAFT_BODY = {
  page: { size: "A4" },
  blocks: [
    { type: "heading", text: "Thank you, {{customer.name}}" },
    { type: "paragraph", text: "Your parcel {{tracking_number}} is on its way." },
    { type: "list", from: "lines", line: "{{quantity}} x {{description}}" },
  ],
}

let ORG = ""
let ADMIN = ""
let MEMBER = ""
let DM = ""
let RECORD = ""
let actor: UserContext
let record: Record<string, unknown> = {}

function turnFrame(taint: string[] = []): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(taint)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator,
    discoveredTools: new Set<string>(),
  }
}

async function agentCall(
  sdkName: string,
  args: Record<string, unknown>,
  taint: string[] = [],
  opts: { frame?: RunContext; as?: UserContext } = {},
): Promise<Record<string, unknown>> {
  const frame = opts.frame ?? turnFrame(taint)
  const tools = buildToolSet(ORG, opts.as ?? actor, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

async function autoApprove(toolName: string): Promise<void> {
  await withPrivilegedDb(ORG, "test:auto-approve-policy", (tx) =>
    tx
      .insert(autoApprovePolicies)
      .values({ orgId: ORG, toolName, createdBy: ADMIN })
      .onConflictDoNothing(),
  )
}

async function fileText(fileId: string): Promise<string> {
  const [file] = await sql<Array<{ storage_key: string }>>`
    SELECT storage_key FROM kernel.files WHERE id = ${fileId}`
  const { bytes } = await getObjectBytes(file!.storage_key, { maxBytes: 10 * 1024 * 1024 })
  return extractPdfText(new Uint8Array(bytes))
}

async function search(query: string): Promise<string[]> {
  const frame = turnFrame()
  const res = await runContextStore.run(frame, () =>
    handleToolSearch({ query, maxResults: 5 }, { orgId: ORG, userId: ADMIN, scopes: ["*"] }),
  )
  return res.matches.map((m) => m.name)
}

describe("documents: agent tools to design, preview and print templates", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    ADMIN = (await minimal.orgAdmin(ORG)).id
    actor = { actorType: "user", userId: ADMIN, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
    DM = await minimal.thread(ORG, ADMIN, { title: "Documents" })
    MEMBER = (await minimal.person(ORG)).id
    RECORD = await minimal.contact(ORG, `doc-${crypto.randomUUID()}@example.com`)
    await ensureAppsForOrg(ORG)
    entityRegistry.set([ORG, APP, ENTITY], {
      labelField: "label",
      handlePrefix: "",
      print: DECLARATION,
    })
    manifestFileParentRegistry.set([ORG, APP, ENTITY], {
      schemaRef: "kernel",
      tableName: "contacts",
      joinOn: "id",
      readScope: "kernel:contacts:read",
      writeScope: "kernel:org:admin",
    })
    toolRegistry.set([ORG, APP, "record_get"], {
      appName: APP,
      name: "record_get",
      description: "The parcel as a printable record",
      requiredScopes: [RECORD_SCOPE],
      readOnly: true,
      params: z.object({ parcel_id: z.string() }),
      handler: async () => record,
    } as never)
    // Stand-ins for the invoicing and notes apps' create tools, for the tool search ranking.
    toolRegistry.set([ORG, "invoicing", "invoice_create_and_issue"], {
      appName: "invoicing",
      name: "invoice_create_and_issue",
      description: "Create a draft invoice and issue it in one call.",
      requiredScopes: ["invoicing:documents:write"],
      params: z.object({ order_id: z.string() }),
      handler: async () => ({}),
    } as never)
    toolRegistry.set([ORG, "notes", "note_create"], {
      appName: "notes",
      name: "note_create",
      description: "Create a note.",
      requiredScopes: ["notes:notes:write"],
      params: z.object({ text: z.string() }),
      handler: async () => ({}),
    } as never)
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
  }, 180_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    entityRegistry.delete([ORG, APP, ENTITY])
    manifestFileParentRegistry.delete([ORG, APP, ENTITY])
    initializedOrgRuntimes.delete(ORG)
    await rebuildFilesSelectPolicy()
    await releaseTestLock()
  })

  it("registers the reads read only, the writes gated and internal with a card, and a guide", () => {
    const tool = (name: string) => toolRegistry.get([ORG, "kernel", name])
    for (const name of [
      "document_record_types_list",
      "document_templates_list",
      "document_template_get",
    ]) {
      expect(tool(name)?.readOnly).toBe(true)
    }
    for (const name of [
      "document_template_create",
      "document_template_update",
      "document_template_archive",
    ]) {
      expect(tool(name)?.gated).toBe(true)
      expect(tool(name)?.approvalImpact).toBe("internal")
      expect(tool(name)?.noAutoApprove).toBeUndefined()
      expect(approvalSummarizerRegistry.get([ORG, "kernel", name])).toBeDefined()
    }
    expect(tool("documents_print")?.gated).toBeUndefined()
    expect(tool("documents_print")?.writesToTable).toBe("kernel.files")
    const guide = agentInstructionsRegistry.get([ORG, "kernel-documents"])
    expect(guide).toMatchObject({
      coveredTools: [
        "kernel__document_template*",
        "kernel__document_record_types_list",
        "kernel__documents_print",
      ],
    })
  })

  it("documents_print takes no values: a data or values key is refused", async () => {
    const base = { app: APP, entity: ENTITY, recordId: RECORD, templateIds: [crypto.randomUUID()] }
    expect(DocumentToolParams.printParams.safeParse(base).success).toBe(true)
    for (const extra of [{ data: { tracking_number: "X" } }, { values: { a: 1 } }]) {
      expect(DocumentToolParams.printParams.safeParse({ ...base, ...extra }).success).toBe(false)
      const res = await agentCall("kernel__documents_print", { ...base, ...extra })
      expect(JSON.stringify(res)).not.toContain('"files"')
      expect(JSON.stringify(res).toLowerCase()).toMatch(/unrecognized|invalid|validation/)
    }
  })

  it("an invalid body is refused with the schema's message, and no card is raised", async () => {
    const res = await agentCall("kernel__document_template_create", {
      name: "Broken",
      recordType: RECORD_TYPE,
      body: { blocks: [{ type: "paragraph", text: "Hello {{ name" }] },
    })
    expect(JSON.stringify(res)).toContain("The template body is not valid: blocks.0.text")
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests
       WHERE org_id = ${ORG} AND tool_name = 'kernel:document_template_create'`
    expect(n).toBe(0)
  })

  it("without a policy, create parks a card naming the template, the record type and its blocks", async () => {
    const res = await agentCall("kernel__document_template_create", {
      name: "Card check",
      recordType: RECORD_TYPE,
      body: DRAFT_BODY,
    })
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    const [req] = await sql<Array<{ summary: { title: string; lines: string[] } }>>`
      SELECT summary FROM kernel.approval_requests
       WHERE org_id = ${ORG} AND tool_name = 'kernel:document_template_create' AND status = 'pending'`
    expect(req?.summary.title).toBe('Create the document template "Card check"')
    expect(req?.summary.lines).toContain(`Prints: Parcel (${RECORD_TYPE})`)
    expect(req?.summary.lines).toContain("Content: 3 blocks (1 heading, 1 paragraph, 1 list)")
    // The card quotes what each block prints, not only how many there are.
    expect(req?.summary.lines).toContain("heading: Thank you, {{customer.name}}")
    expect(req?.summary.lines).toContain("list of lines: {{quantity}} x {{description}}")
    expect(req?.summary.lines.length).toBeLessThanOrEqual(8)
    await sql`UPDATE kernel.approval_requests SET status = 'denied'
               WHERE org_id = ${ORG} AND status = 'pending'`
  })

  it("an update card quotes the blocks it adds and removes, each cut to about 120 characters", async () => {
    await autoApprove("kernel:document_template_create")
    const created = (await agentCall("kernel__document_template_create", {
      name: "Update card check",
      recordType: RECORD_TYPE,
      body: DRAFT_BODY,
    })) as { template?: { id: string } }
    const templateId = created.template?.id
    expect(templateId).toBeString()
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    const long = `Ref {{tracking_number}} ${"word ".repeat(60)}`
    const res = await agentCall("kernel__document_template_update", {
      templateId,
      body: { ...DRAFT_BODY, blocks: [DRAFT_BODY.blocks[0], { type: "paragraph", text: long }] },
    })
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    const [req] = await sql<Array<{ summary: { lines: string[] } }>>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${String(res.approvalRequestId)}`
    const lines = req?.summary.lines ?? []
    expect(lines.length).toBeLessThanOrEqual(8)
    const added = lines.find((l) => l.startsWith("+ paragraph: Ref {{tracking_number}} word"))
    expect(added).toBeDefined()
    expect(added!.endsWith("...")).toBe(true)
    expect(added!.length).toBeLessThanOrEqual("+ paragraph: ".length + 120)
    expect(lines).toContain("- paragraph: Your parcel {{tracking_number}} is on its way.")
    expect(lines).toContain("- list of lines: {{quantity}} x {{description}}")
    await sql`UPDATE kernel.approval_requests SET status = 'denied'
               WHERE org_id = ${ORG} AND status = 'pending'`
  })

  it("the record types list shows only the types whose record tool the caller may call", async () => {
    const as = (scopes: string[]): UserContext => ({ ...actor, scopes })
    const without = (await agentCall("kernel__document_record_types_list", {}, [], {
      as: as(["kernel:files:read"]),
    })) as { recordTypes: Array<{ recordType: string }> }
    expect(without.recordTypes.map((t) => t.recordType)).not.toContain(RECORD_TYPE)
    const withScope = (await agentCall("kernel__document_record_types_list", {}, [], {
      as: as(["kernel:files:read", RECORD_SCOPE]),
    })) as { recordTypes: Array<{ recordType: string }> }
    expect(withScope.recordTypes.map((t) => t.recordType)).toContain(RECORD_TYPE)
  })

  it("round trip by tool calls: record types, SAMPLE preview, create, update, print", async () => {
    const types = (await agentCall("kernel__document_record_types_list", {})) as {
      recordTypes: Array<{ recordType: string; sampleRecord: Record<string, unknown> }>
    }
    const parcel = types.recordTypes.find((t) => t.recordType === RECORD_TYPE)
    expect(parcel?.sampleRecord).toMatchObject({ customer: { name: "Sample Customer name" } })

    // Preview the draft with no record: SAMPLE values, marked on the page and in the result.
    const preview = (await agentCall("kernel__document_template_preview", {
      body: DRAFT_BODY,
      recordType: RECORD_TYPE,
      name: "Thank you letter",
    })) as { fileId: string; sample: boolean; blanks: unknown[]; unknownFields: unknown[] }
    expect(preview.sample).toBe(true)
    expect(preview.blanks).toEqual([])
    expect(preview.unknownFields).toEqual([])
    const sampleText = await fileText(preview.fileId)
    expect(sampleText).toContain("SAMPLE")
    expect(sampleText).toContain("Thank you, Sample Customer name")
    expect(sampleText).toContain("2 x Sample Description 2")
    // The preview is the caller's own staged file, never on a record or a template.
    const [staged] = await sql<Array<{ entity_type: string; uploaded_by: string }>>`
      SELECT entity_type, uploaded_by::text FROM kernel.files WHERE id = ${preview.fileId}`
    expect(staged).toEqual({ entity_type: "file_upload_session", uploaded_by: ADMIN })

    await autoApprove("kernel:document_template_create")
    await autoApprove("kernel:document_template_update")
    const created = (await agentCall("kernel__document_template_create", {
      name: "Thank you letter",
      recordType: RECORD_TYPE,
      body: DRAFT_BODY,
    })) as { template?: { id: string } }
    const templateId = created.template?.id
    expect(templateId).toBeString()

    const updated = await agentCall("kernel__document_template_update", {
      templateId,
      body: {
        ...DRAFT_BODY,
        blocks: [...DRAFT_BODY.blocks, { type: "paragraph", text: "Ref {{order_ref}}" }],
      },
    })
    expect(updated.template).toMatchObject({ id: templateId })
    const got = (await agentCall("kernel__document_template_get", { templateId })) as {
      unknownFields: Array<{ path: string }>
    }
    // A path the record type does not declare is reported, so the agent fixes the mapping.
    expect(got.unknownFields).toEqual([{ path: "order_ref" }])

    record = {
      label: "Parcel 7",
      customer: { name: "Ada" },
      tracking_number: null,
      lines: [{ description: "Plate", quantity: 2 }],
    }
    const listed = (await agentCall("kernel__document_templates_list", {
      recordType: RECORD_TYPE,
    })) as { templates: Array<{ id: string }> }
    expect(listed.templates.map((t) => t.id)).toContain(templateId!)

    const printed = (await agentCall("kernel__documents_print", {
      app: APP,
      entity: ENTITY,
      recordId: RECORD,
      templateIds: [templateId],
    })) as {
      files: Array<{ fileId: string }>
      blanks: Array<{ templateName: string; label: string; path: string | null }>
    }
    expect(printed.files).toHaveLength(1)
    expect(printed.blanks).toContainEqual({
      templateName: "Thank you letter",
      label: "Tracking number",
      path: "tracking_number",
    })
    const text = await fileText(printed.files[0]!.fileId)
    expect(text).toContain("Thank you, Ada")
    expect(text).toContain("[Tracking number]")
    expect(text).toContain("2 x Plate")
    expect(text).not.toContain("SAMPLE")

    // A preview against the real record is not a sample.
    const real = (await agentCall("kernel__document_template_preview", {
      templateId,
      recordId: RECORD,
    })) as { sample: boolean; fileId: string }
    expect(real.sample).toBe(false)
    expect(await fileText(real.fileId)).not.toContain("SAMPLE")
  })

  it("scope taint: a tainted turn's template write always waits for a holder of the taint; a preview and a print run", async () => {
    // The same auto-approve policy the round trip saved through: a tainted turn never uses it.
    // A gated write on a tainted turn parks (scope-taint.ts, rule 8), and only a person holding
    // what the turn read may decide it, so the approval is the disclosure decision.
    await autoApprove("kernel:document_template_create")
    const SECRET = `${APP}:secrets:read`
    for (const taint of [[SECRET], ["kernel:files:read"]]) {
      const name = `Tainted letter ${taint[0]}`
      const res = await agentCall(
        "kernel__document_template_create",
        { name, recordType: RECORD_TYPE, body: DRAFT_BODY },
        taint,
      )
      expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
      const [req] = await sql<Array<{ metadata: { taintAudienceMustHold?: string[] } }>>`
        SELECT metadata FROM kernel.approval_requests WHERE id = ${String(res.approvalRequestId)}`
      expect(req?.metadata.taintAudienceMustHold).toEqual(taint)
      const [{ n }] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM kernel.document_templates
         WHERE org_id = ${ORG} AND name = ${name}`
      expect(n).toBe(0)
    }

    // The preview is the caller's own staged file and the print carries only ids: both run.
    const preview = await agentCall(
      "kernel__document_template_preview",
      { body: DRAFT_BODY, recordType: RECORD_TYPE },
      [SECRET],
    )
    expect(preview).toMatchObject({ sample: true })
    const listed = (await agentCall("kernel__document_templates_list", {
      recordType: RECORD_TYPE,
    })) as { templates: Array<{ id: string }> }
    record = {
      label: "Parcel 8",
      customer: { name: "Ada" },
      tracking_number: "T1",
      lines: [{ description: "Plate", quantity: 1 }],
    }
    const printed = (await agentCall(
      "kernel__documents_print",
      { app: APP, entity: ENTITY, recordId: RECORD, templateIds: [listed.templates[0]!.id] },
      [SECRET],
    )) as { files?: unknown[] }
    expect(printed.files).toHaveLength(1)
    await sql`UPDATE kernel.approval_requests SET status = 'denied'
               WHERE org_id = ${ORG} AND status = 'pending'`
  })

  it("a preview or a print of a real record taints the turn with the record tool's scopes", async () => {
    await autoApprove("kernel:document_template_create")
    const created = (await agentCall("kernel__document_template_create", {
      name: "Taint letter",
      recordType: RECORD_TYPE,
      body: DRAFT_BODY,
    })) as { template?: { id: string } }
    const templateId = created.template!.id
    record = {
      label: "Parcel 9",
      customer: { name: "Ada" },
      tracking_number: "T9",
      lines: [{ description: "Plate", quantity: 1 }],
    }
    const steps: Array<[string, Record<string, unknown>]> = [
      ["kernel__document_template_preview", { templateId, recordId: RECORD }],
      [
        "kernel__documents_print",
        { app: APP, entity: ENTITY, recordId: RECORD, templateIds: [templateId] },
      ],
    ]
    for (const [tool, args] of steps) {
      const frame = turnFrame()
      const out = await agentCall(tool, args, [], { frame })
      expect(JSON.stringify(out)).not.toContain('"error"')
      expect(frame.turnScopeAccumulator?.snapshot()).toContain(RECORD_SCOPE)
      // Posting what it read to a member who lacks the record's scope parks for a holder.
      const title = `Parcel 9 documents ${tool}`
      const posted = await agentCall(
        "kernel__threads_create",
        { participantIds: [MEMBER], title, initialMessage: "Here it is", forceCreate: true },
        [],
        { frame },
      )
      expect(posted).toMatchObject({ blocked: true })
      const [req] = await sql<Array<{ metadata: { taintAudienceMustHold?: string[] } }>>`
        SELECT metadata FROM kernel.approval_requests WHERE id = ${String(posted.approvalRequestId)}`
      expect(req?.metadata.taintAudienceMustHold).toContain(RECORD_SCOPE)
      const [{ n }] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${ORG} AND title = ${title}`
      expect(n).toBe(0)
    }
    // A SAMPLE preview reads no record: it adds no record scope.
    const frame = turnFrame()
    await agentCall("kernel__document_template_preview", { templateId }, [], { frame })
    expect(frame.turnScopeAccumulator?.snapshot()).not.toContain(RECORD_SCOPE)
    await sql`UPDATE kernel.approval_requests SET status = 'denied'
               WHERE org_id = ${ORG} AND status = 'pending'`
  })

  it("tool search does not rank the template tools above invoicing or notes for their own work", async () => {
    const invoice = await search("create an invoice")
    expect(invoice[0]).toBe("invoicing__invoice_create_and_issue")
    const note = await search("create a note")
    expect(note[0]).toBe("notes__note_create")
  })

  it("tool search finds the template tools by the words people use", async () => {
    expect(await search("make a customs declaration template")).toContain(
      "kernel__document_template_create",
    )
    expect(await search("thank you letter for customers")).toContain(
      "kernel__document_template_create",
    )
    expect(await search("print the documents for this shipment")).toContain(
      "kernel__documents_print",
    )
  })
})
