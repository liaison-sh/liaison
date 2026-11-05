// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun src/cli/mailbox-verify-attachment.ts --file-id <uuid>`
// (also `liaison mailbox verify-attachment --file-id <uuid>`)
//
// Task 14.2, spec section 13 V9d. SC3 is the one success criterion with no
// database column to look at: the evidence lives in the object store, as bytes.
// This is the executable form of the claim, and it is deliberately written so
// that it can FAIL:
//
//   * an object that carries a known file magic FAILS,
//   * an object that parses as its own declared MIME type FAILS,
//   * an object that is all printable ASCII FAILS, even with no magic, because
//     a plaintext .txt or .eml attachment has no signature to detect,
//   * an EMPTY object FAILS, because "matches no magic" is trivially true of
//     zero bytes and a check that green-lights an empty object proves nothing,
//   * a row with `enc_version = 0` FAILS whatever the bytes look like: the
//     database itself says those bytes were stored as-is.
//
// Only an object that is non-empty, declared sealed, carries no magic, parses
// as nothing and is not printable text exits 0.
//
// It reads through the app's OWN storage client, so it exercises the same
// bucket, credentials and key layout the product uses. It is read only: it
// fetches a head range and prints. It never writes, deletes or re-seals.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { getObjectRange } from "~/infra/storage/object-storage"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** How much of the object to pull. 64 bytes is the printed head; the rest lets
 *  the container formats (zip end-of-central-directory, PDF trailer) be tried
 *  properly instead of being declared absent because we only looked at 64. */
export const HEAD_BYTES = 8192

export interface AttachmentRecord {
  id: string
  orgId: string
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  encVersion: number
  chunkSize: number | null
  chunkCount: number | null
  plaintextLength: number | null
}

export interface VerifyAttachmentDeps {
  loadFile: (fileId: string) => Promise<AttachmentRecord | null>
  fetchHead: (storageKey: string, length: number) => Promise<Buffer>
}

export interface VerifyAttachmentReport {
  fileId: string
  filename?: string
  mimeType?: string
  encVersion?: number
  byteLength: number
  firstBytesHex: string
  findings: string[]
  verdict: "ciphertext" | "plaintext" | "unverifiable"
}

export interface VerifyAttachmentResult {
  exitCode: number
  report: VerifyAttachmentReport
}

interface Signature {
  name: string
  offset: number
  bytes: number[]
}

/**
 * File magic. Deliberately broad: the check is "does this look like ANY known
 * file", so a signature that fires on a sealed object would be a false alarm we
 * would notice immediately, while a missing signature is a silent pass.
 */
const SIGNATURES: Signature[] = [
  { name: "png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { name: "gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "bmp", offset: 0, bytes: [0x42, 0x4d] },
  { name: "webp", offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { name: "tiff-le", offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { name: "tiff-be", offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { name: "pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: "postscript", offset: 0, bytes: [0x25, 0x21, 0x50, 0x53] },
  { name: "zip", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: "zip-empty", offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  { name: "gzip", offset: 0, bytes: [0x1f, 0x8b] },
  { name: "bzip2", offset: 0, bytes: [0x42, 0x5a, 0x68] },
  { name: "xz", offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: "7z", offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "rar", offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { name: "tar", offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72] },
  { name: "ole2-office", offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: "rtf", offset: 0, bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] },
  { name: "ogg", offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
  { name: "riff", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: "matroska", offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { name: "mp3-id3", offset: 0, bytes: [0x49, 0x44, 0x33] },
  { name: "iso-bmff", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { name: "elf", offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "pe", offset: 0, bytes: [0x4d, 0x5a] },
  { name: "class", offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "sqlite", offset: 0, bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65] },
]

/** The name of the first signature the bytes match, or null. */
export function detectFileMagic(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (bytes.length < sig.offset + sig.bytes.length) continue
    let hit = true
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[sig.offset + i] !== sig.bytes[i]) {
        hit = false
        break
      }
    }
    if (hit) return sig.name
  }
  return null
}

function contains(haystack: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0))
}

/**
 * Does the payload actually parse as the type `kernel.files.mime_type` claims?
 * Returns the reason it parsed, or null.
 *
 * Structural, not signature based: the magic check above already covers the
 * first bytes, so this looks for a second structural marker (a PNG IHDR plus
 * IEND, a zip central directory, a PDF trailer, well formed JSON, XML or UTF-8
 * text). Two independent checks are the point: an attacker-free failure mode
 * where sealing produced a valid file with a stripped header still fails here.
 */
export function parsesAsDeclaredMime(mimeType: string, bytes: Uint8Array): string | null {
  const mime = mimeType.toLowerCase().split(";")[0].trim()
  const magic = detectFileMagic(bytes)

  if (mime === "image/png") {
    if (magic === "png" && contains(bytes, ascii("IHDR"))) return "png header plus IHDR chunk"
    return null
  }
  if (mime === "image/jpeg") return magic === "jpeg" ? "jpeg SOI marker" : null
  if (mime === "image/gif") return magic === "gif" ? "gif header" : null
  if (mime === "image/webp") return magic === "webp" ? "riff webp header" : null
  if (mime === "application/pdf") {
    if (magic === "pdf" && contains(bytes, ascii("obj"))) return "pdf header plus an object"
    return null
  }
  if (
    mime === "application/zip" ||
    mime.endsWith("+zip") ||
    mime.startsWith("application/vnd.openxmlformats")
  ) {
    if (magic === "zip" || magic === "zip-empty") return "zip local header"
    if (contains(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip end of central directory"
    return null
  }
  if (mime === "application/gzip" || mime === "application/x-gzip") {
    return magic === "gzip" ? "gzip header" : null
  }
  if (mime === "application/json") {
    const text = decodeUtf8(bytes)
    if (text === null) return null
    const trimmed = text.trimStart()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null
    try {
      JSON.parse(trimmed)
      return "valid json"
    } catch {
      // A truncated head cannot parse whole; a leading brace plus printable
      // text is still evidence enough, and the printable check below catches it.
      return null
    }
  }
  if (mime === "text/xml" || mime === "application/xml" || mime === "image/svg+xml") {
    const text = decodeUtf8(bytes)
    return text?.trimStart().startsWith("<") ? "xml prolog" : null
  }
  if (mime.startsWith("text/") || mime === "message/rfc822") {
    return decodeUtf8(bytes) !== null ? "decodes as text" : null
  }
  // Unknown declared type: fall back to the magic table, which is why the
  // caller reports both findings separately.
  return magic ? `matches ${magic}` : null
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Printable-ASCII ratio over the head. Sealed bytes are AES-GCM output, so the
 * expected ratio is about 0.37 and the chance of a 64 byte run being fully
 * printable is astronomically small. A threshold of 0.95 over at least 64 bytes
 * therefore fires on plaintext text attachments and never on ciphertext.
 */
export function looksLikePrintableText(bytes: Uint8Array): boolean {
  if (bytes.length < 64) return false
  let printable = 0
  for (const b of bytes) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) printable++
  }
  return printable / bytes.length >= 0.95
}

function defaultDeps(): VerifyAttachmentDeps {
  return {
    loadFile: async (fileId) => {
      const rows = await withSystemDb("mailbox-verify-attachment", async (tx) =>
        extractRows<{
          id: string
          org_id: string
          filename: string
          mime_type: string
          size_bytes: string | number
          storage_key: string
          enc_version: number
          chunk_size: number | null
          chunk_count: number | null
          plaintext_length: string | number | null
        }>(
          await tx.execute(drizzleSql`
            SELECT id, org_id, filename, mime_type, size_bytes, storage_key,
                   enc_version, chunk_size, chunk_count, plaintext_length
              FROM ${K()}.files WHERE id = ${fileId}::uuid`),
        ),
      )
      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        orgId: row.org_id,
        filename: row.filename,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        storageKey: row.storage_key,
        encVersion: Number(row.enc_version),
        chunkSize: row.chunk_size === null ? null : Number(row.chunk_size),
        chunkCount: row.chunk_count === null ? null : Number(row.chunk_count),
        plaintextLength: row.plaintext_length === null ? null : Number(row.plaintext_length),
      }
    },
    fetchHead: async (storageKey, length) => {
      const res = await getObjectRange(storageKey, { start: 0, end: length - 1 })
      return res.bytes
    },
  }
}

export async function verifyAttachment(
  args: { fileId: string },
  deps: VerifyAttachmentDeps = defaultDeps(),
): Promise<VerifyAttachmentResult> {
  const findings: string[] = []
  let row: AttachmentRecord | null = null
  try {
    row = await deps.loadFile(args.fileId)
  } catch (err) {
    findings.push(`kernel.files lookup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!row) {
    findings.push(`file ${args.fileId} not found in kernel.files`)
    return {
      exitCode: 1,
      report: {
        fileId: args.fileId,
        byteLength: 0,
        firstBytesHex: "",
        findings,
        verdict: "unverifiable",
      },
    }
  }

  let bytes = Buffer.alloc(0)
  try {
    bytes = Buffer.from(await deps.fetchHead(row.storageKey, HEAD_BYTES))
  } catch (err) {
    findings.push(`object fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const report: VerifyAttachmentReport = {
    fileId: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    encVersion: row.encVersion,
    byteLength: bytes.length,
    firstBytesHex: bytes.subarray(0, 64).toString("hex"),
    findings,
    verdict: "ciphertext",
  }

  // Non-vacuity first, in both its forms.
  if (bytes.length === 0) {
    findings.push("the stored object is empty: that is not ciphertext, it is nothing")
    report.verdict = "unverifiable"
    return { exitCode: 1, report }
  }
  if (row.encVersion === 0) {
    findings.push(
      `kernel.files.enc_version is 0: the row itself says this object was stored as-is, not sealed`,
    )
  }

  const magic = detectFileMagic(bytes)
  if (magic) findings.push(`first bytes match a known file magic: ${magic}`)
  const parsed = parsesAsDeclaredMime(row.mimeType, bytes)
  if (parsed) findings.push(`payload parses as its declared MIME type ${row.mimeType}: ${parsed}`)
  if (looksLikePrintableText(bytes)) {
    findings.push("payload head is printable text, so it is not ciphertext")
  }

  if (findings.length > 0) {
    report.verdict = report.verdict === "unverifiable" ? "unverifiable" : "plaintext"
    return { exitCode: 1, report }
  }
  return { exitCode: 0, report }
}

const USAGE = "usage: bun src/cli/mailbox-verify-attachment.ts --file-id <kernel.files id>"

export function parseVerifyAttachmentArgv(argv: string[]): {
  ok: boolean
  fileId?: string
  error?: string
} {
  let fileId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file-id") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `--file-id requires a value\n${USAGE}` }
      }
      fileId = value
      i++
      continue
    }
    return { ok: false, error: `unknown option ${argv[i]}\n${USAGE}` }
  }
  if (!fileId) return { ok: false, error: `--file-id <id> is required\n${USAGE}` }
  return { ok: true, fileId }
}

/** Shared by the direct entrypoint and `liaison mailbox verify-attachment`. */
export async function runVerifyAttachmentCli(argv: string[]): Promise<number> {
  const parsed = parseVerifyAttachmentArgv(argv)
  if (!parsed.ok || !parsed.fileId) {
    process.stderr.write(`${parsed.error}\n`)
    return 2
  }
  const res = await verifyAttachment({ fileId: parsed.fileId })
  process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.exitCode !== 0) {
    process.stderr.write(
      `VERDICT ${res.report.verdict}: SC3 is NOT satisfied for this attachment\n`,
    )
  } else {
    process.stdout.write("VERDICT ciphertext: no magic, no parse, not text\n")
  }
  return res.exitCode
}

if (import.meta.main) {
  runVerifyAttachmentCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
      process.exit(1)
    })
}
