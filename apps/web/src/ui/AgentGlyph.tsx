// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's mark: a lightning bolt, drawn rather than typed.
//
// It used to be U+2726 BLACK FOUR POINTED STAR set in the app's font stack.
// WKWebView on iOS has no glyph for it in any of those faces, so every agent
// avatar on the phone was a dotted box with a question mark in it, right next
// to the AGENT badge. A character outside the guaranteed set is a character
// that renders on the machines we happen to test on; a path renders
// everywhere, scales with the text it sits in, and takes the colour around it.
// The bolt is the Agents app's own icon, so one mark now says "agent" in the
// activity bar, the avatars, the mention pills and the turn headers alike.
import type { Component } from "solid-js"

/** The bolt outline (the lucide `zap` shape), filled solid. */
export const AGENT_BOLT_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"

interface AgentGlyphProps {
  /** Any class the caller needs; the size follows the font size by default. */
  class?: string
}

/** The bolt, filled. `1em` so it sizes with its context. */
export const AgentGlyph: Component<AgentGlyphProps> = (props) => (
  <svg
    aria-hidden="true"
    data-agent-glyph
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="currentColor"
    class={props.class}
  >
    <path d={AGENT_BOLT_PATH} />
  </svg>
)

export default AgentGlyph
