// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The range-based zip reader on fixtures generated at test time by the
// test-only writer: deflate, stored with a data descriptor, ZIP64, the
// refusals (encryption, unknown method, too many entries) and the bomb caps.
import { afterAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { deflateSync } from "fflate"
import { deleteObject, putObject } from "~/infra/storage/object-storage"
import { buildZip } from "./__test-helpers__/zip-writer"
import { ParserError } from "./common"
import {
  bufferRangeSource,
  DEFAULT_ZIP_CAPS,
  objectRangeSource,
  type RangeSource,
  readZipDirectory,
  readZipEntry,
  windowedRangeSource,
  ZipBudget,
  type ZipEntry,
} from "./zip"

async function entryBytes(
  src: RangeSource,
  entry: ZipEntry,
  budget = new ZipBudget(src.size),
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const c of readZipEntry(src, entry, budget)) chunks.push(c)
  return Buffer.concat(chunks)
}

async function errorOf(p: Promise<unknown>): Promise<ParserError> {
  try {
    await p
  } catch (err) {
    if (err instanceof ParserError) return err
    throw err
  }
  throw new Error("expected a ParserError")
}

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe("zip reader: formats", () => {
  it("reads deflate entries and directories", async () => {
    const body = "id,subject\n1,Printer offline\n".repeat(500)
    const src = bufferRangeSource(
      buildZip([
        { name: "export/", method: 0 },
        { name: "export/tickets.csv", data: body },
      ]),
    )
    const entries = await readZipDirectory(src)
    expect(entries.map((e) => [e.name, e.isDirectory, e.method])).toEqual([
      ["export/", true, 0],
      ["export/tickets.csv", false, 8],
    ])
    expect(text(await entryBytes(src, entries[1] as ZipEntry))).toBe(body)
  })

  it("reads a stored entry written with a data descriptor (sizes from the central directory)", async () => {
    const src = bufferRangeSource(
      buildZip([
        { name: "a.json", data: '{"a":1}', method: 0, dataDescriptor: true },
        { name: "b.json", data: '{"b":2}', method: 8, dataDescriptor: true },
      ]),
    )
    const [a, b] = await readZipDirectory(src)
    expect(text(await entryBytes(src, a as ZipEntry))).toBe('{"a":1}')
    expect(text(await entryBytes(src, b as ZipEntry))).toBe('{"b":2}')
  })

  it("reads ZIP64: the ZIP64 end of central directory and the per-entry 0x0001 extra field", async () => {
    const src = bufferRangeSource(
      buildZip(
        [
          { name: "one.txt", data: "first" },
          { name: "two.txt", data: "second", method: 0 },
        ],
        { forceZip64: true },
      ),
    )
    const entries = await readZipDirectory(src)
    expect(entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ["one.txt", 5],
      ["two.txt", 6],
    ])
    expect(text(await entryBytes(src, entries[1] as ZipEntry))).toBe("second")
  })

  it("merges the reads of adjacent small entries through one window", async () => {
    const zip = buildZip(
      Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.json`, data: `{"i":${i}}` })),
    )
    let underlying = 0
    const base = bufferRangeSource(zip)
    const counted: RangeSource = {
      size: base.size,
      read: (o, l) => {
        underlying++
        return base.read(o, l)
      },
    }
    const src = windowedRangeSource(counted)
    const entries = await readZipDirectory(src)
    underlying = 0
    for (const e of entries)
      expect(text(await entryBytes(src, e))).toBe(`{"i":${e.name.slice(1, -5)}}`)
    expect(underlying).toBeLessThan(5)
  })

  it("reads an archive stored in the object store by ranged GETs", async () => {
    const key = `test/zip-reader/${randomUUID()}.zip`
    const body = "x,y\n".repeat(50_000)
    await putObject({
      key,
      body: buildZip([
        { name: "big.csv", data: body },
        { name: "small.txt", data: "ok" },
      ]),
      contentType: "application/zip",
    })
    try {
      const src = windowedRangeSource(await objectRangeSource(key))
      const entries = await readZipDirectory(src)
      expect(text(await entryBytes(src, entries[0] as ZipEntry))).toBe(body)
      expect(text(await entryBytes(src, entries[1] as ZipEntry))).toBe("ok")
    } finally {
      await deleteObject(key)
    }
  })
})

describe("zip reader: refusals", () => {
  it("refuses an encrypted archive, naming the entries", async () => {
    const src = bufferRangeSource(
      buildZip([
        { name: "public.txt", data: "hello" },
        { name: "salaries.xlsx", data: "garbage", method: 0, encrypted: true },
      ]),
    )
    const err = await errorOf(readZipDirectory(src))
    expect(err.code).toBe("zip_encrypted")
    expect(err.message).toContain("salaries.xlsx")
    expect(err.message).not.toContain("public.txt")
  })

  it("refuses compression methods other than stored and deflate, by name", async () => {
    const src = bufferRangeSource(buildZip([{ name: "data.csv", data: "x", method: 12 }]))
    const err = await errorOf(readZipDirectory(src))
    expect(err.code).toBe("zip_unsupported_method")
    expect(err.message).toContain("data.csv (bzip2)")
  })

  it("refuses 200,001 entries from the directory record, before reading entries", async () => {
    const zip = buildZip(Array.from({ length: 200_001 }, (_, i) => ({ name: `e${i}`, method: 0 })))
    const err = await errorOf(readZipDirectory(bufferRangeSource(zip)))
    expect(err.code).toBe("zip_too_many_entries")
    expect(err.message).toContain("200001 entries")
  }, 60_000)

  it("refuses an entry that expands more than 100 times", async () => {
    const zeros = new Uint8Array(20 * 1024 * 1024)
    const src = bufferRangeSource(buildZip([{ name: "bomb.csv", data: zeros }]))
    const [entry] = await readZipDirectory(src)
    const err = await errorOf(entryBytes(src, entry as ZipEntry))
    expect(err.code).toBe("zip_ratio_exceeded")
    expect(err.message).toContain("bomb.csv expands more than 100 times")
  })

  it("refuses an entry that inflates past the size it declares", async () => {
    const compressed = deflateSync(new Uint8Array(512 * 1024).fill(65))
    const src = bufferRangeSource(
      buildZip([{ name: "liar.txt", raw: { compressed, uncompressedSize: 10 } }]),
    )
    const [entry] = await readZipDirectory(src)
    const err = await errorOf(entryBytes(src, entry as ZipEntry))
    expect(err.code).toBe("zip_ratio_exceeded")
    expect(err.message).toContain("more than the 10 bytes it declares")
  })

  it("refuses a nested zip bomb: the inner archive's entries count against the same caps", async () => {
    const inner = buildZip(
      Array.from({ length: 4 }, (_, i) => ({
        name: `layer-${i}.bin`,
        data: new Uint8Array(16 * 1024 * 1024),
      })),
    )
    const outer = bufferRangeSource(
      buildZip(Array.from({ length: 3 }, (_, i) => ({ name: `nested-${i}.zip`, data: inner }))),
    )
    const budget = new ZipBudget(outer.size)
    const [first] = await readZipDirectory(outer)
    const innerBytes = await entryBytes(outer, first as ZipEntry, budget)
    const innerSrc = bufferRangeSource(innerBytes)
    const [layer] = await readZipDirectory(innerSrc)
    const err = await errorOf(entryBytes(innerSrc, layer as ZipEntry, budget))
    expect(err.code).toBe("zip_ratio_exceeded")
  })

  it("refuses an upload whose entries together pass 20 times its size", async () => {
    // Entries that each stay under the per-entry ratio (about 50x) but add up
    // past the total. The 64 MiB floor is lowered so the fixture stays small.
    const caps = { ...DEFAULT_ZIP_CAPS, totalFloorBytes: 0 }
    const block = new Uint8Array(2 * 1024 * 1024)
    for (let i = 0; i < block.byteLength; i += 50) block[i] = (i * 7919) & 0xff
    const src = bufferRangeSource(
      buildZip(Array.from({ length: 4 }, (_, i) => ({ name: `part-${i}.bin`, data: block }))),
    )
    const budget = new ZipBudget(src.size, caps)
    expect(budget.limit).toBe(src.size * 20)
    const entries = await readZipDirectory(src, caps)
    const err = await errorOf(
      (async () => {
        for (const e of entries) for await (const _ of readZipEntry(src, e, budget, caps)) void _
      })(),
    )
    expect(err.code).toBe("zip_decompressed_too_large")
  })

  it("the total cap is 20 times the upload, at least 64 MiB, at most 50 GB", () => {
    expect(new ZipBudget(1024).limit).toBe(64 * 1024 * 1024)
    expect(new ZipBudget(100 * 1024 * 1024).limit).toBe(2000 * 1024 * 1024)
    expect(new ZipBudget(10 * 1024 * 1024 * 1024).limit).toBe(50 * 1024 * 1024 * 1024)
  })

  it("refuses a file that is not a zip", async () => {
    const err = await errorOf(
      readZipDirectory(bufferRangeSource(new TextEncoder().encode("id,name\n1,x\n".repeat(10)))),
    )
    expect(err.code).toBe("invalid_zip")
  })
})

afterAll(() => undefined)

describe("zip reader: the central directory read is bounded", () => {
  it("refuses a directory far larger than its entries can need, before reading it", async () => {
    const zip = buildZip([
      { name: "big.bin", data: new Uint8Array(3 * 1024 * 1024).fill(7), method: 0 },
    ])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const eocd = zip.byteLength - 22
    dv.setUint32(eocd + 12, eocd, true) // cdSize: everything before the EOCD
    dv.setUint32(eocd + 16, 0, true) // cdOffset: the start of the file
    let read = 0
    const base = bufferRangeSource(zip)
    const src: RangeSource = {
      size: base.size,
      read: (o, l) => {
        read += l
        return base.read(o, l)
      },
    }
    const err = await errorOf(readZipDirectory(src))
    expect(err.code).toBe("invalid_zip")
    expect(err.message).toContain("central directory is larger")
    expect(read).toBeLessThan(200 * 1024)
  })
})
