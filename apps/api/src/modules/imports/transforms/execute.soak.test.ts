// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SOAK (skipped unless LIAISON_SOAK=1; about 5 minutes and 2 GiB of free
// temporary disk): the transform heap bound (A20) at production scale. A
// generated 2 GiB CSV, stored uncompressed in a zip, is read by the production
// zip reader (ranged reads) and CSV parser, batched, and run through the
// upload transform executor. Every row must be emitted, the final state must
// name the last row, and the sandbox heap must stay under its limit.
//
//   LIAISON_SOAK=1 bun test src/modules/imports/transforms/execute.soak.test.ts
//
// SOAK_BYTES overrides the CSV size (bytes) for a shorter run.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCsv } from "../parsers/csv"
import { fileRangeSource, readZipDirectory, readZipEntry, ZipBudget } from "../parsers/zip"
import { batchRecords } from "./batch"
import { runUploadTransform } from "./execute"
import { shutdownTransformPool, TRANSFORM_MEMORY_LIMIT_BYTES } from "./pool"

const SOAK = process.env.LIAISON_SOAK === "1"
const TARGET = Number(process.env.SOAK_BYTES ?? 2 * 1024 * 1024 * 1024)
const MIB = 1024 * 1024

describe.skipIf(!SOAK)("SOAK: a 2 GiB zip through the upload transform (A20)", () => {
  let dir: string | null = null

  afterAll(async () => {
    await shutdownTransformPool()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("emits every row with the sandbox heap under its limit", async () => {
    dir = mkdtempSync(join(tmpdir(), "liaison-soak-transform-"))
    const csvPath = join(dir, "tickets.csv")
    const zipPath = join(dir, "tickets.zip")

    const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(70)
    const w = Bun.file(csvPath).writer()
    w.write("id,subject,body\n")
    let written = 16
    let rows = 0
    while (written < TARGET) {
      rows++
      const line = `${rows},Subject ${rows},${body}${rows}\n`
      w.write(line)
      written += line.length
      if (rows % 20_000 === 0) await w.flush()
    }
    await w.end()
    const csvSize = statSync(csvPath).size
    expect(csvSize).toBeGreaterThanOrEqual(TARGET)
    const z = Bun.spawnSync(["zip", "-0", "-j", "-q", zipPath, csvPath])
    expect(z.exitCode).toBe(0)
    rmSync(csvPath)
    const zipSize = statSync(zipPath).size
    console.info(`[SOAK] fixture: ${rows} rows, csv ${csvSize} B, zip ${zipSize} B (stored)`)

    const src = fileRangeSource(zipPath, zipSize)
    const entries = await readZipDirectory(src)
    expect(entries.length).toBe(1)
    const records = parseCsv(readZipEntry(src, entries[0]!, new ZipBudget(zipSize)), {
      name: "tickets.csv",
    })

    let emitted = 0
    const heaps: number[] = []
    let rssPeak = 0
    const t0 = performance.now()
    const r = await runUploadTransform({
      source: `
          async function transform(batch, ctx) {
            var out = []
            for (var i = 0; i < batch.records.length; i++) {
              var row = batch.records[i]
              out.push({ externalRef: "csv:" + row.id, subject: row.subject, body: row.body })
            }
            await ctx.emitRecords("tickets.ticket", out)
            return { state: { lastId: batch.records[batch.records.length - 1].id } }
          }`,
      files: [{ name: "tickets.csv", kind: "csv" }],
      batches: batchRecords("tickets.csv", records),
      host: { kinds: ["tickets.ticket"] },
      sink: {
        onEmitted: async (b) => {
          for (const e of b) emitted += e.records.length
        },
      },
      env: { ...process.env, NODE_ENV: "production" },
      onBatch: (rep) => {
        if (rep.heapBytes !== null) heaps.push(rep.heapBytes)
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
      },
    })
    const secs = (performance.now() - t0) / 1000
    const peak = Math.max(...heaps)
    console.info(
      `[SOAK] ${r.records} rows in ${r.batches} batches, ${secs.toFixed(1)} s; peak sandbox heap ${(peak / MIB).toFixed(1)} MiB of ${TRANSFORM_MEMORY_LIMIT_BYTES / MIB} MiB; host RSS peak ${(rssPeak / MIB).toFixed(0)} MiB`,
    )
    expect(r.records).toBe(rows)
    expect(emitted).toBe(rows)
    expect(r.state).toEqual({ lastId: String(rows) })
    expect(heaps.length).toBe(r.batches)
    expect(peak).toBeLessThan(TRANSFORM_MEMORY_LIMIT_BYTES)
  }, 1_800_000)
})
