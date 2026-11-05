// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE RECORDING, IN SELF-CONTAINED PIECES. Transcription upstreams time out
// past about a minute of audio, and splitting a compressed recording needs a
// decoder the server does not have. So the browser splits it: every
// SEGMENT_MS the recorder is restarted on the same stream, and each recorder
// closes a whole, decodable file (its own header). The next recorder starts
// SEGMENT_OVERLAP_MS before the previous one stops, so a word spoken at the
// cut is whole in at least one segment; the join drops the words heard twice
// (dictation-join.ts).
// While recording, the level is read every SPEECH_FRAME_MS into each segment
// still open, so each segment's speech is judged on its own readings before
// anything is sent (dictation-speech.ts).
// `MediaRecorder.start(timeslice)` was not used: its later chunks are
// fragments of ONE file and do not decode on their own.

import { SPEECH_FRAME_MS } from "./dictation-speech"

export const SEGMENT_MS = 45_000
/** How long two consecutive segments record together. */
export const SEGMENT_OVERLAP_MS = 1_000
/** The longest take; recording stops by itself here and transcribes. */
export const MAX_RECORDING_MS = 300_000

const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
]

/** The first container this engine records (Chromium and Firefox webm, Safari mp4). */
export function pickAudioMimeType(): string | undefined {
  const supported = globalThis.MediaRecorder?.isTypeSupported
  if (typeof supported !== "function") return undefined
  return PREFERRED_TYPES.find((type) => supported.call(globalThis.MediaRecorder, type))
}

/** One self-contained piece of the take, and the level read while it recorded. */
export interface RecordedSegment {
  audio: Blob
  /** RMS readings, one per SPEECH_FRAME_MS (none without a level to read). */
  levels: number[]
}

export interface SegmentRecorder {
  /** Stop and answer every non-empty segment, in recording order. */
  stop: () => Promise<RecordedSegment[]>
  /** Stop and drop everything recorded. */
  cancel: () => void
}

export function recordSegments(
  stream: MediaStream,
  mimeType: string | undefined,
  segmentMs: number = SEGMENT_MS,
  /** The live RMS of the stream, read every SPEECH_FRAME_MS (null: no reading now). */
  level?: () => number | null,
): SegmentRecorder {
  const slots: Array<RecordedSegment | null> = []
  /** Each segment's readings, by index; a segment stops reading when its recorder stops. */
  const readings: number[][] = []
  const reading = new Set<number>()
  let open = 0
  let current: MediaRecorder | null = null
  /** A previous segment's recorder still running through the overlap. */
  let overlapping: MediaRecorder | null = null
  let rollTimer: ReturnType<typeof setTimeout> | undefined
  let overlapTimer: ReturnType<typeof setTimeout> | undefined
  let finish: ((segments: RecordedSegment[]) => void) | null = null
  let dropped = false

  const settle = () => {
    if (finish && open === 0) finish(slots.filter((s): s is RecordedSegment => s !== null))
  }

  const begin = () => {
    const index = slots.length
    slots.push(null)
    readings.push([])
    reading.add(index)
    open += 1
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    recorder.addEventListener("stop", () => {
      open -= 1
      if (dropped) return
      if (chunks.length > 0) {
        slots[index] = {
          audio: new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }),
          levels: readings[index] ?? [],
        }
      }
      settle()
    })
    recorder.start()
    recorderIndex.set(recorder, index)
    current = recorder
    rollTimer = setTimeout(roll, segmentMs)
  }

  const recorderIndex = new Map<MediaRecorder, number>()
  const stopRecorder = (recorder: MediaRecorder | null) => {
    if (!recorder) return
    const index = recorderIndex.get(recorder)
    if (index !== undefined) reading.delete(index)
    if (recorder.state !== "inactive") recorder.stop()
  }
  const sampler = level
    ? setInterval(() => {
        const rms = level()
        if (rms === null) return
        for (const index of reading) readings[index]?.push(rms)
      }, SPEECH_FRAME_MS)
    : undefined

  const roll = () => {
    stopRecorder(overlapping)
    overlapping = current
    begin()
    overlapTimer = setTimeout(() => {
      stopRecorder(overlapping)
      overlapping = null
    }, SEGMENT_OVERLAP_MS)
  }

  const stopAll = () => {
    clearInterval(sampler)
    clearTimeout(rollTimer)
    clearTimeout(overlapTimer)
    stopRecorder(overlapping)
    overlapping = null
    stopRecorder(current)
  }

  begin()

  return {
    stop: () =>
      new Promise<RecordedSegment[]>((resolve) => {
        finish = resolve
        stopAll()
        settle()
      }),
    cancel: () => {
      dropped = true
      stopAll()
    },
  }
}

/** Release the microphone: the OS indicator goes off. */
export function releaseStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

/**
 * A 0..1 loudness reading of the live stream for the level meter, or null
 * where the engine has no Web Audio. `stop` closes the audio graph.
 */
export function levelMeter(
  stream: MediaStream,
): { read: () => number; rms: () => number | null; stop: () => void } | null {
  const Ctx = globalThis.AudioContext
  if (typeof Ctx !== "function") return null
  try {
    const ctx = new Ctx()
    const analyser = ctx.createAnalyser()
    // About 43 ms at 48 kHz: one reading covers most of a SPEECH_FRAME_MS frame.
    analyser.fftSize = 2048
    ctx.createMediaStreamSource(stream).connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    // A context the engine started suspended (no user activation left) reads
    // flat silence: it is asked to resume, and until it runs it gives no
    // reading, so a take it heard nothing of is sent rather than judged silent.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {})
    const rms = (): number | null => {
      if (ctx.state === "suspended" || ctx.state === "closed") return null
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const s of samples) {
        const centred = (s - 128) / 128
        sum += centred * centred
      }
      return Math.sqrt(sum / samples.length)
    }
    return {
      rms,
      // Speech sits low in RMS terms: scaled so a normal voice fills most of the meter.
      read: () => Math.min(1, (rms() ?? 0) * 4),
      stop: () => {
        void ctx.close().catch(() => {})
      },
    }
  } catch {
    return null
  }
}
