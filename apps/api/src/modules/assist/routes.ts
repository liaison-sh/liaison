// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  cleanDictationRequestSchema,
  type DictationErrorCode,
  proofreadFormatSchema,
  TRANSCRIBE_MAX_BYTES,
  transcribeAudioTypeOf,
  transcribeQuerySchema,
} from "@liaison/shared"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { userPreferences } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { getRequestSignal } from "~/middleware/request-timeout"
import { recipientLocale } from "~/modules/push/fanout-consumer"
import { cleanDictation, ProofreadError, proofread } from "./proofread-service"
import {
  dictationAvailable,
  TRANSCRIBE_REQUEST_TIMEOUT_MS,
  TranscribeError,
  transcribe,
} from "./transcribe-service"

const log = rootLogger.child({ module: "assist" })

const proofreadSchema = z.object({
  text: z.string().max(20_000),
  format: proofreadFormatSchema,
})

/**
 * Transcriptions per user per window (S3): a long recording is several
 * segments. The clean-up endpoint has its own bucket of the same size.
 */
const TRANSCRIBE_RATE_LIMIT = 30
const TRANSCRIBE_RATE_WINDOW_SECONDS = 600

/** The user's "Clean up dictation automatically" setting (default on). */
async function autoCleanOf(orgId: string, userId: string): Promise<boolean> {
  const [row] = await withPrivilegedDb(orgId, "dictation-auto-clean", (tx) =>
    tx
      .select({ v: userPreferences.dictationAutoClean })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1),
  )
  return row?.v ?? true
}

/** A dictation refusal in the person's language, `{ error: { code, message } }`. */
async function refuse(c: Context<AppEnv>, err: TranscribeError): Promise<Response> {
  const locale = await recipientLocale(c.get("orgId"), c.get("userId")).catch(() => "en" as const)
  const code: DictationErrorCode = err.code
  return c.json({ error: { code, message: err.localized(locale) } }, err.status)
}

export const assistRoutes = new Hono<AppEnv>()

assistRoutes.post("/proofread", zValidator("json", proofreadSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { text, format } = c.req.valid("json")
  try {
    const result = await proofread({ orgId, userId, text, format })
    return success(c, { text: result.text })
  } catch (err) {
    if (err instanceof ProofreadError) {
      // err.status is already `400 | 402 | 500` — no loose cast needed.
      return c.json(
        { error: { message: err.message, ...(err.code ? { code: err.code } : {}) } },
        err.status,
      )
    }
    log.error({ err, orgId }, "proofread failed")
    throw err
  }
})

// Voice dictation (S2, S3). The body is the recording's raw bytes with its own
// Content-Type; the client cuts a long recording into self-contained segments
// and posts each one. The audio is never stored or logged.
assistRoutes.post("/transcribe", zValidator("query", transcribeQuerySchema), async (c) => {
  // The request budget (app.ts) started a moment ago; the clean-up is fitted inside it.
  const deadline = Date.now() + TRANSCRIBE_REQUEST_TIMEOUT_MS
  const orgId = c.get("orgId")
  const userId = c.get("userId")

  const limited = await checkRateLimit(redis, [
    {
      identifier: `assist-transcribe:${userId}`,
      limit: TRANSCRIBE_RATE_LIMIT,
      windowSeconds: TRANSCRIBE_RATE_WINDOW_SECONDS,
    },
  ])
  if (!limited.allowed) {
    c.header("Retry-After", String(limited.failed.retryAfterSeconds))
    return refuse(c, new TranscribeError("rate_limited"))
  }

  const contentType = transcribeAudioTypeOf(c.req.header("content-type"))
  if (!contentType) return refuse(c, new TranscribeError("unsupported_format"))

  const audio = new Uint8Array(await c.req.arrayBuffer())
  if (audio.byteLength > TRANSCRIBE_MAX_BYTES) {
    return refuse(c, new TranscribeError("too_large", {}, "kernel.dictationErrors.tooLarge"))
  }
  if (audio.byteLength === 0) return refuse(c, new TranscribeError("empty_audio"))

  const { clean, language } = c.req.valid("query")
  try {
    const result = await transcribe({
      orgId,
      userId,
      audio,
      contentType,
      ...(language ? { language } : {}),
      clean: clean === undefined ? await autoCleanOf(orgId, userId) : clean === "true",
      signal: getRequestSignal(c),
      deadline,
    })
    return success(c, result)
  } catch (err) {
    if (err instanceof TranscribeError) return refuse(c, err)
    log.error({ err: err instanceof Error ? err.message : String(err), orgId }, "transcribe failed")
    throw err
  }
})

// The clean-up of a multi-segment recording, once its segments' raw texts are
// joined (the wand's dictation mode). Never fails the transcript: a clean-up
// error answers 200 with the text untouched and `cleanError`.
assistRoutes.post(
  "/clean-dictation",
  zValidator("json", cleanDictationRequestSchema),
  async (c) => {
    // A paid model call like a transcription: its own bucket, the same window.
    const limited = await checkRateLimit(redis, [
      {
        identifier: `assist-clean:${c.get("userId")}`,
        limit: TRANSCRIBE_RATE_LIMIT,
        windowSeconds: TRANSCRIBE_RATE_WINDOW_SECONDS,
      },
    ])
    if (!limited.allowed) {
      c.header("Retry-After", String(limited.failed.retryAfterSeconds))
      return refuse(c, new TranscribeError("rate_limited"))
    }
    const { text, language } = c.req.valid("json")
    // Bounded at DICTATION_CLEAN_TIMEOUT_MS (inside the generic request budget),
    // and dropped when the caller goes away.
    const result = await cleanDictation({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      text,
      ...(language ? { language } : {}),
      signal: getRequestSignal(c),
    })
    return success(c, result)
  },
)

// Whether to render the mic control, and the user's clean-up default.
assistRoutes.get("/capabilities", async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const [dictation, autoClean] = await Promise.all([
    dictationAvailable(orgId),
    autoCleanOf(orgId, userId),
  ])
  return success(c, { dictation, autoClean })
})
