// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The server-side streaming writer against the dev object store: a stream of
// unknown length lands as one object, in 8 MiB parts when it needs them, and
// a stream past its limit leaves nothing behind.
import { afterAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { putObjectStream, StreamTooLargeError } from "./multipart"
import { deleteObject, getObjectBuffer, headObject } from "./object-storage"

const MIB = 1024 * 1024
const keys: string[] = []

async function* chunks(total: number, size = 1 * MIB): AsyncGenerator<Uint8Array> {
  let sent = 0
  let n = 0
  while (sent < total) {
    const len = Math.min(size, total - sent)
    yield new Uint8Array(len).fill(n++ % 251)
    sent += len
  }
}

function key(): string {
  const k = `test/multipart-stream/${randomUUID()}.bin`
  keys.push(k)
  return k
}

afterAll(async () => {
  for (const k of keys) await deleteObject(k).catch(() => undefined)
})

describe("putObjectStream", () => {
  it("writes a stream larger than a part as a multipart object", async () => {
    const k = key()
    const total = 2 * 8 * MIB + 12345
    const written = await putObjectStream({
      key: k,
      contentType: "application/pdf",
      body: chunks(total),
      maxBytes: 100 * MIB,
    })
    expect(written).toBe(total)
    const head = await headObject(k)
    expect(head.contentLength).toBe(total)
    expect(head.contentType).toBe("application/pdf")
  }, 60_000)

  it("writes a small stream with one PUT", async () => {
    const k = key()
    const written = await putObjectStream({
      key: k,
      contentType: "text/plain",
      body: chunks(1000, 100),
      maxBytes: MIB,
    })
    expect(written).toBe(1000)
    expect((await getObjectBuffer(k)).byteLength).toBe(1000)
  })

  it("refuses a stream past its limit and leaves no object", async () => {
    const k = key()
    await expect(
      putObjectStream({
        key: k,
        contentType: "application/zip",
        body: chunks(20 * MIB),
        maxBytes: 9 * MIB,
      }),
    ).rejects.toBeInstanceOf(StreamTooLargeError)
    await expect(headObject(k)).rejects.toThrow()
  }, 60_000)
})
