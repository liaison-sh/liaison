// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agreements app's byte work at seal time, done by the host because a
 * bundled app cannot lay out a PDF or write a zip:
 *
 *  - `evidence_signed_pdf`: reads the frozen file, checks it is still the
 *    fingerprinted one, appends the signature pages and stores the signed PDF
 *    on the version. Answers its id and SHA-256.
 *  - `evidence_package_files`: builds the staff evidence file, each signer's
 *    copy and a colleague's copy (modules/signing/evidence-zip.ts writes each
 *    zip and refuses a file the manifest does not name) and stores them on the
 *    evidence package. Answers their ids.
 *  - `evidence_rehash`: the SHA-256 of stored files, for a verify. Answers
 *    hashes only, never bytes.
 *  - `evidence_mail_copy`: one signer's copy by system mail, the signed PDF and
 *    the copy attached, the fingerprint and the seal in the body.
 *
 * No hash here feeds the seal except the signed PDF's, which the app hands to
 * `signing_seal` (bridge/signing.ts) unchanged. Every method refuses any
 * caller but the agreements app, and reads and writes only that app's own
 * files through the files bridge's own doors (parent checks, quota, scan).
 * Expected outcomes answer data, never a throw.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

const APP = "agreements"

function refuse(code: string, message: string): string {
  return JSON.stringify({ status: "error", error: { code, message } })
}

type FilesMethods = Record<string, (json: string) => Promise<string>>

interface Parent {
  entityType: "agreement_version" | "evidence_package"
  entityId: string
}

export function createEvidenceMethods(
  ctx: BridgeContext,
  files: FilesMethods,
): Record<string, (json: string) => Promise<string>> {
  const { requireApp, orgId, txDb } = ctx

  const readBytes = async (fileId: string, parent: Parent): Promise<Uint8Array> => {
    const raw = await files.files_getAttachmentBytes?.(
      JSON.stringify({ fileId, allowedParents: [{ app: APP, ...parent }] }),
    )
    const out = JSON.parse(String(raw)) as { bytesBase64: string; encVersion?: number }
    if (out.encVersion && out.encVersion > 0) throw new Error("sealed_file")
    return new Uint8Array(Buffer.from(out.bytesBase64, "base64"))
  }

  const store = async (
    parent: Parent,
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<string> => {
    const raw = await files.files_importAttachment?.(
      JSON.stringify({
        targetApp: APP,
        targetEntityType: parent.entityType,
        targetEntityId: parent.entityId,
        filename,
        mimeType,
        bytesBase64: Buffer.from(bytes).toString("base64"),
      }),
    )
    const row = (typeof raw === "string" ? JSON.parse(raw) : raw) as { id?: string }
    if (!row?.id) throw new Error("file_not_stored")
    return row.id
  }

  return {
    evidence_signed_pdf: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "evidence_signed_pdf")
      const p = JSON.parse(paramsJson || "{}") as {
        versionId: string
        frozenFileId: string
        documentSha256: string
        lang: "en" | "fr"
        agreement: string
        version: number
        filename: string
        signers: Array<{
          name: string
          capacity: string
          typedPhrase: string | null
          signedAt: string
          level: string
        }>
      }
      const { sha256Hex } = await import("~/modules/signing/seal")
      const { appendSignaturePages, renderSignaturePages, SignaturePageError } = await import(
        "~/modules/agreement-evidence/signature-pages"
      )
      const version: Parent = { entityType: "agreement_version", entityId: p.versionId }
      const frozen = await readBytes(p.frozenFileId, version)
      if (sha256Hex(frozen) !== p.documentSha256)
        return refuse(
          "DOCUMENT_CHANGED",
          "The stored frozen file is not the fingerprinted one. Nothing was signed or sealed.",
        )
      try {
        const pages = await renderSignaturePages({
          lang: p.lang === "fr" ? "fr" : "en",
          documentSha256: p.documentSha256,
          agreement: p.agreement,
          version: p.version,
          signers: p.signers.map((s) => ({ ...s, signedAt: new Date(s.signedAt) })),
        })
        const out = await appendSignaturePages(frozen, pages)
        const fileId = await store(version, p.filename, "application/pdf", out.bytes)
        return JSON.stringify({
          status: "ok",
          fileId,
          sha256: sha256Hex(out.bytes),
          byteSize: out.bytes.byteLength,
          pageCount: out.pageCount,
          signaturePageCount: out.signaturePageCount,
        })
      } catch (err) {
        if (err instanceof SignaturePageError) return refuse(err.code, err.message)
        return refuse(
          "MERGE_FAILED",
          `The signed PDF could not be built (${(err as Error).message}). The version stays signed; the seal is retried.`,
        )
      }
    },

    evidence_package_files: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "evidence_package_files")
      const p = JSON.parse(paramsJson || "{}") as {
        packageId: string
        versionId: string
        signedFileId: string
        frozenFileId: string
        tsrFileId?: string | null
        trail: { events: Array<{ client_action_id: string }> }
        manifestJson: string
        seal: string
        sealedAt: string
        lang: "en" | "fr"
        title: string
        agreement: string
        version: number
        signers: Array<{ name: string; capacity: string }>
        signerActionIds: string[]
        /** Names the stamped set (built again when the stamp arrives). */
        stamped?: boolean
      }
      const { buildPackageFiles, checkPage, renderCertificate } = await import(
        "~/modules/agreement-evidence/package-files"
      )
      const { sha256Hex } = await import("~/modules/signing/seal")
      const version: Parent = { entityType: "agreement_version", entityId: p.versionId }
      const pkg: Parent = { entityType: "evidence_package", entityId: p.packageId }
      const signedPdf = await readBytes(p.signedFileId, version)
      const frozenPdf = await readBytes(p.frozenFileId, version)
      const tsr = p.tsrFileId ? await readBytes(p.tsrFileId, pkg) : undefined
      const manifestBytes = new TextEncoder().encode(p.manifestJson)
      const orgName = await orgNameOf()
      const certificatePdf = await renderCertificate({
        lang: p.lang === "fr" ? "fr" : "en",
        orgName,
        agreement: p.agreement,
        version: p.version,
        title: p.title,
        documentSha256: sha256Hex(frozenPdf),
        signedPdfSha256: sha256Hex(signedPdf),
        seal: p.seal,
        sealedAt: new Date(p.sealedAt),
        timestamped: tsr !== undefined,
        signers: p.signers,
      })
      try {
        const built = buildPackageFiles({
          signedPdf,
          frozenPdf,
          trail: p.trail,
          manifestBytes,
          seal: p.seal,
          ...(tsr ? { timestampReply: tsr } : {}),
          certificatePdf,
          checkHtml: checkPage({
            documentSha256: sha256Hex(frozenPdf),
            signedPdfSha256: sha256Hex(signedPdf),
            seal: p.seal,
          }),
          sealedAt: new Date(p.sealedAt),
          signerActionIds: p.signerActionIds,
        })
        const suffix = p.stamped ? "-stamped" : ""
        const base = `${p.agreement}-v${p.version}`
        const evidenceFileId = await store(
          pkg,
          `${base}-evidence${suffix}.zip`,
          "application/zip",
          built.evidence,
        )
        const signerCopyFileIds: Record<string, string> = {}
        for (const [id, bytes] of Object.entries(built.signerCopies)) {
          signerCopyFileIds[id] = await store(
            pkg,
            `${base}-copy${suffix}.zip`,
            "application/zip",
            bytes,
          )
        }
        signerCopyFileIds.colleague = await store(
          pkg,
          `${base}-copy${suffix}.zip`,
          "application/zip",
          built.colleagueCopy,
        )
        return JSON.stringify({ status: "ok", evidenceFileId, signerCopyFileIds })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === "evidence_inconsistent" || code === "invalid_seal_input")
          return refuse(
            "EVIDENCE_INCONSISTENT",
            `The evidence file was not written: ${(err as Error).message}.`,
          )
        throw err
      }
    },

    evidence_rehash: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "evidence_rehash")
      const p = JSON.parse(paramsJson || "{}") as {
        files: Array<{ fileId: string; parent: Parent }>
      }
      const { sha256Hex } = await import("~/modules/signing/seal")
      const hashes: Record<string, string | null> = {}
      for (const f of p.files ?? []) {
        try {
          hashes[f.fileId] = sha256Hex(await readBytes(f.fileId, f.parent))
        } catch {
          hashes[f.fileId] = null
        }
      }
      return JSON.stringify({ status: "ok", hashes })
    },

    evidence_mail_copy: async (paramsJson: string): Promise<string> => {
      requireApp(APP, "evidence_mail_copy")
      const p = JSON.parse(paramsJson || "{}") as {
        to: string
        lang: "en" | "fr"
        agreement: string
        version: number
        title: string
        documentSha256: string
        seal: string
        timestamped: boolean
        senderEmail?: string | null
        versionId: string
        packageId: string
        signedFileId: string
        copyFileId: string
      }
      const { sendSignedCopyMail } = await import("~/modules/agreement-evidence/copy-mail")
      try {
        const signedPdf = await readBytes(p.signedFileId, {
          entityType: "agreement_version",
          entityId: p.versionId,
        })
        const copyZip = await readBytes(p.copyFileId, {
          entityType: "evidence_package",
          entityId: p.packageId,
        })
        const base = `${p.agreement}-v${p.version}`
        await sendSignedCopyMail({
          orgId,
          orgName: await orgNameOf(),
          to: p.to,
          lang: p.lang === "fr" ? "fr" : "en",
          agreement: p.agreement,
          version: p.version,
          title: p.title,
          documentSha256: p.documentSha256,
          seal: p.seal,
          timestamped: p.timestamped,
          senderEmail: p.senderEmail ?? null,
          signedPdf: { filename: `${base}-signed.pdf`, bytes: signedPdf },
          copyZip: { filename: `${base}-evidence-copy.zip`, bytes: copyZip },
        })
        return JSON.stringify({ status: "sent" })
      } catch (err) {
        return JSON.stringify({
          status: "failed",
          reason: (err as Error).name || "send_failed",
          message: "The copy was not sent; it is retried by the copies job.",
        })
      }
    },
  }

  async function orgNameOf(): Promise<string> {
    const K = drizzleSql.raw(schemaRef("kernel"))
    const rows = extractRows<{ name: string }>(
      await txDb.execute(drizzleSql`SELECT name FROM ${K}.organizations WHERE id = ${orgId}`),
    )
    return rows[0]?.name ?? ""
  }
}
