// SPDX-License-Identifier: FSL-1.1-ALv2
import { orgKernelSettingsSchema } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { fileTypeFromBuffer } from "file-type"
import sharp from "sharp"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob as defaultEnqueueAppJob } from "~/infra/jobs/jobs"
import {
  getObjectBuffer as defaultGetObjectBuffer,
  headObject as defaultHeadObject,
} from "~/infra/storage/object-storage"
import { isManagedEdition } from "~/lib/edition"
import { wrapExternalContent } from "~/lib/external-content"
import { filesLogger as log } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { UUID_RE } from "~/lib/uuid"
import {
  finalizeUsage as defaultFinalizeUsage,
  preCheck as defaultPreCheck,
} from "~/modules/agent/credits/credit-meter"
import { managedSideCallGate as defaultManagedSideCallGate } from "~/modules/agent/credits/managed-side-call"
import {
  analyzeWithGemini as defaultAnalyzeWithGemini,
  analyzeWithOpenRouter as defaultAnalyzeWithOpenRouter,
  type MappedTokens,
  type MediaPart,
  redactSecrets,
} from "~/modules/agent/media/media-analysis-client"
import {
  ANALYSIS_CACHE_TTL_MS,
  ANALYSIS_DEADLINE_MS,
  DOCUMENT_MAX_BYTES,
  IMAGE_MAX_LONG_EDGE_PX,
  INLINE_VIDEO_MAX_REQUEST_BYTES,
  MANAGED_INLINE_MEDIA_MAX_BYTES,
  MANAGED_MEDIA_ANALYSIS_UPSTREAM_ID,
  MEDIA_ANALYSIS_MODEL_ID,
  MEDIA_MAX_BYTES,
  type MediaKind,
  managedMediaTooLargeMessage,
  resolveMediaAnalysisPermission,
  type SupportedSurface,
  VIDEO_END_OFFSET_SECONDS,
  VIDEO_FPS,
} from "~/modules/agent/media/media-analysis-constants"
import { buildSystemInstruction, hashContext } from "~/modules/agent/media/media-analysis-shared"
import {
  normalizeMedia as defaultNormalizeMedia,
  type NormalizeDeps,
  NormalizeError,
} from "~/modules/agent/media/media-normalize"
import {
  type OfficeFormat,
  OfficeTextError,
  officeDocumentText,
  officeFormatOf,
} from "~/modules/agent/media/office-text"
import type { AppContext } from "~/modules/apps/context"
import { demoMediaAnalysisRefusal } from "~/modules/demo/demo-spend"
import { fileIsFromOutside } from "~/modules/files/origin"
import { isMailFilePrivate } from "~/modules/mailbox-crypto/content-suppression"

const K = sql.raw(schemaRef("kernel"))

export interface AnalyzeMediaParams {
  fileId: string
  context?: string
  refresh?: boolean
}

/** The caller identity the analysis needs: its org, its actor (for usage) and its RLS client. */
export type MediaAnalysisCaller = Pick<AppContext, "orgId" | "userId" | "db">

/** Host-side options a tool parameter can never set. */
export interface MediaAnalysisOptions {
  /** Judge the toggle under this surface instead of the file's own app (an app reading its own
   *  file through `files.analyzeDocument` is the `apps` surface). */
  surface?: SupportedSurface
  /** Analyse only these kinds, judged on the sniffed bytes; anything else is `unsupported` before
   *  any spend or slow job (an app's `files.analyzeDocument` takes images and PDFs only). */
  kinds?: readonly MediaKind[]
  /** Analyse these bytes instead of the stored object: the readable copy of an end-to-end
   *  encrypted mail attachment, opened by its owner's browser for this turn
   *  (mail-attachment-read.ts). Implies `noPersist`. */
  suppliedBuffer?: Buffer
  /** Store nothing: no cached summary read or written, no error, no pending status, no slow
   *  job. The analysis goes back to the caller only (a private mailbox's attachment). */
  noPersist?: boolean
}

/** The `model` of an Office document's result: its text, read without a model call. */
export const OFFICE_TEXT_MODEL = "text-extraction"

/** Typed result the agent sees (success). */
export type AnalyzeMediaResult =
  | { summary: string; model: string; analyzedAt: string; cached: boolean }
  | { status: "processing" }
  | { error: { code: string; message: string } }

/**
 * Injection seam — every collaborator optional, each defaulting to the real
 * import in `defaultMediaAnalysisToolDeps`. Mirrors `ThumbnailDeps` /
 * `ProofreadDeps`. Without this seam the timeout/size/cache/cost tests are
 * vacuous (45 s real waits, unspyable module consts, no-op spies).
 */
export interface MediaAnalysisToolDeps {
  headObject: typeof defaultHeadObject
  getObjectBuffer: typeof defaultGetObjectBuffer
  analyzeWithGemini: typeof defaultAnalyzeWithGemini
  /** The managed edition's model call (S31): OpenRouter, zero data retention. */
  analyzeWithOpenRouter: typeof defaultAnalyzeWithOpenRouter
  /** The managed edition's spend gate for that call (D17 refusal, balance). */
  managedSideCallGate: typeof defaultManagedSideCallGate
  preCheck: typeof defaultPreCheck
  finalizeUsage: typeof defaultFinalizeUsage
  enqueueAppJob: typeof defaultEnqueueAppJob
  privileged: <T>(orgId: string, reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  /** Normalize raw bytes to a Gemini-safe format (ffmpeg/heic-convert/sharp). */
  normalizeMedia: (
    buffer: Buffer,
    detectedMime: string,
    nd?: NormalizeDeps,
  ) => Promise<{ buffer: Buffer; mime: string; kind: "image" | "video" }>
  /** Is this file an attachment of a private (encrypted personal) mailbox? Fails closed
   *  (content-suppression.ts `isMailFilePrivate`). */
  isPrivateMailFile: (orgId: string, fileId: string) => Promise<boolean>
  now: () => number
  deadlineMs: number
}

export const defaultMediaAnalysisToolDeps: MediaAnalysisToolDeps = {
  headObject: defaultHeadObject,
  getObjectBuffer: defaultGetObjectBuffer,
  analyzeWithGemini: defaultAnalyzeWithGemini,
  analyzeWithOpenRouter: defaultAnalyzeWithOpenRouter,
  managedSideCallGate: defaultManagedSideCallGate,
  preCheck: defaultPreCheck,
  finalizeUsage: defaultFinalizeUsage,
  enqueueAppJob: defaultEnqueueAppJob,
  privileged: withPrivilegedDb,
  normalizeMedia: defaultNormalizeMedia,
  isPrivateMailFile: (orgId, fileId) =>
    withPrivilegedDb(orgId, "media-analysis:private-mail", (tx) =>
      isMailFilePrivate(tx, orgId, fileId),
    ).catch(() => true),
  now: () => Date.now(),
  deadlineMs: ANALYSIS_DEADLINE_MS,
}

interface FileRow {
  id: string
  app: string
  storageKey: string
  sizeBytes: number
  mimeType: string
  analysisStatus: string | null
  analysisSummary: string | null
  analysisAt: Date | string | null
  analysisContextHash: string | null
  encVersion: number | string | null
}

function err(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

/**
 * Did the file analysed come from outside the org? Only then does the analysis taint the turn
 * (`taintSourceWhen` of analyze_media, scopes/taint.ts). A file a member of the org uploaded does
 * not; everything else does, failing closed:
 * - no uploader (an inbound mail or ticket attachment, a webhook or link ingestion, a rendered or
 *   synced file), or an uploader who is not a user of the org;
 * - a mailbox attachment (app `mail`), whoever imported it;
 * - an integration import staged in an upload session (Google Drive), or a merged PDF (its pages
 *   may come from any of those);
 * - a copy (`copied_from_id`) of any of those, followed back to its first source; a chain that
 *   cannot be followed to its end counts as outside.
 * Read privileged: what decides the mark must not depend on what the caller can see.
 */
export async function analyzedFileIsExternal(
  params: unknown,
  ctx: { orgId: string },
): Promise<boolean> {
  const fileId = (params as { fileId?: unknown } | null)?.fileId
  if (typeof fileId !== "string" || !UUID_RE.test(fileId)) return true
  return fileIsFromOutside(ctx.orgId, fileId)
}

/**
 * The analysis of an attachment can be text a stranger wrote (an invoice's free text, the words in
 * a screenshot), so the agent gets it inside the untrusted-content fence. When the file came from
 * outside the org the tool also taints the turn, so an outward action after it parks for a person
 * (`analyzedFileIsExternal`, scopes/taint.ts).
 */
export function fenceAnalysisSummary(result: AnalyzeMediaResult): AnalyzeMediaResult {
  if (!("summary" in result)) return result
  return { ...result, summary: wrapExternalContent(result.summary) }
}

/** The handler the agent calls: the analysis, fenced as untrusted text. */
export async function analyzeMediaForAgent(
  params: AnalyzeMediaParams,
  ctx: AppContext,
  deps: MediaAnalysisToolDeps = defaultMediaAnalysisToolDeps,
): Promise<AnalyzeMediaResult & { fileId?: string }> {
  const result = fenceAnalysisSummary(await handleAnalyzeMedia(params, ctx, deps))
  // The file id rides on a summary so the redaction of stored tool results can tell a private
  // mailbox's attachment from any other file (mail-plaintext-redaction.ts).
  return "summary" in result ? { fileId: params.fileId, ...result } : result
}

/**
 * The `analyze_media` kernel tool handler — sync fast-path for images, PDF
 * documents (inline-only, ≤14 MB), and inline (≤20 MB request) videos; enqueues
 * the slow job for larger videos.
 *
 * Only an UNBRIEFED analysis is stored on the file. A `context` briefing is the
 * agent's own text and can carry what its turn read elsewhere (an order, an
 * invoice); the summary it steers can repeat it, and a stored summary is shown
 * to everyone who can open the file. So a briefed analysis goes back to the
 * agent only and the file row is left as it was: what the file row ever holds
 * is drawn from the file alone, which is why the tool is `readOnly`.
 */
export async function handleAnalyzeMedia(
  params: AnalyzeMediaParams,
  ctx: MediaAnalysisCaller,
  deps: MediaAnalysisToolDeps = defaultMediaAnalysisToolDeps,
  opts: MediaAnalysisOptions = {},
): Promise<AnalyzeMediaResult> {
  const { fileId, refresh } = params
  const context = params.context?.trim() ? params.context : undefined
  const briefed = context !== undefined

  // 0. A demo org (the reserved App Review org, a visitor) does not analyse
  //    media: it runs on the deployment's key under a small budget that one
  //    video could exceed several times over, and a step's reservation cannot
  //    price a file it has not read. Refused before any read, check or spend.
  const demoRefusal = await demoMediaAnalysisRefusal(ctx.orgId)
  if (demoRefusal) return err("demo_reserved", demoRefusal)

  // 1. Resolve under RLS — the storage key for every later step comes ONLY
  //    from this row, never a param (security invariant). A foreign/other-org
  //    fileId is invisible here → not_found (so the cache branch below can read
  //    its fields off this RLS-validated row safely).
  const file = extractRows<FileRow>(
    await ctx.db.execute(
      sql`SELECT id, app, storage_key AS "storageKey", size_bytes AS "sizeBytes",
                 mime_type AS "mimeType", analysis_status AS "analysisStatus",
                 analysis_summary AS "analysisSummary", analysis_at AS "analysisAt",
                 analysis_context_hash AS "analysisContextHash", enc_version AS "encVersion"
          FROM ${K}.files WHERE id = ${fileId} LIMIT 1`,
    ),
  )[0]
  if (!file) return err("not_found", `File ${fileId} not found.`)

  const storageKey = file.storageKey
  const supplied = opts.suppliedBuffer
  // Nothing about a supplied copy is stored: it is the plaintext of a sealed file.
  const persistAllowed = opts.noPersist !== true && supplied === undefined

  // 1b. A sealed (end-to-end encrypted) attachment is ciphertext in the bucket: the server cannot
  //     read it, and nothing derived from it may be stored. Only its owner's browser can open it,
  //     through the mail attachment reader, which supplies the readable copy.
  if (Number(file.encVersion ?? 0) > 0 && supplied === undefined) {
    return err(
      "encrypted_attachment",
      "This attachment is end-to-end encrypted, so the server cannot read it. Use kernel__mail_attachment_read with this file id: the owner's unlocked Liaison window opens it for this turn.",
    )
  }

  // 1c. Any other attachment of a private (encrypted personal) mailbox, such as one that arrived
  //     before the mailbox was sealed and is still stored in the clear: its analysis must not be
  //     cached on the row nor come back as a tool result (both are stored and shown to others).
  //     Only the mail attachment reader may analyse it, with nothing persisted. Fails closed: a
  //     mail file whose mailbox cannot be resolved counts as private.
  if (file.app === "mail" && persistAllowed && (await deps.isPrivateMailFile(ctx.orgId, file.id))) {
    return err(
      "private_mailbox",
      "This attachment belongs to an encrypted mailbox, so its content is never stored or returned here. Use kernel__mail_attachment_read with this file id: it reads it for this turn only.",
    )
  }

  // 2. Early surface short-circuit (no buffer needed). `unsupported_surface`
  //    (file.app ∉ {tickets,mail,kernel}) is decidable from the step-1 row alone — reject
  //    it BEFORE any storage I/O so a wrong-app call never reads up to 200 MB.
  //    (The per-KIND gate still needs the sniffed kind, so it stays after type
  //    detection below.)
  const surface = opts.surface ?? file.app
  // Privileged read: kernel.organizations carries a deny-all RLS policy, so a
  // ctx.db read silently returns no row and every org override resolved to the
  // surface defaults. The orgId comes from the caller's own context, so this
  // reads only the caller's org settings.
  const settings = await withPrivilegedDb(ctx.orgId, "media-analysis-settings", (db) =>
    getOrgKernelSettings(db, ctx.orgId, orgKernelSettingsSchema),
  )
  if ("unsupported" in resolveMediaAnalysisPermission(settings, surface, "image")) {
    return err("unsupported_surface", `Media analysis is not available for surface "${surface}".`)
  }

  // 3. Cache check (skipped on refresh). Decidable from the step-1 RLS row — runs
  //    BEFORE headObject/getObjectBuffer so a cache hit never downloads the file.
  const contextHash = hashContext(context)
  const nowMs = deps.now()
  // A briefed call never reads the stored summary: it asks its own question.
  if (
    !briefed &&
    !refresh &&
    persistAllowed &&
    file.analysisStatus === "done" &&
    file.analysisAt &&
    file.analysisSummary
  ) {
    const analyzedAtMs = new Date(file.analysisAt).getTime()
    const fresh = analyzedAtMs > nowMs - ANALYSIS_CACHE_TTL_MS
    if (fresh && file.analysisContextHash === contextHash) {
      return {
        summary: file.analysisSummary,
        model: MEDIA_ANALYSIS_MODEL_ID,
        analyzedAt: new Date(file.analysisAt).toISOString(),
        cached: true,
      }
    }
  }

  // 4. Pre-model I/O (size guard + download + true-type sniff). All three can
  //    throw (S3 errors; getObjectBuffer's strict streaming maxBytes throw when
  //    the real byte length exceeds the cap the advisory headObject under-reported)
  //    — wrap so a thrown error becomes a typed result, never a raw handler throw.
  let buffer: Buffer
  let kind: MediaKind
  let sniffedMime: string
  let office: OfficeFormat | null = null
  try {
    if (supplied !== undefined) {
      if (supplied.byteLength > MEDIA_MAX_BYTES) {
        return err("too_large", `File exceeds the ${MEDIA_MAX_BYTES}-byte analysis limit.`)
      }
      if (supplied.byteLength === 0) return err("empty_file", "File is empty (0 bytes).")
      buffer = supplied
    } else {
      const head = await deps.headObject(storageKey)
      if (head.contentLength > MEDIA_MAX_BYTES) {
        return err("too_large", `File exceeds the ${MEDIA_MAX_BYTES}-byte analysis limit.`)
      }
      if (head.contentLength === 0) {
        return err("empty_file", "File is empty (0 bytes).")
      }
      buffer = await deps.getObjectBuffer(storageKey, undefined, { maxBytes: MEDIA_MAX_BYTES })
    }
    const sniffed = await fileTypeFromBuffer(buffer)
    sniffedMime = sniffed?.mime ?? ""
    office = officeFormatOf(sniffedMime)
    if (office && !opts.kinds) kind = "document"
    else if (sniffedMime.startsWith("image/")) kind = "image"
    else if (sniffedMime.startsWith("video/")) kind = "video"
    else if (sniffedMime === "application/pdf") kind = "document"
    else {
      return err(
        "unsupported",
        `Unsupported file type (${sniffedMime || "unknown"}): images, videos, PDFs and Word, Excel or PowerPoint documents (.docx, .xlsx, .pptx) can be read.`,
      )
    }
    if (opts.kinds && !opts.kinds.includes(kind)) {
      return err(
        "unsupported",
        `This call analyses only ${opts.kinds.join(" and ")} files (got ${sniffedMime}).`,
      )
    }
  } catch (ioErr) {
    const message = ioErr instanceof Error ? ioErr.message : String(ioErr)
    if (/maxBytes/i.test(message)) {
      return err("too_large", `File exceeds the ${MEDIA_MAX_BYTES}-byte analysis limit.`)
    }
    log.error({ media: "analyze", fileId: file.id }, redactSecrets(message))
    return err("storage_error", "Could not read the file from storage.")
  }

  // 4b. A private copy is analysed in memory only, and a video cannot be: ffprobe and ffmpeg read
  //     a seekable temp file (media-normalize.ts), and a crash mid-probe would leave the plaintext
  //     on disk. Refused before any normalization or spend.
  if (kind === "video" && !persistAllowed) {
    return err(
      "private_video_unsupported",
      "A private video can't be analysed yet: this attachment is in an encrypted mailbox, and its video cannot be read without writing it to disk. Ask the person to describe it.",
    )
  }

  // 5. Permission gate (in-handler, keyed on file.app + the sniffed KIND). The
  //    surface was already validated above; here the per-kind toggle decides.
  const permission = resolveMediaAnalysisPermission(settings, surface, kind)
  if ("unsupported" in permission) {
    return err("unsupported_surface", `Media analysis is not available for surface "${surface}".`)
  }
  if (!permission.allowed) {
    return err(
      "analysis_disabled",
      `Media analysis is disabled for ${kind}s on the "${surface}" surface (zero spend). An admin can enable it in org settings.`,
    )
  }

  // 5b. An Office document (Word, Excel, PowerPoint) is read as text, in memory, with no model
  //     call and no spend. Nothing is stored: the text is free to read again.
  if (office) {
    try {
      const text = await officeDocumentText(buffer, office)
      if (!text.trim()) return err("empty_summary", "The document holds no text.")
      return {
        summary: text,
        model: OFFICE_TEXT_MODEL,
        analyzedAt: new Date(deps.now()).toISOString(),
        cached: false,
      }
    } catch (officeErr) {
      if (officeErr instanceof OfficeTextError) return err("unreadable_document", officeErr.message)
      const message = officeErr instanceof Error ? officeErr.message : String(officeErr)
      log.error({ media: "office-text", fileId: file.id }, redactSecrets(message))
      return err("unreadable_document", "Could not read the text of this document.")
    }
  }

  // 6. Documents (PDF) bypass normalization entirely — Gemini accepts
  //    application/pdf as inlineData directly, so there is no ffmpeg/sharp step.
  //    The size cap keeps the base64 request under Gemini's ~20 MB inline limit.
  //    Image/video still normalize to a Gemini-safe format BEFORE the
  //    inline-vs-FilesAPI size branch, so the branch decides on the NORMALIZED
  //    bytes; a normalization failure is a typed error.
  if (kind === "document") {
    if (buffer.byteLength > DOCUMENT_MAX_BYTES) {
      return err(
        "too_large",
        `PDF exceeds the ${DOCUMENT_MAX_BYTES}-byte document analysis limit (raw bytes must stay under 14 MB so the inline request fits Gemini's cap).`,
      )
    }
    const systemInstruction = buildSystemInstruction(context, "document")
    const parts: MediaPart[] = [
      { inlineData: { mimeType: "application/pdf", data: buffer.toString("base64") } },
    ]
    return runInlineModelCall(
      deps,
      ctx,
      file.id,
      contextHash,
      systemInstruction,
      parts,
      !briefed && persistAllowed,
    )
  }

  let normalized: { buffer: Buffer; mime: string; kind: "image" | "video" }
  try {
    // A private copy never touches the disk: the normalizer refuses anything it cannot do in
    // memory (a video, refused above already).
    normalized = await deps.normalizeMedia(
      buffer,
      sniffedMime,
      persistAllowed ? undefined : { inMemoryOnly: true },
    )
  } catch (normErr) {
    if (normErr instanceof NormalizeError) {
      return err(normErr.code, normErr.message)
    }
    const message = normErr instanceof Error ? normErr.message : String(normErr)
    log.error({ media: "normalize", fileId: file.id }, redactSecrets(message))
    return err("normalize_failed", "Could not normalize the media for analysis.")
  }

  const isVideo = normalized.kind === "video"
  const systemInstruction = buildSystemInstruction(context, isVideo)

  // 7. Branch — build the inline part, or enqueue the slow job for big video.
  let parts: MediaPart[]
  if (normalized.kind === "image") {
    parts = await buildImagePart(normalized.buffer)
  } else {
    // Inline only when the total request stays under the cap; the buffer is the
    // dominant term (prompt + instruction are small).
    const totalRequestBytes = normalized.buffer.byteLength + Buffer.byteLength(systemInstruction)
    // A managed cell has no slow path (A45: no Gemini Files API, no Google key
    // on a cell): it sends up to its own inline limit and refuses above it.
    if (isManagedEdition()) {
      if (totalRequestBytes > MANAGED_INLINE_MEDIA_MAX_BYTES) {
        return err("too_large", managedMediaTooLargeMessage())
      }
    } else if (totalRequestBytes > INLINE_VIDEO_MAX_REQUEST_BYTES) {
      // The slow job reads the stored object and stores its result on the file row: neither is
      // allowed for a private copy (whose video is refused before normalization anyway).
      if (!persistAllowed) {
        return err("private_video_unsupported", "A private video can't be analysed yet.")
      }
      // The slow path is still credit-gated: preCheck BEFORE the enqueue so a
      // no-key/no-credit org gets the typed reason, not a misleading 'processing'.
      const slowPre = await deps.preCheck(ctx.orgId, MEDIA_ANALYSIS_MODEL_ID)
      if (!slowPre.allowed) {
        return err("precheck_failed", slowPre.reason)
      }
      // orgId is the RLS-trusted ctx.orgId; the worker is registered at boot so
      // the enqueue cannot throw "No handler registered". The slow job's only
      // output is the file row, so it never carries the briefing: it stores an
      // unbriefed analysis, like any other summary the row holds.
      await deps.enqueueAppJob(
        "kernel",
        "files-media-analysis",
        {
          fileId,
          orgId: ctx.orgId,
          storageKey,
          modelId: MEDIA_ANALYSIS_MODEL_ID,
          userId: ctx.userId,
        },
        { jobId: `files-media-analysis:${fileId}` },
      )
      await deps.privileged(ctx.orgId, "files:analysis", async (tx) => {
        await tx.execute(
          sql`UPDATE ${K}.files SET analysis_status = 'pending'
              WHERE id = ${file.id} AND org_id = ${ctx.orgId}`,
        )
      })
      return { status: "processing" }
    }
    parts = [
      {
        inlineData: { mimeType: normalized.mime, data: normalized.buffer.toString("base64") },
        videoMetadata: { fps: VIDEO_FPS, endOffset: `${VIDEO_END_OFFSET_SECONDS}s` },
      },
    ]
  }

  // 8-10. Credit-gate, call the model, persist. Shared with the document path.
  return runInlineModelCall(
    deps,
    ctx,
    file.id,
    contextHash,
    systemInstruction,
    parts,
    !briefed && persistAllowed,
  )
}

/**
 * Steps 8-10 of the sync path, shared by the image/video and document branches:
 * credit pre-check (no error persisted on a billing/config refusal), the
 * deadline-bounded `generateContent` call, and success/empty/error persistence.
 * `persist` false (a briefed call) leaves the file row untouched, success or not.
 */
async function runInlineModelCall(
  deps: MediaAnalysisToolDeps,
  ctx: MediaAnalysisCaller,
  fileId: string,
  contextHash: string,
  systemInstruction: string,
  parts: MediaPart[],
  persist: boolean,
): Promise<AnalyzeMediaResult> {
  // 8. Credit + model (sync path only). On a billing/config refusal we do NOT
  //    persist analysis_status='error' (spec: "no model call" — a config refusal
  //    is not an analysis-attempt failure; mirrors thumbnail/proofread).
  const call = await planModelCall(deps, ctx, parts, systemInstruction)
  if ("refused" in call) {
    return err("precheck_failed", call.refused)
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort("timeout"), deps.deadlineMs)
  try {
    const { summary, usage, costUsd } = await call.run(ac.signal)
    clearTimeout(timer)

    await deps.finalizeUsage(ctx.orgId, {
      model: call.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(costUsd !== undefined ? { providerCostUsd: costUsd } : {}),
      keySource: call.keySource,
      userId: ctx.userId,
    })

    // An empty summary must NOT persist a blank 'done': the cache guard requires a
    // truthy summary, so a blank 'done' is never served and every repeat re-bills.
    // Treat it as a typed soft error + status='error' so the persisted state is
    // consistent with the cache guard.
    if (summary.length === 0) {
      if (persist) await persistError(deps, ctx.orgId, fileId, "The model returned no description.")
      return err("empty_summary", "The model returned no description.")
    }

    // 9. Persist (privileged) — key on the RLS-validated id AND org.
    const analyzedAt = new Date()
    if (!persist) {
      return {
        summary,
        model: MEDIA_ANALYSIS_MODEL_ID,
        analyzedAt: analyzedAt.toISOString(),
        cached: false,
      }
    }
    await deps.privileged(ctx.orgId, "files:analysis", async (tx) => {
      await tx.execute(
        sql`UPDATE ${K}.files
            SET analysis_status = 'done', analysis_summary = ${summary},
                analysis_model = ${MEDIA_ANALYSIS_MODEL_ID}, analysis_at = ${analyzedAt.toISOString()},
                analysis_context_hash = ${contextHash}, analysis_error = NULL
            WHERE id = ${fileId} AND org_id = ${ctx.orgId}`,
      )
    })
    return {
      summary,
      model: MEDIA_ANALYSIS_MODEL_ID,
      analyzedAt: analyzedAt.toISOString(),
      cached: false,
    }
  } catch (rawErr) {
    clearTimeout(timer)
    // 10. Error persistence — sanitized detail, status='error' so a detached
    //     late completion can't overwrite with 'done'.
    const aborted = ac.signal.aborted
    const typed = (rawErr as { error?: { code?: string; message?: string } })?.error
    const code = aborted ? "timeout" : (typed?.code ?? "model_error")
    const message = redactSecrets(
      aborted
        ? "Media analysis timed out."
        : (typed?.message ?? (rawErr instanceof Error ? rawErr.message : String(rawErr))),
    )
    if (persist) await persistError(deps, ctx.orgId, fileId, message)
    log.error({ media: "analyze", code, fileId }, message)
    return err(code, message)
  }
}

type MeteredModel = Parameters<typeof defaultFinalizeUsage>[1]["model"]

/** The model call a sync analysis makes, its key and how it is metered; or a refusal. */
type ModelCallPlan =
  | {
      model: MeteredModel
      keySource: "liaison" | "byok"
      run: (
        signal: AbortSignal,
      ) => Promise<{ summary: string; usage: MappedTokens; costUsd?: number | undefined }>
    }
  | { refused: string }

/**
 * Self-hosted: the Gemini call on the org's (or the deployment's) Google key,
 * priced from its tokens, as before (S19). Managed (S31): the same prompt on
 * OpenRouter with the cell's key and zero data retention, gated by the side-call
 * gate and metered at OpenRouter's reported cost.
 */
async function planModelCall(
  deps: MediaAnalysisToolDeps,
  ctx: MediaAnalysisCaller,
  parts: MediaPart[],
  systemInstruction: string,
): Promise<ModelCallPlan> {
  if (isManagedEdition()) {
    const gate = await deps.managedSideCallGate(ctx.orgId, MANAGED_MEDIA_ANALYSIS_UPSTREAM_ID)
    if (!gate.allowed) return { refused: gate.reason }
    return {
      model: gate.model,
      keySource: gate.keySource,
      run: (signal) =>
        deps.analyzeWithOpenRouter({
          providerKey: gate.key,
          parts,
          systemInstruction,
          signal,
          orgId: ctx.orgId,
        }),
    }
  }
  const pre = await deps.preCheck(ctx.orgId, MEDIA_ANALYSIS_MODEL_ID)
  if (!pre.allowed) return { refused: pre.reason }
  return {
    model: pre.model,
    keySource: pre.keySource,
    run: (signal) =>
      deps.analyzeWithGemini({
        providerKey: pre.providerKey,
        model: pre.model,
        parts,
        systemInstruction,
        signal,
      }),
  }
}

async function persistError(
  deps: MediaAnalysisToolDeps,
  orgId: string,
  fileId: string,
  detail: string,
): Promise<void> {
  await deps.privileged(orgId, "files:analysis", async (tx) => {
    await tx.execute(
      sql`UPDATE ${K}.files SET analysis_status = 'error', analysis_error = ${redactSecrets(detail)}
          WHERE id = ${fileId} AND org_id = ${orgId}`,
    )
  })
}

/**
 * Build an inline image part from ALREADY-NORMALIZED JPEG/PNG/WebP bytes (the
 * normalizer handled HEIC/exotic→JPEG). Here we only downscale to the long-edge
 * cap and re-encode to JPEG for a compact, predictable inline payload.
 */
async function buildImagePart(buffer: Buffer): Promise<MediaPart[]> {
  const resized = await sharp(buffer, { failOn: "none" })
    .resize(IMAGE_MAX_LONG_EDGE_PX, IMAGE_MAX_LONG_EDGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer()
  return [{ inlineData: { mimeType: "image/jpeg", data: resized.toString("base64") } }]
}
