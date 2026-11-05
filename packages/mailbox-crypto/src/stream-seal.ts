// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL ONLY. This module may run on the server: attachment sealing is host-side
// (spec section 5.8), so the encryptor has to be reachable from `apps/api`. The
// decryptor lives in `stream-open.ts` and is client only.
//
// STREAM (Rogaway-Hoang, as instantiated by Tink and age), spec section 3.5:
//
//   nonce = 7 byte per-file random prefix || 4 byte big-endian chunk counter
//           || 1 byte final flag (0x00 on every chunk, 0x01 on the last)
//
// Chunk 0's AAD additionally binds the authenticated chunk count and the total
// plaintext length. Together those make truncation detectable: a dropped tail
// leaves a stream that ends on a non-final chunk, and a stream that lies about
// its count fails chunk 0.

import { buildAad, mailboxAad } from "./aad"
import { blobHeader, MAILBOX_ENC_VERSION } from "./blob"
import { type Bytes, concatBytes, u32be, u64be, ZERO_BYTE } from "./bytes"
import { deriveFieldSubkey, type KeyMaterial } from "./kdf"

/** 64 KiB, so a 50 MB file streams and supports range requests. */
export const STREAM_CHUNK_SIZE = 65536

/** The random half of every chunk nonce. `streamNonce` appends a 4 byte chunk
 *  index and a 1 byte final flag, which is the 12 byte AES-GCM nonce. */
export const STREAM_NONCE_PREFIX_BYTES = 7
export const STREAM_TAG_BYTES = 16

/** The envelope `kernel.files` persists for a sealed attachment. */
export interface AttachmentStreamHeader {
  version: number
  keyId: number
  noncePrefix: Bytes
  chunkSize: number
  chunkCount: number
  plaintextLength: number
}

export class AttachmentStreamError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "AttachmentStreamError"
    this.cause = cause
  }
}

/** A zero byte file is one final, empty chunk. */
export function streamChunkCount(plaintextLength: number, chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new AttachmentStreamError(`chunk size must be a positive integer, got ${chunkSize}`)
  }
  if (!Number.isInteger(plaintextLength) || plaintextLength < 0) {
    throw new AttachmentStreamError(`plaintext length must be a non negative integer`)
  }
  return plaintextLength === 0 ? 1 : Math.ceil(plaintextLength / chunkSize)
}

export function streamNonce(noncePrefix: Bytes, index: number, isFinal: boolean): Bytes {
  if (noncePrefix.length !== STREAM_NONCE_PREFIX_BYTES) {
    throw new AttachmentStreamError(
      `nonce prefix must be ${STREAM_NONCE_PREFIX_BYTES} bytes, got ${noncePrefix.length}`,
    )
  }
  return concatBytes(noncePrefix, u32be(index), new Uint8Array([isFinal ? 0x01 : 0x00]))
}

/**
 * Chunk 0 binds the whole stream, every other chunk binds only the file. The
 * chunk index needs no AAD: it is in the nonce, so a reordered chunk decrypts
 * under the wrong nonce and fails its tag.
 */
export function streamChunkAad(
  header: AttachmentStreamHeader,
  fileId: string,
  index: number,
): Bytes {
  const base = buildAad(blobHeader(header.version, header.keyId), mailboxAad.attachment(fileId))
  if (index !== 0) return base
  return concatBytes(
    base,
    ZERO_BYTE,
    u32be(header.chunkCount),
    ZERO_BYTE,
    u64be(header.plaintextLength),
  )
}

/** The D5 subkey the whole stream runs under, derived once per file. */
export async function importAttachmentStreamKey(
  contentKey: KeyMaterial,
  fileId: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const context = mailboxAad.attachment(fileId)
  const subkey = await deriveFieldSubkey({
    contentKey,
    fieldName: context.fieldName,
    entityId: context.entityId,
  })
  const key = await crypto.subtle.importKey(
    "raw",
    subkey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  )
  subkey.fill(0)
  return key
}

export type ByteSource = Bytes | Iterable<Bytes> | AsyncIterable<Bytes>

async function* iterateSource(source: ByteSource): AsyncGenerator<Bytes> {
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  if (Symbol.asyncIterator in source) {
    for await (const piece of source as AsyncIterable<Bytes>) yield piece
    return
  }
  for (const piece of source as Iterable<Bytes>) yield piece
}

/** Re-cut a ragged source into exact `chunkSize` pieces, last one short. */
async function* rechunk(source: ByteSource, chunkSize: number): AsyncGenerator<Bytes> {
  let buffer = new Uint8Array(0)
  let emitted = 0
  for await (const piece of iterateSource(source)) {
    buffer = concatBytes(buffer, piece)
    while (buffer.length >= chunkSize) {
      yield buffer.subarray(0, chunkSize)
      buffer = buffer.subarray(chunkSize)
      emitted++
    }
  }
  // A trailing empty buffer is a chunk only for a zero byte file, whose single
  // final chunk is empty. A file that is an exact multiple of the chunk size
  // must NOT gain an extra empty chunk: its last full chunk carries the final
  // flag.
  if (buffer.length > 0 || emitted === 0) yield buffer
}

export interface EncryptAttachmentInput {
  contentKey: KeyMaterial
  fileId: string
  keyId: number
  /** Known up front, because chunk 0 authenticates it. */
  plaintextLength: number
  source: ByteSource
  chunkSize?: number
  version?: number
  /** Test seam only. Production always draws a fresh prefix. */
  noncePrefix?: Bytes
}

export interface EncryptedAttachmentStream {
  header: AttachmentStreamHeader
  /** Ciphertext chunks, each `plaintext || tag`. Never materialised whole. */
  chunks: AsyncGenerator<Bytes>
}

export async function encryptAttachmentStream(
  input: EncryptAttachmentInput,
): Promise<EncryptedAttachmentStream> {
  const chunkSize = input.chunkSize ?? STREAM_CHUNK_SIZE
  const header: AttachmentStreamHeader = {
    version: input.version ?? MAILBOX_ENC_VERSION,
    keyId: input.keyId,
    noncePrefix:
      input.noncePrefix ?? crypto.getRandomValues(new Uint8Array(STREAM_NONCE_PREFIX_BYTES)),
    chunkSize,
    chunkCount: streamChunkCount(input.plaintextLength, chunkSize),
    plaintextLength: input.plaintextLength,
  }
  const key = await importAttachmentStreamKey(input.contentKey, input.fileId, "encrypt")

  async function* chunks(): AsyncGenerator<Bytes> {
    let index = 0
    let written = 0
    for await (const piece of rechunk(input.source, chunkSize)) {
      if (index >= header.chunkCount) {
        throw new AttachmentStreamError(
          `source produced more than the declared ${header.chunkCount} chunks`,
        )
      }
      const isFinal = index === header.chunkCount - 1
      const sealed = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: streamNonce(header.noncePrefix, index, isFinal),
          additionalData: streamChunkAad(header, input.fileId, index),
          tagLength: 128,
        },
        key,
        piece,
      )
      written += piece.length
      index++
      yield new Uint8Array(sealed)
    }
    if (index !== header.chunkCount || written !== header.plaintextLength) {
      throw new AttachmentStreamError(
        `source produced ${written} bytes in ${index} chunks, declared ${header.plaintextLength} bytes in ${header.chunkCount}`,
      )
    }
  }

  return { header, chunks: chunks() }
}
