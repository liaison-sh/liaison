// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `entities.<e>.print` manifest key: an entity that can be printed through
// the org's document templates names the app's own READ tool that returns the
// record, and the fields templates may map. The kernel runs that tool under the
// caller's authorization at print time, so it must be a declared, readOnly,
// ungated tool, and the printed files land on the entity's own fileParent.

import { describe, expect, it } from "bun:test"
import { validateAppDescriptor, validateAppManifest } from "~/modules/apps/contract"

const FILE_PARENT = {
  tableName: "shipment",
  schemaRef: "app_shipper",
  joinOn: "id",
  readScope: "shipper:shipments:read",
  writeScope: "shipper:shipments:write",
}

const PRINT = {
  recordTool: "print_record_get",
  idParam: "shipment_id",
  label: "Shipment",
  fields: [
    { path: "order.name", label: "Order", type: "string" },
    { path: "shipment.tracking_number", label: "Tracking number", type: "string" },
    { path: "lines.sku", label: "SKU", type: "string", repeat: "lines" },
    { path: "lines.quantity", label: "Quantity", type: "number", repeat: "lines" },
  ],
}

function recordTool(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "The shipment as a printable record",
    handler: "printRecordGet",
    requiredScopes: ["shipper:shipments:read"],
    readOnly: true,
    params: {
      type: "object",
      properties: { shipment_id: { type: "string" } },
      required: ["shipment_id"],
    },
    ...extra,
  }
}

function manifest(opts: {
  tool?: Record<string, unknown> | null
  print?: Record<string, unknown>
  fileParent?: boolean
}): Record<string, unknown> {
  const tools: Record<string, unknown> = {}
  if (opts.tool !== null) tools.print_record_get = opts.tool ?? recordTool()
  return {
    name: "shipper",
    version: "1.0.0",
    schema: { shipment: { fields: { reference: "string" } } },
    tools,
    entities: {
      shipment: {
        labelField: "reference",
        ...(opts.fileParent === false ? {} : { fileParent: FILE_PARENT }),
        print: opts.print ?? PRINT,
      },
    },
  }
}

describe("entities.<e>.print", () => {
  it("accepts a readOnly, ungated record tool on an entity with a fileParent", () => {
    const result = validateAppManifest(manifest({}))
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
  })

  it("refuses a gated record tool", () => {
    const result = validateAppManifest(manifest({ tool: recordTool({ gated: true }) }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
    expect(result.error).toContain("entities.shipment.print.recordTool")
  })

  it("refuses a conditionally gated record tool", () => {
    const result = validateAppManifest(manifest({ tool: recordTool({ conditionalGate: true }) }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
  })

  it("refuses a record tool that is not readOnly", () => {
    const result = validateAppManifest(manifest({ tool: recordTool({ readOnly: false }) }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
  })

  it("refuses a record tool the manifest does not declare", () => {
    const result = validateAppManifest(manifest({ tool: null }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
  })

  it("refuses an idParam the record tool does not take", () => {
    const result = validateAppManifest(manifest({ print: { ...PRINT, idParam: "order_id" } }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
    expect(result.error).toContain("order_id")
  })

  it("refuses a printable entity without a fileParent", () => {
    const result = validateAppManifest(manifest({ fileParent: false }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
    expect(result.error).toContain("fileParent")
  })

  it("refuses a repeating field whose path is not inside its list", () => {
    const result = validateAppManifest(
      manifest({
        print: {
          ...PRINT,
          fields: [{ path: "order.sku", label: "SKU", type: "string", repeat: "lines" }],
        },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_field_invalid")
  })

  it("refuses a numeric index in a declared field path", () => {
    const result = validateAppManifest(
      manifest({
        print: { ...PRINT, fields: [{ path: "lines.0.sku", label: "SKU", type: "string" }] },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_field_invalid")
  })

  it("refuses a field path declared twice", () => {
    const result = validateAppManifest(
      manifest({
        print: {
          ...PRINT,
          fields: [
            { path: "order.name", label: "Order", type: "string" },
            { path: "order.name", label: "Order again", type: "string" },
          ],
        },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_field_invalid")
  })

  it("refuses an unknown key in the print declaration", () => {
    const result = validateAppManifest(manifest({ print: { ...PRINT, data: { x: 1 } } }))
    expect(result.success).toBe(false)
  })

  it("applies the same record-tool rule to an in-process descriptor", () => {
    const handler = async () => ({})
    const descriptor = {
      name: "shipper",
      version: "1.0.0",
      tools: {
        print_record_get: {
          description: "x",
          requiredScopes: ["shipper:shipments:read"],
          handler,
          gated: true,
        },
      },
      entities: { shipment: { labelField: "reference", fileParent: FILE_PARENT, print: PRINT } },
    }
    const result = validateAppDescriptor(descriptor)
    expect(result.success).toBe(false)
    expect(result.error).toContain("print_record_tool_invalid")
  })
})

describe("entities.<e>.print.parentMadeOnPrint", () => {
  function withFlag(table: Record<string, unknown>, parent: Record<string, unknown> = FILE_PARENT) {
    const m = manifest({ print: { ...PRINT, parentMadeOnPrint: true } })
    m.schema = { shipment: { fields: { reference: "string" }, ...table } }
    ;(m.entities as { shipment: Record<string, unknown> }).shipment.fileParent = parent
    return validateAppManifest(m)
  }

  it("accepts a parent in the app's own table whose rows every holder of its read scope sees", () => {
    const result = withFlag({ rlsScope: "shipments" })
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
  })

  it("refuses a parent whose rows RLS restricts beyond the scope, or another schema, or another scope", () => {
    for (const result of [
      withFlag({ rlsScope: "shipments", dimensions: { region: { type: "value", column: "reference" } } }),
      withFlag({ rlsScope: "shipments", personalScope: {} }),
      withFlag({ rlsScope: "shipments", rlsGovernedByMigration: true }),
      withFlag({ rlsScope: "shipments" }, { ...FILE_PARENT, schemaRef: "kernel", tableName: "contacts" }),
      withFlag({}), // generated read scope is shipper:shipment:read, the parent says shipments
    ]) {
      expect(result.success).toBe(false)
      expect(result.error).toContain("entities.shipment.print.parentMadeOnPrint")
    }
  })
})
