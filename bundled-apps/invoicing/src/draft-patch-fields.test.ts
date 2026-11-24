// SPDX-License-Identifier: FSL-1.1-ALv2
//
// drafts_update refuses a patch that names a field it does not change: an answer of success with
// nothing written would report a change that did not happen.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { harness, schedule } from "./__fixtures__/recurring-draft"
import { PATCH_FIELDS } from "./mutations/drafts"
import { draftsUpdate, draftsUpdatePreflight, draftsUpdateTool } from "./mutations"
import { recurringDraftJob } from "./recurring/draft-job"

async function aDraft() {
  const h = harness("2026-11-27", { schedules: [schedule("33333333-3333-4333-8333-333333333331")] })
  const doc = await h.db.insert("documents", {
    type: "invoice",
    status: "draft",
    number: null,
    counterparty_contact_id: null,
    counterparty_name: "Nadir",
    issuer_profile_id: "11111111-1111-4111-8111-111111111111",
    currency: "EUR",
    incoterm: "DAP",
    external_refs: {},
    lifecycle_log: [],
    subtotal_minor: "0",
    tax_total_minor: "0",
    grand_total_minor: "0",
  })
  return { h, id: String((doc as { id: unknown }).id) }
}

describe("a drafts_update patch with a field it does not change", () => {
  test("is refused by name, with the field meant, and nothing is written", async () => {
    const { h, id } = await aDraft()
    const before = JSON.stringify(h.db.__all("documents").find((d) => d.id === id))
    const patch = { items: [{ description: "x", quantity: "1", unit_price_minor: "100" }] } as never
    for (const run of [draftsUpdateTool, draftsUpdate]) {
      await expect(run(h.ctx as never, { draft_id: id, patch })).rejects.toThrow(
        /^unknown_field: .*"items".*lines/,
      )
    }
    expect(await draftsUpdatePreflight(h.ctx as never, { draft_id: id, patch })).toMatchObject({
      error: { code: "unknown_field" },
    })
    // A known field beside an unknown one is not written either.
    await expect(
      draftsUpdate(h.ctx as never, {
        draft_id: id,
        patch: { notes: "kept out", number: "F-1", constructor: 1 } as never,
      }),
    ).rejects.toThrow(/"number".*"constructor"/)
    expect(JSON.stringify(h.db.__all("documents").find((d) => d.id === id))).toBe(before)
  })

  test("is refused on a month-end run's row too", async () => {
    const { h } = await aDraft()
    await recurringDraftJob(h.ctx)
    const [item] = h.db.__all("recurring_run_items")
    await expect(
      draftsUpdateTool(h.ctx as never, {
        draft_id: String(item?.document_id),
        applies: "this_month",
        patch: { items: [] } as never,
      }),
    ).rejects.toThrow(/^unknown_field/)
  })

  test("every field the tool declares is one it writes", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
    ) as { tools: Record<string, { params: { properties: { patch: { properties: object } } } }> }
    const declared = Object.keys(manifest.tools.drafts_update!.params.properties.patch.properties)
    expect(declared.filter((k) => !PATCH_FIELDS.has(k))).toEqual([])
  })
})
