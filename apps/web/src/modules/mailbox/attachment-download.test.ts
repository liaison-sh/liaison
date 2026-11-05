// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Journey (f): opening an attachment on a sealed mail saves the READABLE file.
//
// What shipped saved the stored object under the original filename, so a user
// who opened an invoice got an unopenable file named invoice.pdf. The bytes are
// sealed at rest by design, and the server serves exactly what it stores, so
// the decryption has to happen here or nowhere.

import { describe, expect, it, vi } from "vitest"
import { downloadMailAttachment } from "~/modules/mailbox/attachment-download"

const FILE_ID = "33333333-3333-4333-8333-333333333333"
const PLAINTEXT = "readable pdf bytes"

function base64(value: string): string {
  return btoa(value)
}

function sealedMetadata() {
  return {
    id: FILE_ID,
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 64,
    encryption: {
      encVersion: 1,
      keyId: 1,
      chunkSize: 16,
      chunkCount: 1,
      plaintextLength: PLAINTEXT.length,
      noncePrefixBase64: base64("nonce"),
      contentKeyWrappedBase64: base64("wrapped"),
      contentKeyEpkBase64: base64("epk"),
    },
  }
}

describe("downloadMailAttachment", () => {
  it("decrypts a sealed attachment before saving it", async () => {
    const saved: Array<{ bytes: Uint8Array; filename: string }> = []
    const openAttachment = vi.fn(async () => ({
      fileId: FILE_ID,
      bytesBase64: base64(PLAINTEXT),
    }))
    const api = {
      get: vi.fn(async () => sealedMetadata()),
      rawGet: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    }

    await downloadMailAttachment({
      // biome-ignore lint/suspicious/noExplicitAny: a two-method stand-in for the api client
      api: api as any,
      // biome-ignore lint/suspicious/noExplicitAny: a two-method stand-in for the worker handle
      client: { isUnlocked: () => true, openAttachment } as any,
      file: { id: FILE_ID, filename: "invoice.pdf" },
      save: async (bytes, filename) => {
        saved.push({ bytes, filename })
      },
    })

    expect(openAttachment).toHaveBeenCalledTimes(1)
    expect(saved).toHaveLength(1)
    expect(new TextDecoder().decode(saved[0].bytes)).toBe(PLAINTEXT)
    expect(saved[0].filename).toBe("invoice.pdf")
  })

  it("saves an unsealed attachment unchanged", async () => {
    const saved: Array<{ bytes: Uint8Array; filename: string }> = []
    const api = {
      get: vi.fn(async () => ({ ...sealedMetadata(), encryption: null })),
      rawGet: vi.fn(async () => new Response(new TextEncoder().encode("plain bytes"))),
    }

    await downloadMailAttachment({
      // biome-ignore lint/suspicious/noExplicitAny: a two-method stand-in for the api client
      api: api as any,
      client: null,
      file: { id: FILE_ID, filename: "notes.txt" },
      save: async (bytes, filename) => {
        saved.push({ bytes, filename })
      },
    })

    expect(new TextDecoder().decode(saved[0].bytes)).toBe("plain bytes")
  })

  it("refuses rather than saving ciphertext when the mailbox is locked", async () => {
    const api = {
      get: vi.fn(async () => sealedMetadata()),
      rawGet: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    }
    await expect(
      downloadMailAttachment({
        // biome-ignore lint/suspicious/noExplicitAny: a two-method stand-in for the api client
        api: api as any,
        client: null,
        file: { id: FILE_ID, filename: "invoice.pdf" },
        save: async () => {
          throw new Error("nothing may be saved here")
        },
      }),
    ).rejects.toThrow()
  })
})
