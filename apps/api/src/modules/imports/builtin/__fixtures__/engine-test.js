// SPDX-License-Identifier: FSL-1.1-ALv2
// A built-in transform for the engine's own tests (transform-run.test.ts):
// a listing is counted, JSON rows and text files become notes, a row naming a
// file declares it. Registered by the test only, never shipped as an import.
const PARAMS = { prefix: "", listing: false }

async function transform(batch, ctx) {
  const st = batch.state || { listed: 0, listRecords: 0, firstListed: null, early: 0 }
  if (batch.file === "(listing)") {
    for (let i = 0; i < batch.records.length; i++) {
      const entries = batch.records[i].entries
      if (st.firstListed === null && entries.length > 0) st.firstListed = entries[0].path
      st.listRecords++
      st.listed += entries.length
    }
    return { state: st }
  }
  if (st.listRecords === 0) st.early++
  const out = []
  for (let j = 0; j < batch.records.length; j++) {
    const r = batch.records[j]
    if (typeof r.text === "string") {
      out.push({ ref: PARAMS.prefix + batch.file, title: batch.file })
      continue
    }
    const rec = { ref: PARAMS.prefix + r.id, title: r.title }
    if (r.file) {
      rec.attachments = [
        { filename: "pic.png", mimeType: "image/png", fileId: await ctx.declareFile(r.file) },
      ]
    }
    out.push(rec)
  }
  await ctx.emitRecords("xformfix.note", out)
  return { state: st }
}

async function finish(batch, ctx) {
  const st = batch.state || {}
  if (PARAMS.listing && st.listRecords) {
    await ctx.emitRecords("xformfix.note", [
      {
        ref: PARAMS.prefix + "listing",
        title:
          "listed " +
          st.listed +
          " in " +
          st.listRecords +
          " first " +
          st.firstListed +
          " early " +
          st.early,
      },
    ])
  }
  return {}
}
