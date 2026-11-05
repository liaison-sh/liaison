// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 14.2. SC3 says an enrolled mailbox's attachment, fetched raw from the
// object store, "yields ciphertext whose first 64 bytes match no known file
// magic and which fails to parse as its declared MIME type". Before this CLI
// there was no way to execute that sentence: it was a claim, not a check.
//
// Every case here is about the tool's ability to FAIL. A verifier that returns
// zero on a plaintext PNG is worse than no verifier, because it launders the
// claim. So the plaintext fixtures come first and the sealed one last.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import {
  type AttachmentRecord,
  detectFileMagic,
  parsesAsDeclaredMime,
  verifyAttachment,
} from "~/cli/mailbox-verify-attachment"

const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..")

/** A real, minimal PNG: signature, IHDR, IDAT, IEND. */
function pngBytes(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    return Buffer.concat([len, Buffer.from(type, "ascii"), body, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function pdfBytes(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n", "latin1")
}

function zipBytes(): Buffer {
  const local = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  return Buffer.concat([local, Buffer.alloc(26), eocd, Buffer.alloc(18)])
}

/** Sealed bytes: STREAM chunks are raw AES-GCM output, so pseudorandom. */
function sealedBytes(n = 4096): Buffer {
  const b = Buffer.alloc(n)
  crypto.getRandomValues(b)
  return b
}

function record(over: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    filename: "quote.png",
    mimeType: "image/png",
    sizeBytes: 4096,
    storageKey: "org/x/mail/quote.png",
    encVersion: 1,
    chunkCount: 1,
    chunkSize: 65536,
    plaintextLength: 4000,
    ...over,
  }
}

function deps(row: AttachmentRecord | null, bytes: Buffer) {
  return {
    loadFile: async () => row,
    fetchHead: async (_key: string, length: number) => bytes.subarray(0, length),
  }
}

describe("detectFileMagic", () => {
  test("names the type for every signature the check relies on", () => {
    expect(detectFileMagic(pngBytes())).toBe("png")
    expect(detectFileMagic(pdfBytes())).toBe("pdf")
    expect(detectFileMagic(zipBytes())).toBe("zip")
    expect(detectFileMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg")
    expect(detectFileMagic(Buffer.from([0x1f, 0x8b, 0x08]))).toBe("gzip")
  })

  test("returns null on pseudorandom bytes", () => {
    expect(detectFileMagic(sealedBytes())).toBeNull()
  })
})

describe("parsesAsDeclaredMime", () => {
  test("a real PNG parses as image/png and a PDF as application/pdf", () => {
    expect(parsesAsDeclaredMime("image/png", pngBytes())).not.toBeNull()
    expect(parsesAsDeclaredMime("application/pdf", pdfBytes())).not.toBeNull()
    expect(parsesAsDeclaredMime("application/zip", zipBytes())).not.toBeNull()
  })

  test("sealed bytes parse as nothing", () => {
    const sealed = sealedBytes()
    expect(parsesAsDeclaredMime("image/png", sealed)).toBeNull()
    expect(parsesAsDeclaredMime("application/pdf", sealed)).toBeNull()
    expect(parsesAsDeclaredMime("application/zip", sealed)).toBeNull()
  })
})

describe("mailbox verify-attachment", () => {
  test("a plaintext PNG stored for a sealed file exits non-zero, naming both findings", async () => {
    const res = await verifyAttachment({ fileId: record().id }, deps(record(), pngBytes()))
    expect(res.exitCode).not.toBe(0)
    expect(res.report.verdict).toBe("plaintext")
    expect(res.report.findings.join(" ")).toContain("png")
    expect(res.report.findings.join(" ")).toMatch(/image\/png/)
    // The operator gets the bytes, not just a verdict.
    expect(res.report.firstBytesHex.startsWith("89504e47")).toBe(true)
  })

  test("a plaintext PDF exits non-zero", async () => {
    const row = record({ filename: "invoice.pdf", mimeType: "application/pdf" })
    const res = await verifyAttachment({ fileId: row.id }, deps(row, pdfBytes()))
    expect(res.exitCode).not.toBe(0)
  })

  test("a plaintext zip exits non-zero", async () => {
    const row = record({ filename: "logs.zip", mimeType: "application/zip" })
    const res = await verifyAttachment({ fileId: row.id }, deps(row, zipBytes()))
    expect(res.exitCode).not.toBe(0)
  })

  test("an ASCII text payload exits non-zero even though it has no magic", async () => {
    const row = record({ filename: "note.txt", mimeType: "text/plain" })
    const body = Buffer.from("Dear Taylor, the quote for the batch is attached.\n".repeat(40))
    const res = await verifyAttachment({ fileId: row.id }, deps(row, body))
    expect(res.exitCode).not.toBe(0)
    expect(res.report.findings.join(" ")).toMatch(/printable/i)
  })

  test("an empty object is a hard failure, not a pass", async () => {
    // Non-vacuity. Zero bytes match no magic and parse as nothing, so a naive
    // check would call an EMPTY object ciphertext and report green.
    const res = await verifyAttachment({ fileId: record().id }, deps(record(), Buffer.alloc(0)))
    expect(res.exitCode).not.toBe(0)
    expect(res.report.verdict).toBe("unverifiable")
    expect(res.report.findings.join(" ")).toMatch(/empty/i)
  })

  test("enc_version 0 is a hard failure whatever the bytes look like", async () => {
    const row = record({ encVersion: 0 })
    const res = await verifyAttachment({ fileId: row.id }, deps(row, sealedBytes()))
    expect(res.exitCode).not.toBe(0)
    expect(res.report.findings.join(" ")).toMatch(/enc_version/)
  })

  test("an unknown file id is a hard failure, never a silent pass", async () => {
    const res = await verifyAttachment({ fileId: "no-such-file" }, deps(null, Buffer.alloc(0)))
    expect(res.exitCode).not.toBe(0)
    expect(res.report.findings.join(" ")).toMatch(/not found/i)
  })

  test("a sealed object exits zero", async () => {
    const res = await verifyAttachment({ fileId: record().id }, deps(record(), sealedBytes()))
    expect(res.exitCode).toBe(0)
    expect(res.report.verdict).toBe("ciphertext")
    expect(res.report.findings).toEqual([])
    expect(res.report.firstBytesHex.length).toBe(128)
  })

  test("the direct entrypoint refuses to run without --file-id", () => {
    const r = spawnSync("bun", ["run", "src/cli/mailbox-verify-attachment.ts"], {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" },
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stderr}${r.stdout}`).toContain("--file-id")
  })
})
