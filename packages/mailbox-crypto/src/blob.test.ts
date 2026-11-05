// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.1. The blob codec, `version:u8 || key_id:u8 || iv:12 || ciphertext || tag:16`
// (spec section 3.4). The part of T-CRYPTO-11 that lives here is structural:
// the two-byte header is exposed separately so it can be fed into the AAD, and
// a truncated blob is rejected rather than silently reinterpreted.

import { describe, expect, it } from "bun:test"
import {
  BLOB_HEADER_BYTES,
  BLOB_IV_BYTES,
  BLOB_TAG_BYTES,
  blobHeader,
  decodeBlob,
  encodeBlob,
  MAILBOX_ENC_VERSION,
  MailboxBlobError,
} from "./blob"
import { toHex } from "./bytes"

const iv = Uint8Array.from({ length: 12 }, (_, i) => i + 1)
const body = Uint8Array.from({ length: 40 }, (_, i) => 0x80 ^ i)

describe("T-CRYPTO-11 blob codec", () => {
  it("round trips a well formed blob", () => {
    const bytes = encodeBlob({
      version: MAILBOX_ENC_VERSION,
      keyId: 3,
      iv,
      ciphertextWithTag: body,
    })
    expect(bytes.length).toBe(BLOB_HEADER_BYTES + BLOB_IV_BYTES + body.length)
    const decoded = decodeBlob(bytes)
    expect(decoded.version).toBe(MAILBOX_ENC_VERSION)
    expect(decoded.keyId).toBe(3)
    expect(toHex(decoded.iv)).toBe(toHex(iv))
    expect(toHex(decoded.body)).toBe(toHex(body))
    expect(toHex(decoded.header)).toBe(toHex(blobHeader(MAILBOX_ENC_VERSION, 3)))
    expect(decoded.header.length).toBe(BLOB_HEADER_BYTES)
  })

  it("exposes the header as the first two bytes, version then key id", () => {
    const bytes = encodeBlob({ version: 1, keyId: 255, iv, ciphertextWithTag: body })
    expect(Array.from(bytes.subarray(0, 2))).toEqual([1, 255])
  })

  it("rejects a key id outside a single byte", () => {
    expect(() => encodeBlob({ version: 1, keyId: 256, iv, ciphertextWithTag: body })).toThrow(
      MailboxBlobError,
    )
    expect(() => encodeBlob({ version: 1, keyId: -1, iv, ciphertextWithTag: body })).toThrow(
      MailboxBlobError,
    )
  })

  it("rejects a version outside a single byte", () => {
    expect(() => encodeBlob({ version: 256, keyId: 1, iv, ciphertextWithTag: body })).toThrow(
      MailboxBlobError,
    )
  })

  it("rejects an iv that is not twelve bytes", () => {
    expect(() =>
      encodeBlob({ version: 1, keyId: 1, iv: new Uint8Array(11), ciphertextWithTag: body }),
    ).toThrow(MailboxBlobError)
  })

  it("rejects a body shorter than the tag", () => {
    expect(() =>
      encodeBlob({
        version: 1,
        keyId: 1,
        iv,
        ciphertextWithTag: new Uint8Array(BLOB_TAG_BYTES - 1),
      }),
    ).toThrow(MailboxBlobError)
  })

  it("accepts a body that is exactly the tag, an empty plaintext", () => {
    const bytes = encodeBlob({
      version: 1,
      keyId: 0,
      iv,
      ciphertextWithTag: new Uint8Array(BLOB_TAG_BYTES),
    })
    expect(decodeBlob(bytes).body.length).toBe(BLOB_TAG_BYTES)
  })

  it("rejects truncated input at decode", () => {
    const bytes = encodeBlob({ version: 1, keyId: 1, iv, ciphertextWithTag: body })
    for (const cut of [0, 1, 2, 13, BLOB_HEADER_BYTES + BLOB_IV_BYTES + BLOB_TAG_BYTES - 1]) {
      expect(() => decodeBlob(bytes.subarray(0, cut)), `cut at ${cut}`).toThrow(MailboxBlobError)
    }
  })

  it("does not alias the caller's buffers", () => {
    const mutableIv = Uint8Array.from(iv)
    const bytes = encodeBlob({ version: 1, keyId: 1, iv: mutableIv, ciphertextWithTag: body })
    mutableIv.fill(0)
    expect(toHex(decodeBlob(bytes).iv)).toBe(toHex(iv))
  })
})
