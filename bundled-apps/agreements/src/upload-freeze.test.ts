// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An uploaded PDF frozen as is: the host's checks decide, the version holds the
// fingerprints the host read, a refused file leaves no version, a long check
// answers `checking` and the job finishes it. At seal, a signed copy that does
// not read as the frozen file did writes no package and no seal.

import { describe, expect, it } from "bun:test"
import { agreementCreate, agreementPrepare, agreementUpdate, uploadFreezeJob } from "./agreements"
import type { AgreementsCtx } from "./ctx"
import { memoryDb, type Row } from "./memory-db.testutil"
import { packageOf, sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"

const PERSON = "11111111-1111-4111-8111-111111111111"
const UPLOAD = "44444444-4444-4444-8444-444444444444"
/** The copy the host keeps on the agreement. */
const KEPT_COPY = "55555555-5555-4555-8555-555555555555"
const SHA = "c".repeat(64)
const PAGES = "d".repeat(64)

function world(check: () => unknown) {
  const db = memoryDb()
  const calls = { freeze: [] as unknown[], attach: [] as unknown[] }
  const readable = { upload: true }
  const ctx: AgreementsCtx = {
    orgId: "org",
    userId: PERSON,
    db,
    turn: { get: async () => ({ agentId: null }) },
    today: "2026-11-16",
    files_attachToParent: async (p) => {
      calls.attach.push(p)
      if (!readable.upload) throw new Error("source file not found or not readable")
      return { id: KEPT_COPY, filename: "upload.pdf", mimeType: "application/pdf", sizeBytes: 1200 }
    },
    pdf_upload_check: async () => check(),
    pdf_upload_freeze: async (p) => {
      calls.freeze.push(p)
      return {
        status: "ok",
        fileId: "frozen-file",
        pages: [
          { n: 1, picture_file_id: "pic-1", sha256: "e".repeat(64), text: "PRICE EUR 10000" },
        ],
      }
    },
  }
  return { db, ctx, calls, readable }
}

const KEPT = {
  status: "ok",
  sha256: SHA,
  byteSize: 1200,
  pageCount: 1,
  pagesSha256: PAGES,
  scanState: "not_run",
  scanned: false,
  report: {
    revisions: 0,
    signed: true,
    emptyFields: 12,
    comments: 0,
    fontsNotEmbedded: 0,
    openGoTo: false,
  },
}

async function draftWithUpload(ctx: AgreementsCtx): Promise<string> {
  const created = (await agreementCreate(ctx, {
    kind: "other",
    title: "Supplier contract",
    what_it_is: "The supplier's own contract",
    file_id: UPLOAD,
  })) as { id?: string; agreement?: { id: string } }
  return (created.id ?? created.agreement?.id) as string
}

describe("an uploaded PDF frozen as is", () => {
  it("the version holds the uploaded file's fingerprint and the reading's, and is marked uploaded", async () => {
    const w = world(() => KEPT)
    const id = await draftWithUpload(w.ctx)
    const out = (await agreementPrepare(w.ctx, { id })) as Record<string, unknown>
    expect(out).toMatchObject({ status: "ok", sha256: SHA, page_count: 1 })
    expect(String(out.message)).toContain("12 empty field(s) in this file will stay empty.")
    expect(String(out.message)).toContain("digital signature")
    const [v] = w.db.tables.get("agreement_versions") as Row[]
    expect(v).toMatchObject({
      source_kind: "uploaded",
      sha256: SHA,
      pages_sha256: PAGES,
      file_id: "frozen-file",
      scan_state: "not_run",
      status: "frozen",
    })
    expect(w.calls.freeze[0]).toMatchObject({ fileId: KEPT_COPY, sha256: SHA, pagesSha256: PAGES })
  })

  it("a refused file leaves no version and says why", async () => {
    const w = world(() => ({
      status: "error",
      error: {
        code: "PDF_ACTIVE_CONTENT",
        message: "the file holds /JavaScript. Nothing was frozen.",
      },
    }))
    const id = await draftWithUpload(w.ctx)
    expect(await agreementPrepare(w.ctx, { id })).toMatchObject({
      status: "error",
      error: { code: "PDF_ACTIVE_CONTENT" },
    })
    expect(w.db.tables.get("agreement_versions") ?? []).toHaveLength(0)
    expect(w.calls.freeze).toHaveLength(0)
  })

  it("a long check answers checking, and the job freezes it", async () => {
    let answer: unknown = { status: "checking" }
    const w = world(() => answer)
    const id = await draftWithUpload(w.ctx)
    expect(await agreementPrepare(w.ctx, { id })).toMatchObject({
      status: "checking",
      version_id: null,
    })
    expect(w.db.tables.get("agreement_versions") ?? []).toHaveLength(0)
    answer = KEPT
    expect(await uploadFreezeJob(w.ctx)).toMatchObject({ frozen: 1 })
    expect(w.db.tables.get("agreement_versions")).toHaveLength(1)
    expect(await uploadFreezeJob(w.ctx)).toMatchObject({ frozen: 0 })
  })

  it("a later upload on a draft makes the next version an upload again", async () => {
    const w = world(() => KEPT)
    const id = await draftWithUpload(w.ctx)
    await agreementPrepare(w.ctx, { id })
    const [d] = w.db.tables.get("agreement_drafts") as Row[]
    expect(d?.upload_file_id).toBeNull()
    expect(await agreementUpdate(w.ctx, { id, file_id: UPLOAD })).toMatchObject({ status: "ok" })
    const [d2] = w.db.tables.get("agreement_drafts") as Row[]
    expect(d2?.upload_file_id).toBe(KEPT_COPY)
  })

  it("the upload is kept as a copy on the agreement, so whoever reads the agreement reads it", async () => {
    const w = world(() => KEPT)
    const id = await draftWithUpload(w.ctx)
    expect(w.calls.attach[0]).toEqual({
      sourceFileId: UPLOAD,
      targetApp: "agreements",
      targetEntityType: "agreement",
      targetEntityId: id,
    })
    const [d] = w.db.tables.get("agreement_drafts") as Row[]
    expect(d?.upload_file_id).toBe(KEPT_COPY)
  })

  it("an upload the person cannot read changes nothing on the draft", async () => {
    const w = world(() => KEPT)
    const id = await draftWithUpload(w.ctx)
    await agreementPrepare(w.ctx, { id })
    w.readable.upload = false
    const out = await agreementUpdate(w.ctx, { id, file_id: UPLOAD })
    expect(out).toMatchObject({ status: "error", error: { code: "NOT_READABLE" } })
    const [d] = w.db.tables.get("agreement_drafts") as Row[]
    expect(d?.upload_file_id).toBeNull()
  })
})

describe("the seal of an uploaded version", () => {
  it("a signed copy that does not read as the frozen file writes no package and no seal", async () => {
    const w = await signedWorld()
    let sealed = 0
    w.ctx.evidence_signed_pdf = async () => ({
      status: "error",
      error: {
        code: "COPY_DIFFERS",
        message: "The signed copy did not match what was read. Nothing was sealed. Send it again.",
      },
    })
    const realSeal = w.ctx.signing_seal
    w.ctx.signing_seal = async (p: unknown) => {
      sealed++
      return realSeal?.(p)
    }
    const out = await sealVersion(w.ctx, w.versionId)
    expect(out).toMatchObject({ status: "error", error: { code: "COPY_DIFFERS" } })
    expect(sealed).toBe(0)
    expect(await packageOf(w.ctx, w.versionId)).toBeNull()
    const mismatch = w.ctx.calls.emitted.filter((e) => e.action === "mismatch")
    expect(mismatch[0]?.data).toMatchObject({ what: "signed_copy" })
    expect(w.ctx.calls.mails).toHaveLength(0)
  })
})
