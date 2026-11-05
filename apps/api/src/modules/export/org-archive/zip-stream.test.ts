// SPDX-License-Identifier: FSL-1.1-ALv2
// The streaming zip writer behind the whole-org export: real zip output, the
// no-ZIP64 guards (EXPORT_TOO_LARGE before 4 GiB or 65,000 entries), the
// bounded queue between fflate and the upload, and safe entry names.
import { describe, expect, it } from "bun:test"
import { unzipSync } from "fflate"
import {
  ExportTooLargeError,
  fileEntryName,
  ZIP_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  ZipStreamWriter,
} from "./zip-stream"

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of it) parts.push(c)
  return new Uint8Array(Buffer.concat(parts))
}

describe("ZipStreamWriter", () => {
  it("writes a zip whose entries read back byte-equal (deflate and stored)", async () => {
    const w = new ZipStreamWriter()
    const out = collect(w.output())
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251)
    await w.addEntry("data/kernel.users.ndjson", '{"a":1}\n{"a":2}\n', { deflate: true })
    await w.addEntry(
      "files/1/photo.bin",
      (async function* () {
        yield big.subarray(0, 100_000)
        yield big.subarray(100_000)
      })(),
      { deflate: false, sizeHint: big.byteLength },
    )
    await w.addEntry("manifest.json", "{}", { deflate: true })
    await w.finish()
    const files = unzipSync(await out)
    expect(Object.keys(files)).toEqual([
      "data/kernel.users.ndjson",
      "files/1/photo.bin",
      "manifest.json",
    ])
    expect(new TextDecoder().decode(files["data/kernel.users.ndjson"])).toBe('{"a":1}\n{"a":2}\n')
    expect(Buffer.from(files["files/1/photo.bin"] as Uint8Array).equals(Buffer.from(big))).toBe(
      true,
    )
  })

  it("refuses the entry past the entry limit with EXPORT_TOO_LARGE naming both numbers", async () => {
    const w = new ZipStreamWriter({ maxEntries: 2 })
    const out = collect(w.output()).catch((e) => e)
    await w.addEntry("a", "1", { deflate: true })
    await w.addEntry("b", "2", { deflate: true })
    const err = await w.addEntry("c", "3", { deflate: true }).catch((e) => e)
    expect(err).toBeInstanceOf(ExportTooLargeError)
    expect((err as ExportTooLargeError).code).toBe("EXPORT_TOO_LARGE")
    expect(String((err as Error).message)).toContain("2 entries")
    expect(String((err as Error).message)).toContain(String(4 * 1024 ** 3))
    // The upload side sees the failure too (so the multipart upload aborts).
    expect(await out).toBeInstanceOf(ExportTooLargeError)
  })

  it("refuses before passing the byte limit (size hint and actual bytes)", async () => {
    const w = new ZipStreamWriter({ maxBytes: 10_000 })
    const out = collect(w.output()).catch((e) => e)
    await w.addEntry("small", "x", { deflate: false })
    const hinted = await w
      .addEntry("big", new Uint8Array(20_000), { deflate: false, sizeHint: 20_000 })
      .catch((e) => e)
    expect(hinted).toBeInstanceOf(ExportTooLargeError)
    expect(String((hinted as Error).message)).toContain("65000")
    expect(await out).toBeInstanceOf(ExportTooLargeError)

    // No hint (an NDJSON stream): refused as the bytes pass the limit.
    const w2 = new ZipStreamWriter({ maxBytes: 10_000 })
    const out2 = collect(w2.output()).catch((e) => e)
    const rnd = new Uint8Array(30_000).map(() => Math.floor(Math.random() * 256))
    const live = await w2
      .addEntry(
        "stream",
        (async function* () {
          for (let i = 0; i < 3; i++) yield rnd.subarray(i * 10_000, (i + 1) * 10_000)
        })(),
        { deflate: false },
      )
      .catch((e) => e)
    expect(live).toBeInstanceOf(ExportTooLargeError)
    expect(await out2).toBeInstanceOf(ExportTooLargeError)
  })

  it("the defaults are the zip format's limits without ZIP64", () => {
    expect(ZIP_MAX_ENTRIES).toBe(65_000)
    expect(ZIP_MAX_BYTES).toBeLessThan(4 * 1024 ** 3)
  })

  it("the producer waits while the consumer is slow (bounded queue)", async () => {
    const w = new ZipStreamWriter({ highWaterBytes: 64 * 1024 })
    const chunk = new Uint8Array(32 * 1024).map(() => Math.floor(Math.random() * 256))
    let produced = 0
    const adding = w.addEntry(
      "f",
      (async function* () {
        for (let i = 0; i < 64; i++) {
          produced++
          yield chunk
        }
      })(),
      { deflate: false },
    )
    // Nobody reads: the producer must stall near the high-water mark.
    await new Promise((r) => setTimeout(r, 50))
    expect(produced).toBeLessThan(8)
    expect(w.queuedBytes).toBeLessThanOrEqual(64 * 1024 + chunk.byteLength + 1024)
    const out = collect(w.output())
    await adding
    await w.finish()
    expect((await out).byteLength).toBeGreaterThan(64 * chunk.byteLength)
    expect(produced).toBe(64)
  })

  it("a failed consumer wakes a waiting producer with the error", async () => {
    const w = new ZipStreamWriter({ highWaterBytes: 1024 })
    const adding = w
      .addEntry(
        "f",
        (async function* () {
          for (let i = 0; i < 100; i++) yield new Uint8Array(4096)
        })(),
        { deflate: false },
      )
      .catch((e) => e)
    const it = w.output()[Symbol.asyncIterator]()
    await it.next()
    await it.return?.(undefined)
    const err = await adding
    expect(err).toBeInstanceOf(Error)
  })
})

describe("fileEntryName", () => {
  it("keeps every name inside files/<id>/ (zip-slip)", () => {
    expect(fileEntryName("f1", "../../x")).toBe("files/f1/x")
    expect(fileEntryName("f1", "/etc/passwd")).toBe("files/f1/passwd")
    expect(fileEntryName("f1", "..")).toBe("files/f1/file")
    expect(fileEntryName("f1", "a\\..\\b.txt")).toBe("files/f1/b.txt")
    expect(fileEntryName("f1", "report.pdf")).toBe("files/f1/report.pdf")
  })
})
