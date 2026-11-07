// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side multipart/form-data assembly for a sandboxed `ctx.fetch` upload. The sandbox has no
// binary types, so an app names its parts and the host builds the body: a text field as given, a
// file part read from `kernel.files` under the calling bridge's own RLS context (the app can only
// upload a file it may read). Each file part is fingerprinted (SHA-256); a part may pin the
// fingerprint it expects, and a mismatch refuses the call before anything is sent. A PDF part may
// also pin the exact content of a file embedded in it (`expectEmbeddedFile`, e.g. the CII XML of a
// Factur-X): the host extracts the attachment from the very bytes it uploads and refuses unless
// it equals the text the app checked, so what the app validated is what leaves.
// A part may also name file parents it must not come from (`refuseParents`, e.g. a file another
// app already delivered upstream): such a file refuses the call before anything is sent.

import { createHash, randomBytes } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

export interface MultipartPartReport {
  name: string
  size: number
  sha256: string
  fileId?: string
}

export interface MultipartUpload {
  body: Uint8Array
  contentType: string
  size: number
  parts: MultipartPartReport[]
}

type PartSpec =
  | { name: string; value: string }
  | {
      name: string
      fileId: string
      filename?: string
      contentType?: string
      expectSha256?: string
      expectEmbeddedFile?: { name: string; text: string }
      refuseParents?: Array<{ app: string; entityType: string }>
    }

/**
 * The bytes of the file named `name` embedded in a PDF (the EmbeddedFiles name tree, then the
 * catalog's /AF list), decoded; null when the PDF has no such attachment or cannot be parsed.
 */
export async function extractPdfEmbeddedFile(
  pdf: Uint8Array,
  name: string,
): Promise<Uint8Array | null> {
  const {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFHexString,
    PDFString,
    decodePDFRawStream,
  } = await import("pdf-lib")
  let doc: Awaited<ReturnType<typeof PDFDocument.load>>
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: false })
  } catch {
    return null
  }
  const text = (v: unknown): string | null =>
    v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null
  const fromSpec = (specRef: unknown): Uint8Array | null => {
    const spec = doc.context.lookup(specRef as never)
    if (!(spec instanceof PDFDict)) return null
    const names = [text(spec.lookup(PDFName.of("UF"))), text(spec.lookup(PDFName.of("F")))]
    if (!names.includes(name)) return null
    const ef = spec.lookup(PDFName.of("EF"))
    if (!(ef instanceof PDFDict)) return null
    const stream = ef.lookup(PDFName.of("F")) ?? ef.lookup(PDFName.of("UF"))
    if (!(stream instanceof PDFRawStream)) return null
    try {
      return decodePDFRawStream(stream).decode()
    } catch {
      return null
    }
  }
  const specs: unknown[] = []
  const walk = (node: unknown, depth: number) => {
    const n = doc.context.lookup(node as never)
    if (!(n instanceof PDFDict) || depth > 16) return
    const leaf = n.lookup(PDFName.of("Names"))
    if (leaf instanceof PDFArray) for (let i = 1; i < leaf.size(); i += 2) specs.push(leaf.get(i))
    const kids = n.lookup(PDFName.of("Kids"))
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1)
  }
  const namesDict = doc.catalog.lookup(PDFName.of("Names"))
  if (namesDict instanceof PDFDict) walk(namesDict.get(PDFName.of("EmbeddedFiles")), 0)
  const af = doc.catalog.lookup(PDFName.of("AF"))
  if (af instanceof PDFArray) for (let i = 0; i < af.size(); i++) specs.push(af.get(i))
  // Two attachments under the same name would let the uploaded file say two things: refuse.
  const found = specs.map(fromSpec).filter((b): b is Uint8Array => b !== null)
  if (found.length === 0) return null
  const first = found[0]!
  for (const b of found) if (Buffer.compare(Buffer.from(b), Buffer.from(first)) !== 0) return null
  return first
}

const NAME_RE = /^[A-Za-z0-9_\-[\].]{1,100}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PARTS = 50

function refuse(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string; status: number }
  err.code = code
  err.status = 400
  throw err
}

function headerSafe(v: string, what: string): string {
  if (/[\r\n"\\]/.test(v) || v.length > 200)
    refuse("invalid_multipart", `${what} contains forbidden characters`)
  return v
}

/** Reads one file's bytes, visible under the caller's RLS context, or refuses. */
async function readVisibleFile(
  ctx: BridgeContext,
  fileId: string,
  maxBytes: number,
  refuseParents: Array<{ app: string; entityType: string }> = [],
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  if (!UUID_RE.test(fileId)) refuse("invalid_multipart", "fileId must be a uuid")
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const query = drizzleSql`
      SELECT filename, mime_type, storage_key, enc_version, app, entity_type
      FROM ${KS}.files WHERE id = ${fileId} AND org_id = ${ctx.orgId} LIMIT 1
    `
  // A provider-contract op runs without the caller's data scopes; the caller's files the op names
  // were checked readable by the CALLER and granted for this call only: those are read org-scoped.
  const granted = ctx.bridgeOptions?.contractFileGrant?.includes(fileId) === true
  // A session bridge's fetch runs without a transaction: read the row in one short one.
  const withShortTx = ctx.bridgeOptions?.withShortTx
  const result = granted
    ? await (await import("~/db/privileged")).withPrivilegedDb(
        ctx.orgId,
        "contract-file-grant",
        (tx) => tx.execute(query),
      )
    : withShortTx
      ? await withShortTx((tx) => tx.execute(query))
      : await ctx.txDb.execute(query)
  const rows = extractRows<{
    filename: string
    mime_type: string
    storage_key: string
    enc_version: number | null
    app: string | null
    entity_type: string | null
  }>(result)
  const row = rows[0]
  if (!row) refuse("file_not_readable", "file not found or not readable by this app")
  if (refuseParents.some((r) => r.app === row.app && r.entityType === row.entity_type)) {
    refuse(
      "file_parent_refused",
      `file ${fileId} belongs to ${row.app}/${row.entity_type}, which this upload refuses`,
    )
  }
  if (Number(row.enc_version ?? 0) === 2) {
    // A server-managed mail attachment: opened for the mailbox owner (or a
    // host job acting for them), audited, never for anyone else.
    const { openManagedFile } = await import("~/modules/mailbox-crypto/managed-open")
    const read = (tx: Pick<RlsClient, "execute">) =>
      openManagedFile(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        fileId,
        purpose: { kind: "tool", tool: "multipart" },
        maxBytes,
      })
    const { ManagedMailAccessError } = await import("~/modules/mailbox-crypto/managed-open")
    try {
      return withShortTx ? await withShortTx(read) : await read(ctx.txDb)
    } catch (err) {
      if (err instanceof ManagedMailAccessError) {
        refuse("file_not_readable", `file ${fileId} is another person's encrypted mail attachment`)
      }
      throw err
    }
  }
  if (Number(row.enc_version ?? 0) > 0) refuse("file_not_readable", "file is end-to-end encrypted")
  const { getObjectBytes } = await import("~/lib/storage/get-object-bytes")
  const got = await getObjectBytes(row.storage_key, { maxBytes })
  return { bytes: got.bytes, filename: row.filename, mimeType: row.mime_type }
}

export async function buildMultipartBody(
  ctx: BridgeContext,
  rawParts: unknown[],
  maxBytes: number,
): Promise<MultipartUpload> {
  if (rawParts.length === 0 || rawParts.length > MAX_PARTS) {
    refuse("invalid_multipart", `multipart needs 1 to ${MAX_PARTS} parts`)
  }
  const boundary = `----liaison${randomBytes(12).toString("hex")}`
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const parts: MultipartPartReport[] = []
  let size = 0
  const push = (b: Uint8Array) => {
    size += b.byteLength
    if (size > maxBytes) refuse("request_too_large", `Request body exceeds ${maxBytes} bytes`)
    chunks.push(b)
  }
  for (const raw of rawParts) {
    const p = raw as PartSpec
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !NAME_RE.test(p.name)) {
      refuse("invalid_multipart", "every part needs a name of letters, digits, _ - [ ] .")
    }
    if ("fileId" in p && typeof p.fileId === "string") {
      const refuseParents = Array.isArray(p.refuseParents)
        ? p.refuseParents.filter(
            (r) => r && typeof r.app === "string" && typeof r.entityType === "string",
          )
        : []
      const file = await readVisibleFile(ctx, p.fileId, maxBytes, refuseParents)
      const sha256 = createHash("sha256").update(file.bytes).digest("hex")
      if (p.expectSha256 && p.expectSha256.toLowerCase() !== sha256) {
        refuse(
          "part_sha256_mismatch",
          `part ${p.name}: the file's bytes do not match the expected fingerprint`,
        )
      }
      if (p.expectEmbeddedFile !== undefined) {
        const want = p.expectEmbeddedFile
        if (
          !want ||
          typeof want.name !== "string" ||
          typeof want.text !== "string" ||
          want.name === ""
        ) {
          refuse("invalid_multipart", `part ${p.name}: expectEmbeddedFile needs a name and a text`)
        }
        const embedded = await extractPdfEmbeddedFile(new Uint8Array(file.bytes), want.name)
        if (
          !embedded ||
          Buffer.compare(Buffer.from(embedded), Buffer.from(enc.encode(want.text))) !== 0
        ) {
          refuse(
            "embedded_file_mismatch",
            `part ${p.name}: the uploaded file does not embed exactly the ${want.name} that was checked`,
          )
        }
      }
      const filename = headerSafe(p.filename ?? file.filename, "filename")
      const contentType = headerSafe(
        p.contentType ?? file.mimeType ?? "application/octet-stream",
        "contentType",
      )
      push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
        ),
      )
      push(new Uint8Array(file.bytes))
      push(enc.encode("\r\n"))
      parts.push({ name: p.name, size: file.bytes.byteLength, sha256, fileId: p.fileId })
    } else if ("value" in p && typeof p.value === "string") {
      const v = enc.encode(p.value)
      push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n`))
      push(v)
      push(enc.encode("\r\n"))
      parts.push({
        name: p.name,
        size: v.byteLength,
        sha256: createHash("sha256").update(v).digest("hex"),
      })
    } else {
      refuse("invalid_multipart", `part ${p.name}: give either value (string) or fileId`)
    }
  }
  push(enc.encode(`--${boundary}--\r\n`))
  const body = new Uint8Array(size)
  let o = 0
  for (const c of chunks) {
    body.set(c, o)
    o += c.byteLength
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, size, parts }
}
