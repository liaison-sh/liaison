// SPDX-License-Identifier: FSL-1.1-ALv2
import { createPartFromUri, GoogleGenAI, ThinkingLevel } from "@google/genai"
import { eq, sql } from "drizzle-orm"
import { fileTypeFromBuffer } from "file-type"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { getObjectBuffer as defaultGetObjectBuffer } from "~/infra/storage/object-storage"
import { isManagedEdition } from "~/lib/edition"
import { filesLogger as log } from "~/lib/logger"
import {
  finalizeUsage as defaultFinalizeUsage,
  preCheck as defaultPreCheck,
} from "~/modules/agent/credits/credit-meter"
import {
  type GeminiUsageMetadata,
  mapUsageToTokens,
  redactSecrets,
} from "~/modules/agent/media/media-analysis-client"
import {
  FILES_API_POLL_INTERVAL_MS,
  FILES_API_POLL_MAX_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  MEDIA_ANALYSIS_MODEL_ID,
  MEDIA_MAX_BYTES,
  managedMediaTooLargeMessage,
  VIDEO_END_OFFSET_SECONDS,
  VIDEO_FPS,
} from "~/modules/agent/media/media-analysis-constants"
import { buildSystemInstruction, hashContext } from "~/modules/agent/media/media-analysis-shared"
import {
  normalizeMedia as defaultNormalizeMedia,
  type NormalizeDeps,
  NormalizeError,
} from "~/modules/agent/media/media-normalize"
import { demoMediaAnalysisRefusal } from "~/modules/demo/demo-spend"
import {
  isEncryptedAttachment,
  logDerivativeSkip,
} from "~/modules/mailbox-crypto/attachment-derivatives"

const K = sql.raw(schemaRef("kernel"))

export interface MediaAnalysisJobPayload {
  fileId: string
  orgId: string
  storageKey: string
  modelId: string
  context?: string
  userId?: string
  _tx?: PrivilegedDb
}

/** Minimal SDK surface the job needs — injectable for tests (no live calls). */
export interface GenaiFilesClient {
  files: {
    upload: (args: {
      file: Blob | string
      config?: { mimeType?: string }
    }) => Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }>
    get: (args: {
      name: string
    }) => Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }>
  }
  models: {
    generateContent: (
      args: unknown,
    ) => Promise<{ text?: string; usageMetadata?: GeminiUsageMetadata }>
  }
}

export interface MediaAnalysisJobDeps {
  getObjectBuffer?: typeof defaultGetObjectBuffer
  genaiClientFactory?: (apiKey: string) => GenaiFilesClient
  preCheck?: typeof defaultPreCheck
  finalizeUsage?: typeof defaultFinalizeUsage
  resolveAnyOrgUser?: (orgId: string) => Promise<string | null>
  normalizeMedia?: (
    buffer: Buffer,
    detectedMime: string,
    nd?: NormalizeDeps,
  ) => Promise<{ buffer: Buffer; mime: string; kind: "image" | "video" }>
  privileged?: <T>(
    orgId: string,
    reason: string,
    fn: (tx: PrivilegedDb) => Promise<T>,
  ) => Promise<T>
  pollIntervalMs?: number
  pollMaxAttempts?: number
}

// The real GoogleGenAI implements a strict superset of GenaiFilesClient (richer
// param + response types); a single `as unknown as` adapter bridges the two.
const defaultGenaiClientFactory = (apiKey: string): GenaiFilesClient =>
  new GoogleGenAI({ apiKey }) as unknown as GenaiFilesClient

/** REAL org user for billing attribution — NOT the zero-UUID system sentinel. */
async function defaultResolveAnyOrgUser(orgId: string): Promise<string | null> {
  const { users: kernelUsers } = await import("~/db/schema/kernel")
  const [u] = await withPrivilegedDb(orgId, "media-analysis-resolve-user", (tx) =>
    tx
      .select({ id: kernelUsers.id })
      .from(kernelUsers)
      .where(eq(kernelUsers.orgId, orgId))
      .limit(1),
  )
  return u?.id ?? null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Slow-path media-analysis job for >20 MB video: upload via the Gemini Files
 * API, poll until ACTIVE, generateContent, finalizeUsage, persist. Unbounded
 * by a turn budget. Mocked SDK in tests — never a live call.
 */
export async function processMediaAnalysisJob(
  payload: MediaAnalysisJobPayload,
  deps: MediaAnalysisJobDeps = {},
): Promise<void> {
  const { fileId, orgId, storageKey, context } = payload
  const getBuffer = deps.getObjectBuffer ?? defaultGetObjectBuffer
  const preCheck = deps.preCheck ?? defaultPreCheck
  const finalizeUsage = deps.finalizeUsage ?? defaultFinalizeUsage
  const resolveUser = deps.resolveAnyOrgUser ?? defaultResolveAnyOrgUser
  const privileged =
    deps.privileged ??
    ((oid: string, reason: string, fn: (tx: PrivilegedDb) => Promise<unknown>) =>
      withPrivilegedDb(oid, reason, fn))
  const pollInterval = deps.pollIntervalMs ?? FILES_API_POLL_INTERVAL_MS
  const pollMax = deps.pollMaxAttempts ?? FILES_API_POLL_MAX_ATTEMPTS

  const persistError = async (detail: string) => {
    await privileged(orgId, "files:analysis", async (tx) => {
      await tx.execute(
        sql`UPDATE ${K}.files SET analysis_status = 'error', analysis_error = ${redactSecrets(detail)}
            WHERE id = ${fileId} AND org_id = ${orgId}`,
      )
    })
  }

  // An LLM-written description of an attachment IS content (spec section 7 step
  // 7c), and a sealed attachment has no plaintext the server can read anyway.
  // Skip explicitly, before any billing pre-check, and never as a throw: a
  // failing job would retry forever and would also persist an analysis_error on
  // a row whose whole point is to carry nothing derived from the content.
  if (await isEncryptedAttachment(orgId, fileId)) {
    logDerivativeSkip("media-analysis", fileId, orgId)
    return
  }

  // A managed cell never takes the Gemini Files-API slow path (A45: no Google
  // key on a cell, nothing outside OpenRouter's zero-retention routing). A job
  // queued before the switch, or by any other path, stops with the limit.
  if (isManagedEdition()) {
    await persistError(managedMediaTooLargeMessage())
    return
  }

  try {
    // A demo org never analyses media (see `demoMediaAnalysisRefusal`); a job
    // enqueued before that rule, or by any other path, stops here without a
    // model call.
    const demoRefusal = await demoMediaAnalysisRefusal(orgId)
    if (demoRefusal) {
      await persistError(demoRefusal)
      return
    }
    const pre = await preCheck(orgId, MEDIA_ANALYSIS_MODEL_ID)
    if (!pre.allowed) {
      await persistError(pre.reason)
      return
    }

    const usageUserId = payload.userId ?? (await resolveUser(orgId))
    if (!usageUserId) {
      await persistError("No org user available for billing attribution.")
      return
    }

    const rawBytes = await getBuffer(storageKey, undefined, { maxBytes: MEDIA_MAX_BYTES })
    // True-type sniff so normalization + the upload mimeType are honest.
    const sniffed = await fileTypeFromBuffer(rawBytes)
    const sniffedMime = sniffed?.mime ?? "video/mp4"

    // Normalize to a Gemini-safe format BEFORE the Files-API upload (h264-in-mp4
    // passes through; an exotic codec/container is transcoded to H.264/AAC MP4).
    // A normalization failure is terminal for this job (typed error persisted).
    const normalize = deps.normalizeMedia ?? defaultNormalizeMedia
    let normalized: { buffer: Buffer; mime: string }
    try {
      normalized = await normalize(rawBytes, sniffedMime)
    } catch (normErr) {
      if (normErr instanceof NormalizeError) {
        await persistError(`${normErr.code}: ${normErr.message}`)
        return
      }
      throw normErr
    }
    const bytes = normalized.buffer
    const uploadMime = normalized.mime

    const client = (deps.genaiClientFactory ?? defaultGenaiClientFactory)(pre.providerKey)

    // Files API upload — `file` is `string | Blob`, NOT a raw Buffer (a Buffer
    // throws a TypeError). Wrap in a Blob and pass config.mimeType explicitly.
    const uploaded = await client.files.upload({
      // Wrap in a Blob — the Files API `file` is `string | Blob`; a raw Buffer
      // throws a TypeError. Bun's Blob accepts a Uint8Array part.
      file: new Blob([new Uint8Array(bytes)], { type: uploadMime }),
      config: { mimeType: uploadMime },
    })
    const uploadedName = uploaded.name
    if (!uploadedName) {
      await persistError("Files API upload returned no file name.")
      return
    }

    // Poll until ACTIVE. FAILED is an immediate terminal error (don't burn
    // attempts); never-ACTIVE by the cap → timeout.
    let active: { uri?: string; mimeType?: string; state?: string } | undefined
    for (let attempt = 0; attempt < pollMax; attempt++) {
      const f = await client.files.get({ name: uploadedName })
      if (f.state === "FAILED") {
        await persistError("video_processing_failed: the Files API reported FAILED.")
        return
      }
      if (f.state === "ACTIVE") {
        active = f
        break
      }
      await sleep(pollInterval)
    }
    if (!active) {
      await persistError("video_processing_timeout: file never became ACTIVE.")
      return
    }
    if (!active.uri) {
      await persistError("video_processing_failed: ACTIVE file has no uri.")
      return
    }

    const systemInstruction = buildSystemInstruction(context, true)
    const videoPart = createPartFromUri(active.uri, active.mimeType ?? uploadMime) as Record<
      string,
      unknown
    >
    // Attach the video levers inside videoMetadata (fps at the part top level is
    // dropped → default 1.0 fps ≈ 2× cost).
    videoPart.videoMetadata = { fps: VIDEO_FPS, endOffset: `${VIDEO_END_OFFSET_SECONDS}s` }

    const response = await client.models.generateContent({
      model: MEDIA_ANALYSIS_MODEL_ID,
      contents: [videoPart],
      config: {
        systemInstruction,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // `thinkingLevel` is the Gemini-3.x lever for the `*-latest` alias (see
        // media-analysis-client.ts). MINIMAL is the closest-to-zero setting.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    })
    const summary = (response.text ?? "").trim()
    const usage = mapUsageToTokens(response.usageMetadata)

    await finalizeUsage(orgId, {
      model: pre.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      keySource: pre.keySource,
      userId: usageUserId,
    })

    // An empty summary must NOT persist a blank 'done' (the sync cache guard
    // requires a truthy summary, so a blank 'done' would re-bill on the next
    // analyze_media call). Persist status='error' instead.
    if (summary.length === 0) {
      await persistError("empty_summary: the model returned no description.")
      return
    }

    await privileged(orgId, "files:analysis", async (tx) => {
      await tx.execute(
        sql`UPDATE ${K}.files
            SET analysis_status = 'done', analysis_summary = ${summary},
                analysis_model = ${MEDIA_ANALYSIS_MODEL_ID}, analysis_at = ${new Date().toISOString()},
                analysis_context_hash = ${hashContext(context)}, analysis_error = NULL
            WHERE id = ${fileId} AND org_id = ${orgId}`,
      )
    })
  } catch (rawErr) {
    const detail = redactSecrets(rawErr instanceof Error ? rawErr.message : String(rawErr))
    log.error({ media: "analyze-job", fileId, orgId }, detail)
    await persistError(detail)
  }
}

export function registerMediaAnalysisJobWorker(): void {
  registerJobWorker("kernel", "files-media-analysis", async (payload) => {
    await processMediaAnalysisJob(payload as MediaAnalysisJobPayload)
  })
}
