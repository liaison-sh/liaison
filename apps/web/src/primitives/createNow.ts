// SPDX-License-Identifier: FSL-1.1-ALv2
// A shared ticking time signal. Returns an accessor to `Date.now()` that
// updates every `intervalMs`. One interval per subscriber scope; cleared on
// owner disposal so hidden/unmounted components leak no timers.
//
// Use for relative-time labels ("1m ago") and clock-derived greetings so they
// stay truthful instead of freezing at their initial render value.
import { type Accessor, createSignal, onCleanup } from "solid-js"

export function createNow(intervalMs: number): Accessor<number> {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), intervalMs)
  onCleanup(() => clearInterval(timer))
  return now
}
