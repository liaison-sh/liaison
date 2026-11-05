// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bounds of one transcription request, before and after the paid call:
//  * its length is read off the container BEFORE anything is spent, and a
//    request longer than one client segment (plus slack) is refused with no
//    upstream call (a 10 MB low-bitrate file is an hour of billed audio);
//  * a call the provider answered without saying what it heard or billed is
//    still metered, at the bounded length times the model's price;
//  * the clean-up gets what is left of the request budget, never more than its
//    own 20 s, so a slow clean-up cannot turn a transcript into a 504.
// The provider and the spend path are injected; nothing leaves the process.
import { describe, expect, it } from "bun:test"
import { DICTATION_SEGMENT_SECONDS } from "@liaison/shared"
import { containerDurationSeconds, minimumSecondsOf } from "./audio-duration"
import { DICTATION_CLEAN_TIMEOUT_MS } from "./proofread-service"
import {
  DICTATION_REQUEST_MAX_SECONDS,
  defaultTranscribeDeps,
  type TranscribeDeps,
  transcribe,
} from "./transcribe-service"
import {
  findTranscriptionModel,
  MEASURED_DEFAULT_TRANSCRIPTION_KEY,
  type TranscriptionModel,
} from "./transcription-models"

const ORG_ID = "00000000-0000-4000-8000-0000000f7001"
const USER_ID = "00000000-0000-4000-8000-0000000f7002"
const MODEL = findTranscriptionModel(MEASURED_DEFAULT_TRANSCRIPTION_KEY) as TranscriptionModel

// ── Synthetic containers, built the way a browser's MediaRecorder writes them ──

function ebml(id: number[], body: number[] | null): number[] {
  // null body: unknown size (0x01FFFFFFFFFFFFFF), as a live recording writes Segment and Cluster.
  if (body === null) return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
  const n = body.length
  return [...id, 0x40 | (n >> 8), n & 0xff, ...body]
}

/** A WebM of `seconds`: unknown-size Segment and Clusters, no Duration, one block a second. */
function webm(seconds: number): Uint8Array {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])
  const info = ebml([0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])
  const out = [...header, ...ebml([0x18, 0x53, 0x80, 0x67], null), ...info]
  for (let cluster = 0; cluster * 30 <= seconds; cluster++) {
    const startMs = cluster * 30_000
    out.push(...ebml([0x1f, 0x43, 0xb6, 0x75], null))
    out.push(
      0xe7,
      0x84,
      (startMs >>> 24) & 0xff,
      (startMs >>> 16) & 0xff,
      (startMs >>> 8) & 0xff,
      startMs & 0xff,
    )
    for (let s = 0; s < 30 && cluster * 30 + s <= seconds; s++) {
      const rel = s * 1000
      out.push(...ebml([0xa3], [0x81, (rel >> 8) & 0xff, rel & 0xff, 0x80, 0xfc, 0xff, 0xfe]))
    }
  }
  return new Uint8Array(out)
}

/** A WAV of `seconds` at 8 kHz, 8-bit mono. */
function wav(seconds: number): Uint8Array {
  const data = 8000 * seconds
  const buf = new ArrayBuffer(44 + data)
  const v = new DataView(buf)
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  tag(0, "RIFF")
  v.setUint32(4, 36 + data, true)
  tag(8, "WAVE")
  tag(12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true)
  v.setUint32(28, 8000, true)
  v.setUint16(32, 1, true)
  v.setUint16(34, 8, true)
  tag(36, "data")
  v.setUint32(40, data, true)
  return new Uint8Array(buf)
}

describe("reading a recording's length off its container", () => {
  it("a browser WebM (no Duration, unknown sizes): the last block's time", () => {
    expect(containerDurationSeconds(webm(44), "audio/webm")).toBeCloseTo(44, 1)
    expect(containerDurationSeconds(webm(120), "audio/webm")).toBeCloseTo(120, 1)
  })

  it("a real WebM fixture: what ffprobe says (27.958 s)", async () => {
    const bytes = new Uint8Array(
      await Bun.file(`${import.meta.dir}/__fixtures__/dictation/en-ami-01.webm`).arrayBuffer(),
    )
    expect(containerDurationSeconds(bytes, "audio/webm")).toBeCloseTo(27.958, 0)
  })

  it("a WAV: its data over its byte rate", () => {
    expect(containerDurationSeconds(wav(3), "audio/wav")).toBeCloseTo(3, 5)
  })

  it("says nothing about bytes it cannot read", () => {
    expect(containerDurationSeconds(new Uint8Array([1, 2, 3, 4]), "audio/webm")).toBeNull()
    expect(containerDurationSeconds(new Uint8Array(64), "audio/mpeg")).toBeNull()
  })

  it("bounds an unreadable file by its bytes at 320 kbit/s", () => {
    expect(minimumSecondsOf(40_000 * 90)).toBe(90)
  })
})

interface Seen {
  calls: number
  gates: number
  metered: Array<{ fixedCostUsd?: number; providerCostUsd?: number }>
  clean: Array<{ timeoutMs?: number }>
}

function deps(
  seen: Seen,
  answer: { text: string; seconds: number | null; costUsd: number | undefined },
): TranscribeDeps {
  return {
    ...defaultTranscribeDeps,
    resolvePlan: async () => ({ model: MODEL, hedge: null }),
    callProvider: async () => {
      seen.calls++
      return answer
    },
    clean: async (input) => {
      seen.clean.push({ timeoutMs: input.timeoutMs })
      return { cleaned: input.text, cleanModel: "c" }
    },
    log: { warn: () => {}, error: () => {} } as never,
    spend: {
      resolveKey: async () => ({ key: "k", source: "byok" }),
      spendGate: async () => {
        seen.gates++
        return null
      },
      finalizeUsage: async (_orgId, params) => {
        seen.metered.push({
          ...(params.fixedCostUsd !== undefined ? { fixedCostUsd: params.fixedCostUsd } : {}),
          ...(params.providerCostUsd !== undefined
            ? { providerCostUsd: params.providerCostUsd }
            : {}),
        })
        return { creditCost: "0" }
      },
      recordReservedDemoSideSpend: async () => {},
      releaseDemoTurnReservation: async () => {},
    },
  }
}

const fresh = (): Seen => ({ calls: 0, gates: 0, metered: [], clean: [] })

function run(
  audio: Uint8Array,
  contentType: "audio/webm" | "audio/wav" | "audio/mpeg",
  d: TranscribeDeps,
  extra: { clean?: boolean; deadline?: number } = {},
) {
  return transcribe(
    {
      orgId: ORG_ID,
      userId: USER_ID,
      audio,
      contentType,
      clean: extra.clean ?? false,
      signal: new AbortController().signal,
      ...(extra.deadline !== undefined ? { deadline: extra.deadline } : {}),
    },
    d,
  )
}

describe("the length bound, before anything is spent", () => {
  it("allows one client segment plus slack (60 s)", () => {
    expect(DICTATION_REQUEST_MAX_SECONDS).toBe(60)
    expect(DICTATION_REQUEST_MAX_SECONDS).toBeGreaterThan(DICTATION_SEGMENT_SECONDS)
  })

  it("refuses a 2-minute WebM with too_large, no gate and no upstream call", async () => {
    const seen = fresh()
    const err = (await run(webm(120), "audio/webm", deps(seen, ok())).catch((e) => e)) as {
      code?: string
      status?: number
      message?: string
    }
    expect(err.code).toBe("too_large")
    expect(err.status).toBe(413)
    expect(err.message).toContain("60")
    expect(seen.calls).toBe(0)
    expect(seen.gates).toBe(0)
    expect(seen.metered).toEqual([])
  })

  it("refuses a 2-minute WAV the same way", async () => {
    const seen = fresh()
    const err = (await run(wav(120), "audio/wav", deps(seen, ok())).catch((e) => e)) as {
      code?: string
    }
    expect(err.code).toBe("too_large")
    expect(seen.calls).toBe(0)
  })

  it("refuses an unreadable file whose bytes alone hold more than 60 s", async () => {
    const seen = fresh()
    const bytes = new Uint8Array(40_000 * 61)
    const err = (await run(bytes, "audio/mpeg", deps(seen, ok())).catch((e) => e)) as {
      code?: string
    }
    expect(err.code).toBe("too_large")
    expect(seen.calls).toBe(0)
  })

  it("lets a 44 s segment through", async () => {
    const seen = fresh()
    const res = await run(webm(44), "audio/webm", deps(seen, ok()))
    expect(res.raw).toBe("hello")
    expect(seen.calls).toBe(1)
  })
})

function ok() {
  return { text: "hello", seconds: 12, costUsd: 0.00004 }
}

describe("metering a call that reported nothing", () => {
  it("meters the container's length times the model's price", async () => {
    const seen = fresh()
    await run(
      webm(30),
      "audio/webm",
      deps(seen, { text: "hello", seconds: null, costUsd: undefined }),
    )
    expect(seen.metered).toHaveLength(1)
    const cost = seen.metered[0]?.fixedCostUsd ?? 0
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeCloseTo(30 * MODEL.pricePerSecondUsd, 8)
  })

  it("meters an unreadable file at the longest length allowed", async () => {
    const seen = fresh()
    await run(
      new Uint8Array(2048),
      "audio/mpeg",
      deps(seen, { text: "hi", seconds: null, costUsd: undefined }),
    )
    expect(seen.metered[0]?.fixedCostUsd).toBeCloseTo(
      DICTATION_REQUEST_MAX_SECONDS * MODEL.pricePerSecondUsd,
      8,
    )
  })
})

describe("the clean-up's share of the request budget", () => {
  it("20 s when the request has plenty left", async () => {
    const seen = fresh()
    await run(webm(5), "audio/webm", deps(seen, ok()), {
      clean: true,
      deadline: Date.now() + 100_000,
    })
    expect(seen.clean).toEqual([{ timeoutMs: DICTATION_CLEAN_TIMEOUT_MS }])
  })

  it("what is left minus a 2 s margin when the request is nearly out", async () => {
    const seen = fresh()
    await run(webm(5), "audio/webm", deps(seen, ok()), {
      clean: true,
      deadline: Date.now() + 10_000,
    })
    const t = seen.clean[0]?.timeoutMs ?? -1
    expect(t).toBeLessThanOrEqual(8_000)
    expect(t).toBeGreaterThan(7_000)
  })
})
