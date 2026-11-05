// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 7.3: what a client needs to read a sealed attachment, and the range
// arithmetic that lets it read part of one.
//
// A sealed attachment is served as ciphertext and opened in the browser's
// crypto worker. For that the client needs the envelope: the wrapped content
// key, the ephemeral public key it was wrapped against, the identity key id,
// and the three authenticated STREAM values (chunk size, chunk count, plaintext
// length) plus the nonce prefix. All of it is public in the sense that matters:
// none of it opens anything without the user's own private key.
//
// Nothing here decrypts. The server cannot, and this file is the reason it does
// not have to: it hands the browser the map and the browser does the reading.

/** The row shape the routes select. Snake case, straight from `kernel.files`. */
export interface FileEncryptionRow {
  enc_version: number | string | null
  content_key_wrapped: Buffer | Uint8Array | null
  content_key_epk: Buffer | Uint8Array | null
  enc_key_id: number | string | null
  chunk_size: number | string | null
  chunk_count: number | string | null
  plaintext_length: number | string | null
  nonce_prefix: Buffer | Uint8Array | null
}

export interface AttachmentEncryptionMetadata {
  encVersion: number
  keyId: number
  chunkSize: number
  chunkCount: number
  plaintextLength: number
  noncePrefixBase64: string
  contentKeyWrappedBase64: string
  contentKeyEpkBase64: string
}

function b64(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64")
}

/**
 * Null when the file is stored as it arrived. A row that claims `enc_version >
 * 0` but is missing any part of its envelope is a broken row, not a partially
 * sealed one, so it reports null rather than a metadata block the client would
 * fail on halfway through a download.
 */
export function toEncryptionMetadata(row: FileEncryptionRow): AttachmentEncryptionMetadata | null {
  const version = Number(row.enc_version ?? 0)
  if (!version) return null
  if (
    !row.content_key_wrapped ||
    !row.content_key_epk ||
    !row.nonce_prefix ||
    row.enc_key_id === null ||
    row.chunk_size === null ||
    row.chunk_count === null ||
    row.plaintext_length === null
  ) {
    return null
  }
  return {
    encVersion: version,
    keyId: Number(row.enc_key_id),
    chunkSize: Number(row.chunk_size),
    chunkCount: Number(row.chunk_count),
    plaintextLength: Number(row.plaintext_length),
    noncePrefixBase64: b64(row.nonce_prefix),
    contentKeyWrappedBase64: b64(row.content_key_wrapped),
    contentKeyEpkBase64: b64(row.content_key_epk),
  }
}

export type ParsedRange =
  | { kind: "range"; start: number; end: number }
  /** Syntactically fine, but outside the object. The caller answers 416. */
  | { kind: "unsatisfiable" }
  /** Absent, malformed, or multi-range. The caller serves the whole object. */
  | { kind: "none" }

/**
 * Parse a single `bytes=` range against a known total length.
 *
 * Deliberately narrow: one range only. A multi-range request is answered with
 * the whole object, which RFC 9110 explicitly permits, rather than growing a
 * multipart encoder no client of ours sends.
 */
export function parseRangeHeader(header: string | null | undefined, total: number): ParsedRange {
  if (!header) return { kind: "none" }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: "none" }
  const rawStart = match[1] ?? ""
  const rawEnd = match[2] ?? ""
  if (rawStart === "" && rawEnd === "") return { kind: "none" }
  if (total <= 0) return { kind: "unsatisfiable" }

  let start: number
  let end: number
  if (rawStart === "") {
    // A suffix range: the LAST n bytes.
    const suffix = Number(rawEnd)
    if (suffix <= 0) return { kind: "unsatisfiable" }
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === "" ? total - 1 : Number(rawEnd)
    if (start >= total) return { kind: "unsatisfiable" }
    if (end >= total) end = total - 1
    if (end < start) return { kind: "unsatisfiable" }
  }
  return { kind: "range", start, end }
}

/**
 * The ciphertext byte span covering a plaintext span, so a client can ask for
 * exactly the chunks it needs and no more.
 *
 * Every chunk is `chunkSize` plaintext bytes plus one 16 byte GCM tag, except
 * the last, which is short. That regularity is what makes a range request on an
 * encrypted object possible at all.
 */
export function ciphertextSpanForPlaintextRange(
  meta: Pick<AttachmentEncryptionMetadata, "chunkSize" | "chunkCount" | "plaintextLength">,
  start: number,
  end: number,
  tagBytes = 16,
): { firstChunk: number; lastChunk: number; start: number; end: number } {
  const firstChunk = Math.min(Math.floor(start / meta.chunkSize), meta.chunkCount - 1)
  const lastChunk = Math.min(Math.floor(end / meta.chunkSize), meta.chunkCount - 1)
  const sealedChunkSize = meta.chunkSize + tagBytes
  const cipherStart = firstChunk * sealedChunkSize
  const plaintextBefore = lastChunk * meta.chunkSize
  const lastChunkPlaintext = Math.min(meta.chunkSize, meta.plaintextLength - plaintextBefore)
  const cipherEnd = lastChunk * sealedChunkSize + lastChunkPlaintext + tagBytes - 1
  return { firstChunk, lastChunk, start: cipherStart, end: cipherEnd }
}
