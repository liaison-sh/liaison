// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.7. STREAM attachment encryption (Rogaway-Hoang, as instantiated by
// Tink and age), spec section 3.5.
//
// Per-chunk AAD alone prevents reordering and cross-file substitution but NOT
// truncation: dropping the trailing objects of a 50 MB attachment leaves a
// stream where every remaining chunk verifies perfectly. So the nonce carries a
// final flag and chunk 0's AAD binds the authenticated chunk count and total
// plaintext length.
//
// `stream-seal.ts` and `stream-open.ts` are imported separately here: the
// encryptor is seal-safe and the decryptor is client only.
//
// T-CRYPTO-6 round trip. T-CRYPTO-12 truncation and reordering fail closed.

import { describe, expect, it } from "bun:test"
import { type Bytes, toHex } from "./bytes"
import { generateContentKey } from "./seal"
import { decryptAttachmentStream } from "./stream-open"
import {
  type AttachmentStreamHeader,
  encryptAttachmentStream,
  STREAM_CHUNK_SIZE,
  STREAM_NONCE_PREFIX_BYTES,
  streamChunkCount,
} from "./stream-seal"

const fileId = "f0f0f0f0-0000-4000-8000-000000000003"
const keyId = 7

async function collect(chunks: AsyncIterable<Bytes>): Promise<Bytes[]> {
  const out: Bytes[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

function join(parts: Bytes[]): Bytes {
  const total = parts.reduce((acc, p) => acc + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

async function seal(plaintext: Bytes, chunkSize: number, contentKey: Bytes) {
  const sealed = await encryptAttachmentStream({
    contentKey,
    fileId,
    keyId,
    plaintextLength: plaintext.length,
    chunkSize,
    source: plaintext,
  })
  return { header: sealed.header, chunks: await collect(sealed.chunks) }
}

async function open(
  header: AttachmentStreamHeader,
  chunks: Bytes[],
  contentKey: Bytes,
): Promise<Bytes> {
  return join(await collect(decryptAttachmentStream({ contentKey, fileId, header, chunks })))
}

describe("T-CRYPTO-6 attachment stream round trip", () => {
  const cases = [
    { name: "a zero byte file", length: 0, chunkSize: 64, chunks: 1 },
    { name: "a file shorter than one chunk", length: 10, chunkSize: 64, chunks: 1 },
    { name: "a file exactly one chunk long", length: 64, chunkSize: 64, chunks: 1 },
    { name: "a file one byte over a chunk", length: 65, chunkSize: 64, chunks: 2 },
    { name: "a file exactly n chunks long", length: 256, chunkSize: 64, chunks: 4 },
    { name: "a file with a short final chunk", length: 300, chunkSize: 64, chunks: 5 },
  ]

  for (const testCase of cases) {
    it(`round trips ${testCase.name}`, async () => {
      const contentKey = generateContentKey()
      const plaintext = crypto.getRandomValues(new Uint8Array(testCase.length))
      const { header, chunks } = await seal(plaintext, testCase.chunkSize, contentKey)
      expect(header.chunkCount).toBe(testCase.chunks)
      expect(chunks.length).toBe(testCase.chunks)
      expect(header.plaintextLength).toBe(testCase.length)
      expect(header.noncePrefix.length).toBe(STREAM_NONCE_PREFIX_BYTES)
      expect(toHex(await open(header, chunks, contentKey))).toBe(toHex(plaintext))
    })
  }

  it("round trips at the real 64 KiB chunk size across chunk boundaries", async () => {
    const contentKey = generateContentKey()
    expect(STREAM_CHUNK_SIZE).toBe(65536)
    const plaintext = crypto.getRandomValues(new Uint8Array(STREAM_CHUNK_SIZE * 2 + 17))
    const sealed = await encryptAttachmentStream({
      contentKey,
      fileId,
      keyId,
      plaintextLength: plaintext.length,
      source: plaintext,
    })
    const chunks = await collect(sealed.chunks)
    expect(sealed.header.chunkSize).toBe(STREAM_CHUNK_SIZE)
    expect(sealed.header.chunkCount).toBe(3)
    expect(toHex(await open(sealed.header, chunks, contentKey))).toBe(toHex(plaintext))
  })

  it("accepts a source that arrives in ragged pieces", async () => {
    const contentKey = generateContentKey()
    const plaintext = crypto.getRandomValues(new Uint8Array(200))
    const pieces = [plaintext.subarray(0, 3), plaintext.subarray(3, 130), plaintext.subarray(130)]
    const sealed = await encryptAttachmentStream({
      contentKey,
      fileId,
      keyId,
      plaintextLength: plaintext.length,
      chunkSize: 64,
      source: pieces,
    })
    const chunks = await collect(sealed.chunks)
    expect(toHex(await open(sealed.header, chunks, contentKey))).toBe(toHex(plaintext))
  })

  it("computes the chunk count the same way for every size", () => {
    expect(streamChunkCount(0, 64)).toBe(1)
    expect(streamChunkCount(1, 64)).toBe(1)
    expect(streamChunkCount(64, 64)).toBe(1)
    expect(streamChunkCount(65, 64)).toBe(2)
    expect(streamChunkCount(128, 64)).toBe(2)
  })

  it("refuses a source whose length does not match the declared length", async () => {
    const contentKey = generateContentKey()
    const sealed = await encryptAttachmentStream({
      contentKey,
      fileId,
      keyId,
      plaintextLength: 100,
      chunkSize: 64,
      source: new Uint8Array(90),
    })
    await expect(collect(sealed.chunks)).rejects.toThrow()
  })

  it("draws a fresh nonce prefix per file", async () => {
    const contentKey = generateContentKey()
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const { header } = await seal(new Uint8Array(10), 64, contentKey)
      seen.add(toHex(header.noncePrefix))
    }
    expect(seen.size).toBe(4)
  })
})

describe("T-CRYPTO-12 the stream fails closed", () => {
  const plaintextLength = 300
  const chunkSize = 64

  async function fixture() {
    const contentKey = generateContentKey()
    const plaintext = crypto.getRandomValues(new Uint8Array(plaintextLength))
    const { header, chunks } = await seal(plaintext, chunkSize, contentKey)
    // Non-vacuity: the untampered stream opens.
    expect(toHex(await open(header, chunks, contentKey))).toBe(toHex(plaintext))
    return { contentKey, plaintext, header, chunks }
  }

  it("refuses a stream with the final chunk dropped", async () => {
    const { contentKey, header, chunks } = await fixture()
    await expect(open(header, chunks.slice(0, -1), contentKey)).rejects.toThrow()
  })

  it("refuses a truncated stream that also lies about the chunk count", async () => {
    const { contentKey, header, chunks } = await fixture()
    const lying = { ...header, chunkCount: header.chunkCount - 1, plaintextLength: chunkSize * 4 }
    await expect(open(lying, chunks.slice(0, -1), contentKey)).rejects.toThrow()
  })

  it("refuses a stream with two chunks swapped", async () => {
    const { contentKey, header, chunks } = await fixture()
    const swapped = [...chunks]
    const first = swapped[1]
    swapped[1] = swapped[2]
    swapped[2] = first
    await expect(open(header, swapped, contentKey)).rejects.toThrow()
  })

  it("refuses a chunk spliced in from another file at the same index", async () => {
    const { contentKey, header, chunks } = await fixture()
    const otherFile = await encryptAttachmentStream({
      contentKey,
      fileId: "aaaaaaaa-0000-4000-8000-00000000000a",
      keyId,
      plaintextLength,
      chunkSize,
      source: crypto.getRandomValues(new Uint8Array(plaintextLength)),
    })
    const otherChunks = await collect(otherFile.chunks)
    const spliced = [...chunks]
    spliced[2] = otherChunks[2]
    await expect(open(header, spliced, contentKey)).rejects.toThrow()
  })

  it("refuses a chunk spliced in from another stream of the same file", async () => {
    const { contentKey, header, chunks } = await fixture()
    const second = await seal(
      crypto.getRandomValues(new Uint8Array(plaintextLength)),
      chunkSize,
      contentKey,
    )
    const spliced = [...chunks]
    spliced[2] = second.chunks[2]
    await expect(open(header, spliced, contentKey)).rejects.toThrow()
  })

  it("refuses extra chunks appended past the authenticated count", async () => {
    const { contentKey, header, chunks } = await fixture()
    await expect(open(header, [...chunks, chunks[0]], contentKey)).rejects.toThrow()
  })

  it("refuses a flipped byte in any chunk", async () => {
    const { contentKey, header, chunks } = await fixture()
    for (let i = 0; i < chunks.length; i++) {
      const tampered = chunks.map((c, index) => (index === i ? Uint8Array.from(c) : c))
      tampered[i][0] ^= 0x01
      await expect(open(header, tampered, contentKey), `chunk ${i}`).rejects.toThrow()
    }
  })

  it("refuses a substituted nonce prefix, a changed key id and a changed length", async () => {
    const { contentKey, header, chunks } = await fixture()
    const prefix = crypto.getRandomValues(new Uint8Array(STREAM_NONCE_PREFIX_BYTES))
    await expect(open({ ...header, noncePrefix: prefix }, chunks, contentKey)).rejects.toThrow()
    await expect(open({ ...header, keyId: keyId + 1 }, chunks, contentKey)).rejects.toThrow()
    await expect(
      open({ ...header, plaintextLength: plaintextLength - 1 }, chunks, contentKey),
    ).rejects.toThrow()
  })

  it("refuses the whole file under a different content key", async () => {
    const { header, chunks } = await fixture()
    await expect(open(header, chunks, generateContentKey())).rejects.toThrow()
  })
})
