// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FOOTER_ACTIONS.idParam vs. manifest params — pins the id key each footer
// action sends against the tool's own declared schema. Before `idParam` was
// added, `DocumentDetail.tsx`'s `invoke()` hardcoded `{ id: documentId }` for
// every footer action, but `documents_mark_paid` / `documents_send_to_customer`
// require `document_id` and `documents_convert_to_invoice` requires
// `source_document_id` — the kernel's `assertKnownParams` rejects the unknown
// `id` key with a 400 before the handler runs, so those three buttons did
// nothing. This test fails whenever an action's `idParam` is not both a
// declared property AND a required key of its own tool.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FOOTER_ACTIONS } from "./DocumentDetail"

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "../../app.manifest.json"), "utf-8"),
) as {
  tools: Record<string, { params?: { properties?: Record<string, unknown>; required?: string[] } }>
}

describe("FOOTER_ACTIONS idParam matches the tool's manifest schema", () => {
  for (const [name, action] of Object.entries(FOOTER_ACTIONS)) {
    it(`${name} (${action.tool}) sends its tool's required id key ("${action.idParam}")`, () => {
      const tool = manifest.tools[action.tool]
      expect(tool).toBeDefined()
      const properties = tool?.params?.properties ?? {}
      const required = tool?.params?.required ?? []
      expect(Object.keys(properties)).toContain(action.idParam)
      expect(required).toContain(action.idParam)
    })
  }
})
