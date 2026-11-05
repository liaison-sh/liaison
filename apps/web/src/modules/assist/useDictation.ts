// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE DICTATION TAKE: idle → requesting (the permission prompt) → recording
// (elapsed time, level) → transcribing → the text at the caret held since the
// take began, or an error said in words. Cancel, unmounting and leaving the
// tab drop the audio and release the microphone; nothing is uploaded until
// Stop (or the 5 minute cap) ends the take, and cancel or unmounting aborts
// an upload still in flight. A segment in which no speech was heard is not
// uploaded, and a take with none says so and inserts nothing
// (dictation-speech.ts). The surface draws the take with the shared recorder
// line (RecorderBar.tsx), which shows while `shown()` holds.

import type { CleanDictationResponse, TranscribeResponse } from "@liaison/shared"
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useApi } from "~/modules/shell/ApiContext"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { assistCapabilities, canRecordAudio } from "./dictation-capabilities"
import {
  captureAnchor,
  type DictationAnchor,
  type DictationTarget,
  targetElement,
} from "./dictation-insert"
import { joinTranscripts } from "./dictation-join"
import {
  levelMeter,
  MAX_RECORDING_MS,
  pickAudioMimeType,
  type RecordedSegment,
  recordSegments,
  releaseStream,
  type SegmentRecorder,
} from "./dictation-recorder"
import { segmentsWithSpeech } from "./dictation-speech"

export type DictationStatus = "idle" | "requesting" | "recording" | "transcribing" | "error"

export type DictationErrorKind =
  | "permission"
  | "no_device"
  | "network"
  | "empty"
  | "no_speech"
  | "rate_limited"
  | "too_large"
  | "credits"
  | "demo_key"
  /** A demo visitor must confirm their email before dictating on the demo's key. */
  | "demo_verify"
  | "failed"

/** How long an error stays in the recorder line (it has a dismiss) before the row returns. */
export const MESSAGE_MS = 10_000
/** How long "No speech heard" (or nothing transcribed) stays before the row returns. */
export const NOTICE_MS = 2_000
/** Segments transcribed at once for a long take. */
const PARALLEL_SEGMENTS = 4

export interface Dictation {
  /** The org transcribes and this runtime records: the mic is offered. */
  available: Accessor<boolean>
  status: Accessor<DictationStatus>
  /** The recorder line replaces the surface's control row (a take, or its message). */
  shown: Accessor<boolean>
  error: Accessor<DictationErrorKind | null>
  elapsedMs: Accessor<number>
  level: Accessor<number>
  /** The take hit the 5 minute cap and is being transcribed as recorded. */
  autoStopped: Accessor<boolean>
  start: () => Promise<void>
  stop: () => Promise<void>
  /** Drop the take: nothing recorded is uploaded, an upload in flight is aborted. */
  cancel: () => void
  /** Clear the message in the recorder line: the row returns. */
  dismiss: () => void
  /** Put the focus back in the field the take writes to. */
  focusTarget: () => void
}

/** Does the engine list a microphone? False when it cannot say. */
async function microphoneListed(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.some((d) => d.kind === "audioinput")
  } catch {
    return false
  }
}

async function micErrorKind(error: unknown): Promise<DictationErrorKind> {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "permission"
  }
  // Headless and embedded engines refuse a denied prompt with NotSupportedError:
  // with a microphone listed, that is a refusal, not a missing device.
  if (name === "NotSupportedError" && (await microphoneListed())) return "permission"
  return "no_device"
}

/**
 * The window event a demo spend refusal raises, so the demo shell can act on
 * it (open the email-code prompt, the budget page) without this module
 * knowing the demo module.
 */
export const DEMO_REFUSAL_EVENT = "liaison:demo-refusal"

function announceDemoSpendRefusal(code: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(DEMO_REFUSAL_EVENT, { detail: { code } }))
}

/** What the recorder line says for a failed request (exported for its test). */
export function apiErrorKind(error: unknown): DictationErrorKind {
  if (!(error instanceof ApiError)) return "failed"
  switch (error.code) {
    case "too_large":
      return "too_large"
    case "empty_audio":
      return "empty"
    case "rate_limited":
      return "rate_limited"
    case "insufficient_credits":
      return "credits"
    case "demo_key_required":
      return "demo_key"
    // A demo visitor dictating on the demo's own key (its spend gate).
    case "demo_verification_required":
      announceDemoSpendRefusal(error.code)
      return "demo_verify"
    case "demo_budget_exhausted":
    case "demo_network_exhausted":
    case "demo_box_exhausted":
      announceDemoSpendRefusal(error.code)
      return "credits"
    case "demo_rate_limited":
    case "demo_busy":
      return "rate_limited"
    case "demo_unavailable":
      return "failed"
  }
  if (error.status === 0) return "network"
  if (error.status === 429) return "rate_limited"
  if (error.status === 402) return "credits"
  if (error.status === 413) return "too_large"
  return "failed"
}

class EmptyTake extends Error {}

/**
 * `run` over `items`, at most `limit` at once, results in order. The first
 * failure empties the queue (nothing further starts) and is what rejects.
 */
async function inOrder<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  const queue = items.map((item, index) => ({ item, index }))
  const lane = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        out[job.index] = await run(job.item)
      } catch (err) {
        queue.length = 0
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

/**
 * The audio worth sending: every segment in which speech was heard, or that
 * could not be judged (no Web Audio).
 */
function withSpeech(segments: RecordedSegment[]): Blob[] {
  const verdicts = segmentsWithSpeech(segments.map((s) => s.levels))
  return segments.filter((_, i) => verdicts[i] !== false).map((s) => s.audio)
}

export function useDictation(opts: {
  target: () => DictationTarget | undefined
  /** Recording or transcribing: a field that closes on blur stays open meanwhile. */
  onActiveChange?: (active: boolean) => void
}): Dictation {
  const api = useApi()
  const tabActive = useTabIsActive()
  const [status, setStatus] = createSignal<DictationStatus>("idle")
  const [error, setError] = createSignal<DictationErrorKind | null>(null)
  const [elapsedMs, setElapsedMs] = createSignal(0)
  const [level, setLevel] = createSignal(0)
  const [autoStopped, setAutoStopped] = createSignal(false)

  let take = 0
  let disposed = false
  let stream: MediaStream | null = null
  let recorder: SegmentRecorder | null = null
  let meter: ReturnType<typeof levelMeter> = null
  let anchor: DictationAnchor | null = null
  let tick: ReturnType<typeof setInterval> | undefined
  let frame: number | undefined
  let messageTimer: ReturnType<typeof setTimeout> | undefined
  /** The take's uploads in flight: aborted on cancel and on unmount. */
  let uploads: AbortController | null = null

  // A plain signal, not a resource: reading a resource would suspend the
  // surface around the composer while the answer is on its way.
  const [available, setAvailable] = createSignal(false)
  if (canRecordAudio()) {
    void assistCapabilities(api).then((caps) => {
      if (!disposed) setAvailable(caps.dictation)
    })
  }

  const stopCapture = () => {
    clearInterval(tick)
    tick = undefined
    if (frame !== undefined && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(frame)
    frame = undefined
    meter?.stop()
    meter = null
    releaseStream(stream)
    stream = null
    setLevel(0)
  }

  const dismiss = () => {
    clearTimeout(messageTimer)
    setError(null)
    if (status() === "error") setStatus("idle")
  }

  /** Say `kind` in the recorder line until it times out or is dismissed (null: clear it). */
  const say = (kind: DictationErrorKind | null) => {
    clearTimeout(messageTimer)
    setError(kind)
    if (!kind) return
    setStatus("error")
    const brief = kind === "no_speech" || kind === "empty"
    messageTimer = setTimeout(dismiss, brief ? NOTICE_MS : MESSAGE_MS)
  }

  const focusTarget = () => {
    const target = opts.target()
    if (target) targetElement(target).focus()
  }

  const readLevel = () => {
    if (!meter) return
    setLevel(meter.read())
    frame = requestAnimationFrame(readLevel)
  }

  async function transcribe(segments: Blob[], signal: AbortSignal): Promise<string> {
    if (segments.length === 0) throw new EmptyTake()
    const { autoClean } = await assistCapabilities(api)
    const quiet = { suppressGlobalError: true, signal }
    if (segments.length === 1) {
      const res = await api.post<TranscribeResponse>(
        `/assist/transcribe?clean=${autoClean}`,
        segments[0],
        quiet,
      )
      if (!res.raw.trim()) throw new EmptyTake()
      return res.cleaned.trim() ? res.cleaned : res.raw
    }
    // A long take: each piece raw, joined in order, then ONE clean-up over the
    // whole. The first piece that fails fails the take: nothing further is
    // sent, and the pieces still in flight are aborted.
    const pieces = new AbortController()
    const pieceInit = { ...quiet, signal: AbortSignal.any([signal, pieces.signal]) }
    const texts = await inOrder(segments, PARALLEL_SEGMENTS, (segment) =>
      api
        .post<TranscribeResponse>("/assist/transcribe?clean=false", segment, pieceInit)
        .then((res) => res.raw.trim())
        .catch((err: unknown) => {
          // A silent tail (the last second of a window) is not a failed take.
          if (err instanceof ApiError && err.code === "empty_audio") return ""
          throw err
        }),
    ).catch((err: unknown) => {
      pieces.abort()
      throw err
    })
    const raw = joinTranscripts(texts)
    if (!raw) throw new EmptyTake()
    if (!autoClean) return raw
    try {
      const res = await api.post<CleanDictationResponse>(
        "/assist/clean-dictation",
        { text: raw },
        quiet,
      )
      return res.cleaned.trim() ? res.cleaned : raw
    } catch {
      // The speech is never lost to a failed clean-up.
      return raw
    }
  }

  async function start(): Promise<void> {
    const s = status()
    if (s === "requesting" || s === "recording" || s === "transcribing") return
    const target = opts.target()
    if (!target) return
    say(null)
    setAutoStopped(false)
    const mine = ++take
    anchor = captureAnchor(target)
    setStatus("requesting")
    let captured: MediaStream
    try {
      captured = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const kind = await micErrorKind(err)
      if (mine !== take || disposed) return
      anchor?.release()
      anchor = null
      say(kind)
      return
    }
    if (mine !== take || disposed) {
      releaseStream(captured)
      return
    }
    stream = captured
    const takeMeter = levelMeter(captured)
    meter = takeMeter
    try {
      recorder = recordSegments(
        captured,
        pickAudioMimeType(),
        undefined,
        takeMeter ? () => takeMeter.rms() : undefined,
      )
    } catch {
      stopCapture()
      anchor?.release()
      anchor = null
      say("no_device")
      return
    }
    if (meter && typeof requestAnimationFrame === "function")
      frame = requestAnimationFrame(readLevel)
    const startedAt = Date.now()
    setElapsedMs(0)
    tick = setInterval(() => {
      const elapsed = Math.min(Date.now() - startedAt, MAX_RECORDING_MS)
      setElapsedMs(elapsed)
      if (elapsed >= MAX_RECORDING_MS) void finish(true)
    }, 250)
    setStatus("recording")
  }

  async function finish(capped: boolean): Promise<void> {
    if (status() !== "recording" || !recorder) return
    const mine = take
    const current = recorder
    recorder = null
    clearInterval(tick)
    tick = undefined
    setAutoStopped(capped)
    setStatus("transcribing")
    const segments = await current.stop()
    stopCapture()
    if (mine !== take || disposed) return
    const held = anchor
    anchor = null
    const spoken = withSpeech(segments)
    if (spoken.length === 0) {
      held?.release()
      setAutoStopped(false)
      say("no_speech")
      return
    }
    const controller = new AbortController()
    uploads = controller
    try {
      const text = await transcribe(spoken, controller.signal)
      if (mine !== take || disposed || !held) {
        held?.release()
        return
      }
      // The row returns first, so the text lands in a field whose Send is back.
      setAutoStopped(false)
      setStatus("idle")
      held.insert(text)
    } catch (err) {
      held?.release()
      if (mine !== take || disposed) return
      setAutoStopped(false)
      say(err instanceof EmptyTake ? "empty" : apiErrorKind(err))
    } finally {
      if (uploads === controller) uploads = null
    }
  }

  function cancel(): void {
    take += 1
    uploads?.abort()
    uploads = null
    recorder?.cancel()
    recorder = null
    stopCapture()
    anchor?.release()
    anchor = null
    setAutoStopped(false)
    const s = status()
    if (s === "requesting" || s === "recording" || s === "transcribing") setStatus("idle")
  }

  const active = () => {
    const s = status()
    return s === "requesting" || s === "recording" || s === "transcribing"
  }
  createEffect(on(active, (a) => opts.onActiveChange?.(a), { defer: true }))

  // Leaving the tab while the mic is open drops the take (tabs stay mounted).
  createEffect(
    on(
      tabActive,
      (visible) => {
        const s = status()
        if (!visible && (s === "requesting" || s === "recording")) cancel()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    disposed = true
    cancel()
    clearTimeout(messageTimer)
  })

  return {
    available,
    status,
    shown: () => status() !== "idle",
    error,
    elapsedMs,
    level,
    autoStopped,
    start,
    stop: () => finish(false),
    cancel,
    dismiss,
    focusTarget,
  }
}

/** One take for a form of several writable fields (an approval draft). */
export interface FormDictation {
  dictation: Dictation
  /** A field the take may write to (call from its ref). */
  field: (target: DictationTarget | undefined) => void
  /** The person is in this field: the next take writes there. */
  focused: (target: DictationTarget | undefined) => void
}

/**
 * ONE MIC FOR A FORM, beside its primary action: the take writes to the field
 * last focused, else the first one still on the page.
 */
export function useFormDictation(): FormDictation {
  let fields: DictationTarget[] = []
  let last: DictationTarget | undefined
  const live = (t: DictationTarget | undefined): t is DictationTarget =>
    t !== undefined && targetElement(t).isConnected
  const dictation = useDictation({
    target: () => {
      fields = fields.filter(live)
      return live(last) ? last : fields[0]
    },
  })
  return {
    dictation,
    field: (target) => {
      if (target && !fields.includes(target)) fields.push(target)
    },
    focused: (target) => {
      last = target
    },
  }
}
