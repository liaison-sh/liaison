// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel__mail_attachment_read: an ordinary attachment goes through the cached media analysis; a
// sealed one is asked of the turn's own window over the mailbox request channel, analysed in
// memory, and leaves NOTHING behind (no summary, status or error on the row, no object read).
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { seedModelPricing } from "~/infra/seed-model-pricing"
import { MAILBOX_ATTACHMENT_MAX_BYTES } from "~/modules/agent/mailbox-plaintext/answer-limits"
import { fulfilMailboxMarker } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  MailboxPlaintextRegistryTestAccess,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import {
  defaultMailAttachmentReadDeps,
  handleMailAttachmentRead,
  MAIL_ATTACHMENT_DELIVERED_MESSAGE,
  type MailAttachmentReadDeps,
  type MailAttachmentReadParams,
} from "~/modules/agent/media/mail-attachment-read"
import {
  defaultMediaAnalysisToolDeps,
  type MediaAnalysisToolDeps,
  OFFICE_TEXT_MODEL,
} from "~/modules/agent/media/media-analysis-tool"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import type { AppContext } from "~/modules/apps/context"
import { seedFileRow } from "~/seed/factories/files/file-row"
import * as minimal from "~/seed/tiers/minimal"
import {
  installPermissiveFilesSelectPolicy,
  restoreFilesSelectPolicy,
} from "~/tests/helpers/files-select-policy"
import { createTestOrg } from "~/tests/helpers/org"

// Set by beforeAll: an org and a member made by the seed engine.
let ORG = ""
let USER = ""
const THREAD = "00000000-0000-4000-8000-0000000c0003"
const PLAIN_ID = "00000000-0000-4000-8000-0000000cf001"
const SEALED_ID = "00000000-0000-4000-8000-0000000cf002"
const BIG_ID = "00000000-0000-4000-8000-0000000cf003"
const TICKET_ID = "00000000-0000-4000-8000-0000000cf004"
const PRIVATE_PLAIN_ID = "00000000-0000-4000-8000-0000000cf005"

/** A bare PDF header is enough for file-type to sniff application/pdf. */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF")
const SUMMARY = "Invoice INV-2207 from Northwind Parts: 3 lines, total 1,240.00 EUR, due 30 days."

async function seed(opts: {
  id: string
  app?: string
  sealed?: boolean
  sizeBytes?: number
}): Promise<void> {
  await seedFileRow({
    id: opts.id,
    orgId: ORG,
    app: opts.app ?? "mail",
    entityType: "message",
    entityId: "msg-1",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: opts.sizeBytes ?? PDF.byteLength,
    storageKey: `orgs/${ORG}/mail/message/${opts.id}/invoice.pdf`,
    encVersion: opts.sealed ? 1 : 0,
    plaintextLength: opts.sealed ? (opts.sizeBytes ?? PDF.byteLength) : null,
  })
}

async function row(id: string) {
  const [r] = await sql`SELECT analysis_status, analysis_summary, analysis_model, analysis_at,
      analysis_error, analysis_context_hash, thumbnail_key FROM kernel.files WHERE id = ${id}`
  return r
}

function mediaDeps(): MediaAnalysisToolDeps & {
  getObjectBuffer: ReturnType<typeof mock>
  headObject: ReturnType<typeof mock>
  analyzeWithGemini: ReturnType<typeof mock>
} {
  return {
    ...defaultMediaAnalysisToolDeps,
    headObject: mock(async () => ({
      contentLength: PDF.byteLength,
      contentType: "application/pdf",
    })),
    getObjectBuffer: mock(async () => PDF),
    analyzeWithGemini: mock(async () => ({
      summary: SUMMARY,
      usage: { inputTokens: 100, outputTokens: 30 },
    })),
    enqueueAppJob: mock(async (): Promise<never> => {
      throw new Error("no background job may be enqueued here")
    }),
  }
}

const FRAME = {
  runId: "run-attach-1",
  parentRunId: null,
  rootRunId: "run-attach-1",
  nestingDepth: 0,
  mailboxTurnNonce: "nonce-owner",
} as RunContext

function harness(opts: { privateMailbox?: boolean; frame?: RunContext | undefined } = {}) {
  const media = {
    ...mediaDeps(),
    // The same answer as the reader's own predicate: analyze_media re-checks the mailbox.
    isPrivateMailFile: async () => opts.privateMailbox ?? false,
  }
  const contexts: Array<{ runId: string; block: string }> = []
  const deps: MailAttachmentReadDeps = {
    media,
    isPrivateMailbox: async () => opts.privateMailbox ?? false,
    currentRun: () => ("frame" in opts ? opts.frame : FRAME),
    injectContext: (runId, block) => {
      contexts.push({ runId, block })
    },
  }
  const run = (params: MailAttachmentReadParams) =>
    withRlsContext(
      { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      async (tx) =>
        handleMailAttachmentRead(
          params,
          { userId: USER, orgId: ORG, db: tx } as unknown as AppContext,
          deps,
        ),
    )
  return { media, contexts, run }
}

describe("kernel__mail_attachment_read", () => {
  beforeAll(async () => {
    const member = await minimal.person((await createTestOrg()).id)
    ORG = member.orgId
    USER = member.id
    // preCheck falls back to the placeholder GOOGLE_API_KEY of the test preload; the model
    // call itself is faked (as in media-analysis-tool.test.ts). Its price comes from the seed.
    await seedModelPricing()
    await installPermissiveFilesSelectPolicy()
  })

  afterAll(async () => {
    await restoreFilesSelectPolicy()
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
  })

  beforeEach(async () => {
    MailboxPlaintextRegistryTestAccess.reset()
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
  })

  it("unsealed attachment: returns the analysis through the cached path", async () => {
    await seed({ id: PLAIN_ID })
    const h = harness()
    const res = await h.run({ fileId: PLAIN_ID })
    expect("summary" in res && res.summary).toContain("INV-2207")
    // The id rides on the summary, so the stored-result redaction can resolve the file.
    expect("fileId" in res && res.fileId).toBe(PLAIN_ID)
    expect(h.media.analyzeWithGemini).toHaveBeenCalledTimes(1)
    const r = await row(PLAIN_ID)
    expect(r.analysis_status).toBe("done")
    expect(r.analysis_summary).toBe(SUMMARY)

    // The second read is the cache: no model call, no download.
    const again = await h.run({ fileId: PLAIN_ID })
    expect("cached" in again && again.cached).toBe(true)
    expect(h.media.analyzeWithGemini).toHaveBeenCalledTimes(1)
    expect(h.contexts).toHaveLength(0)
  })

  for (const answeredBy of ["the turn's window", "another unlocked app of the user"] as const) {
    it(`sealed attachment: round trip answered by ${answeredBy}, analysed in memory, nothing persisted`, async () => {
      await seed({ id: SEALED_ID, sealed: true })
      const h = harness()

      // Phase 1: the marker, ids only.
      const first = await h.run({ fileId: SEALED_ID })
      expect("needsPlaintext" in first && first.needsPlaintext).toEqual({
        requestKind: "mail.attachment",
        messageIds: [SEALED_ID],
        purpose: "read this attachment for the agent, for this turn only",
      })

      // The broker asks the turn's window; the stubbed browser answers with the readable bytes.
      const emitted: Array<Record<string, unknown>> = []
      const frame = { ...FRAME } as RunContext
      const fulfilled = await fulfilMailboxMarker({
        result: first,
        orgId: ORG,
        userId: USER,
        threadId: THREAD,
        frame,
        deps: {
          getUnlock: async () => ({ unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 }),
          emit: async (_action, data) => {
            emitted.push(data)
            const proof =
              answeredBy === "the turn's window"
                ? { turnNonce: "nonce-owner", turnOwner: true }
                : { orgId: ORG, answerToken: String(data.answerToken) }
            resolveMailboxRequest(String(data.requestId), {
              userId: USER,
              ...proof,
              response: {
                kind: "plaintext",
                items: [{ messageId: SEALED_ID, bytesBase64: PDF.toString("base64") }],
                undecryptable: [],
              },
            })
          },
          injectContext: () => {},
        },
      })
      expect(emitted[0]?.requestKind).toBe("mail.attachment")
      expect(emitted[0]?.messageIds).toEqual([SEALED_ID])
      // The request carries ids only, never bytes.
      expect(JSON.stringify(emitted)).not.toContain(PDF.toString("base64"))
      const supplied = fulfilled.retryArgs?.__mailboxAttachments
      expect(supplied).toEqual({ [SEALED_ID]: PDF.toString("base64") })

      // Phase 2: the bridge calls again with the bytes merged into the arguments.
      const second = await h.run({
        fileId: SEALED_ID,
        __mailboxAttachments: supplied as Record<string, unknown>,
      })
      expect("mailbox" in second && second.mailbox).toEqual({
        status: "delivered",
        message: MAIL_ATTACHMENT_DELIVERED_MESSAGE,
      })
      // The analysis ran on the decrypted bytes, never on the stored object.
      expect(h.media.getObjectBuffer).not.toHaveBeenCalled()
      expect(h.media.headObject).not.toHaveBeenCalled()
      const modelCall = h.media.analyzeWithGemini.mock.calls[0]?.[0] as
        | { parts: unknown[] }
        | undefined
      expect(JSON.stringify(modelCall?.parts)).toContain(PDF.toString("base64"))
      // The content reaches the model as the turn's context block, never the tool result.
      expect(JSON.stringify(second)).not.toContain("INV-2207")
      expect(h.contexts).toHaveLength(1)
      expect(h.contexts[0]?.runId).toBe(FRAME.runId)
      expect(h.contexts[0]?.block).toContain("INV-2207")

      // NOTHING persists: no summary, status, error, cache key or thumbnail on the row.
      const r = await row(SEALED_ID)
      expect(r).toEqual({
        analysis_status: null,
        analysis_summary: null,
        analysis_model: null,
        analysis_at: null,
        analysis_error: null,
        analysis_context_hash: null,
        thumbnail_key: null,
      })

      // A second read is not served from any cache: it asks again.
      const third = await h.run({ fileId: SEALED_ID })
      expect("needsPlaintext" in third).toBe(true)
    })
  }

  it("sealed attachment whose window did not decrypt: a plain locked error, nothing stored", async () => {
    await seed({ id: SEALED_ID, sealed: true })
    const h = harness()
    const res = await h.run({ fileId: SEALED_ID, __mailboxAttachments: { [SEALED_ID]: "" } })
    expect("error" in res && res.error.code).toBe("mailbox_locked")
    expect("error" in res && res.error.message).toContain("unlock")
    expect(h.media.analyzeWithGemini).not.toHaveBeenCalled()
    expect((await row(SEALED_ID)).analysis_error).toBeNull()
  })

  it("a model failure on a sealed attachment stores no error on the row", async () => {
    await seed({ id: SEALED_ID, sealed: true })
    const h = harness()
    h.media.analyzeWithGemini.mockImplementation(async () => {
      throw { error: { code: "model_error", message: "The media model is unavailable (503)." } }
    })
    const res = await h.run({
      fileId: SEALED_ID,
      __mailboxAttachments: { [SEALED_ID]: PDF.toString("base64") },
    })
    expect("error" in res && res.error).toEqual({
      code: "model_error",
      message: "The media model is unavailable (503).",
    })
    const r = await row(SEALED_ID)
    expect(r.analysis_status).toBeNull()
    expect(r.analysis_error).toBeNull()
    expect(h.contexts).toHaveLength(0)
  })

  it("over-size: refused before anything is asked of the browser", async () => {
    await seed({ id: BIG_ID, sealed: true, sizeBytes: MAILBOX_ATTACHMENT_MAX_BYTES + 1 })
    const h = harness()
    const res = await h.run({ fileId: BIG_ID })
    expect("error" in res && res.error.code).toBe("too_large")
    expect("error" in res && res.error.message).toContain("25 MB")
    expect("needsPlaintext" in res).toBe(false)
  })

  it("over-size bytes supplied anyway are refused, unanalysed", async () => {
    await seed({ id: SEALED_ID, sealed: true })
    const h = harness()
    const huge = Buffer.alloc(MAILBOX_ATTACHMENT_MAX_BYTES + 1, 1).toString("base64")
    const res = await h.run({ fileId: SEALED_ID, __mailboxAttachments: { [SEALED_ID]: huge } })
    expect("error" in res && res.error.code).toBe("too_large")
    expect(h.media.analyzeWithGemini).not.toHaveBeenCalled()
  })

  it("an unsealed attachment of an encrypted personal mailbox is read but not stored", async () => {
    await seed({ id: PRIVATE_PLAIN_ID })
    const h = harness({ privateMailbox: true })
    const res = await h.run({ fileId: PRIVATE_PLAIN_ID })
    expect("mailbox" in res && res.mailbox.status).toBe("delivered")
    expect(h.contexts[0]?.block).toContain("INV-2207")
    expect((await row(PRIVATE_PLAIN_ID)).analysis_summary).toBeNull()
    expect((await row(PRIVATE_PLAIN_ID)).analysis_status).toBeNull()
  })

  it("a sealed video is refused plainly: never normalized, nothing written to disk", async () => {
    await seed({ id: SEALED_ID, sealed: true })
    const h = harness()
    // An MP4 `ftyp` box: file-type sniffs video/mp4.
    const mp4 = Buffer.concat([
      Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02,
        0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
      ]),
      Buffer.alloc(64),
    ])
    const res = await h.run({
      fileId: SEALED_ID,
      __mailboxAttachments: { [SEALED_ID]: mp4.toString("base64") },
    })
    expect("error" in res && res.error.code).toBe("private_video_unsupported")
    expect("error" in res && res.error.message).toContain("A private video can't be analysed yet")
    expect(h.media.analyzeWithGemini).not.toHaveBeenCalled()
    expect(h.contexts).toHaveLength(0)
    expect((await row(SEALED_ID)).analysis_error).toBeNull()
  })

  it("the mailbox predicate FAILS CLOSED: unknown or unresolvable means private", async () => {
    const missing = "00000000-0000-4000-8000-0000000c0fff"
    const ask = defaultMailAttachmentReadDeps.isPrivateMailbox
    expect(await ask(ORG, "message", missing)).toBe(true)
    expect(await ask(ORG, "outbound_staging", missing)).toBe(true)
    // A query error (not a uuid) and an entity type it does not know.
    expect(await ask(ORG, "message", "not-a-uuid")).toBe(true)
    expect(await ask(ORG, "something_else", missing)).toBe(true)
  })

  it("a private attachment outside a conversation says where it can be read", async () => {
    await seed({ id: SEALED_ID, sealed: true })
    const h = harness({ frame: undefined })
    const res = await h.run({ fileId: SEALED_ID })
    expect("error" in res && res.error.code).toBe("needs_conversation")
  })

  it("a file that is not a mail attachment points to analyze_media", async () => {
    await seed({ id: TICKET_ID, app: "tickets" })
    const res = await harness().run({ fileId: TICKET_ID })
    expect("error" in res && res.error.code).toBe("not_mail_attachment")
  })

  it("an unsupported type names what can be read", async () => {
    await seed({ id: PLAIN_ID })
    const h = harness()
    h.media.getObjectBuffer.mockImplementation(async () => Buffer.from("just some plain words"))
    const res = await h.run({ fileId: PLAIN_ID })
    expect("error" in res && res.error.code).toBe("unsupported")
    expect("error" in res && res.error.message).toContain(".docx")
  })

  it("reads a Word document's text without a model call", async () => {
    await seed({ id: SEALED_ID, sealed: true })
    const h = harness()
    const docx = await buildDocx("Purchase order PO-5512", "Qty 4 x valve kit")
    const res = await h.run({
      fileId: SEALED_ID,
      __mailboxAttachments: { [SEALED_ID]: docx.toString("base64") },
    })
    expect("model" in res && res.model).toBe(OFFICE_TEXT_MODEL)
    expect(h.media.analyzeWithGemini).not.toHaveBeenCalled()
    expect(h.contexts[0]?.block).toContain("Purchase order PO-5512\nQty 4 x valve kit")
  })
})

/** A minimal .docx: the content types, the package relation and one body part. */
async function buildDocx(...lines: string[]): Promise<Buffer> {
  const { zipSync, strToU8 } = await import("fflate")
  const body = lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join("")
  const files = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  }
  return Buffer.from(zipSync(files))
}
