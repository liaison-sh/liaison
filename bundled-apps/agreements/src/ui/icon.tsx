// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Activity-bar and tab icon: a 16px stroked page with a pen line (inline SVG, no icon
// dependency), the convention of the other bundled apps.
import type { Component } from "solid-js"

export const AgreementsAppIcon: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z" />
    <path d="M9.5 1.5V5H13" />
    <path d="M5.5 11.5c1-1.2 1.6-1.2 2.2 0s1.3 1.2 2.8-.5" />
  </svg>
)
