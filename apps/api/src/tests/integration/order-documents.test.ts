// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SHIPPING PAPERS BY CONFIGURATION ALONE, through the real chat seam (buildToolSet's execute
// closure, then executeToolCore), the real handlers, real Postgres and object storage. Synthetic
// data only.
//
// An organisation configures, with tool calls and no code:
//   - a product attribute on a SKU (what the product is made of, and one confirmed fact; an
//     unconfirmed fact is simply not set),
//   - a rich_text template that prints the order's lines in a table, a section per matching line,
//     a paragraph only once a tracking number exists, and grey words for an unconfirmed value,
//   - a document rule: destination US AND a product holding that attribute -> the template.
// Then the rule asks for the template only on the order that holds the attribute; printing the
// order before a label stores a PDF on the record with the unconfirmed value grey and no
// tracking; printing it again once the tracking number exists stores a new PDF that carries it.
// (The shipping app's automatic run of these steps, and the print pack, are its own tests:
// bundled-apps/boxtal/src/customs-documents.test.ts and print-pack.test.ts.)
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
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  appCrossAppCallsRegistry,
  entityRegistry,
  initializedOrgRuntimes,
  manifestFileParentRegistry,
  type PrintDeclaration,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "papersfixture"
const ENTITY = "order"
const RECORD_TYPE = `${APP}:${ENTITY}`
// The app's own record type for its scheduled pass: a parent whose write scope is the app's.
const OWN = "parcel"
// A record type whose file-parent row is made by its first print (print.parentMadeOnPrint).
const LAZY = "lazyorder"

const DECLARATION: PrintDeclaration = {
  recordTool: "order_record_get",
  idParam: "order_id",
  label: "Order",
  fields: [
    { path: "invoice.number", label: "Invoice number", type: "string" },
    { path: "order.customer", label: "Customer name", type: "string" },
    { path: "order.phone", label: "Delivery phone", type: "string" },
    { path: "shipment.tracking_number", label: "Tracking number", type: "string" },
    { path: "lines.sku", label: "Line SKU", type: "string", repeat: "lines" },
    { path: "lines.hts", label: "Line HS code", type: "string", repeat: "lines" },
    { path: "lines.quantity", label: "Line quantity", type: "number", repeat: "lines" },
    { path: "lines.attributes", label: "Line product attributes", type: "string", repeat: "lines" },
  ],
}

const BODY = {
  blocks: [
    { type: "heading", text: "METAL CONTENT DECLARATION" },
    {
      type: "paragraph",
      text: "Commercial invoice {{invoice.number}} — consignee {{order.customer}}, phone {{order.phone ??}}.",
    },
    {
      type: "paragraph",
      text: "Carrier tracking number {{shipment.tracking_number}}.",
      when: { path: "shipment.tracking_number" },
    },
    {
      type: "table",
      from: "lines",
      columns: [
        { header: "SKU", text: "{{sku}}" },
        { header: "HS code", text: "{{hts}}" },
        { header: "Qty", text: "{{quantity}}" },
      ],
    },
    {
      type: "repeat",
      from: "lines",
      where: { path: "attributes.material", equals: "steel" },
      blocks: [
        {
          type: "table",
          columns: [{ width: 2 }, { width: 3 }],
          rows: [
            ["{{sku}} — grade", "{{attributes.steel_grade ?? not confirmed by the supplier}}"],
            ["{{sku}} — mill", "{{attributes.steel_mill ?? not confirmed by the supplier}}"],
          ],
        },
      ],
    },
  ],
}

let ORG = ""
let ADMIN = ""
let DM = ""
let RECORD = ""
let OTHER = ""
let actor: UserContext
let record: Record<string, unknown> = {}

function turnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
    discoveredTools: new Set<string>(),
  }
}

async function agentCall(
  sdkName: string,
  args: Record<string, unknown>,
  as: UserContext = actor,
): Promise<Record<string, unknown>> {
  const frame = turnFrame()
  const tools = buildToolSet(ORG, as, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
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

describe("shipping papers by configuration: attribute rule -> template -> PDF on the record -> reprint with tracking", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    ADMIN = (await minimal.orgAdmin(ORG)).id
    actor = { actorType: "user", userId: ADMIN, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
    DM = await minimal.thread(ORG, ADMIN, { title: "Papers" })
    // The record's file parent: a contact row stands in for the order row.
    RECORD = await minimal.contact(ORG, `papers-${crypto.randomUUID()}@example.com`)
    OTHER = crypto.randomUUID()
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
    // The app's own record: its parent row stands in as the org's admin user row (visible by org).
    entityRegistry.set([ORG, APP, OWN], {
      labelField: "label",
      handlePrefix: "",
      print: DECLARATION,
    })
    manifestFileParentRegistry.set([ORG, APP, OWN], {
      schemaRef: "kernel",
      tableName: "users",
      joinOn: "id",
      readScope: `${APP}:orders:read`,
      writeScope: `${APP}:orders:write`,
    })
    entityRegistry.set([ORG, APP, LAZY], {
      labelField: "label",
      handlePrefix: "",
      print: { ...DECLARATION, parentMadeOnPrint: true },
    })
    manifestFileParentRegistry.set([ORG, APP, LAZY], {
      schemaRef: "kernel",
      tableName: "contacts",
      joinOn: "id",
      readScope: "kernel:contacts:read",
      writeScope: "kernel:org:admin",
    })
    toolRegistry.set([ORG, APP, "order_record_get"], {
      appName: APP,
      name: "order_record_get",
      description: "The order as a printable record",
      requiredScopes: [`${APP}:orders:read`],
      readOnly: true,
      params: z.object({ order_id: z.string() }),
      handler: async () => record,
    } as never)
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
    for (const tool of [
      "kernel:document_template_create",
      "kernel:document_rules_upsert",
      "kernel:product_attributes_upsert",
    ]) {
      await autoApprove(tool)
    }
  }, 180_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    entityRegistry.delete([ORG, APP, ENTITY])
    manifestFileParentRegistry.delete([ORG, APP, ENTITY])
    entityRegistry.delete([ORG, APP, OWN])
    manifestFileParentRegistry.delete([ORG, APP, OWN])
    entityRegistry.delete([ORG, APP, LAZY])
    manifestFileParentRegistry.delete([ORG, APP, LAZY])
    appCrossAppCallsRegistry.delete([ORG, APP])
    initializedOrgRuntimes.delete(ORG)
    await rebuildFilesSelectPolicy()
    await releaseTestLock()
  })

  it("configures, matches, prints before the label and again with the tracking number", async () => {
    // 1. Product facts: the confirmed grade is set; the mill, unconfirmed, is not.
    const attrs = await agentCall("kernel__product_attributes_upsert", {
      items: [
        { sku: "SKU-PLATE", key: "material", value: "steel" },
        { sku: "SKU-PLATE", key: "steel_grade", value: "GRADE-1" },
        { sku: "SKU-PAD", key: "material", value: "silicone" },
      ],
    })
    expect(attrs.blocked).toBeUndefined()

    // 2. The template.
    const created = (await agentCall("kernel__document_template_create", {
      name: "Metal declaration",
      recordType: RECORD_TYPE,
      body: BODY,
    })) as { template?: { id: string } }
    const templateId = created.template?.id
    expect(templateId).toBeString()

    // 3. The rule: destination US AND a product made of steel.
    const rule = await agentCall("kernel__document_rules_upsert", {
      recordType: RECORD_TYPE,
      name: "Steel to the US",
      when: { countryIso2: ["US"], attribute: { material: ["steel"] } },
      templateIds: [templateId],
    })
    expect(rule.blocked).toBeUndefined()

    // 4. Only the order that holds a steel product (and goes to the US) needs it.
    const matched = (await agentCall("kernel__document_rules_match", {
      recordType: RECORD_TYPE,
      records: [
        { id: RECORD, skus: ["SKU-PLATE", "SKU-PAD"], countryIso2: "US" },
        { id: OTHER, skus: ["SKU-PAD"], countryIso2: "US" },
        { id: "eu-order", skus: ["SKU-PLATE"], countryIso2: "DE" },
      ],
    })) as { matches: Array<{ recordId: string; templates: Array<{ id: string }> }> }
    expect(matched.matches.map((m) => m.recordId)).toEqual([RECORD])
    expect(matched.matches[0]!.templates.map((t) => t.id)).toEqual([templateId!])

    // 5. Printed at To prepare: no label, no tracking number, no phone given.
    record = {
      label: "INV-T-1",
      invoice: { number: "INV-T-1" },
      order: { customer: "Test Buyer", phone: null },
      shipment: { tracking_number: null },
      lines: [
        {
          sku: "SKU-PLATE",
          hts: "0000.11",
          quantity: 2,
          attributes: { material: "steel", steel_grade: "GRADE-1" },
        },
        { sku: "SKU-PAD", hts: "0000.22", quantity: 1, attributes: { material: "silicone" } },
      ],
    }
    const first = (await agentCall("kernel__documents_print", {
      app: APP,
      entity: ENTITY,
      recordId: RECORD,
      templateIds: [templateId],
    })) as { files: Array<{ fileId: string }>; blanks: Array<{ path: string | null }> }
    expect(first.files).toHaveLength(1)
    const before = await fileText(first.files[0]!.fileId)
    expect(before).toContain("Commercial invoice INV-T-1")
    expect(before).toContain("SKU-PLATE")
    expect(before).toContain("SKU-PAD")
    expect(before).toContain("GRADE-1")
    expect(before).toContain("not confirmed by the supplier")
    expect(before).not.toContain("Carrier tracking number")
    expect(before).not.toContain("null")
    // The unconfirmed mill is a blank to fill; the optional phone is not.
    expect(first.blanks.map((b) => b.path)).toEqual(["lines.0.attributes.steel_mill"])

    // 6. The label is bought: the tracking number exists, the paper is printed again.
    record = { ...record, shipment: { tracking_number: "TRK-T-9" } }
    const second = (await agentCall("kernel__documents_print", {
      app: APP,
      entity: ENTITY,
      recordId: RECORD,
      templateIds: [templateId],
    })) as { files: Array<{ fileId: string }> }
    const after = await fileText(second.files[0]!.fileId)
    expect(after).toContain("Carrier tracking number TRK-T-9")
    expect(second.files[0]!.fileId).not.toBe(first.files[0]!.fileId)

    // Both papers are on the order's own record.
    const onRecord = await sql<Array<{ id: string }>>`
      SELECT id::text FROM kernel.files WHERE org_id = ${ORG} AND entity_id = ${RECORD}`
    const ids = onRecord.map((r) => r.id)
    expect(ids).toContain(first.files[0]!.fileId)
    expect(ids).toContain(second.files[0]!.fileId)
  })

  it("previews a record whose file-parent row its first print makes, only on that declaration", async () => {
    const created = (await agentCall("kernel__document_template_create", {
      name: "Order summary",
      recordType: `${APP}:${LAZY}`,
      body: { blocks: [{ type: "paragraph", text: "Summary for {{invoice.number}}." }] },
    })) as { template?: { id: string } }
    const templateId = created.template!.id
    record = { ...record, label: "INV-P-1", invoice: { number: "INV-P-1" } }
    // OTHER has no parent row yet: the record type declares its row is made by the first print.
    const preview = (await agentCall("kernel__document_template_preview", {
      templateId,
      recordId: OTHER,
    })) as { sample?: boolean; fileId?: string; error?: unknown }
    expect(preview.error ?? null).toBeNull()
    expect(preview.sample).toBe(false)
    expect(await fileText(preview.fileId!)).toContain("Summary for INV-P-1")

    // Without the parent's read scope, no row proves the record: refused.
    const narrow: UserContext = { ...actor, scopes: ["kernel:files:read", `${APP}:orders:read`] }
    const refused = (await agentCall(
      "kernel__document_template_preview",
      { templateId, recordId: OTHER },
      narrow,
    )) as { error?: unknown }
    expect(JSON.stringify(refused.error ?? null)).toContain("record_not_found")

    // A record type without the declaration still needs its row.
    const plain = (await agentCall("kernel__document_template_create", {
      name: "Order summary (row needed)",
      recordType: RECORD_TYPE,
      body: { blocks: [{ type: "paragraph", text: "Summary for {{invoice.number}}." }] },
    })) as { template?: { id: string } }
    const noRow = (await agentCall("kernel__document_template_preview", {
      templateId: plain.template!.id,
      recordId: OTHER,
    })) as { error?: unknown }
    expect(JSON.stringify(noRow.error ?? null)).toContain("record_not_found")
  })

  it("the app's scheduled pass (a system actor, no person) prints onto its own record, never another's", async () => {
    const created = (await agentCall("kernel__document_template_create", {
      name: "Parcel certificate",
      recordType: `${APP}:${OWN}`,
      body: { blocks: [{ type: "paragraph", text: "Certificate for {{invoice.number}}." }] },
    })) as { template?: { id: string } }
    const templateId = created.template!.id
    record = { ...record, label: "INV-S-1", invoice: { number: "INV-S-1" } }
    appCrossAppCallsRegistry.set([ORG, APP], { targets: ["kernel:documents_print"] })
    // What the app's job bridge dispatches: a system actor holding no scopes of its own.
    const asJob = (entity: string, recordId: string) =>
      executeToolCore({
        toolName: "kernel:documents_print",
        orgId: ORG,
        actor: { actorType: "system", orgId: ORG, purpose: "job", scopes: [] },
        params: { app: APP, entity, recordId, templateIds: [templateId] },
        origin: "system",
        internalCall: { callerApp: APP },
      })

    const printed = await asJob(OWN, ADMIN)
    expect("error" in printed ? printed.error.message : "").toBe("")
    const files = (printed as { data: { files: Array<{ fileId: string }> } }).data.files
    expect(files).toHaveLength(1)
    expect(await fileText(files[0]!.fileId)).toContain("Certificate for INV-S-1")
    const [row] = await sql<Array<{ entity_id: string; uploaded_by: string | null }>>`
      SELECT entity_id, uploaded_by::text FROM kernel.files WHERE id = ${files[0]!.fileId}`
    expect(row).toEqual({ entity_id: ADMIN, uploaded_by: null })

    // A record whose parent another authority writes (here kernel:org:admin) stays refused.
    const other = (await executeToolCore({
      toolName: "kernel:documents_print",
      orgId: ORG,
      actor: { actorType: "system", orgId: ORG, purpose: "job", scopes: [] },
      params: { app: APP, entity: ENTITY, recordId: RECORD, templateIds: [templateId] },
      origin: "system",
      internalCall: { callerApp: APP },
    })) as { error?: { code: string; message: string } }
    expect(other.error?.message ?? JSON.stringify(other)).toContain("permission")
  })
})
