// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A36's density, as ONE constant.
//
// Two variants were captured and judged before any code landed (the mock at
// impl/ws06d-sidebar-mock.md): "slack", 32 px rows with a 24 px avatar on a
// person, and "slack-dense", 28 px rows with a presence dot instead. Which one
// ships is a taste call that is still open, so the row and every glyph inside
// it read their sizes from here rather than carrying literals. Flipping
// SIDEBAR_DENSITY flips the sidebar; nothing else has to move.
//
// The pixel proof of either variant is the driven walk, not a jsdom class
// assertion: the tests below and in HomeSidebar.slack.test.tsx pin that the
// row takes its height class FROM this table and that the two rows differ.

export type SidebarDensity = "slack" | "slack-dense"

/** The judged default: changing this line is the whole change. */
export const SIDEBAR_DENSITY: SidebarDensity = "slack"

export interface SidebarMetrics {
  /** Row height utility. h-8 = 32 px (A), h-7 = 28 px (B). */
  row: string
  /** The conversation name's type step. */
  name: string
  /** Lucide size for the hash / lock / pin / bell glyphs, in px. */
  glyph: number
  /** A person is an avatar in A, a presence dot in B. */
  person: "avatar" | "dot"
  /** The agent mark's box. Classes rather than an inline font size: the phone
   *  tier's 16 px floor is a `:root :is(...)` rule that outranks a utility but
   *  not an inline style (styles/ios-zoom-floor.test.ts sweeps for those). */
  agentMark: string
  /** Section header block padding. */
  headerPad: string
}

export const SIDEBAR_METRICS: Record<SidebarDensity, SidebarMetrics> = {
  slack: {
    row: "h-8",
    name: "text-[13.5px]",
    glyph: 14,
    person: "avatar",
    agentMark: "h-6 w-6 text-[12px]",
    headerPad: "pt-3 pb-0.5",
  },
  "slack-dense": {
    row: "h-7",
    name: "text-[13px]",
    glyph: 13,
    person: "dot",
    agentMark: "text-[13px]",
    headerPad: "pt-2 pb-0",
  },
}

/** The metrics in force. Takes an explicit density only so a test can render
 *  the other variant without reaching into module internals. */
export function sidebarMetrics(density: SidebarDensity = SIDEBAR_DENSITY): SidebarMetrics {
  return SIDEBAR_METRICS[density]
}
