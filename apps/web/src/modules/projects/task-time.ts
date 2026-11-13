// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where a task's time went, from its status transitions: how long it has been
 * in its status, the time spent in each status (for the "Where the time went"
 * strip), a duration in short words ("6 d", "5 h", "0.5 d"), and the deadline an
 * automation keeps on it (a flow's wait step on this task: still waiting = the
 * deadline ahead, done because the status still held = the deadline passed).
 */
import type { FlowRunStep } from "~/modules/agent/flow/flow-model"
import type { Translate } from "~/modules/i18n/i18n-context"
import type { TaskTransition } from "./TaskStatusHistory"

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A duration in short words: minutes under an hour, hours under a day, else days. */
export function shortDuration(ms: number, t: Translate, locale: string): string {
  const fmt = (n: number, max: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: max }).format(n)
  if (ms < HOUR) return t("projects.taskTime.minutes", { n: fmt(Math.max(1, ms / 60_000), 0) })
  if (ms < DAY) return t("projects.taskTime.hours", { n: fmt(ms / HOUR, 0) })
  const days = ms / DAY
  return t("projects.taskTime.days", { n: fmt(days, days < 10 ? 1 : 0) })
}

export interface TimeSegment {
  statusId: string
  label: string | null
  ms: number
}

/**
 * Time per status, in the order the task first entered each: each transition starts a stay
 * that lasts until the next one (the last until now). Transitions come newest first.
 */
export function timeInStatuses(
  transitions: readonly TaskTransition[] | undefined,
  now: number = Date.now(),
): TimeSegment[] {
  const list = [...(transitions ?? [])].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  )
  const out: TimeSegment[] = []
  list.forEach((x, i) => {
    const start = new Date(x.at).getTime()
    const next = list[i + 1]
    const end = next ? new Date(next.at).getTime() : now
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    const ms = Math.max(0, end - start)
    const seg = out.find((s) => s.statusId === x.toStatusId)
    if (seg) seg.ms += ms
    else out.push({ statusId: x.toStatusId, label: x.toStatusLabel, ms })
  })
  return out
}

/** A flow run fired on this task, as GET /agent/routines/entity-runs serves it. */
export interface EntityRun {
  id: string
  routineId: string
  routineTitle: string
  ranAt: string
  status: string
  steps?: FlowRunStep[] | null
}

export type TaskDeadline =
  | { kind: "ahead"; at: string; routineTitle: string }
  | { kind: "passed"; at: string; routineTitle: string }

/**
 * The deadline an automation keeps on this task in its current status, or null when none
 * applies: the newest run since the task entered its status whose wait step waits (the
 * deadline ahead) or finished because the status still held (the deadline passed).
 */
export function taskDeadline(
  runs: readonly EntityRun[] | undefined,
  statusEnteredAt: string | null | undefined,
): TaskDeadline | null {
  const since = statusEnteredAt ? new Date(statusEnteredAt).getTime() : 0
  for (const run of runs ?? []) {
    if (new Date(run.ranAt).getTime() < since - 1000) continue
    for (const s of run.steps ?? []) {
      if (s.type && s.type !== "wait") continue
      const deadline = s.output?.deadline
      if (typeof deadline !== "string") continue
      if (s.state === "waiting") {
        return { kind: "ahead", at: deadline, routineTitle: run.routineTitle }
      }
      if (s.state === "done") {
        return { kind: "passed", at: s.endedAt ?? deadline, routineTitle: run.routineTitle }
      }
    }
  }
  return null
}
