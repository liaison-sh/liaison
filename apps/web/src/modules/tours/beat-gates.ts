// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Beat gates: what the tour panel shows on a demo world beat that cannot run
 * yet (a `kernel:tour` frame's `gate`: `verify`, `budget` or `failed`). The
 * tours engine owns the slot and knows nothing of the demo: whoever owns a
 * gate's meaning registers its component here (the demo module registers the
 * email-code prompt, the budget notice and the Retry), and the panel renders
 * the one registered for the beat's current gate.
 *
 * A refused agent turn names its gate too (`registerTourRefusalGate`): when the
 * turn a beat waits on is refused before it ran (the demo's "confirm your
 * email"), the panel shows that gate instead of waiting for an answer that
 * will not come.
 *
 * Also the slot of the completion card's follow-up (`registerTourCompletedAction`):
 * the demo's scenario runner offers the next scenario there.
 */
import type { EffectiveBeat, Tour, TourBeatGate, TourProgress } from "@liaison/shared"
import type { Component } from "solid-js"
import { createSignal } from "solid-js"

export interface TourBeatGateProps {
  tour: Tour
  progress: TourProgress
  beat: EffectiveBeat
  gate: TourBeatGate
}

export interface TourCompletedActionProps {
  tour: Tour
  progress: TourProgress
}

const [gates, setGates] = createSignal<ReadonlyMap<TourBeatGate, Component<TourBeatGateProps>>>(
  new Map(),
)
const [completedAction, setCompletedAction] = createSignal<{
  component: Component<TourCompletedActionProps>
  holds?: (tour: Tour) => boolean
} | null>(null)

/**
 * Register the component the panel renders for `gate`. The latest registration
 * for a gate wins; the returned function removes it (only if it is still the
 * registered one).
 */
export function registerTourBeatGate(
  gate: TourBeatGate,
  component: Component<TourBeatGateProps>,
): () => void {
  setGates((prev) => new Map(prev).set(gate, component))
  return () =>
    setGates((prev) => {
      if (prev.get(gate) !== component) return prev
      const next = new Map(prev)
      next.delete(gate)
      return next
    })
}

/** The component registered for `gate`, if any (reactive). */
export function tourBeatGate(gate: TourBeatGate): Component<TourBeatGateProps> | undefined {
  return gates().get(gate)
}

/**
 * Register what the completion card offers after a tour (one slot; the latest
 * wins). `holds`: the card offers something for this tour (the next scenario),
 * so it stays until the person acts on it or closes it, instead of closing by
 * itself after a moment.
 */
export function registerTourCompletedAction(
  component: Component<TourCompletedActionProps>,
  holds?: (tour: Tour) => boolean,
): () => void {
  const entry = { component, holds }
  setCompletedAction(entry)
  return () => {
    if (completedAction() === entry) setCompletedAction(null)
  }
}

/** The completion card's follow-up, if one is registered (reactive). */
export function tourCompletedAction(): Component<TourCompletedActionProps> | null {
  return completedAction()?.component ?? null
}

/** The completion card of `tour` offers something next, so it stays until the person acts. */
export function tourCompletedCardHolds(tour: Tour): boolean {
  return completedAction()?.holds?.(tour) === true
}

const [refusalGates, setRefusalGates] = createSignal<ReadonlyMap<string, TourBeatGate>>(new Map())

/**
 * A refused agent turn whose refusal code is `code` (a conversation's refusal
 * line, `metadata.demoRefusal`) shows `gate` on the beat that waited on it.
 * The returned function removes the mapping (only if it is still this one).
 */
export function registerTourRefusalGate(code: string, gate: TourBeatGate): () => void {
  setRefusalGates((prev) => new Map(prev).set(code, gate))
  return () =>
    setRefusalGates((prev) => {
      if (prev.get(code) !== gate) return prev
      const next = new Map(prev)
      next.delete(code)
      return next
    })
}

/** The gate a refusal code names, if any. */
export function tourRefusalGate(code: string | null | undefined): TourBeatGate | null {
  return code ? (refusalGates().get(code) ?? null) : null
}
