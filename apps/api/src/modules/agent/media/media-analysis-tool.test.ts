// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import sharp from "sharp"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { hashContext } from "~/modules/agent/media/media-analysis-shared"
import {
  type AnalyzeMediaParams,
  type AnalyzeMediaResult,
  defaultMediaAnalysisToolDeps,
  handleAnalyzeMedia,
  type MediaAnalysisOptions,
  type MediaAnalysisToolDeps,
} from "~/modules/agent/media/media-analysis-tool"
import type { AppContext } from "~/modules/apps/context"
import {
  installPermissiveFilesSelectPolicy,
  restoreFilesSelectPolicy,
} from "~/tests/helpers/files-select-policy"

const ORG_A = "00000000-0000-4000-8000-0000000a0001"
const ORG_B = "00000000-0000-4000-8000-0000000b0001"
const USER_A = "00000000-0000-4000-8000-0000000a0002"

/** Build a small real JPEG so fileTypeFromBuffer sniffs image/jpeg. */
async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .toBuffer()
}

/** Build a buffer with an MP4 ftyp box so file-type sniffs video/mp4. */
function makeMp4(extra = 0): Buffer {
  const header = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ])
  return extra > 0 ? Buffer.concat([header, Buffer.alloc(extra)]) : header
}

/**
 * Build a minimal PDF buffer. A bare `%PDF-1.4` header is enough for
 * fileTypeFromBuffer to sniff `application/pdf` (verified). `pad` grows it with
 * trailing bytes to exercise the DOCUMENT_MAX_BYTES cap without a real encoder.
 */
function makePdf(pad = 0): Buffer {
  const header = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
  )
  return pad > 0 ? Buffer.concat([header, Buffer.alloc(pad)]) : header
}

async function seedFile(opts: {
  id: string
  orgId: string
  app: string
  status?: string | null
  summary?: string | null
  at?: string | null
  contextHash?: string | null
}): Promise<void> {
  await sql`INSERT INTO kernel.files
    (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key,
     analysis_status, analysis_summary, analysis_at, analysis_context_hash)
    VALUES (${opts.id}, ${opts.orgId}, ${opts.app}, 'message', 'msg-1', 'photo.jpg',
            'image/jpeg', 1234, ${`orgs/${opts.orgId}/${opts.app}/message/${opts.id}/photo.jpg`},
            ${opts.status ?? null}, ${opts.summary ?? null}, ${opts.at ?? null}, ${opts.contextHash ?? null})`
}

/** Run the handler inside an RLS context for the given org/user (mirrors execute-tool.ts). */
async function runAnalyze(
  orgId: string,
  userId: string,
  params: AnalyzeMediaParams,
  deps: MediaAnalysisToolDeps,
  opts: MediaAnalysisOptions = {},
): Promise<AnalyzeMediaResult> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
    async (tx) => {
      const ctx = {
        userId,
        orgId,
        db: tx,
        actorType: "agent",
        approverUserId: null,
      } as unknown as AppContext
      return handleAnalyzeMedia(params, ctx, deps, opts)
    },
  )
}

function fakeDeps(over: Partial<MediaAnalysisToolDeps> = {}): MediaAnalysisToolDeps {
  return {
    ...defaultMediaAnalysisToolDeps,
    headObject: mock(async () => ({ contentLength: 1234, contentType: "image/jpeg" })),
    getObjectBuffer: mock(async () => await makeJpeg()),
    // Deterministic passthrough — the real normalizer would spawn ffmpeg/ffprobe.
    // Tests for the normalizer itself live in media-normalize.test.ts.
    normalizeMedia: mock(async (buffer: Buffer, detectedMime: string) => ({
      buffer,
      mime: detectedMime,
      kind: detectedMime.startsWith("video/") ? ("video" as const) : ("image" as const),
    })),
    analyzeWithGemini: mock(async () => ({
      summary: "It shows a cracked LCD panel with error E04.",
      usage: { inputTokens: 120, outputTokens: 40 },
    })),
    // An ordinary mailbox unless a test says otherwise (the real predicate has its own test).
    isPrivateMailFile: mock(async () => false),
    ...over,
  }
}

async function creditRows(orgId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM kernel.credit_transactions
    WHERE org_id = ${orgId} AND model = 'gemini-flash-lite-latest'`
  return (rows[0]?.n as number | undefined) ?? 0
}

describe("handleAnalyzeMedia", () => {
  // preCheck resolves the Google key before any spend; with no BYOK key on the
  // test org it falls back to GOOGLE_API_KEY, which the test preload
  // (src/tests/test-env-defaults.ts) sets to a placeholder. The model call
  // itself is faked.

  beforeAll(async () => {
    for (const org of [ORG_A, ORG_B]) {
      await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
        VALUES (${org}, ${`Org ${org}`}, ${`org-${org}`}, '{}')
        ON CONFLICT (id) DO UPDATE SET settings = '{}'`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_A}, 'media-a@test.com', 'Media A', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, source)
      VALUES ('google', 'gemini-flash-lite-latest', 'Gemini Flash Lite', '0.09000000', '0.35000000', 1000000, true, 'manual')
      ON CONFLICT (provider, model_id) DO NOTHING`
    // Production reads a file via the tickets/mail fileParent projection. Here
    // we install an org-scoped read policy (what a real readable parent grants)
    // so the handler's RLS resolve can find the seeded rows, in one transaction,
    // and put back what the registry describes afterwards.
    await installPermissiveFilesSelectPolicy()
  })

  afterAll(async () => {
    await restoreFilesSelectPolicy()
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.files WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.files WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`UPDATE kernel.organizations SET settings = '{}' WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("image happy path → done, persists, bills once", async () => {
    const id = "00000000-0000-4000-8000-00000000f001"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, fakeDeps())
    expect("summary" in res && res.summary.length > 0).toBe(true)
    const [row] = await sql`SELECT analysis_status, analysis_summary, analysis_model, analysis_at
      FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("done")
    expect(row.analysis_summary).toBeTruthy()
    expect(row.analysis_model).toBe("gemini-flash-lite-latest")
    expect(row.analysis_at).toBeTruthy()
    expect(await creditRows(ORG_A)).toBe(1)
    const [txn] = await sql`SELECT raw_cost FROM kernel.credit_transactions
      WHERE org_id = ${ORG_A} AND model = 'gemini-flash-lite-latest'`
    expect(Number(txn.raw_cost)).toBeGreaterThan(0)
  })

  it("disabled surface → refusal, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000f002"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"mail":{"image":false,"video":false}}}'::jsonb
      WHERE id = ${ORG_A}`
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, fakeDeps())
    expect("error" in res && res.error.code).toBe("analysis_disabled")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("per-KIND gate: MP4 on mail with video:false (image:true) → analysis_disabled, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000fa01"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"mail":{"image":true,"video":false}}}'::jsonb
      WHERE id = ${ORG_A}`
    // A real MP4 buffer so the sniffed kind is 'video' — the gate must read the
    // VIDEO toggle (false), not the IMAGE toggle (true).
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => makeMp4()),
      headObject: mock(async () => ({ contentLength: 24, contentType: "video/mp4" })),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("analysis_disabled")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("per-KIND gate inverse: image on mail with image:false (video:true) → analysis_disabled", async () => {
    const id = "00000000-0000-4000-8000-00000000fa02"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"mail":{"image":false,"video":true}}}'::jsonb
      WHERE id = ${ORG_A}`
    // A JPEG → sniffed kind 'image'; the gate must read the IMAGE toggle (false).
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, fakeDeps())
    expect("error" in res && res.error.code).toBe("analysis_disabled")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("unsupported surface → unsupported_surface, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000f003"
    await seedFile({ id, orgId: ORG_A, app: "threads" })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, fakeDeps())
    expect("error" in res && res.error.code).toBe("unsupported_surface")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("cache hit on an unbriefed re-analysis; refresh re-bills", async () => {
    const id = "00000000-0000-4000-8000-00000000f004"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps()
    const first = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("cached" in first && first.cached).toBe(false)
    const second = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("cached" in second && second.cached).toBe(true)
    expect(await creditRows(ORG_A)).toBe(1)
    const third = await runAnalyze(ORG_A, USER_A, { fileId: id, refresh: true }, deps)
    expect("cached" in third && third.cached).toBe(false)
    expect(await creditRows(ORG_A)).toBe(2)
  })

  // A briefing is the agent's own text and can carry what its turn read elsewhere (an order,
  // an invoice). The analysis it steers goes back to the agent only: the file row, which
  // everyone who can open the file reads, never holds it. FALSIFIABLE: storing it made the
  // tool a write to kernel.files, and every routine tick that had read an order parked it.
  it("a briefed analysis comes back to the agent and leaves the file row untouched", async () => {
    const id = "00000000-0000-4000-8000-00000000f00b"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps()
    const briefing = "customer order #3530, invoice INV-0412"
    const first = await runAnalyze(ORG_A, USER_A, { fileId: id, context: briefing }, deps)
    expect("summary" in first && first.summary.length > 0).toBe(true)
    expect("cached" in first && first.cached).toBe(false)
    const [row] = await sql`SELECT analysis_status, analysis_summary, analysis_context_hash
      FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBeNull()
    expect(row.analysis_summary).toBeNull()
    expect(row.analysis_context_hash).toBeNull()
    // Never served from a cache it could not have written: the same briefing runs again.
    const second = await runAnalyze(ORG_A, USER_A, { fileId: id, context: briefing }, deps)
    expect("cached" in second && second.cached).toBe(false)
    expect(await creditRows(ORG_A)).toBe(2)
  })

  it("a briefed call does not read the stored unbriefed summary", async () => {
    const id = "00000000-0000-4000-8000-00000000f00c"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps()
    await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    const briefed = await runAnalyze(ORG_A, USER_A, { fileId: id, context: "the LED" }, deps)
    expect("cached" in briefed && briefed.cached).toBe(false)
    expect(await creditRows(ORG_A)).toBe(2)
    // The stored, unbriefed analysis is still the one on the row.
    const [row] = await sql`SELECT analysis_status, analysis_context_hash FROM kernel.files
      WHERE id = ${id}`
    expect(row.analysis_status).toBe("done")
    expect(row.analysis_context_hash).toBe(hashContext(undefined))
  })

  it("empty-string context and no-arg context collide on the same cache slot", async () => {
    const id = "00000000-0000-4000-8000-00000000f005"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps()
    await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    const second = await runAnalyze(ORG_A, USER_A, { fileId: id, context: "" }, deps)
    expect("cached" in second && second.cached).toBe(true)
    expect(await creditRows(ORG_A)).toBe(1)
  })

  // NOTE: this is structurally an RLS-RESOLVE test — the cache fields come off
  // the step-1 RLS row, so org B never sees org A's row at all (→ not_found) and
  // a cross-path cache leak is impossible by construction. We keep the
  // secret-string negative assertion as a belt-and-suspenders guard.
  it("RLS-resolve guard: org B cannot read org A's cached summary (not_found, no leak)", async () => {
    const id = "00000000-0000-4000-8000-00000000f006"
    await seedFile({
      id,
      orgId: ORG_A,
      app: "tickets",
      status: "done",
      summary: "ORG A SECRET SUMMARY",
      at: new Date().toISOString(),
      contextHash: null,
    })
    const res = await runAnalyze(ORG_B, USER_A, { fileId: id }, fakeDeps())
    expect("error" in res && res.error.code).toBe("not_found")
    if ("summary" in res) expect(res.summary).not.toContain("ORG A SECRET")
  })

  it("oversize file → too_large, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000f007"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps({
      headObject: mock(async () => ({
        contentLength: 300 * 1024 * 1024,
        contentType: "image/jpeg",
      })),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("too_large")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("getObjectBuffer maxBytes streaming throw → typed too_large (not a raw handler throw)", async () => {
    const id = "00000000-0000-4000-8000-00000000fb01"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => {
        throw new Error("Object exceeds maxBytes=209715200 during streaming")
      }),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("too_large")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("a generic storage error → typed storage_error (sanitized), no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000fb02"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => {
        throw new Error("S3 connection reset")
      }),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("storage_error")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("empty model summary → typed empty_summary + status=error (no blank 'done', no re-bill)", async () => {
    const id = "00000000-0000-4000-8000-00000000fb03"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const deps = fakeDeps({
      analyzeWithGemini: mock(async () => ({
        summary: "",
        usage: { inputTokens: 100, outputTokens: 0 },
      })),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("empty_summary")
    const [row] =
      await sql`SELECT analysis_status, analysis_summary FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
    // It still billed the (already-spent) call once, but did NOT persist a blank 'done'.
    expect(row.analysis_summary).toBeNull()
  })

  it("preCheck failure → precheck_failed, NO persisted error status, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000fb04"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const preCheck: MediaAnalysisToolDeps["preCheck"] = mock(
      async (_orgId: string, _modelId?: string | null) => ({
        allowed: false as const,
        status: 402 as const,
        persistSystemMessage: false,
        reason: "Insufficient credits.",
      }),
    )
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, fakeDeps({ preCheck }))
    expect("error" in res && res.error.code).toBe("precheck_failed")
    const [row] = await sql`SELECT analysis_status FROM kernel.files WHERE id = ${id}`
    // A billing/config refusal must NOT write analysis_status='error'.
    expect(row.analysis_status).toBeNull()
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("large video → processing, enqueues slow job with exact jobId + userId, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000f008"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const enqueueAppJob = mock(async () => {})
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => makeMp4(21 * 1024 * 1024)),
      headObject: mock(async () => ({ contentLength: 22 * 1024 * 1024, contentType: "video/mp4" })),
      enqueueAppJob: enqueueAppJob as unknown as MediaAnalysisToolDeps["enqueueAppJob"],
    })
    // Briefed: the slow job's only output is the file row, so the briefing never travels.
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id, context: "order #3530" }, deps)
    expect("status" in res && res.status).toBe("processing")
    expect(enqueueAppJob).toHaveBeenCalledTimes(1)
    const call = enqueueAppJob.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      { jobId: string },
    ]
    expect(call[0]).toBe("kernel")
    expect(call[1]).toBe("files-media-analysis")
    expect(call[2].userId).toBe(USER_A)
    expect("context" in call[2]).toBe(false)
    expect(call[3].jobId).toBe(`files-media-analysis:${id}`)
    const [row] = await sql`SELECT analysis_status FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("pending")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("timeout: AbortController fires, typed timeout, status=error", async () => {
    const id = "00000000-0000-4000-8000-00000000f009"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    let firedSignal: AbortSignal | undefined
    const deps = fakeDeps({
      deadlineMs: 5,
      analyzeWithGemini: mock(
        (args: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            firedSignal = args.signal
            args.signal.addEventListener("abort", () => reject(new Error("aborted")))
          }),
      ) as unknown as MediaAnalysisToolDeps["analyzeWithGemini"],
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("timeout")
    expect(firedSignal?.aborted).toBe(true)
    const [row] = await sql`SELECT analysis_status FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
  })

  it("RLS isolation on first resolve: foreign fileId → not_found", async () => {
    const id = "00000000-0000-4000-8000-00000000f00a"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const res = await runAnalyze(ORG_B, USER_A, { fileId: id }, fakeDeps())
    expect("error" in res && res.error.code).toBe("not_found")
  })

  // --- PDF document support -------------------------------------------------

  it("PDF document happy path: sniffs document, bypasses normalize, sends inline application/pdf, done", async () => {
    const id = "00000000-0000-4000-8000-00000000fd01"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    const pdf = makePdf()
    const normalizeMedia = mock(async (buffer: Buffer, detectedMime: string) => ({
      buffer,
      mime: detectedMime,
      kind: "image" as const,
    }))
    const analyzeWithGemini = mock(async () => ({
      summary: "Purchase order PO-4471: 3x SKU-EQ2 at 219.00 EUR, total 657.00 EUR.",
      usage: { inputTokens: 300, outputTokens: 60 },
    }))
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => pdf),
      headObject: mock(async () => ({
        contentLength: pdf.byteLength,
        contentType: "application/pdf",
      })),
      normalizeMedia,
      analyzeWithGemini: analyzeWithGemini as unknown as MediaAnalysisToolDeps["analyzeWithGemini"],
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("summary" in res && res.summary.length > 0).toBe(true)
    // Documents skip normalization entirely (spy never called).
    expect(normalizeMedia).toHaveBeenCalledTimes(0)
    // The inline part carries the RAW pdf bytes with the application/pdf mime.
    const call = analyzeWithGemini.mock.calls[0] as unknown as [
      { parts: Array<{ inlineData?: { mimeType?: string; data?: string } }> },
    ]
    const inline = call[0].parts[0]?.inlineData
    expect(inline?.mimeType).toBe("application/pdf")
    expect(inline?.data).toBe(pdf.toString("base64"))
    const [row] =
      await sql`SELECT analysis_status, analysis_summary FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("done")
    expect(row.analysis_summary).toBeTruthy()
    expect(await creditRows(ORG_A)).toBe(1)
  })

  it("oversize PDF (>14 MB raw) → too_large, no normalize, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000fd02"
    await seedFile({ id, orgId: ORG_A, app: "tickets" })
    // 15 MB of raw bytes — over the 14 MB document cap but under MEDIA_MAX_BYTES,
    // so the guard is the document-specific cap, not the generic 200 MB one.
    const big = makePdf(15 * 1024 * 1024)
    const normalizeMedia = mock(async (buffer: Buffer, detectedMime: string) => ({
      buffer,
      mime: detectedMime,
      kind: "image" as const,
    }))
    const analyzeWithGemini = mock(async () => ({
      summary: "unreachable",
      usage: { inputTokens: 0, outputTokens: 0 },
    }))
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => big),
      headObject: mock(async () => ({
        contentLength: big.byteLength,
        contentType: "application/pdf",
      })),
      normalizeMedia,
      analyzeWithGemini: analyzeWithGemini as unknown as MediaAnalysisToolDeps["analyzeWithGemini"],
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("too_large")
    expect(normalizeMedia).toHaveBeenCalledTimes(0)
    expect(analyzeWithGemini).toHaveBeenCalledTimes(0)
    expect(await creditRows(ORG_A)).toBe(0)
  })

  // The document per-surface gate: unlike image/video, document defaults ON for
  // mail (business PDFs arriving as mail attachments are the primary use case).
  // The settings read runs privileged, so an explicit org override CAN turn it
  // off — both directions asserted here against the real org settings row.
  it("PDF on mail (document default on) → analyzed, bills once", async () => {
    const id = "00000000-0000-4000-8000-00000000fd03"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    const pdf = makePdf()
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => pdf),
      headObject: mock(async () => ({
        contentLength: pdf.byteLength,
        contentType: "application/pdf",
      })),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("summary" in res && res.summary.length > 0).toBe(true)
    expect(await creditRows(ORG_A)).toBe(1)
  })

  it("PDF on mail with an org override document:false → analysis_disabled, no spend (override read privileged)", async () => {
    const id = "00000000-0000-4000-8000-00000000fd05"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"mail":{"document":false}}}'::jsonb
      WHERE id = ${ORG_A}`
    try {
      const pdf = makePdf()
      const deps = fakeDeps({
        getObjectBuffer: mock(async () => pdf),
        headObject: mock(async () => ({
          contentLength: pdf.byteLength,
          contentType: "application/pdf",
        })),
      })
      const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
      expect("error" in res && res.error.code).toBe("analysis_disabled")
      expect(await creditRows(ORG_A)).toBe(0)
    } finally {
      await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${ORG_A}`
    }
  })

  it("PDF on kernel (agent-chat, document default on) → analyzed, bills once", async () => {
    const id = "00000000-0000-4000-8000-00000000fd04"
    await seedFile({ id, orgId: ORG_A, app: "kernel" })
    const pdf = makePdf()
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => pdf),
      headObject: mock(async () => ({
        contentLength: pdf.byteLength,
        contentType: "application/pdf",
      })),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("summary" in res && res.summary.length > 0).toBe(true)
    expect(await creditRows(ORG_A)).toBe(1)
  })

  // files.analyzeDocument: an app reading its own file is judged on the `apps` surface.
  function pdfDeps(): MediaAnalysisToolDeps {
    const pdf = makePdf()
    return fakeDeps({
      getObjectBuffer: mock(async () => pdf),
      headObject: mock(async () => ({
        contentLength: pdf.byteLength,
        contentType: "application/pdf",
      })),
    })
  }

  it("an app's own PDF on the apps surface → analysed, bills once, file row untouched", async () => {
    const id = "00000000-0000-4000-8000-00000000fd06"
    await seedFile({ id, orgId: ORG_A, app: "shipping-app" })
    const res = await runAnalyze(
      ORG_A,
      USER_A,
      { fileId: id, context: "Read the tracking number." },
      pdfDeps(),
      { surface: "apps" },
    )
    expect("summary" in res && res.summary.length > 0).toBe(true)
    expect(await creditRows(ORG_A)).toBe(1)
    const row = await sql`SELECT analysis_status FROM kernel.files WHERE id = ${id}`
    expect(row[0]?.analysis_status ?? null).toBeNull()
  })

  it("apps surface switched off → analysis_disabled, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000fd07"
    await seedFile({ id, orgId: ORG_A, app: "shipping-app" })
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"apps":{"document":false}}}'::jsonb
      WHERE id = ${ORG_A}`
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id, context: "q" }, pdfDeps(), {
      surface: "apps",
    })
    expect("error" in res && res.error.code).toBe("analysis_disabled")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("the agent's call on an app file keeps the file's own surface → unsupported_surface", async () => {
    const id = "00000000-0000-4000-8000-00000000fd08"
    await seedFile({ id, orgId: ORG_A, app: "shipping-app" })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, pdfDeps())
    expect("error" in res && res.error.code).toBe("unsupported_surface")
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("kinds limited to image + document: a video is refused before any spend or slow job, even with video on", async () => {
    const id = "00000000-0000-4000-8000-00000000fd09"
    await seedFile({ id, orgId: ORG_A, app: "shipping-app" })
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"apps":{"video":true}}}'::jsonb
      WHERE id = ${ORG_A}`
    const enqueueAppJob = mock(async () => {})
    const deps = fakeDeps({
      getObjectBuffer: mock(async () => makeMp4(21 * 1024 * 1024)),
      headObject: mock(async () => ({ contentLength: 22 * 1024 * 1024, contentType: "video/mp4" })),
      enqueueAppJob: enqueueAppJob as unknown as MediaAnalysisToolDeps["enqueueAppJob"],
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id, context: "q" }, deps, {
      surface: "apps",
      kinds: ["image", "document"],
    })
    expect("error" in res && res.error.code).toBe("unsupported")
    expect(enqueueAppJob).toHaveBeenCalledTimes(0)
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("a cleartext attachment of a PRIVATE mailbox → refused, nothing read, cached or stored", async () => {
    const id = "00000000-0000-4000-8000-00000000fb01"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    const deps = fakeDeps({ isPrivateMailFile: mock(async () => true) })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("private_mailbox")
    expect("error" in res && res.error.message).toContain("kernel__mail_attachment_read")
    expect(deps.getObjectBuffer).not.toHaveBeenCalled()
    expect(deps.analyzeWithGemini).not.toHaveBeenCalled()
    const [row] = await sql`SELECT analysis_status, analysis_summary, analysis_error
      FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBeNull()
    expect(row.analysis_summary).toBeNull()
    expect(row.analysis_error).toBeNull()
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("a cached summary of a private mailbox's attachment is not served either", async () => {
    const id = "00000000-0000-4000-8000-00000000fb02"
    await seedFile({
      id,
      orgId: ORG_A,
      app: "mail",
      status: "done",
      summary: "an old cached summary",
      at: new Date().toISOString(),
      contextHash: "",
    })
    const res = await runAnalyze(
      ORG_A,
      USER_A,
      { fileId: id },
      fakeDeps({ isPrivateMailFile: mock(async () => true) }),
    )
    expect("error" in res && res.error.code).toBe("private_mailbox")
  })

  it("the real predicate FAILS CLOSED: a mail file whose mailbox does not resolve is private", async () => {
    const id = "00000000-0000-4000-8000-00000000fb03"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    // No mail message behind `msg-1`: unknown means private, so analyze_media refuses it.
    const deps = fakeDeps({ isPrivateMailFile: defaultMediaAnalysisToolDeps.isPrivateMailFile })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps)
    expect("error" in res && res.error.code).toBe("private_mailbox")
    expect(deps.getObjectBuffer).not.toHaveBeenCalled()
    // A file of another app is not a mailbox's.
    const other = "00000000-0000-4000-8000-00000000fb04"
    await seedFile({ id: other, orgId: ORG_A, app: "tickets" })
    expect(await defaultMediaAnalysisToolDeps.isPrivateMailFile(ORG_A, other)).toBe(false)
  })

  it("a supplied (private) video is refused before normalization: nothing touches the disk", async () => {
    const id = "00000000-0000-4000-8000-00000000fb05"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    const deps = fakeDeps()
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps, {
      suppliedBuffer: makeMp4(),
      noPersist: true,
    })
    expect("error" in res && res.error.code).toBe("private_video_unsupported")
    expect("error" in res && res.error.message).toContain("A private video can't be analysed yet")
    expect(deps.normalizeMedia).not.toHaveBeenCalled()
    expect(deps.analyzeWithGemini).not.toHaveBeenCalled()
    expect(await creditRows(ORG_A)).toBe(0)
  })

  it("a supplied (private) image is normalized in memory only", async () => {
    const id = "00000000-0000-4000-8000-00000000fb06"
    await seedFile({ id, orgId: ORG_A, app: "mail" })
    // Images of email are off until an admin turns them on.
    await sql`UPDATE kernel.organizations
      SET settings = '{"mediaAnalysis":{"mail":{"image":true}}}'::jsonb WHERE id = ${ORG_A}`
    const seen: unknown[] = []
    const deps = fakeDeps({
      normalizeMedia: mock(async (buffer: Buffer, mime: string, nd?: unknown) => {
        seen.push(nd)
        return { buffer, mime, kind: "image" as const }
      }),
    })
    const res = await runAnalyze(ORG_A, USER_A, { fileId: id }, deps, {
      suppliedBuffer: await makeJpeg(),
      noPersist: true,
    })
    expect("summary" in res).toBe(true)
    expect(seen).toEqual([{ inMemoryOnly: true }])
    expect(deps.getObjectBuffer).not.toHaveBeenCalled()
    const [row] = await sql`SELECT analysis_summary FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_summary).toBeNull()
  })
})
