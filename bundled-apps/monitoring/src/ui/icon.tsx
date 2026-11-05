// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Activity-bar / tab icon — a 14px stroked pulse line (inline SVG, no icon
// dep), matching the boxtal/invoicing icon convention.
import type { Component } from "solid-js"

export const MonitoringAppIcon: Component<{ class?: string }> = (props) => (
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
    <path d="M1.5 8h3l1.5-4.5L9.5 12 11 8h3.5" />
  </svg>
)
