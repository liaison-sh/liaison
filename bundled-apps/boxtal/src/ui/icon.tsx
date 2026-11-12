// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BoxtalAppIcon — activity-bar icon. Inline SVG (no lucide-solid dep), stroke
// 1.5 currentColor to match the kernel's icon set. A parcel/box mark reads as
// "shipment" without carrier-specific iconography.
import { type Component, Show } from "solid-js"
import { carrierDisplay, MARK_HEIGHT } from "./carrier-mark"
import { cx } from "./kit"

export const BoxtalAppIcon: Component<{ size?: number }> = (props) => {
  const s = props.size ?? 16
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.27 6.96 8.73 5.05 8.73-5.05" />
      <path d="M12 22.08V12" />
    </svg>
  )
}

// PrinterIcon — the Label control's glyph in the prep grid's Actions cell. The
// word "Label" was worth ~30px of an already overcrowded sticky Actions cell
// (238.5px at 1440x900 with the agent panel open, which is what pushed the
// Document column under it), and Label is the one action of the three an
// operator does not hunt for by name: it follows a Ship. Same 1.5-stroke
// currentColor family as the app icon. The wording lives on title + aria-label.
export const PrinterIcon: Component<{ size?: number }> = (props) => {
  const s = props.size ?? 14
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      <path d="M6 14h12v7H6z" />
    </svg>
  )
}

// CarrierLogo -- the COLLAPSED carrier/offer control in the prep grid's total
// cell. At rest the chosen offer's carrier is its WORDMARK alone, not the
// carrier spelled out plus a 140px dropdown: those two together were what set
// the Total column's width, and Total is one of the columns that must fit
// before the sticky Actions cell.
//
// The mark is the carrier's NAME in the carrier's colours on the carrier's
// ground (carrier-mark.ts), drawn as inline SVG (the app is sandboxed: no image
// URL, no fetch). It is a wordmark, not an abbreviation: `CHR` on a coloured
// badge was less recognisable than "Chronopost", which is the whole point of a
// logo. `textLength` + `lengthAdjust="spacingAndGlyphs"` condense the name to
// the mark's DECLARED width, so the column's cost is a fact independent of the
// platform font's metrics, and the oracle can assert the cap from data.
//
// It ALWAYS carries its carrier's name on `<title>` + `aria-label` -- an icon
// with no accessible name is a finding, not a fix. A carrier belonging to no
// known brand has no mark and renders its short text name instead, so nothing
// on the row is ever unnamable.
export const CarrierLogo: Component<{ carrier: string; height?: number; class?: string }> = (
  props,
) => {
  const d = () => carrierDisplay(props.carrier)
  const h = () => props.height ?? MARK_HEIGHT
  const scale = () => h() / MARK_HEIGHT
  return (
    <Show
      when={d().mark}
      fallback={
        <span class={cx("text-[11px] text-text-tertiary", props.class)} title={d().name}>
          {d().name}
        </span>
      }
    >
      {(mark) => (
        <svg
          class={props.class}
          width={mark().width * scale()}
          height={h()}
          viewBox={`0 0 ${mark().width} ${MARK_HEIGHT}`}
          role="img"
          aria-label={mark().name}
        >
          <title>{mark().name}</title>
          <rect
            x="0.25"
            y="0.25"
            width={mark().width - 0.5}
            height={MARK_HEIGHT - 0.5}
            rx="2"
            fill={mark().bg}
            stroke="rgba(0,0,0,0.25)"
            stroke-width="0.5"
          />
          <text
            x={mark().width / 2}
            y="10.1"
            text-anchor="middle"
            textLength={mark().width - 6}
            lengthAdjust="spacingAndGlyphs"
            font-size="8"
            font-weight="700"
            font-family="system-ui, sans-serif"
            fill={mark().fg}
          >
            {mark().text}
            <Show when={mark().text2}>
              {(second) => <tspan fill={mark().fg2 ?? mark().fg}>{second()}</tspan>}
            </Show>
          </text>
        </svg>
      )}
    </Show>
  )
}

// CaretIcon -- the "this opens something" mark on the collapsed carrier control.
//
// The offer picker is a transparent native <select> laid over the carrier's wordmark, which cost
// the row nothing but also gave it NO affordance: no caret, no border, no hover cue, so the owner
// read the wordmark as a static logo ("need some kind of down arrow or some shit", 2026-09-08).
// This is that arrow. It is `aria-hidden` and carries no role: the accessible name of the control
// is the <select>'s own aria-label, and the wordmark keeps `role="img"` plus its carrier name, so
// the grid's oracle still finds exactly one named mark per estimate cell.
export const CaretIcon: Component<{ size?: number; class?: string }> = (props) => {
  const s = props.size ?? 8
  return (
    <svg
      class={props.class}
      width={s}
      height={s}
      viewBox="0 0 8 8"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 3 4 5.5 6.5 3" />
    </svg>
  )
}
