// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DICTATION RECORDER, ONE FOR EVERY COMPOSER. Idle, a surface shows the
// mic immediately left of its Send (`DictationMic`). While a take records or
// transcribes, the surface's whole control row gives way to ONE line
// (`RecorderRow` swaps them): discard, a pulsing red dot and the timer, a
// live waveform drawn from the same level the speech gate reads, and
// stop-and-insert where Send was. Transcribing freezes the waveform dimmed
// under a sweep, and Send stays out until the text is in. A take that heard
// no speech says so for a moment in the waveform's place, the line keeping
// its geometry (stop disabled); an error stays in the line with a dismiss.
// The only red is the dot and the stop button.
//
// Focus follows the take: the stop button takes it when recording starts,
// the field gets it back when the text lands or the take is dropped. Escape
// drops the take.
import { Check, Mic, Trash2, X } from "lucide-solid"
import {
  type Component,
  createEffect,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { DictationTarget } from "./dictation-insert"
import { micPlatform } from "./dictation-platform"
import { MAX_RECORDING_MS } from "./dictation-recorder"
import { type Dictation, type DictationErrorKind, useDictation } from "./useDictation"

/** From here the timer turns red: 15 seconds before the take stops by itself. */
export const TIMER_WARN_MS = MAX_RECORDING_MS - 15_000

export const DICTATION_ICON_CLASS =
  "inline-flex items-center justify-center rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"

const ERROR_KEYS: Record<Exclude<DictationErrorKind, "permission">, string> = {
  no_device: "kernel.dictation.errors.noDevice",
  network: "kernel.dictation.errors.network",
  empty: "kernel.dictation.errors.empty",
  no_speech: "kernel.dictation.errors.noSpeech",
  rate_limited: "kernel.dictation.errors.rateLimited",
  too_large: "kernel.dictation.errors.tooLarge",
  credits: "kernel.dictation.errors.credits",
  demo_key: "kernel.dictation.errors.demoKey",
  demo_verify: "kernel.demo.refusal.demo_verification_required",
  failed: "kernel.dictation.errors.failed",
}

/** A notice, not a failure: it goes by itself and carries no dismiss. */
const BRIEF: ReadonlySet<DictationErrorKind> = new Set(["no_speech", "empty"])

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

/** Keep the editor's caret and focus when a control is pressed. */
const keep = (e: MouseEvent) => e.preventDefault()

/** The mic, idle: starts a take. Sits immediately left of the surface's Send. */
export const DictationMic: Component<{
  dictation: Dictation
  disabled?: boolean
  class?: string
  iconSize?: number
  /** The conversation whose composer it sits in, as `data-thread-id` (a tour rings that one's mic). */
  threadId?: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={props.dictation.available()}>
      <button
        type="button"
        data-testid="voice-dictation-button"
        data-thread-id={props.threadId}
        aria-label={i18n.t("kernel.dictation.start")}
        title={i18n.t("kernel.dictation.start")}
        disabled={props.disabled || props.dictation.shown()}
        onMouseDown={keep}
        onClick={() => void props.dictation.start()}
        class={cn(DICTATION_ICON_CLASS, props.class)}
      >
        <Mic size={props.iconSize ?? 16} aria-hidden="true" />
      </button>
    </Show>
  )
}

/**
 * A surface's control row, or the recorder line in its place. The row's own
 * controls stay mounted (hidden), so nothing in them loses its state.
 */
export const RecorderRow: Component<{
  dictation: Dictation
  /** `phone`: round controls and the timer and waveform in a pill (the phone composer). */
  variant?: "row" | "phone"
  /** Classes for the recorder line (a row that does not stretch gives it a width). */
  barClass?: string
  children: JSX.Element
}> = (props) => (
  <>
    <div class="contents" data-recorder-row hidden={props.dictation.shown()}>
      {props.children}
    </div>
    <Show when={props.dictation.shown()}>
      <RecorderBar dictation={props.dictation} variant={props.variant} class={props.barClass} />
    </Show>
  </>
)

/**
 * THE PHONE'S INPUT LINE BECOMES THE RECORDER (D20, variant A): while a take
 * runs, the field it wraps folds away and the recorder line is the whole
 * composer. The field stays mounted, its text and history kept, and comes back
 * before the text lands, so the insert and the focus go to it. `when` false
 * (desktop) leaves the field in view above the recorder row.
 */
export const RecorderFold: Component<{
  dictation: Dictation
  when: boolean
  children: JSX.Element
}> = (props) => (
  <div class="contents" data-recorder-fold hidden={props.when && props.dictation.shown()}>
    {props.children}
  </div>
)

/**
 * A take for a field that lives in a narrower scope than its surface (one
 * edited note in a list, a draft card): the take lasts as long as that scope.
 */
export const WithDictation: Component<{
  target: () => DictationTarget | undefined
  onActiveChange?: (active: boolean) => void
  children: (dictation: Dictation) => JSX.Element
}> = (props) => {
  const dictation = useDictation({
    target: () => props.target(),
    onActiveChange: (active) => props.onActiveChange?.(active),
  })
  return <>{props.children(dictation)}</>
}

/** The recorder line itself (RecorderRow draws it in place of the row). */
export const RecorderBar: Component<{
  dictation: Dictation
  variant?: "row" | "phone"
  class?: string
}> = (props) => {
  const i18n = useI18n()
  const d = props.dictation
  const phone = () => props.variant === "phone"
  let stopButton: HTMLButtonElement | undefined

  const active = () => {
    const s = d.status()
    return s === "requesting" || s === "recording" || s === "transcribing"
  }

  const message = (): string | null => {
    const kind = d.error()
    if (!kind) return null
    if (kind === "permission") return i18n.t(`kernel.dictation.errors.permission.${micPlatform()}`)
    return i18n.t(ERROR_KEYS[kind])
  }

  const discard = () => {
    d.cancel()
    d.focusTarget()
  }

  const dismiss = () => {
    d.dismiss()
    d.focusTarget()
  }

  // The stop button takes the focus when recording starts.
  createEffect(
    on(d.status, (s) => {
      if (s === "recording") stopButton?.focus()
    }),
  )

  // Escape drops the take (or clears the message), before any dialog round
  // the composer closes on it.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (active()) discard()
      else if (d.error()) dismiss()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener("keydown", onKey, true)
    onCleanup(() => document.removeEventListener("keydown", onKey, true))
  })

  const roundButton = () => (phone() ? "h-9 w-9 rounded-full" : "h-[30px] w-[30px] rounded-lg")

  const discardButton = (): JSX.Element => (
    <button
      type="button"
      data-testid="voice-dictation-discard"
      aria-label={i18n.t("kernel.dictation.discard")}
      title={i18n.t("kernel.dictation.discard")}
      onMouseDown={keep}
      onClick={() => (brief() ? dismiss() : discard())}
      class={cn(
        "flex shrink-0 items-center justify-center text-text-secondary transition-colors hover:bg-surface-hover hover:text-text",
        roundButton(),
      )}
    >
      <Trash2 size={phone() ? 18 : 16} aria-hidden="true" />
    </button>
  )

  const label = (): string =>
    d.status() === "requesting"
      ? i18n.t("kernel.dictation.requesting")
      : d.autoStopped()
        ? i18n.t("kernel.dictation.autoStopped")
        : i18n.t("kernel.dictation.transcribing")

  /** A notice the line says in place of the waveform, keeping the take's geometry. */
  const brief = () => {
    const kind = d.error()
    return kind !== null && BRIEF.has(kind)
  }

  /** Dot and timer while recording (kept, stopped, for a notice), else what the
   *  take is waiting on; then the waveform, or the notice in its place. */
  const take = (): JSX.Element => (
    <>
      <Show
        when={d.status() === "recording" || brief()}
        fallback={
          <span
            data-testid="voice-dictation-label"
            aria-live="polite"
            class="min-w-0 shrink truncate text-[12.5px] text-text-secondary"
          >
            {label()}
          </span>
        }
      >
        <span
          aria-hidden="true"
          data-testid="voice-dictation-dot"
          class={cn(
            "h-2 w-2 shrink-0 rounded-full",
            brief() ? "bg-text-tertiary" : "recorder-dot bg-danger",
          )}
        />
        <span
          data-testid="voice-dictation-elapsed"
          data-warn={d.elapsedMs() >= TIMER_WARN_MS ? "" : undefined}
          class={cn(
            "min-w-[34px] shrink-0 font-mono text-[12.5px] tabular-nums",
            d.elapsedMs() >= TIMER_WARN_MS ? "text-danger" : "text-text",
          )}
        >
          {formatElapsed(d.elapsedMs())}
        </span>
      </Show>
      <Show
        when={!brief()}
        fallback={
          <span
            role="status"
            data-testid="voice-dictation-note"
            data-kind={d.error() ?? undefined}
            class="flex h-[26px] min-w-0 flex-1 items-center truncate px-1 text-[12.5px] text-text-secondary"
          >
            {message()}
          </span>
        }
      >
        <div
          aria-hidden="true"
          class={cn(
            "flex h-[26px] min-w-0 flex-1",
            d.status() === "transcribing" && "recorder-shimmer",
          )}
        >
          <Waveform level={d.level} live={() => d.status() === "recording"} />
        </div>
      </Show>
    </>
  )

  const endButton = (): JSX.Element => (
    <Switch
      fallback={
        // Send's place, kept while the text is on its way: nothing to press.
        <button
          type="button"
          disabled
          data-testid="voice-dictation-pending"
          aria-label={label()}
          class={cn(
            "flex shrink-0 items-center justify-center bg-surface-active text-text-tertiary",
            roundButton(),
          )}
        >
          <Check size={phone() ? 18 : 16} aria-hidden="true" />
        </button>
      }
    >
      <Match when={d.status() === "recording" || brief()}>
        {/* Disabled under a notice: it keeps its place, nothing to stop. */}
        <button
          ref={stopButton}
          type="button"
          data-testid="voice-dictation-stop"
          aria-label={i18n.t("kernel.dictation.stop")}
          title={i18n.t("kernel.dictation.stop")}
          disabled={brief()}
          onMouseDown={keep}
          onClick={() => void d.stop()}
          class={cn(
            "flex shrink-0 items-center justify-center bg-danger text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100",
            roundButton(),
          )}
        >
          <Check size={phone() ? 18 : 16} stroke-width={2.4} aria-hidden="true" />
        </button>
      </Match>
    </Switch>
  )

  return (
    <fieldset
      aria-label={i18n.t("kernel.dictation.recorder")}
      data-testid="voice-dictation-recorder"
      data-state={d.status()}
      class={cn(
        "m-0 flex min-w-0 flex-1 basis-full items-center border-0 p-0",
        phone() ? "min-h-10 gap-1.5" : "min-h-[30px] gap-2",
        props.class,
      )}
    >
      <Show
        when={active() || brief()}
        fallback={
          <>
            <span
              role="status"
              data-testid="voice-dictation-note"
              data-kind={d.error() ?? undefined}
              class="min-w-0 flex-1 px-1 text-[12.5px] leading-snug text-text-secondary"
            >
              {message()}
            </span>
            <Show when={d.error()}>
              <button
                type="button"
                data-testid="voice-dictation-dismiss"
                aria-label={i18n.t("kernel.dictation.dismiss")}
                title={i18n.t("kernel.dictation.dismiss")}
                onMouseDown={keep}
                onClick={dismiss}
                class={cn(
                  "flex shrink-0 items-center justify-center text-text-secondary transition-colors hover:bg-surface-hover hover:text-text",
                  roundButton(),
                )}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Show>
          </>
        }
      >
        {discardButton()}
        <Show
          when={phone()}
          fallback={
            <div data-recorder-slot class="flex min-w-0 flex-1 items-center gap-2">
              {take()}
            </div>
          }
        >
          <div
            data-recorder-slot
            class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-surface px-2.5"
          >
            {take()}
          </div>
        </Show>
        {endButton()}
      </Show>
    </fieldset>
  )
}

/** One bar per sample, newest at the right. */
const BAR_PX = 2.5
const GAP_PX = 2
/** A sample every 70 ms: the bars scroll in at a speaking pace. */
const SAMPLE_MS = 70
const MAX_SAMPLES = 600

/**
 * The bars a canvas `count` bars wide shows of `history` (0..1 levels):
 * the newest at the right, and `null` for the slots no sample reached yet.
 */
export function waveformBars(history: readonly number[], count: number): Array<number | null> {
  const bars: Array<number | null> = []
  for (let i = 0; i < count; i++) {
    const at = history.length - count + i
    bars.push(at >= 0 ? (history[at] ?? 0) : null)
  }
  return bars
}

/**
 * The live waveform: the take's level, sampled while it records and drawn as
 * rounded bars in the theme's colours. It holds still once recording ends
 * (the take is transcribed). Draws nothing where the engine has no 2D canvas.
 */
const Waveform: Component<{ level: () => number; live: () => boolean }> = (props) => {
  let canvas: HTMLCanvasElement | undefined
  const history: number[] = []
  onMount(() => {
    if (!canvas || typeof CanvasRenderingContext2D === "undefined") return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const el = canvas
    let last = 0
    let frame = 0
    const paint = () => {
      const ratio = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(el.clientWidth * ratio))
      const height = Math.max(1, Math.round(el.clientHeight * ratio))
      if (el.width !== width) el.width = width
      if (el.height !== height) el.height = height
      const style = getComputedStyle(el)
      const live = props.live()
      const bright = style.getPropertyValue("--color-accent").trim() || "#4a5468"
      const dim = style.getPropertyValue("--color-border-strong").trim() || "#cdcdd5"
      ctx.clearRect(0, 0, width, height)
      const bar = BAR_PX * ratio
      const step = bar + GAP_PX * ratio
      const bars = waveformBars(history, Math.floor(width / step))
      bars.forEach((level, i) => {
        const h = Math.max(2 * ratio, (level ?? 0.04) * (height - 2 * ratio))
        ctx.fillStyle = live && level !== null ? bright : dim
        ctx.beginPath()
        if (typeof ctx.roundRect === "function")
          ctx.roundRect(i * step, (height - h) / 2, bar, h, bar / 2)
        else ctx.rect(i * step, (height - h) / 2, bar, h)
        ctx.fill()
      })
    }
    const tick = (now: number) => {
      if (props.live() && now - last >= SAMPLE_MS) {
        history.push(props.level())
        if (history.length > MAX_SAMPLES) history.shift()
        last = now
      }
      paint()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(frame))
  })
  return (
    <canvas
      ref={canvas}
      data-testid="voice-dictation-waveform"
      class="block h-full w-full min-w-0"
    />
  )
}
