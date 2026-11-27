// SPDX-License-Identifier: FSL-1.1-ALv2
// "Today" for the grids: a signal that moves to the next day at local midnight (and when the
// page comes back after a sleep), so a calendar tab left open overnight highlights the right day.
import { type Accessor, createSignal, onCleanup } from "solid-js"

function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Milliseconds from `now` until the next local midnight (plus a small margin). */
export function msUntilNextDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return next.getTime() - now.getTime() + 250
}

export function createToday(): Accessor<Date> {
  const [today, setToday] = createSignal(startOfToday())
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    const now = startOfToday()
    if (now.getTime() !== today().getTime()) setToday(now)
  }
  const schedule = () => {
    timer = setTimeout(() => {
      refresh()
      schedule()
    }, msUntilNextDay(new Date()))
  }
  schedule()
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh()
  }
  document.addEventListener("visibilitychange", onVisible)
  onCleanup(() => {
    if (timer) clearTimeout(timer)
    document.removeEventListener("visibilitychange", onVisible)
  })
  return today
}
