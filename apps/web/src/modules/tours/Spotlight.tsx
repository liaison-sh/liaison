// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Component } from "solid-js"
import type { AnchorBox } from "./anchor-tracker"

const PAD = 4
/** The ring's outline, drawn outside its box (`outline-2`). */
const OUTLINE = 2

/** How much the page dims around a spotlit element, or behind a step with none: calm, never black. */
export const TOUR_DIM = "rgb(0 0 0 / 0.3)"

/**
 * A ring around the beat's anchor and a soft dim around it. Purely visual:
 * `pointer-events: none`, so the app under it stays fully usable.
 */
export const Spotlight: Component<{ box: AnchorBox; testid: string }> = (props) => {
  // Padded around the element, but never past what it is seen through (the
  // chat window a streaming answer is in, the viewport): the ring and its
  // outline stay inside it.
  const rect = () => {
    const b = props.box
    let top = b.top - PAD
    let left = b.left - PAD
    let bottom = b.top + b.height + PAD
    let right = b.left + b.width + PAD
    const clip = b.clip
    if (clip) {
      top = Math.max(top, clip.top + OUTLINE)
      left = Math.max(left, clip.left + OUTLINE)
      bottom = Math.min(bottom, clip.bottom - OUTLINE)
      right = Math.min(right, clip.right - OUTLINE)
    }
    return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) }
  }
  return (
    <div
      data-testid="tour-spotlight"
      data-anchor={props.testid}
      aria-hidden="true"
      class="pointer-events-none fixed z-[55] rounded-md outline outline-2 outline-offset-0 outline-accent transition-[top,left,width,height] duration-150"
      style={{
        top: `${rect().top}px`,
        left: `${rect().left}px`,
        width: `${rect().width}px`,
        height: `${rect().height}px`,
        "box-shadow": `0 0 0 9999px ${TOUR_DIM}`,
      }}
    />
  )
}

/**
 * Behind a step with nothing on screen to point at (an end card, a step about
 * the whole screen, an element still coming): the page dims as it does around
 * a spotlit element, so the card reads as the thing to look at. Purely visual:
 * every press goes through to the app.
 */
export const TourScrim: Component = () => (
  <div
    data-testid="tour-scrim"
    aria-hidden="true"
    class="pointer-events-none fixed inset-0 z-[55] transition-opacity duration-150"
    style={{ background: TOUR_DIM }}
  />
)
