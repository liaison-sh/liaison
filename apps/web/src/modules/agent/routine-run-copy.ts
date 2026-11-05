// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a run of a routine is named in its history: what started it and how its
// outcome is toned. Shared by the run history list and the run transcript.
import type { ChipTone } from "./Chip"
import type { RoutineRunRow } from "./routines-store"

type Translate = (key: string, params?: Record<string, string | number>) => string

const TRIGGER_KEYS: Record<string, string> = {
  schedule: "kernel.agentForms.runTriggerSchedule",
  event: "kernel.agentForms.runTriggerEvent",
  manual: "kernel.agentForms.runTriggerManual",
  retry: "kernel.agentForms.runTriggerRetry",
}

/** "Scheduled", "On event", "Run now" or "Retry" (the event reconciler fired it again). A run recorded before the trigger
 *  was kept reads its routine's own kind instead: an event routine only ever
 *  ran on an event or by hand, a scheduled one on its schedule or by hand, and
 *  the kind is the likelier of the two. Null only when neither is known. */
export function runTriggerLabel(
  t: Translate,
  run: Pick<RoutineRunRow, "trigger">,
  routineKind?: string | null,
): string | null {
  const trigger =
    run.trigger ?? (routineKind ? (routineKind === "event" ? "event" : "schedule") : null)
  const key = trigger ? TRIGGER_KEYS[trigger] : undefined
  return key ? t(key) : null
}

/** How long a run took, in the reader's locale: "12 s", "2 min 5 s". Null when
 *  the run did not record it (a skip, a node dispatch). */
export function formatRunDuration(ms: number | null | undefined, locale: string): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null
  const unit = (n: number, u: "second" | "minute" | "hour") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(n)
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return unit(totalSeconds, "second")
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60)
    return seconds
      ? `${unit(minutes, "minute")} ${unit(seconds, "second")}`
      : unit(minutes, "minute")
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour")
}

/** A failure stands out; a skip is muted; a run that did its work is plain. */
export function runTone(status: string): ChipTone {
  if (status === "failed") return "warn"
  if (status.startsWith("skipped_")) return "done"
  return "default"
}
