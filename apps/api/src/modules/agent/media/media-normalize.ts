// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ffmpegPath from "ffmpeg-static"
import { path as ffprobePath } from "ffprobe-static"
import sharp from "sharp"
import { filesLogger as log } from "~/lib/logger"
import {
  FFMPEG_KILL_TIMEOUT_MS,
  FFPROBE_KILL_TIMEOUT_MS,
  NORMALIZE_MAX_CONCURRENCY,
  VIDEO_MAX_LONG_EDGE_PX,
} from "~/modules/agent/media/media-analysis-constants"

/**
 * Media normalization front-door. Converts ANY supported input into a
 * Gemini-safe format BEFORE the analysis call, so the pipeline robustly
 * understands media in any codec/container:
 *
 * - image heic/heif → heic-convert → JPEG
 * - image/* not in {jpeg,png,webp} → sharp → JPEG
 * - image/jpeg|png|webp → pass through (already Gemini-safe)
 * - video h264-in-mp4/mov → pass through
 * - other video → ffmpeg transcode → H.264/AAC MP4 downscaled ≤720p
 *
 * ffmpeg is a FORMAT NORMALIZER ONLY — analysis stays Gemini-native (no
 * keyframe-extraction, no ASR). ffmpeg/ffprobe are spawned via `Bun.spawn`
 * (never fluent-ffmpeg / ffmpeg.wasm), each with a hard kill-timeout and a
 * process-wide concurrency cap so a pathological file can't hang a worker.
 *
 * Tests inject `deps.spawn` (and `deps.heicConvert`) for deterministic runs —
 * real ffmpeg is exercised only at the e2e stage.
 */

export interface NormalizedMedia {
  buffer: Buffer
  mime: string
  kind: "image" | "video"
}

/** Typed normalization failure surfaced to the caller (tool/job). */
export class NormalizeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "NormalizeError"
    this.code = code
  }
}

/** Result of a spawned process run — bytes on stdout, text on stderr, exit code. */
export interface SpawnRunResult {
  exitCode: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
}

/**
 * Run a child process feeding `input` to stdin and collecting stdout/stderr,
 * with a hard kill-timeout. The default uses `Bun.spawn`; tests inject a fake.
 */
export type SpawnRunner = (
  cmd: string[],
  input: Buffer | undefined,
  killTimeoutMs: number,
) => Promise<SpawnRunResult>

export interface NormalizeDeps {
  spawn?: SpawnRunner
  /** heic-convert seam (default lazy-imports the real module). */
  heicConvert?: (buffer: Buffer) => Promise<Buffer>
  ffmpegPath?: string | null
  ffprobePath?: string
  /** Never write the bytes to disk (the readable copy of an end-to-end encrypted attachment):
   *  images are converted in memory (sharp, heic-convert); a video, which ffprobe and ffmpeg read
   *  from a temp file, is refused before any file is written or process spawned. */
  inMemoryOnly?: boolean
}

const defaultSpawnRunner: SpawnRunner = async (cmd, input, killTimeoutMs) => {
  const proc = Bun.spawn(cmd, {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (input && proc.stdin) {
    const w = proc.stdin as { write: (b: Uint8Array) => void; end: () => void }
    w.write(new Uint8Array(input))
    w.end()
  }
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, killTimeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout: Buffer.from(stdout), stderr, timedOut }
  } finally {
    clearTimeout(killer)
  }
}

async function defaultHeicConvert(buffer: Buffer): Promise<Buffer> {
  const convert = (await import("heic-convert")).default
  // heic-convert's `buffer` is `Uint8Array`; a Node `Buffer` IS a `Uint8Array`,
  // so it is passed directly (no cast).
  return Buffer.from(await convert({ buffer, format: "JPEG", quality: 0.9 }))
}

// ---- process-wide concurrency gate ----------------------------------------
let active = 0
const waiters: Array<() => void> = []
async function acquireSlot(): Promise<() => void> {
  if (active < NORMALIZE_MAX_CONCURRENCY) {
    active++
    return release
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  active++
  return release
}
function release(): void {
  active--
  const next = waiters.shift()
  if (next) next()
}

// Attacker-supplied media goes through native decoders (libvips, libheif, ffmpeg).
// A decompression bomb is a small file that decodes to billions of pixels or hours
// of video, so every decode is bounded: pixels for stills, bytes for HEIC (whose
// converter has no pixel limit of its own), and protocol, input and duration for
// ffmpeg (an attacker's container can name `http:` or `concat:` inputs).
const IMAGE_MAX_INPUT_PIXELS = 100_000_000
const HEIC_MAX_BYTES = 30 * 1024 * 1024
const FFMPEG_MAX_DURATION_SECONDS = 900
const FFMPEG_SAFE_INPUT_ARGS = ["-protocol_whitelist", "file,pipe", "-nostdin"] as const

const PASS_THROUGH_IMAGE = new Set(["image/jpeg", "image/png", "image/webp"])

interface ProbeResult {
  videoCodec: string | null
  container: string
  durationSeconds: number | null
}

/** Parse `ffprobe -of json` output into the fields we gate on. */
export function parseFfprobe(json: unknown): ProbeResult {
  const root = (json ?? {}) as {
    streams?: Array<{ codec_type?: string; codec_name?: string }>
    format?: { format_name?: string; duration?: string }
  }
  const streams = root.streams ?? []
  const videoStream = streams.find((s) => s.codec_type === "video")
  const formatName = root.format?.format_name ?? ""
  const durationRaw = root.format?.duration
  const duration = durationRaw !== undefined ? Number(durationRaw) : Number.NaN
  return {
    videoCodec: videoStream?.codec_name ?? null,
    container: formatName.toLowerCase(),
    durationSeconds: Number.isFinite(duration) ? duration : null,
  }
}

/**
 * h264-in-mp4/mov passes through. ffprobe's `format_name` for an MP4 is
 * typically `mov,mp4,m4a,3gp,3g2,mj2` (a comma list) — so a substring match on
 * `mp4` or `mov` is the right test.
 */
function isGeminiSafeVideo(probe: ProbeResult): boolean {
  if (probe.videoCodec !== "h264") return false
  return probe.container.includes("mp4") || probe.container.includes("mov")
}

async function normalizeImage(
  buffer: Buffer,
  detectedMime: string,
  heicConvert: (b: Buffer) => Promise<Buffer>,
): Promise<NormalizedMedia> {
  if (PASS_THROUGH_IMAGE.has(detectedMime)) {
    return { buffer, mime: detectedMime, kind: "image" }
  }
  if (detectedMime === "image/heic" || detectedMime === "image/heif") {
    // sharp's prebuilt lacks libheif → always heic-convert (the blocking-#1 fix:
    // never feed raw HEIC bytes to sharp).
    if (buffer.byteLength > HEIC_MAX_BYTES) {
      throw new NormalizeError(
        "image_transcode_failed",
        `HEIC image is too large to convert (${buffer.byteLength} > ${HEIC_MAX_BYTES} bytes).`,
      )
    }
    try {
      const jpeg = await heicConvert(buffer)
      return { buffer: jpeg, mime: "image/jpeg", kind: "image" }
    } catch (err) {
      throw new NormalizeError(
        "image_transcode_failed",
        `Could not transcode HEIC image: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  // Any other image format (tiff/avif/gif/bmp/…) → sharp → JPEG.
  try {
    const jpeg = await sharp(buffer, {
      failOn: "none",
      limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .jpeg({ quality: 90 })
      .toBuffer()
    return { buffer: jpeg, mime: "image/jpeg", kind: "image" }
  } catch (err) {
    throw new NormalizeError(
      "image_transcode_failed",
      `Could not transcode image (${detectedMime}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function normalizeVideo(
  buffer: Buffer,
  detectedMime: string,
  deps: Required<Pick<NormalizeDeps, "spawn">> & {
    ffmpegPath: string | null
    ffprobePath: string
  },
): Promise<NormalizedMedia> {
  const release = await acquireSlot()
  // ffmpeg/ffprobe read the input from a SEEKABLE TEMP FILE, never `pipe:0`.
  // iPhone HEVC `.mov` files carry their index (`moov` atom) and timed-metadata
  // tracks in a layout the demuxer must SEEK to parse; on a non-seekable stdin
  // pipe ffmpeg hits "partial file / Invalid data found", aborts demuxing, yet —
  // because of `-movflags empty_moov` — still flushes a tiny (~1.3 KB) valid-but-
  // EMPTY fragmented-MP4 header to stdout and exits 0. That empty clip then 500s
  // Gemini. A real file on disk is seekable, so the demux succeeds. The temp dir
  // is always removed in `finally`.
  let workDir: string | null = null
  try {
    workDir = await mkdtemp(join(tmpdir(), "liaison-media-"))
    const inputPath = join(workDir, `in-${randomUUID()}`)
    await writeFile(inputPath, buffer)

    // 1. ffprobe FIRST — gate on a real video stream + read codec/container.
    const probeRun = await deps.spawn(
      [
        deps.ffprobePath,
        ...FFMPEG_SAFE_INPUT_ARGS.filter((a) => a !== "-nostdin"),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        "-i",
        inputPath,
      ],
      undefined,
      FFPROBE_KILL_TIMEOUT_MS,
    )
    if (probeRun.timedOut) {
      throw new NormalizeError("normalize_timeout", "ffprobe timed out.")
    }
    if (probeRun.exitCode !== 0) {
      throw new NormalizeError(
        "probe_failed",
        `ffprobe failed (exit ${probeRun.exitCode}): ${probeRun.stderr.slice(0, 300)}`,
      )
    }
    let probe: ProbeResult
    try {
      probe = parseFfprobe(JSON.parse(probeRun.stdout.toString("utf8")))
    } catch {
      throw new NormalizeError("probe_failed", "ffprobe returned unparseable output.")
    }
    if (!probe.videoCodec) {
      throw new NormalizeError("no_video_stream", "File has no decodable video stream.")
    }

    // 2. h264-in-mp4/mov → pass through (already Gemini-safe).
    if (isGeminiSafeVideo(probe)) {
      return { buffer, mime: detectedMime, kind: "video" }
    }

    // 3. Otherwise transcode → H.264/AAC MP4, downscaled ≤720p, honoring rotation.
    if (!deps.ffmpegPath) {
      throw new NormalizeError(
        "ffmpeg_unavailable",
        "ffmpeg binary is not available on this platform.",
      )
    }
    const ffRun = await deps.spawn(
      [
        deps.ffmpegPath,
        ...FFMPEG_SAFE_INPUT_ARGS,
        "-v",
        "error",
        "-i",
        inputPath,
        "-t",
        String(FFMPEG_MAX_DURATION_SECONDS),
        // Take ONLY the first video + first audio stream — iPhone .mov carries
        // extra timed-metadata/data tracks that `-c:a aac` would choke on.
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        // honor rotation metadata (autorotate via the scale filter input);
        // downscale so the long edge is ≤ VIDEO_MAX_LONG_EDGE_PX (even dims).
        "-vf",
        `scale='min(${VIDEO_MAX_LONG_EDGE_PX},iw)':-2`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ],
      undefined,
      FFMPEG_KILL_TIMEOUT_MS,
    )
    if (ffRun.timedOut) {
      throw new NormalizeError("normalize_timeout", "ffmpeg transcode timed out.")
    }
    if (ffRun.exitCode !== 0 || ffRun.stdout.byteLength === 0) {
      throw new NormalizeError(
        "transcode_failed",
        `ffmpeg transcode failed (exit ${ffRun.exitCode}): ${ffRun.stderr.slice(0, 300)}`,
      )
    }
    return { buffer: ffRun.stdout, mime: "video/mp4", kind: "video" }
  } finally {
    release()
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Normalize a media buffer to a Gemini-safe format. `detectedMime` MUST come
 * from a magic-byte sniff (never a stored mime/filename). Throws a
 * `NormalizeError` (typed) on any failure — the caller surfaces it; raw bytes of
 * an unknown format are NEVER sent to Gemini.
 */
export async function normalizeMedia(
  buffer: Buffer,
  detectedMime: string,
  deps: NormalizeDeps = {},
): Promise<NormalizedMedia> {
  const spawn = deps.spawn ?? defaultSpawnRunner
  const heicConvert = deps.heicConvert ?? defaultHeicConvert
  const ffmpeg = deps.ffmpegPath !== undefined ? deps.ffmpegPath : (ffmpegPath as string | null)
  const ffprobe = deps.ffprobePath ?? ffprobePath

  if (detectedMime.startsWith("image/")) {
    return normalizeImage(buffer, detectedMime, heicConvert)
  }
  if (detectedMime.startsWith("video/")) {
    if (deps.inMemoryOnly) {
      throw new NormalizeError(
        "private_video_unsupported",
        "A private video can't be analysed yet: reading a video needs a temporary file on disk.",
      )
    }
    try {
      return await normalizeVideo(buffer, detectedMime, {
        spawn,
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
      })
    } catch (err) {
      if (err instanceof NormalizeError) {
        log.warn({ media: "normalize", code: err.code }, err.message)
        throw err
      }
      const detail = err instanceof Error ? err.message : String(err)
      log.warn({ media: "normalize", code: "normalize_failed" }, detail)
      throw new NormalizeError("normalize_failed", detail)
    }
  }
  throw new NormalizeError("unsupported", `Unsupported media type (${detectedMime || "unknown"}).`)
}
