// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side K2 PDF renderer. Looks up a registered template by
// (orgId, callingAppId, kind), runs it through the pool, optionally
// normalises through Ghostscript to PDF/A-3, then stores the bytes as a
// `kernel.files` row owned by the calling app. Returns the new file id
// plus byte size, page count, and a flag indicating whether PDF/A-3
// normalisation succeeded.

import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import {
  getObjectBuffer as defaultGetObjectBuffer,
  putObject as defaultPutObject,
} from "~/infra/storage/object-storage"
import { pdfLogger as log } from "~/lib/logger"
import { isAppActiveForOrgAsync } from "~/modules/apps/org-apps"
import {
  buildStorageKey,
  loadOrgSettings,
  noteStoredOrgUsage,
  resolveParent,
  storageQuotaExemption,
  wouldExceedOrgQuota,
} from "~/modules/files/service"
import type { PdfAAttachment } from "./pdfa/finalize"
import type { XmpExtension } from "./pdfa/xmp"
import { enqueue, PdfRenderError } from "./pool"
import { getTemplate } from "./registry"
import { loadAppTemplates } from "./registry-rehydrate"

const K = () => sql.raw(schemaRef("kernel"))

export const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024
let MAX_PDF_BYTES_OVERRIDE: number | undefined

function maxPdfBytes(): number {
  return MAX_PDF_BYTES_OVERRIDE ?? DEFAULT_MAX_PDF_BYTES
}

export interface RenderPdfInput {
  orgId: string
  callingAppId: string
  template_kind: string
  data: unknown
  /** Default: true. When false, Ghostscript normalisation is skipped. */
  pdf_a3?: boolean
  /**
   * Optional caller-supplied download name for the stored file (e.g. an invoice
   * number). Sanitised to safe characters and forced to a single `.pdf`
   * extension. When omitted, the file is named after the template kind
   * (`invoicing_invoice_v1.pdf`), which is unhelpful for a customer download —
   * apps that have a real document identity should pass one.
   */
  filename?: string
  /**
   * Native PDF/A-3B output (replaces the best-effort Ghostscript pass): XMP, sRGB OutputIntent,
   * embedded fonts only, trailer ID, and the associated files below. Validated by the caller
   * (the sandbox bridge) before it gets here.
   */
  pdfa?: "3b"
  /** Associated files embedded in a PDF/A-3 document (`pdfa` required). */
  attachments?: PdfAAttachment[]
  /** XMP extension schemas (with their pdfaExtension description) for a PDF/A document. */
  xmpExtensions?: XmpExtension[]
  /**
   * The file parent the stored file belongs to. Default: `pdf`, entity id = the new file id
   * (a document row then points at it). The bridge validated `entityType` as one of the calling
   * app's registered fileParents and resolved `entityId`.
   */
  parent?: { entityType: string; entityId: string }
  /**
   * Who asked for the render, as the HOST knows it (the sandbox bridge's own
   * actor and acting agent, never a value the app passes). Decides the storage
   * quota: a render a person or an agent starts is refused at the org's quota,
   * system work and a legal record's file are stored anyway. Absent = refused at
   * the quota like a person's render.
   */
  actor?: { actorType: "user" | "agent" | "system" | "mcp"; actingAgentId: string | null }
  /** The execution token of the app run that asked for the render (its bridge's). */
  nestedParentKey?: string
}

/** The org is at its storage quota and the render is not exempt: nothing was stored. */
export class PdfStorageQuotaError extends Error {
  readonly code = "STORAGE_QUOTA_EXCEEDED"
  constructor() {
    super("The organization's storage limit is reached; the PDF was not saved")
    this.name = "PdfStorageQuotaError"
  }
}

export interface RenderPdfResult {
  file_id: string
  byte_size: number
  page_count: number
  pdf_a3_normalized: boolean
  /** The final stored filename (sanitised caller name, or the kind fallback). */
  filename: string
  /** SHA-256 (hex) of the stored bytes. */
  sha256: string
  /** "3b" when the file was produced as PDF/A-3B natively. */
  pdfa: "3b" | null
  /** Where the file is attached. */
  parent_entity_type: string
  parent_entity_id: string
}

export interface RenderPdfDeps {
  putObject?: typeof defaultPutObject
  privileged?: <T>(reason: string, fn: (tx: unknown) => Promise<T>) => Promise<T>
  getObjectBuffer?: typeof defaultGetObjectBuffer
}

/**
 * Resolve an `embedImage` command's `fileId` to bytes + mime, scoped to
 * `orgId` AND to files the calling app itself owns (`kernel.files.app`): the
 * template's data is app-supplied, and a lookup by org alone would let it embed
 * any image in the org (another app's private attachment, a mail inline image)
 * into a PDF its caller can read. Sealed (encrypted) files are skipped, their
 * bytes being ciphertext. Fail-closed: a `kernel.files` row that doesn't belong to this org
 * (or doesn't exist) resolves to `null`, same as any other lookup failure
 * (storage read error, non-image mime). `withPrivilegedDb` scopes the lookup
 * to `orgId` via the `app.current_org_id` GUC, so a plain
 * `WHERE id = fileId` already can't cross orgs, but we still filter on
 * `org_id` explicitly for defense in depth / readability.
 */
export function makeResolveImage(
  orgId: string,
  callingAppId: string,
  getObjectBuffer: typeof defaultGetObjectBuffer,
): (fileId: string) => Promise<{ bytes: Uint8Array; mime: string } | null> {
  return async (fileId: string) => {
    try {
      const row = await withPrivilegedDb(orgId, "pdf:resolve-image", async (tx) => {
        const rs = await tx.execute(
          sql`SELECT storage_key AS "storageKey", mime_type AS "mimeType"
              FROM ${K()}.files
              WHERE id = ${fileId}::uuid AND org_id = ${orgId}::uuid
                AND app = ${callingAppId} AND enc_version = 0
              LIMIT 1`,
        )
        return (rs as unknown as Array<{ storageKey: string; mimeType: string }>)[0]
      })
      if (!row) return null
      const buf = await getObjectBuffer(row.storageKey)
      return { bytes: new Uint8Array(buf), mime: row.mimeType }
    } catch (err) {
      log.warn({ err, orgId, fileId }, "pdf embedImage resolve failed; skipping")
      return null
    }
  }
}

export async function renderPdf(
  _dbUnused: unknown,
  input: RenderPdfInput,
  deps: RenderPdfDeps = {},
): Promise<RenderPdfResult> {
  const { orgId, callingAppId, template_kind, data } = input
  const wantPdfA3 = input.pdf_a3 !== false
  const nativePdfA = input.pdfa === "3b"
  if (!nativePdfA && (input.attachments?.length || input.xmpExtensions?.length)) {
    throw new PdfRenderError("render_failed", "attachments and xmp extensions need pdfa")
  }

  // An app turned Off for the org renders no PDF (S19, A6): its registered
  // templates survive in this process (registration is not torn down), so the
  // persisted state decides. Fail-closed on an unreadable state.
  if (!(await isAppActiveForOrgAsync(orgId, callingAppId))) {
    throw new PdfRenderError("app_disabled", `the ${callingAppId} app is turned off by your admin`)
  }
  let source = getTemplate(callingAppId, template_kind)
  if (!source) {
    // Loaded on demand: nothing loads at boot.
    await loadAppTemplates(callingAppId)
    source = getTemplate(callingAppId, template_kind)
  }
  if (!source) {
    throw new PdfRenderError("template_not_found", `no template registered for ${template_kind}`)
  }

  // Run through the pool — saturation, deadline, and template runtime errors
  // bubble up as PdfRenderError.
  const getObjectBuffer = deps.getObjectBuffer ?? defaultGetObjectBuffer
  const rawBytes = await enqueue({
    orgId,
    appId: callingAppId,
    source,
    data,
    ...(input.nestedParentKey ? { nestedParentKey: input.nestedParentKey } : {}),
    replay: {
      resolveImage: makeResolveImage(orgId, callingAppId, getObjectBuffer),
      ...(nativePdfA
        ? {
            pdfa: {
              level: "3b" as const,
              attachments: input.attachments ?? [],
              xmpExtensions: input.xmpExtensions ?? [],
            },
          }
        : {}),
    },
  })

  const cap = maxPdfBytes()
  if (rawBytes.byteLength > cap) {
    throw new PdfRenderError("output_too_large", `pdf > ${cap} bytes`)
  }

  // Try PDF/A-3 normalisation via Ghostscript. Any failure (binary missing,
  // non-zero exit, spawn error) falls back to the un-normalised bytes plus
  // a flag so callers can stamp `pdf_status = pdf_a3_normalization_skipped`.
  let bytes = rawBytes
  let pdf_a3_normalized = nativePdfA
  if (wantPdfA3 && !nativePdfA) {
    const out = await normalizeToPdfA3(rawBytes)
    if (out) {
      bytes = out
      pdf_a3_normalized = true
    } else {
      log.warn({ orgId, callingAppId, template_kind }, "ghostscript normalisation skipped")
    }
  }

  // Best-effort page count via pdf-lib. If the doc cannot be parsed (very
  // unusual once render succeeded), default to 1 — we already have valid
  // PDF bytes from the renderer.
  let page_count = 1
  try {
    const { PDFDocument } = await import("pdf-lib")
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    page_count = doc.getPageCount()
  } catch (err) {
    log.warn({ err }, "page count parse failed; defaulting to 1")
  }

  const filename = input.filename
    ? sanitiseProvidedFilename(input.filename)
    : `${sanitiseKind(template_kind)}.pdf`
  const stored = await storeGeneratedPdf(
    {
      orgId,
      app: callingAppId,
      ...(input.parent ? { parent: input.parent } : {}),
      filename,
      bytes,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    deps,
  )
  const fileId = stored.fileId
  const parentType = stored.parentEntityType
  const parentId = stored.parentEntityId

  return {
    file_id: fileId,
    byte_size: bytes.byteLength,
    page_count,
    pdf_a3_normalized,
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pdfa: nativePdfA ? "3b" : null,
    parent_entity_type: parentType,
    parent_entity_id: parentId,
  }
}

export interface StoreGeneratedPdfInput {
  orgId: string
  /** The app the file belongs to (`kernel.files.app`). */
  app: string
  /** Default: `pdf`, entity id = the new file id. */
  parent?: { entityType: string; entityId: string }
  /** The final, already safe filename. */
  filename: string
  bytes: Uint8Array
  /** Decides the storage quota exemption (see RenderPdfInput.actor). */
  actor?: RenderPdfInput["actor"]
  /** Who asked for it; null (the default) for a server-rendered file. */
  uploadedBy?: string | null
}

export interface StoredGeneratedPdf {
  fileId: string
  parentEntityType: string
  parentEntityId: string
}

/**
 * Store a PDF the server produced as a `kernel.files` row: the org's storage
 * quota first (refused with PdfStorageQuotaError unless exempt), then the
 * object, then the row. The caller has already authorised the parent.
 */
export async function storeGeneratedPdf(
  input: StoreGeneratedPdfInput,
  deps: Pick<RenderPdfDeps, "putObject"> = {},
): Promise<StoredGeneratedPdf> {
  const { orgId, bytes, filename } = input
  const fileId = randomUUID()
  const parentType = input.parent?.entityType ?? "pdf"
  const parentId = input.parent?.entityId ?? fileId
  const storageKey = buildStorageKey({
    orgId,
    app: input.app,
    entityType: parentType,
    entityId: parentId,
    filename,
  })

  // The org's storage quota, before any byte is stored (see `actor`).
  const exemption = storageQuotaExemption({
    actorType: input.actor?.actorType ?? "user",
    actingAgentId: input.actor?.actingAgentId ?? null,
    parent: resolveParent(orgId, input.app, parentType),
  })
  if (
    exemption === null &&
    (await withPrivilegedDb(orgId, "pdf:render-quota", async (tx) =>
      wouldExceedOrgQuota(tx, orgId, await loadOrgSettings(tx, orgId), bytes.byteLength),
    ))
  ) {
    throw new PdfStorageQuotaError()
  }
  const put = deps.putObject ?? defaultPutObject
  await put({ key: storageKey, body: bytes, contentType: "application/pdf" })

  await withPrivilegedDb(orgId, "pdf:render", async (tx) => {
    await tx.insert(files).values({
      id: fileId,
      orgId,
      app: input.app,
      entityType: parentType,
      entityId: parentId,
      filename,
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      storageKey,
      // Null when server-rendered with no person behind it.
      uploadedBy: input.uploadedBy ?? null,
    })
    await noteStoredOrgUsage(tx, orgId)
  })
  return { fileId, parentEntityType: parentType, parentEntityId: parentId }
}

function sanitiseKind(kind: string): string {
  return kind.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

/**
 * Turn a caller-supplied download name into a safe single-`.pdf` filename:
 * keep only the basename (no path traversal), map unsafe characters to `_`
 * (same class as `sanitiseKind`), collapse any caller `.pdf` suffix so we never
 * emit `foo.pdf.pdf`, cap the stem length, and never return an empty name.
 */
function sanitiseProvidedFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const stem = base
    .replace(/\.pdf$/i, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120)
  return `${stem || "document"}.pdf`
}

/**
 * Pipe `bytes` through Ghostscript with `-dPDFA=3`. Returns the normalised
 * bytes on success, or `null` on any failure (missing binary, non-zero exit,
 * spawn error) — caller is responsible for falling back to the un-normalised
 * bytes and stamping `pdf_a3_normalized: false` downstream.
 */
async function normalizeToPdfA3(bytes: Uint8Array): Promise<Uint8Array | null> {
  const bin = Bun.env.GS_BIN ?? "gs"
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), "pdfa3-"))
    const inPath = join(dir, "in.pdf")
    const outPath = join(dir, "out.pdf")
    await writeFile(inPath, bytes)
    const proc = Bun.spawn(
      [
        bin,
        "-dPDFA=3",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=pdfwrite",
        `-sOutputFile=${outPath}`,
        inPath,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    const exit = await proc.exited
    if (exit !== 0) return null
    return await readFile(outPath)
  } catch {
    return null
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Helper for tests and other modules that need to read back the raw PDF
 * bytes by file id. Reads the storage key under privileged access, then
 * fetches the object bytes from storage.
 *
 * SECURITY NOTE (Phase 17 fix M1): this helper bypasses RLS — the file row
 * was just written under privileged context and we have a file id but no
 * caller. It is intended for the rehydrate / health-check / test paths only
 * and MUST NOT be exposed to bundled apps. The sandbox bridge's `pdf_render`
 * accessor returns a `file_id` and stops there — apps that need to read the
 * bytes back go through the standard `files_*` RPC which is RLS-scoped.
 */
export async function getFileBytes(
  _db: unknown,
  fileId: string,
  deps: { getObjectBuffer?: typeof defaultGetObjectBuffer } = {},
): Promise<Uint8Array> {
  const getBuf = deps.getObjectBuffer ?? defaultGetObjectBuffer
  // Read storage key under the system role — the file row is the source of
  // truth for orgId; we don't have a caller context here.
  const row = await import("~/db/privileged").then(({ withSystemDb }) =>
    withSystemDb("pdf:read-file", async (tx) => {
      const rs = await tx.execute(
        sql`SELECT storage_key AS "storageKey" FROM ${K()}.files WHERE id = ${fileId}::uuid LIMIT 1`,
      )
      return (rs as unknown as Array<{ storageKey: string }>)[0]
    }),
  )
  if (!row) throw new Error(`file ${fileId} not found`)
  return await getBuf(row.storageKey)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const PdfRenderTestAccess = {
  setMaxPdfBytes(bytes: number | undefined): void {
    MAX_PDF_BYTES_OVERRIDE = bytes
  },
}
