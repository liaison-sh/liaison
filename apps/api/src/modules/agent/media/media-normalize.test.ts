// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import sharp from "sharp"
import {
  NormalizeError,
  normalizeMedia,
  parseFfprobe,
  type SpawnRunResult,
} from "~/modules/agent/media/media-normalize"

/** Build a deterministic ffprobe JSON stdout for a given codec/container. */
function probeJson(codec: string | null, formatName: string): Buffer {
  const streams = codec ? [{ codec_type: "video", codec_name: codec }] : []
  return Buffer.from(
    JSON.stringify({ streams, format: { format_name: formatName, duration: "12.0" } }),
  )
}

const ok = (stdout: Buffer): SpawnRunResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
})

/**
 * A spawn fake that returns probe JSON for ffprobe and a fixed transcoded
 * buffer for ffmpeg, recording which binaries were invoked.
 */
function fakeSpawn(opts: { probe?: SpawnRunResult; ffmpeg?: SpawnRunResult; calls?: string[] }) {
  return mock(async (cmd: string[]): Promise<SpawnRunResult> => {
    const bin = cmd[0]
    opts.calls?.push(bin)
    if (bin.includes("ffprobe")) return opts.probe ?? ok(probeJson("h264", "mov,mp4,m4a"))
    // ffmpeg
    return opts.ffmpeg ?? ok(Buffer.from("TRANSCODED_MP4_BYTES"))
  })
}

const FF = { ffmpegPath: "/bin/ffmpeg", ffprobePath: "/bin/ffprobe" }

describe("parseFfprobe", () => {
  it("reads video codec + container + duration", () => {
    const r = parseFfprobe(JSON.parse(probeJson("h264", "mov,mp4,m4a").toString()))
    expect(r.videoCodec).toBe("h264")
    expect(r.container).toContain("mp4")
    expect(r.durationSeconds).toBe(12)
  })
  it("returns null codec when there is no video stream", () => {
    const r = parseFfprobe({ streams: [{ codec_type: "audio", codec_name: "aac" }], format: {} })
    expect(r.videoCodec).toBeNull()
  })
})

describe("normalizeMedia — video routing", () => {
  it("runs ffprobe and ffmpeg confined to local input with a duration cap", async () => {
    const cmds: string[][] = []
    const spawn = mock(async (cmd: string[]): Promise<SpawnRunResult> => {
      cmds.push(cmd)
      if (cmd[0].includes("ffprobe")) return ok(probeJson("hevc", "mov,mp4,m4a"))
      return ok(Buffer.from("H264_MP4"))
    })
    await normalizeMedia(Buffer.from("HEVC_MOV"), "video/quicktime", { spawn, ...FF })
    for (const cmd of cmds) {
      // An attacker's container can name http:, concat: or other protocol inputs.
      const i = cmd.indexOf("-protocol_whitelist")
      expect(i).toBeGreaterThan(0)
      expect(cmd[i + 1]).toBe("file,pipe")
    }
    const ffmpeg = cmds.find((c) => c[0].includes("ffmpeg"))!
    expect(ffmpeg).toContain("-nostdin")
    expect(ffmpeg).toContain("-t")
  })

  it("h264-in-mp4 PASSES THROUGH (no ffmpeg transcode)", async () => {
    const calls: string[] = []
    const spawn = fakeSpawn({ probe: ok(probeJson("h264", "mov,mp4,m4a,3gp")), calls })
    const input = Buffer.from("ORIGINAL_MP4")
    const res = await normalizeMedia(input, "video/mp4", { spawn, ...FF })
    expect(res.kind).toBe("video")
    expect(res.mime).toBe("video/mp4")
    // Pass-through returns the ORIGINAL bytes; ffmpeg is never spawned.
    expect(res.buffer.equals(input)).toBe(true)
    expect(calls.some((c) => c.includes("ffmpeg"))).toBe(false)
    expect(calls.some((c) => c.includes("ffprobe"))).toBe(true)
  })

  it("hevc-in-mov TRANSCODES (→ H.264/AAC MP4)", async () => {
    const calls: string[] = []
    const spawn = fakeSpawn({
      probe: ok(probeJson("hevc", "mov,mp4,m4a")),
      ffmpeg: ok(Buffer.from("H264_MP4")),
      calls,
    })
    const res = await normalizeMedia(Buffer.from("HEVC_MOV"), "video/quicktime", { spawn, ...FF })
    expect(res.kind).toBe("video")
    expect(res.mime).toBe("video/mp4")
    expect(res.buffer.toString()).toBe("H264_MP4")
    expect(calls.some((c) => c.includes("ffmpeg"))).toBe(true)
  })

  it("an exotic container (h264 but webm) TRANSCODES", async () => {
    const calls: string[] = []
    const spawn = fakeSpawn({
      probe: ok(probeJson("h264", "matroska,webm")),
      ffmpeg: ok(Buffer.from("REMUXED_MP4")),
      calls,
    })
    const res = await normalizeMedia(Buffer.from("WEBM"), "video/webm", { spawn, ...FF })
    expect(res.mime).toBe("video/mp4")
    expect(calls.some((c) => c.includes("ffmpeg"))).toBe(true)
  })

  it("no-video-stream → typed NormalizeError(no_video_stream)", async () => {
    const spawn = fakeSpawn({ probe: ok(probeJson(null, "mov,mp4,m4a")) })
    await expect(
      normalizeMedia(Buffer.from("AUDIO_ONLY"), "video/mp4", { spawn, ...FF }),
    ).rejects.toMatchObject({ code: "no_video_stream" })
  })

  it("ffprobe timeout → typed NormalizeError(normalize_timeout)", async () => {
    const spawn = mock(
      async (cmd: string[]): Promise<SpawnRunResult> => ({
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        timedOut: cmd[0].includes("ffprobe"),
      }),
    )
    await expect(
      normalizeMedia(Buffer.from("HANG"), "video/mp4", { spawn, ...FF }),
    ).rejects.toMatchObject({ code: "normalize_timeout" })
  })

  it("ffmpeg transcode timeout → typed NormalizeError(normalize_timeout)", async () => {
    const spawn = mock(async (cmd: string[]): Promise<SpawnRunResult> => {
      if (cmd[0].includes("ffprobe")) return ok(probeJson("hevc", "mov,mp4,m4a"))
      return { exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: true }
    })
    await expect(
      normalizeMedia(Buffer.from("HEVC"), "video/quicktime", { spawn, ...FF }),
    ).rejects.toMatchObject({ code: "normalize_timeout" })
  })

  it("ffprobe non-zero exit → typed NormalizeError(probe_failed)", async () => {
    const spawn = mock(
      async (): Promise<SpawnRunResult> => ({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: "Invalid data found",
        timedOut: false,
      }),
    )
    await expect(
      normalizeMedia(Buffer.from("GARBAGE"), "video/mp4", { spawn, ...FF }),
    ).rejects.toMatchObject({ code: "probe_failed" })
  })

  it("ffmpeg unavailable on the platform → typed NormalizeError(ffmpeg_unavailable)", async () => {
    const spawn = fakeSpawn({ probe: ok(probeJson("hevc", "mov,mp4,m4a")) })
    await expect(
      normalizeMedia(Buffer.from("HEVC"), "video/quicktime", {
        spawn,
        ffmpegPath: null,
        ffprobePath: "/bin/ffprobe",
      }),
    ).rejects.toMatchObject({ code: "ffmpeg_unavailable" })
  })
})

describe("normalizeMedia — image routing", () => {
  it("jpeg PASSES THROUGH (no transcode, no spawn)", async () => {
    const spawn = mock(async (): Promise<SpawnRunResult> => {
      throw new Error("spawn must not run for a pass-through image")
    })
    const input = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const res = await normalizeMedia(input, "image/jpeg", { spawn })
    expect(res.kind).toBe("image")
    expect(res.mime).toBe("image/jpeg")
    expect(res.buffer.equals(input)).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("png and webp PASS THROUGH", async () => {
    const png = await normalizeMedia(Buffer.from("PNGDATA"), "image/png")
    expect(png.mime).toBe("image/png")
    const webp = await normalizeMedia(Buffer.from("WEBPDATA"), "image/webp")
    expect(webp.mime).toBe("image/webp")
  })

  it("heic → heic-convert → JPEG (never raw HEIC to sharp)", async () => {
    const heicConvert = mock(async () => Buffer.from("CONVERTED_JPEG"))
    const res = await normalizeMedia(Buffer.from("HEICBYTES"), "image/heic", { heicConvert })
    expect(res.mime).toBe("image/jpeg")
    expect(res.buffer.toString()).toBe("CONVERTED_JPEG")
    expect(heicConvert).toHaveBeenCalledTimes(1)
  })

  it("a non-passthrough image (tiff) → sharp → JPEG", async () => {
    // A real TIFF so sharp can decode it deterministically.
    const tiff = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .tiff()
      .toBuffer()
    const res = await normalizeMedia(tiff, "image/tiff")
    expect(res.mime).toBe("image/jpeg")
    // The output is a real JPEG.
    expect(res.buffer[0]).toBe(0xff)
    expect(res.buffer[1]).toBe(0xd8)
  })

  it("a non-media mime → typed NormalizeError(unsupported)", async () => {
    await expect(normalizeMedia(Buffer.from("PK"), "application/zip")).rejects.toBeInstanceOf(
      NormalizeError,
    )
  })
})

describe("normalizeMedia — inMemoryOnly (a private mailbox's readable copy)", () => {
  it("refuses a video before writing a temp file or spawning ffprobe", async () => {
    const calls: string[] = []
    const spawn = fakeSpawn({ calls })
    const err = await normalizeMedia(Buffer.from("MP4BYTES"), "video/mp4", {
      ...FF,
      spawn,
      inMemoryOnly: true,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NormalizeError)
    expect((err as NormalizeError).code).toBe("private_video_unsupported")
    expect(spawn).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it("converts an image in memory: sharp on the buffer, no spawn", async () => {
    const spawn = mock(async (): Promise<SpawnRunResult> => {
      throw new Error("no process may run for an image")
    })
    const gif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .gif()
      .toBuffer()
    const res = await normalizeMedia(gif, "image/gif", { ...FF, spawn, inMemoryOnly: true })
    expect(res.kind).toBe("image")
    expect(res.mime).toBe("image/jpeg")
    expect(res.buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })
})
