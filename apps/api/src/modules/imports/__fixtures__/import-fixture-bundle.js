// SPDX-License-Identifier: FSL-1.1-ALv2
// A sandboxed import kind for the runner tests (modules/imports/runner.test.ts):
// writes `widgets` rows through the RLS session bridge (ctx.db_*), skipping a
// dedup value it already holds. Plain JS, run by the untrusted worker pool.
// A record may name a `fileId` and `floors`: the bundle then claims that file
// row and those sequence floors, as a hostile bundle could (runner.test.ts).
async function importWidgets(params, ctx) {
  const out = []
  for (let i = 0; i < params.records.length; i++) {
    const item = params.records[i]
    const existing = JSON.parse(
      await ctx.db_findMany("widgets", JSON.stringify({ where: { externalRef: item.dedupValue } })),
    )
    const list = Array.isArray(existing) ? existing : existing.rows || existing.data || []
    if (list.length > 0) {
      out.push({ status: "skipped", rows: [] })
      continue
    }
    const inserted = JSON.parse(
      await ctx.db_insert(
        "widgets",
        JSON.stringify({ externalRef: item.dedupValue, title: item.record.title }),
      ),
    )
    const rows = [{ table: "app_importbundlefix.widgets", id: inserted.id }]
    // The host-verified side channels (runner.ts, D4): a kernel.files row the
    // bundle claims as its own, and sequence floors to raise.
    if (typeof item.record.fileId === "string")
      rows.push({ table: "kernel.files", id: item.record.fileId })
    // `claimRowId`: also report a row this record did not write (a lying bundle).
    if (typeof item.record.claimRowId === "string")
      rows.push({ table: "app_importbundlefix.widgets", id: item.record.claimRowId })
    // `failAfterInsert`: the record fails after a write; its rows are still reported.
    if (item.record.failAfterInsert) {
      out.push({ status: "failed", rows, error: "a later line was invalid" })
      continue
    }
    const result = { status: "created", rows }
    if (Array.isArray(item.record.floors)) result.sequenceFloors = item.record.floors
    // `attach`: ask the host to attach an uploaded file to a row through one
    // of the app's file parents (`rowId` defaults to the widget just written).
    if (item.record.attach) {
      result.attachments = [
        {
          fileId: item.record.attach.fileId,
          parent: item.record.attach.parent,
          rowId: item.record.attach.rowId || inserted.id,
        },
      ]
    }
    out.push(result)
  }
  return out
}

// Preview checks (`check` exports) that try to change something: the runner
// runs them on a read-only bridge and READ ONLY transactions (runner.test.ts).
// `checkWidgetsInsert` writes a widget; `checkWidgetsEffect` calls the bridge
// method a record names (`effect`), with harmless arguments.
async function checkWidgetsInsert(params, ctx) {
  const out = []
  for (const item of params.records) {
    await ctx.db_insert(
      "widgets",
      JSON.stringify({ externalRef: item.dedupValue, title: item.record.title }),
    )
    out.push({ status: "created" })
  }
  return out
}

async function checkWidgetsEffect(params, ctx) {
  const out = []
  for (const item of params.records) {
    const effect = item.record.title
    if (effect === "fetch") await ctx.fetch("https://example.com/", JSON.stringify({}))
    else if (effect === "enqueueJob") await ctx.enqueueJob("sync", JSON.stringify({}))
    else if (effect === "smtp_send") await ctx.smtp_send("mail", "x", JSON.stringify({}))
    else if (effect === "emit") await ctx.emit("widget.changed", JSON.stringify({}))
    out.push({ status: "created" })
  }
  return out
}

export { checkWidgetsEffect, checkWidgetsInsert, importWidgets }
