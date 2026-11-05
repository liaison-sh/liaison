// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`. This is the half that turns
// sealed attachment chunks back into file bytes; no server entrypoint may reach
// it. The encryptor is `stream-seal.ts`, which the host does need (spec section
// 5.8), which is exactly why the two are separate modules.
//
// The decryptor refuses a stream that ends on a non-final chunk, a stream whose
// observed chunk count disagrees with the authenticated value, and a stream
// whose decrypted length disagrees with the authenticated total. A truncated
// contract PDF is an integrity failure that must not be silent.

import type { Bytes } from "./bytes"
import type { KeyMaterial } from "./kdf"
import {
  AttachmentStreamError,
  type AttachmentStreamHeader,
  type ByteSource,
  importAttachmentStreamKey,
  STREAM_TAG_BYTES,
  streamChunkAad,
  streamChunkCount,
  streamNonce,
} from "./stream-seal"

export interface DecryptAttachmentInput {
  contentKey: KeyMaterial
  fileId: string
  header: AttachmentStreamHeader
  chunks: ByteSource
}

async function* iterate(source: ByteSource): AsyncGenerator<Bytes> {
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

export interface DecryptAttachmentChunksInput {
  contentKey: KeyMaterial
  fileId: string
  header: AttachmentStreamHeader
  /** Index of the FIRST chunk in `chunks`, so the nonces line up. */
  firstChunkIndex: number
  chunks: ByteSource
}

/**
 * Open a CONTIGUOUS RUN of chunks, which is what a range request returns.
 *
 * Every chunk still authenticates under its own index, its own final flag and
 * the file binding, so a substituted, reordered or cross-file chunk fails here
 * exactly as it does in a full read. What a partial read cannot attest is the
 * WHOLE stream: a caller that never asked for the tail cannot learn that the
 * tail is missing. Truncation detection therefore belongs to
 * `decryptAttachmentStream`, and a caller that needs the integrity guarantee for
 * the whole file has to read the whole file. Callers that only need to show a
 * page of a PDF do not, which is the entire point of a range request.
 */
export async function* decryptAttachmentChunks(
  input: DecryptAttachmentChunksInput,
): AsyncGenerator<Bytes> {
  const { header } = input
  const expected = streamChunkCount(header.plaintextLength, header.chunkSize)
  if (header.chunkCount !== expected) {
    throw new AttachmentStreamError(
      `header claims ${header.chunkCount} chunks but ${header.plaintextLength} bytes at ${header.chunkSize} is ${expected}`,
    )
  }
  if (
    !Number.isInteger(input.firstChunkIndex) ||
    input.firstChunkIndex < 0 ||
    input.firstChunkIndex >= header.chunkCount
  ) {
    throw new AttachmentStreamError(
      `first chunk index ${input.firstChunkIndex} is outside the ${header.chunkCount} chunk stream`,
    )
  }
  const key = await importAttachmentStreamKey(input.contentKey, input.fileId, "decrypt")
  let index = input.firstChunkIndex
  for await (const chunk of iterate(input.chunks)) {
    if (index >= header.chunkCount) {
      throw new AttachmentStreamError(
        `range carries more than the authenticated ${header.chunkCount} chunks`,
      )
    }
    if (chunk.length < STREAM_TAG_BYTES) {
      throw new AttachmentStreamError(`chunk ${index} is shorter than the tag`)
    }
    const isFinal = index === header.chunkCount - 1
    let plaintext: Bytes
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: streamNonce(header.noncePrefix, index, isFinal),
            additionalData: streamChunkAad(header, input.fileId, index),
            tagLength: 128,
          },
          key,
          chunk,
        ),
      )
    } catch (error) {
      throw new AttachmentStreamError(`attachment chunk ${index} did not authenticate`, error)
    }
    if (!isFinal && plaintext.length !== header.chunkSize) {
      throw new AttachmentStreamError(
        `non final chunk ${index} decrypted to ${plaintext.length} bytes, expected ${header.chunkSize}`,
      )
    }
    index++
    yield plaintext
  }
}

export async function* decryptAttachmentStream(
  input: DecryptAttachmentInput,
): AsyncGenerator<Bytes> {
  const { header } = input
  const expected = streamChunkCount(header.plaintextLength, header.chunkSize)
  if (header.chunkCount !== expected) {
    throw new AttachmentStreamError(
      `header claims ${header.chunkCount} chunks but ${header.plaintextLength} bytes at ${header.chunkSize} is ${expected}`,
    )
  }
  const key = await importAttachmentStreamKey(input.contentKey, input.fileId, "decrypt")
  let index = 0
  let produced = 0
  for await (const chunk of iterate(input.chunks)) {
    if (index >= header.chunkCount) {
      throw new AttachmentStreamError(
        `stream carries more than the authenticated ${header.chunkCount} chunks`,
      )
    }
    if (chunk.length < STREAM_TAG_BYTES) {
      throw new AttachmentStreamError(`chunk ${index} is shorter than the tag`)
    }
    const isFinal = index === header.chunkCount - 1
    let plaintext: Bytes
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: streamNonce(header.noncePrefix, index, isFinal),
            additionalData: streamChunkAad(header, input.fileId, index),
            tagLength: 128,
          },
          key,
          chunk,
        ),
      )
    } catch (error) {
      throw new AttachmentStreamError(`attachment chunk ${index} did not authenticate`, error)
    }
    if (!isFinal && plaintext.length !== header.chunkSize) {
      throw new AttachmentStreamError(
        `non final chunk ${index} decrypted to ${plaintext.length} bytes, expected ${header.chunkSize}`,
      )
    }
    produced += plaintext.length
    index++
    yield plaintext
  }
  if (index !== header.chunkCount) {
    // A truncated stream ends on a non-final chunk. Fail closed.
    throw new AttachmentStreamError(
      `attachment stream ended after ${index} of ${header.chunkCount} chunks`,
    )
  }
  if (produced !== header.plaintextLength) {
    throw new AttachmentStreamError(
      `attachment decrypted to ${produced} bytes, authenticated length is ${header.plaintextLength}`,
    )
  }
}
