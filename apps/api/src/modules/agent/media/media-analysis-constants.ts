// SPDX-License-Identifier: FSL-1.1-ALv2
import type { OrgKernelSettings } from "@liaison/shared"

/**
 * Single source of truth for every fixed media-analysis constant and the pure
 * per-(surface, kind) permission resolver. The tool, the slow-path job, and the
 * link-ingest downloader all import these so the values never drift.
 */

/** The Gemini model used for all media analysis (seeded in model-pricing-seed). */
export const MEDIA_ANALYSIS_MODEL_ID = "gemini-flash-lite-latest"

/**
 * The OpenRouter model a managed cell analyses media on (S31): the current
 * flash-lite with a zero-data-retention endpoint, the family the Gemini alias
 * above resolves to. Verified against the provider: images, PDFs (`file` part), video
 * and audio inline, all under `zdr: true`.
 */
export const MANAGED_MEDIA_ANALYSIS_UPSTREAM_ID = "google/gemini-3.5-flash-lite"

/**
 * The largest media a managed cell analyses, inline. A managed cell has
 * no Gemini Files-API slow path, so anything larger is refused with this
 * limit. The 2026-11-03 probe sent a 64.5 MB video inline (about 86 MB of
 * base64) without error; the limit keeps headroom under that.
 */
export const MANAGED_INLINE_MEDIA_MAX_BYTES = 60 * 1024 * 1024

/** The refusal a managed cell gives for media above its inline limit. */
export function managedMediaTooLargeMessage(): string {
  return `This file is too large to analyse here (max ${MANAGED_INLINE_MEDIA_MAX_BYTES / (1024 * 1024)} MB).`
}

/** Cached analysis is reusable for 7 days when the context hash matches. */
export const ANALYSIS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Absolute upper bound on a media file we will fetch/analyze (200 MB). */
export const MEDIA_MAX_BYTES = 200 * 1024 * 1024

/** Inline-video total-request cap; above this we take the Files-API slow path (20 MB). */
export const INLINE_VIDEO_MAX_REQUEST_BYTES = 20 * 1024 * 1024

/**
 * Raw-PDF cap for the inline-only document path. Documents are sent as base64
 * inlineData (no Files-API slow path), so base64 expansion (~4/3) plus the
 * prompt must stay under Gemini's ~20 MB inline request limit. 14 MB of raw
 * bytes → ~18.7 MB base64, leaving headroom for the system instruction.
 */
export const DOCUMENT_MAX_BYTES = 14 * 1024 * 1024

/** Transfer-link download timeout. */
export const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * Hard deadline for the synchronous in-handler model call (its own
 * AbortController). Sized for the worst-case sync-path input: a near-cap inline
 * VIDEO (just under `INLINE_VIDEO_MAX_REQUEST_BYTES`, ~2+ minutes at
 * `VIDEO_FPS`) — Gemini's video pass legitimately takes tens of seconds on such
 * a clip and its latency varies run to run, so a 45s ceiling intermittently
 * aborts an otherwise-successful analysis. 90s keeps the synchronous path
 * viable for a real troubleshooting video while still bounding the agent's wait;
 * genuinely huge videos already take the async slow-path job, not this deadline.
 */
export const ANALYSIS_DEADLINE_MS = 90_000

/**
 * Transient-error retry for the `generateContent` call. Gemini's media endpoint
 * intermittently returns a retryable upstream error (HTTP 429 rate-limit, 500
 * INTERNAL, 503 UNAVAILABLE) — most visible on inline video. A single attempt
 * would surface that hiccup to the ticket-solving agent as a hard `model_error`
 * and abandon the customer's media; a bounded retry with exponential backoff
 * recovers the common transient case. Non-transient errors (4xx other than 429,
 * key/quota/config) and aborts are NOT retried. `MODEL_CALL_MAX_ATTEMPTS`
 * counts the FIRST try, so 3 = one initial call + up to two retries; the worst-
 * case total backoff (0.5s + 1s) stays well inside `ANALYSIS_DEADLINE_MS`.
 */
export const MODEL_CALL_MAX_ATTEMPTS = 3
export const MODEL_CALL_BACKOFF_BASE_MS = 500

/** Files-API poll cadence + cap for the slow-path video job. */
export const FILES_API_POLL_INTERVAL_MS = 2_000
export const FILES_API_POLL_MAX_ATTEMPTS = 60

/** Video analysis levers. */
export const VIDEO_END_OFFSET_SECONDS = 1200
export const VIDEO_FPS = 0.5
export const MAX_OUTPUT_TOKENS = 600

/** Downscale images so the long edge is at most this many pixels before upload. */
export const IMAGE_MAX_LONG_EDGE_PX = 1568

/**
 * ffmpeg/ffprobe normalization levers. ffmpeg is a FORMAT NORMALIZER only —
 * it converts unknown codecs/containers into a Gemini-safe H.264/AAC MP4 (or
 * leaves already-safe media untouched); analysis stays Gemini-native (no
 * keyframe-extraction / ASR). A hard per-spawn kill-timeout and bounded
 * concurrency keep a pathological file from hanging a worker.
 */
export const FFMPEG_KILL_TIMEOUT_MS = 120_000
export const FFPROBE_KILL_TIMEOUT_MS = 15_000
/** Max concurrent ffmpeg/ffprobe spawns across the process (RAM/CPU guard). */
export const NORMALIZE_MAX_CONCURRENCY = 2
/** Transcode target: downscale to at most this many pixels on the long edge. */
export const VIDEO_MAX_LONG_EDGE_PX = 1280

/**
 * Transfer-host whitelist for the always-on inbound link auto-downloader.
 * Read from a comma-separated env override if present, else the default —
 * a one-line list so hosts are easy to add.
 *
 * TRUST ASSUMPTION: the matcher (`hostInWhitelist`) trusts ANY subdomain of a
 * whitelisted apex on the initial URL AND every redirect hop. DNS-pinning (in
 * `outbound-fetch.ts`) still blocks private/loopback/metadata targets, so this
 * is bounded to an open-redirect-to-arbitrary-PUBLIC-host surface gated by the
 * magic-byte image/video check — NOT an SSRF-to-metadata pivot. Before adding a
 * host that offers user-controlled subdomains (or a URL-shortener apex like
 * `we.tl`, whose redirect targets land on CDN hosts NOT under `.we.tl` and so
 * mostly fail the post-redirect whitelist check anyway), weigh this trust.
 */
export const TRANSFER_HOST_WHITELIST: string[] = (() => {
  const override = process.env.MEDIA_TRANSFER_HOST_WHITELIST
  if (override && override.trim().length > 0) {
    return override
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  }
  return ["wetransfer.com", "we.tl", "swisstransfer.com"]
})()

// NOTE: `mediaResolution` is intentionally NOT sent. It is a real, cost-affecting
// field on the current model family (the `gemini-flash-lite-latest` alias resolves
// to Gemini 3.x), NOT inert — it is omitted as a deliberate product choice: the
// model's default media resolution is acceptable for diagnostic summaries, and the
// default keeps token cost predictable.

// `kernel` covers files parented to kernel entities (thread / agent-chat
// message attachments and their upload-session staging parent) — a user
// pasting a screenshot into the agent chat expects the agent to see it.
// `apps` covers an app's OWN files analysed by that app through the declared
// `files.analyzeDocument` host call (a shipping label read for its tracking
// number). It is never the surface of an agent's `analyze_media` call, whose
// surface is the file's own app.
const SUPPORTED_SURFACES = ["tickets", "mail", "kernel", "apps"] as const
export type SupportedSurface = (typeof SUPPORTED_SURFACES)[number]

function isSupportedSurface(surface: string): surface is SupportedSurface {
  return (SUPPORTED_SURFACES as readonly string[]).includes(surface)
}

/** The kinds `analyze_media` understands: rendered media plus PDF documents. */
export type MediaKind = "image" | "video" | "document"

export type MediaAnalysisPermission = { allowed: boolean } | { unsupported: true }

/**
 * Pure resolver — the single source of truth for the in-handler gate and the
 * settings-route default projection. Takes a parsed settings object (no DB).
 *
 * - An unknown surface (anything other than `tickets`/`mail`/`kernel`/`apps`) →
 *   `{ unsupported: true }` (distinct from `{ allowed: false }` so the handler
 *   can surface the typed `unsupported_surface` error rather than a plain refusal).
 * - Otherwise the per-(surface, kind) toggle. Defaults: `tickets` and `kernel`
 *   on for every kind; `mail` off for image/video (spend guard on a high-volume
 *   surface) but ON for document — business PDFs (purchase orders, invoices)
 *   arriving as mail attachments are the primary document use case, and a
 *   single-document analysis is cheap. `apps` on for image/document, off for video.
 */
export function resolveMediaAnalysisPermission(
  settings: OrgKernelSettings,
  surface: string,
  kind: MediaKind,
): MediaAnalysisPermission {
  if (!isSupportedSurface(surface)) return { unsupported: true }
  // `apps`: an app reads its own label or scan; a video is never what it needs, so it is off.
  const surfaceDefault =
    surface === "apps" ? kind !== "video" : surface !== "mail" || kind === "document"
  const configured = settings.mediaAnalysis?.[surface]?.[kind]
  return { allowed: configured ?? surfaceDefault }
}

/**
 * Resolve the toggle for a KNOWN surface, returning a plain boolean (no
 * `unsupported` branch). Used by the settings route's default projection, which
 * only ever passes the two known surfaces — this removes the route's unsafe
 * `as { allowed: boolean }` cast (and TypeErrors loudly if a future caller
 * passes an unknown surface here rather than silently coercing to `undefined`).
 */
export function resolveKnownSurfacePermission(
  settings: OrgKernelSettings,
  surface: SupportedSurface,
  kind: MediaKind,
): boolean {
  const result = resolveMediaAnalysisPermission(settings, surface, kind)
  if ("unsupported" in result) {
    throw new Error(`resolveKnownSurfacePermission called with unsupported surface "${surface}"`)
  }
  return result.allowed
}
