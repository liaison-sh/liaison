// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The transform executor against the real transform pool (out-of-process
// QuickJS workers): records emitted through the bridge, the per-call deadline,
// the module refusal, state across batches, the API pull loop's 429 and cursor
// rules, and the heap bound on a 200 MB CSV generated at test time.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { batchRecords, type ParsedRecord, type TransformBatch } from "./batch"
import type { EmittedBatch } from "./bridge"
import { runApiPull, runTransformCall, runUploadTransform, TransformRunError } from "./execute"
import { shutdownTransformPool, TRANSFORM_MEMORY_LIMIT_BYTES } from "./pool"
import { TransformSourceError } from "./source"

afterAll(async () => {
  await shutdownTransformPool()
})

const PRODUCTION_ENV: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" }

function collectingSink() {
  const emitted: EmittedBatch[] = []
  return {
    emitted,
    sink: {
      onEmitted: async (b: EmittedBatch[]) => {
        emitted.push(...b)
      },
    },
  }
}

async function* batchesOf(...batches: TransformBatch[]): AsyncGenerator<TransformBatch> {
  for (const b of batches) yield b
}

function batch(records: unknown[], firstRecord = 1, file = "tickets.csv"): TransformBatch {
  return { file, firstRecord, records, bytes: JSON.stringify(records).length }
}

const host = { orgId: "00000000-0000-0000-0000-0000000000a1", kinds: ["tickets.ticket"] }

describe("transform executor: one call", () => {
  it("a transform emits 3 records through ctx.emitRecords", async () => {
    const r = await runTransformCall({
      source: `
        async function transform(batch, ctx) {
          var out = batch.records.map(function (row) {
            return { externalRef: "help:" + row.id, subject: row.subject }
          })
          var answer = await ctx.emitRecords("tickets.ticket", out)
          return { state: { accepted: answer.accepted } }
        }`,
      entry: "transform",
      params: {
        records: [
          { id: 1, subject: "Printer offline" },
          { id: 2, subject: "Refund request" },
          { id: 3, subject: "Login loop" },
        ],
      },
      host: { ...host, sourceType: "upload" },
    })
    expect(r.emitted).toEqual([
      {
        kind: "tickets.ticket",
        records: [
          { externalRef: "help:1", subject: "Printer offline" },
          { externalRef: "help:2", subject: "Refund request" },
          { externalRef: "help:3", subject: "Login loop" },
        ],
      },
    ])
    expect(r.value).toEqual({ state: { accepted: 3 } })
    expect(typeof r.heapBytes).toBe("number")
    expect(r.heapBytes ?? 0).toBeGreaterThan(0)
  })

  it("an undeclared kind and a non-object record are refused, the rest accepted", async () => {
    const r = await runTransformCall({
      source: `
        async function transform(batch, ctx) {
          var a = await ctx.emitRecords("tickets.ticket", [{ subject: "ok" }, "not a record"])
          var b
          try { await ctx.emitRecords("projects.issue", [{ title: "x" }]) } catch (e) { b = e.message }
          return { state: { a: a, b: b } }
        }`,
      entry: "transform",
      params: {},
      host: { ...host, sourceType: "upload" },
    })
    const state = (
      r.value as { state: { a: { accepted: number; rejected: unknown[] }; b: string } }
    ).state
    expect(state.a.accepted).toBe(1)
    expect(state.a.rejected).toEqual([{ index: 1, message: "a record is an object" }])
    expect(state.b).toContain('unknown kind "projects.issue"')
    expect(r.rejected).toEqual([
      { index: 1, message: "a record is an object", kind: "tickets.ticket" },
    ])
  })

  it("import, export and require are refused before anything runs, with a message", async () => {
    const cases = [
      `import { parse } from "csv"\nfunction transform(b, ctx) {}`,
      `export function transform(b, ctx) {}`,
      `function transform(b, ctx) { var fs = require("fs") }`,
      `async function transform(b, ctx) { await import("node:fs") }`,
    ]
    for (const source of cases) {
      let err: unknown
      try {
        await runTransformCall({
          source,
          entry: "transform",
          params: {},
          host: { ...host, sourceType: "upload" },
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(TransformSourceError)
      expect((err as Error).message).toMatch(
        /(import|export|require\(\)) is not available in a transform/,
      )
      expect((err as Error).message).toContain("function transform(batch, ctx)")
    }
  })

  it("keywords inside strings and comments do not trip the module check", async () => {
    const r = await runTransformCall({
      source: `
        // import this, export that, require("x")
        function transform(batch, ctx) {
          return { state: { note: "import the rows; export nothing; require(nothing)" } }
        }`,
      entry: "transform",
      params: {},
      host: { ...host, sourceType: "upload" },
    })
    expect(r.value).toEqual({
      state: { note: "import the rows; export nothing; require(nothing)" },
    })
  })

  it("a source without the entry function is refused by name", async () => {
    await expect(
      runTransformCall({
        source: "function convert(b) {}",
        entry: "transform",
        params: {},
        host: { ...host, sourceType: "upload" },
      }),
    ).rejects.toThrow("must define a top-level function transform(batch, ctx)")
  })
})

describe("transform executor: upload loop", () => {
  it("calls finish once after the last batch, with the state, so a group still open is emitted", async () => {
    const emitted: unknown[] = []
    const r = await runUploadTransform({
      source: `
        async function transform(batch, ctx) {
          var open = (batch.state && batch.state.open) || null
          var out = []
          for (var i = 0; i < batch.records.length; i++) {
            var row = batch.records[i]
            if (open && open.key !== row.key) { out.push(open); open = null }
            if (!open) open = { key: row.key, rows: 0 }
            open.rows++
          }
          if (out.length) await ctx.emitRecords("tickets.ticket", out)
          return { state: { open: open } }
        }
        async function finish(batch, ctx) {
          if (batch.state && batch.state.open) await ctx.emitRecords("tickets.ticket", [batch.state.open])
          return {}
        }`,
      files: [{ name: "rows.csv", kind: "csv" }],
      batches: batchesOf(
        batch([{ key: "a" }, { key: "a" }, { key: "b" }], 1, "rows.csv"),
        batch([{ key: "b" }, { key: "c" }], 4, "rows.csv"),
      ),
      host,
      sink: {
        onEmitted: async (b) => {
          for (const x of b) emitted.push(...x.records)
        },
      },
    })
    expect(emitted).toEqual([
      { key: "a", rows: 2 },
      { key: "b", rows: 2 },
      { key: "c", rows: 1 },
    ])
    expect(r.batches).toBe(2)
  })

  it("a transform without finish is called for its batches only", async () => {
    let calls = 0
    await runUploadTransform({
      source: `async function transform(batch, ctx) { return {} }`,
      files: [{ name: "rows.csv", kind: "csv" }],
      batches: batchesOf(batch([{ key: "a" }], 1, "rows.csv")),
      host,
      sink: { onEmitted: async () => {} },
      onBatch: () => {
        calls++
      },
    })
    expect(calls).toBe(1)
  })

  it("finish is the global one only: a top-level const finish is called, a helper named finish inside another function is not", async () => {
    const emitted: unknown[] = []
    const sink = {
      onEmitted: async (b: Array<{ records: unknown[] }>) => {
        for (const x of b) emitted.push(...x.records)
      },
    }
    await runUploadTransform({
      source: `
        async function transform(batch, ctx) { return { state: { last: batch.records[0].key } } }
        const finish = async (batch, ctx) => {
          await ctx.emitRecords("tickets.ticket", [{ key: batch.state.last, from: "finish" }])
          return {}
        }`,
      files: [{ name: "rows.csv", kind: "csv" }],
      batches: batchesOf(batch([{ key: "z" }], 1, "rows.csv")),
      host,
      sink,
    })
    expect(emitted).toEqual([{ key: "z", from: "finish" }])

    let calls = 0
    const r = await runUploadTransform({
      source: `
        async function transform(batch, ctx) {
          function finish(x) { return x }
          return { state: { done: finish(true) } }
        }`,
      files: [{ name: "rows.csv", kind: "csv" }],
      batches: batchesOf(batch([{ key: "a" }], 1, "rows.csv")),
      host,
      sink: { onEmitted: async () => {} },
      onBatch: () => {
        calls++
      },
    })
    // No global finish: the batches only, and the run does not fail.
    expect(calls).toBe(1)
    expect(r.batches).toBe(1)
  })

  it("carries state across batches; each call is a fresh context", async () => {
    const { sink, emitted } = collectingSink()
    const r = await runUploadTransform({
      source: `
        var calls = (typeof calls === "number" ? calls : 0) + 1
        async function transform(batch, ctx) {
          var seen = (batch.state && batch.state.seen) || 0
          await ctx.emitRecords("tickets.ticket", batch.records.map(function (r) { return { n: r.n, calls: calls } }))
          return { state: { seen: seen + batch.records.length } }
        }`,
      files: [{ name: "tickets.csv", kind: "csv" }],
      batches: batchesOf(batch([{ n: 1 }, { n: 2 }], 1), batch([{ n: 3 }], 3)),
      host,
      sink,
    })
    expect(r).toMatchObject({ batches: 2, records: 3, state: { seen: 3 } })
    expect(emitted.flatMap((e) => e.records)).toEqual([
      { n: 1, calls: 1 },
      { n: 2, calls: 1 },
      { n: 3, calls: 1 },
    ])
  })

  it("a call that throws emits nothing and names its batch", async () => {
    const { sink, emitted } = collectingSink()
    const err = await runUploadTransform({
      source: `
        async function transform(batch, ctx) {
          await ctx.emitRecords("tickets.ticket", [{ offset: batch.offset }])
          if (batch.offset > 1) throw new Error("unexpected column 'Prioriy'")
          return {}
        }`,
      files: [{ name: "tickets.csv", kind: "csv" }],
      batches: batchesOf(batch([{ a: 1 }], 1), batch([{ a: 2 }], 2)),
      host,
      sink,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransformRunError)
    expect((err as TransformRunError).step).toBe(2)
    expect((err as Error).message).toContain("batch 2 (tickets.csv, records 2-2)")
    expect((err as Error).message).toContain("unexpected column 'Prioriy'")
    expect(emitted).toEqual([{ kind: "tickets.ticket", records: [{ offset: 1 }] }])
  })

  it("an endless loop is killed by the call deadline under production limits, naming the batch", async () => {
    const { sink } = collectingSink()
    const started = Date.now()
    const err = await runUploadTransform({
      source: `
          function transform(batch, ctx) {
            if (batch.offset > 1) { for (;;) {} }
            return {}
          }`,
      files: [{ name: "tickets.csv", kind: "csv" }],
      batches: batchesOf(batch([{ a: 1 }], 1), batch([{ a: 2 }], 2)),
      host,
      sink,
      budgetMs: 1,
      env: PRODUCTION_ENV,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransformRunError)
    expect((err as Error).message).toContain("batch 2")
    expect((err as Error).message).toContain("timed out")
    // Production floors the budget at the sandbox base (5 s), never longer than the grace.
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)
})

describe("transform executor: API pull loop", () => {
  it("a 429 page is retried after Retry-After and its records are not kept twice", async () => {
    const { sink, emitted } = collectingSink()
    let gets = 0
    const waits: number[] = []
    const r = await runApiPull({
      source: `
        async function pull(page, ctx) {
          var at = page.cursor || 0
          await ctx.emitRecords("tickets.ticket", [{ page: at }])
          var res = await ctx.apiGet("/items?start=" + at)
          if (res.status === 429) return { nextCursor: at }
          return { nextCursor: res.data.next, state: { last: at } }
        }`,
      host: {
        ...host,
        apiGet: async (path: string) => {
          gets++
          if (gets === 2) return { status: 429, data: null, retryAfterMs: 1500 }
          const start = Number(new URL(path, "https://x.example").searchParams.get("start"))
          return { status: 200, data: { next: start >= 2 ? null : start + 1 }, retryAfterMs: null }
        },
      },
      sink,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(r.stoppedOn).toBe("done")
    expect(r.pages).toBe(3)
    expect(waits).toEqual([1500])
    expect(emitted.flatMap((e) => e.records)).toEqual([{ page: 0 }, { page: 1 }, { page: 2 }])
  })

  it("a repeated cursor stops the run", async () => {
    const { sink } = collectingSink()
    const r = await runApiPull({
      source: `async function pull(page, ctx) { return { nextCursor: "same" } }`,
      host,
      sink,
    })
    expect(r).toMatchObject({ pages: 2, stoppedOn: "repeated_cursor", nextCursor: "same" })
  })

  it("downloads are recorded during the call and performed by the host after it, before its records reach the sink", async () => {
    const order: string[] = []
    const r = await runApiPull({
      source: `
        async function pull(page, ctx) {
          var ref = await ctx.downloadToFile("/attachment/content/10001", { filename: "invoice.pdf" })
          await ctx.emitRecords("tickets.ticket", [{ attachment: ref }])
          return { nextCursor: null }
        }`,
      host,
      sink: {
        onEmitted: async (b) => {
          order.push(`emitted:${JSON.stringify(b[0]?.records)}`)
        },
        onDownloads: async (d) => {
          order.push(`downloads:${JSON.stringify(d)}`)
        },
      },
    })
    expect(r.stoppedOn).toBe("done")
    expect(order).toEqual([
      'downloads:[{"refId":"download:1","path":"/attachment/content/10001","filename":"invoice.pdf"}]',
      'emitted:[{"attachment":"download:1"}]',
    ])
  })
})

describe("transform executor: heap bound on a 200 MB CSV (A20)", () => {
  const dir = mkdtempSync(join(tmpdir(), "liaison-transform-heap-"))
  const csvPath = join(dir, "tickets-200mb.csv")
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function writeFixture(targetBytes: number): Promise<number> {
    const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(70)
    const writer = Bun.file(csvPath).writer()
    writer.write("id,subject,body\n")
    let written = 0
    let rows = 0
    while (written < targetBytes) {
      rows++
      const line = `${rows},Subject ${rows},${body}${rows}\n`
      writer.write(line)
      written += line.length
    }
    await writer.end()
    return rows
  }

  async function* lines(path: string): AsyncGenerator<ParsedRecord> {
    const decoder = new TextDecoder()
    let rest = ""
    let n = -1
    for await (const chunk of Bun.file(path).stream()) {
      rest += decoder.decode(chunk, { stream: true })
      let at = rest.indexOf("\n")
      while (at >= 0) {
        const line = rest.slice(0, at)
        rest = rest.slice(at + 1)
        n++
        if (n > 0) {
          const [id, subject, body] = line.split(",")
          yield { number: n, value: { id, subject, body } }
        }
        at = rest.indexOf("\n")
      }
    }
  }

  it("imports the whole file batch by batch with the sandbox heap under 32 MiB; the whole file as one argument fails", async () => {
    const rows = await writeFixture(200 * 1024 * 1024)
    expect(statSync(csvPath).size).toBeGreaterThanOrEqual(200 * 1024 * 1024)

    let emittedCount = 0
    const heaps: number[] = []
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
      files: [{ name: "tickets-200mb.csv", kind: "csv" }],
      batches: batchRecords("tickets-200mb.csv", lines(csvPath)),
      host,
      sink: {
        onEmitted: async (b) => {
          for (const e of b) emittedCount += e.records.length
        },
      },
      env: PRODUCTION_ENV,
      onBatch: (rep) => {
        if (rep.heapBytes !== null) heaps.push(rep.heapBytes)
      },
    })
    expect(r.records).toBe(rows)
    expect(emittedCount).toBe(rows)
    expect(r.state).toEqual({ lastId: String(rows) })
    expect(heaps.length).toBe(r.batches)
    const peak = Math.max(...heaps)
    expect(r.peakHeapBytes).toBe(peak)
    expect(peak).toBeLessThan(TRANSFORM_MEMORY_LIMIT_BYTES)
    console.info(
      `[A20] ${rows} rows in ${r.batches} batches; peak sandbox heap ${(peak / 1024 / 1024).toFixed(1)} MiB of ${TRANSFORM_MEMORY_LIMIT_BYTES / 1024 / 1024} MiB`,
    )

    // Discriminator: the same file handed to the sandbox in one call fails.
    const whole = await Bun.file(csvPath).text()
    const err = await runTransformCall({
      source: `function transform(batch, ctx) { return { state: { n: batch.text.length } } }`,
      entry: "transform",
      params: { text: whole },
      host: { ...host, sourceType: "upload" },
      env: PRODUCTION_ENV,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    console.info(`[A20] whole file as one argument: ${(err as Error).message.slice(0, 200)}`)
    expect((err as Error).message).toMatch(/out of memory|memory ceiling/i)
  }, 600_000)
})
