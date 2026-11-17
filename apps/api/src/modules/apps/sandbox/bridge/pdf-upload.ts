// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agreements app's uploaded documents, done by the host because a bundled
 * app cannot parse a PDF (and nothing parses one outside the render service):
 *
 *  - `pdf_upload_check`: reads the uploaded file kept on an agreement the caller
 *    can see, runs the file checks, the two readers' compare and the virus
 *    scan, and answers the
 *    verdict, the fingerprints and the report. Stores nothing. A tool call
 *    passes `deadlineMs`: past it the answer is `{status: "checking"}` and the
 *    app finishes the work in its `upload-freeze` job.
 *  - `pdf_upload_freeze`: for the uploaded version the app just created (no file yet, the
 *    checked fingerprints recorded on it; any other version is refused), runs the same
 *    checks again, refuses unless the bytes and the reading are the ones
 *    checked, then stores the uploaded bytes untouched as the version's frozen
 *    file and every page picture on the version. Answers their ids.
 *  - `pdf_upload_rescan`: for a frozen uploaded version whose virus scan did
 *    not run, scans its frozen file again, read under the caller's row rules
 *    and only when its bytes hash to the version's fingerprint. Answers the
 *    scan's state; the app records it. Stores nothing.
 *
 * All refuse any caller but the agreements app. Expected outcomes answer
 * data, never a throw.
 */

import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { scanBytes } from "~/lib/clamav"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { UPLOAD_PDF_MAX_BYTES } from "~/modules/documents/pdf-form-core"
import { checkUploadedPdf, type UploadCheck } from "~/modules/pdf-render/upload"

const APP = "agreements"
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function refuse(code: string, message: string): string {
  return JSON.stringify({ status: "error", error: { code, message } })
}

type FilesMethods = Record<string, (json: string) => Promise<string>>

export function createPdfUploadMethods(
  ctx: BridgeContext,
  files: FilesMethods,
): Record<string, (json: string) => Promise<string>> {
  const { requireApp, orgId, txDb } = ctx

  /**
   * The uploaded file's bytes: only the copy kept on an agreement (the person's
   * update put it there), read under the caller's own row rules, so the system
   * run of the `upload-freeze` job reads it as any reader of the agreement does.
   */
  const readUpload = async (
    fileId: string,
  ): Promise<{ bytes: Uint8Array } | { refusal: string }> => {
    if (!UUID.test(fileId))
      return { refusal: refuse("NOT_READABLE", "No such uploaded file. Nothing was frozen.") }
    const [row] = extractRows<{
      storage_key: string
      size_bytes: number | string
      enc_version: number | string | null
    }>(
      await txDb.execute(drizzleSql`
        SELECT storage_key, size_bytes, enc_version
          FROM ${drizzleSql.raw(schemaRef("kernel"))}.files
         WHERE id = ${fileId}::uuid AND org_id = ${orgId}::uuid
           AND app = ${APP} AND entity_type = 'agreement'
         LIMIT 1`),
    )
    if (!row || Number(row.enc_version ?? 0) !== 0)
      return {
        refusal: refuse(
          "NOT_READABLE",
          "That uploaded file cannot be read here. Nothing was frozen.",
        ),
      }
    if (Number(row.size_bytes) > UPLOAD_PDF_MAX_BYTES)
      return {
        refusal: refuse(
          "PDF_TOO_LARGE",
          "The file is over 8 MB. Signed copies go by mail; upload a smaller PDF. Nothing was frozen.",
        ),
      }
    const got = await getObjectBytes(row.storage_key, { maxBytes: UPLOAD_PDF_MAX_BYTES })
    return { bytes: new Uint8Array(got.bytes) }
  }

  const quarantine = async (fileId: string, check: UploadCheck) => {
    if (check.status !== "refused" || check.code !== "PDF_INFECTED") return
    const { emitSecurityEvent } = await import("~/modules/security/security-events")
    await emitSecurityEvent({
      kind: "malware_quarantined",
      orgId,
      detail: {
        where: APP,
        entityType: "upload",
        entityId: fileId,
        signature: check.signature ?? "",
      },
    })
  }

  const refusalOf = (check: Exclude<UploadCheck, { status: "ok" }>) =>
    refuse(check.code, `${check.message}. Nothing was frozen.`)

  const store = async (
    versionId: string,
    filename: string,
    mimeType: string,
    bytesBase64: string,
  ): Promise<string> => {
    const raw = await files.files_importAttachment?.(
      JSON.stringify({
        targetApp: APP,
        targetEntityType: "agreement_version",
        targetEntityId: versionId,
        filename,
        mimeType,
        bytesBase64,
      }),
    )
    const row = (typeof raw === "string" ? JSON.parse(raw) : raw) as { id?: string }
    if (!row?.id) throw new Error("file_not_stored")
    return row.id
  }

  /** A frozen version's own file, read under row rules, or why it cannot be. */
  const readFrozen = async (
    versionId: string,
  ): Promise<{ bytes: Uint8Array; fileId: string } | { refusal: string }> => {
    const [row] = extractRows<{
      file_id: string | null
      sha256: string | null
      storage_key: string | null
      enc_version: number | string | null
    }>(
      await txDb.execute(drizzleSql`
        SELECT v.file_id::text AS file_id, v.sha256, f.storage_key, f.enc_version
          FROM ${drizzleSql.raw(schemaRef("app_agreements"))}.agreement_versions v
          LEFT JOIN ${drizzleSql.raw(schemaRef("kernel"))}.files f
            ON f.id = v.file_id AND f.org_id = v.org_id AND f.app = ${APP}
           AND f.entity_type = 'agreement_version' AND f.entity_id = v.id::text
         WHERE v.id = ${versionId}::uuid AND v.org_id = ${orgId}::uuid
           AND v.source_kind = 'uploaded'
         LIMIT 1`),
    )
    if (!row?.file_id || !row.storage_key || Number(row.enc_version ?? 0) !== 0)
      return { refusal: refuse("NOT_READABLE", "That version has no frozen file to scan.") }
    const got = await getObjectBytes(row.storage_key, { maxBytes: UPLOAD_PDF_MAX_BYTES })
    const bytes = new Uint8Array(got.bytes)
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      return {
        refusal: refuse(
          "COPY_DIFFERS",
          "The stored file does not match the version's fingerprint. It was not scanned.",
        ),
      }
    return { bytes, fileId: row.file_id }
  }

  return {
    pdf_upload_rescan: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "pdf_upload_rescan")
      const p = JSON.parse(paramsJson || "{}") as { versionId: string }
      if (!UUID.test(p.versionId ?? ""))
        return refuse("NOT_FOUND", "No such agreement version. Nothing was scanned.")
      const read = await readFrozen(p.versionId)
      if ("refusal" in read) return read.refusal
      const scan = await scanBytes(read.bytes)
      if (scan.status === "infected") {
        await quarantine(read.fileId, {
          status: "refused",
          code: "PDF_INFECTED",
          message: "the virus scanner refused this file",
          signature: scan.signature,
        })
        return JSON.stringify({ status: "ok", scanState: "infected" })
      }
      return JSON.stringify({
        status: "ok",
        scanState: scan.status === "clean" ? "clean" : "not_run",
      })
    },

    pdf_upload_check: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "pdf_upload_check")
      const p = JSON.parse(paramsJson || "{}") as { fileId: string; deadlineMs?: number }
      const read = await readUpload(p.fileId)
      if ("refusal" in read) return read.refusal
      const work = checkUploadedPdf(orgId, read.bytes)
      const deadline = Number(p.deadlineMs ?? 0)
      const check =
        deadline > 0
          ? await Promise.race([
              work,
              new Promise<"checking">((r) => setTimeout(() => r("checking"), deadline)),
            ])
          : await work
      if (check === "checking") return JSON.stringify({ status: "checking" })
      if (check.status !== "ok") {
        await quarantine(p.fileId, check)
        return refusalOf(check)
      }
      return JSON.stringify({
        status: "ok",
        sha256: check.sha256,
        byteSize: check.byteSize,
        pageCount: check.intake.report.pageCount,
        pagesSha256: check.pagesSha256,
        scanState: check.scanState,
        scanned: check.intake.scanned,
        report: check.intake.report,
      })
    },

    pdf_upload_freeze: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "pdf_upload_freeze")
      const p = JSON.parse(paramsJson || "{}") as {
        fileId: string
        versionId: string
        sha256: string
        pagesSha256: string
        filename: string
      }
      if (!UUID.test(p.versionId))
        return refuse("NOT_FOUND", "No such agreement version. Nothing was frozen.")
      // Only the uploaded version just made for exactly these bytes and this reading, with no
      // file yet, takes them: never another version, nor one already holding its file.
      const [waiting] = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          SELECT id::text AS id FROM ${drizzleSql.raw(schemaRef("app_agreements"))}.agreement_versions
           WHERE id = ${p.versionId}::uuid AND org_id = ${orgId}::uuid
             AND source_kind = 'uploaded' AND status = 'frozen' AND file_id IS NULL
             AND sha256 = ${String(p.sha256 ?? "")} AND pages_sha256 = ${String(p.pagesSha256 ?? "")}
           LIMIT 1`),
      )
      if (!waiting)
        return refuse(
          "NOT_FOUND",
          "No uploaded version waits for this file with these fingerprints. Nothing was frozen.",
        )
      const read = await readUpload(p.fileId)
      if ("refusal" in read) return read.refusal
      const check = await checkUploadedPdf(orgId, read.bytes)
      if (check.status !== "ok") {
        await quarantine(p.fileId, check)
        return refusalOf(check)
      }
      if (check.sha256 !== p.sha256 || check.pagesSha256 !== p.pagesSha256)
        return refuse(
          "VERSION_CHANGED",
          "The file or its reading changed since it was checked. Nothing was frozen; prepare it again.",
        )
      const fileId = await store(
        p.versionId,
        p.filename,
        "application/pdf",
        Buffer.from(read.bytes).toString("base64"),
      )
      const pages = []
      for (const page of check.intake.pages) {
        const pictureFileId = await store(
          p.versionId,
          `page-${page.n}.webp`,
          "image/webp",
          page.reading,
        )
        const smallFileId = await store(
          p.versionId,
          `page-${page.n}-small.webp`,
          "image/webp",
          page.small,
        )
        pages.push({
          n: page.n,
          width: page.width,
          height: page.height,
          picture_file_id: pictureFileId,
          small_file_id: smallFileId,
          sha256: createHash("sha256").update(Buffer.from(page.reading, "base64")).digest("hex"),
          rgba_sha256: page.rgbaSha256,
          text: page.text,
        })
      }
      return JSON.stringify({ status: "ok", fileId, pages })
    },
  }
}
