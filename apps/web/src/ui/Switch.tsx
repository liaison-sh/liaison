// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The on/off track-and-thumb switch, as one primitive.
//
// It exists because the control was copied into two settings screens and both
// copies were silently broken at the touch tiers: `index.css` gives every
// button at tablet and phone a 44px hit floor, so a 24x44 track inflated to
// 44x44, went square and let the thumb ride out past its own right edge.
//
// The floor is right and the switch is the documented exception to it, so the
// exception is written down ONCE, here: the track carries `data-touch-dense`
// and keeps its real size, and the enclosing ROW is what carries the 44px tap
// area (`min-h-11`), which is the phone idiom anyway: you tap the line, not
// the little track at the end of it.
//
// It is a button rather than a Kobalte `Switch`, whose hidden checkbox input
// is itself matched by that same tier floor: the wrapper would have to opt the
// input out too, for a control whose whole markup is a track and a thumb.
import { type Component, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

interface SwitchProps {
  /** Whether the switch is on. */
  checked: boolean
  /** Called with the value the switch is moving TO. */
  onChange: (next: boolean) => void
  /** Accessible name. The visible label usually lives in the enclosing row. */
  label: string
  disabled?: boolean
  class?: string
  "data-testid"?: string
}

export const Switch: Component<SwitchProps> = (props) => {
  const [local, others] = splitProps(props, ["checked", "onChange", "label", "class"])

  return (
    <button
      type="button"
      role="switch"
      // The touch-density exception: see the note at the top of this file.
      data-touch-dense
      aria-checked={local.checked}
      // The CLASS is what paints the track, but a class list is not a contract
      // a test can hold: `data-checked` states the on/off state in the markup
      // so the accent is asserted on a stable hook rather than on Tailwind.
      data-checked={local.checked ? "" : undefined}
      aria-label={local.label}
      onClick={() => local.onChange(!local.checked)}
      class={cn(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // On/off has to be readable from across the row, at both densities.
        // `bg-accent-glow` is a 10% wash of the accent over the surface, so the
        // checked track was all but indistinguishable from the unchecked one and
        // only the thumb travel told you the state: a gestalt walk read the row
        // wrong at phone width, where the track is the same 24px but the row is
        // further from the eye. The checked track takes the FULL accent.
        local.checked ? "border-accent bg-accent" : "border-border bg-bg",
        local.class,
      )}
      {...others}
    >
      <span
        data-switch-thumb
        // `left-0` is load bearing. With `left: auto` the thumb starts from its
        // STATIC position, and a button's UA `text-align: center` puts that in
        // the middle of the track: the travel was then measured from the centre
        // and the thumb rode out past the track's right edge in the on state.
        class={cn(
          "absolute left-0 top-0.5 h-4.5 w-4.5 rounded-full transition-transform duration-150",
          // A `bg-text` thumb on a full-accent track is two pale greys touching.
          // The checked thumb takes the accent's own foreground, the token that
          // exists for exactly this: anything painted ON --color-accent.
          local.checked ? "bg-accent-foreground" : "bg-text",
          local.checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  )
}
