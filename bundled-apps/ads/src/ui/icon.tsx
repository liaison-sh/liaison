// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MetaAdsIcon — activity-bar icon. Inline SVG (no lucide-solid dep), stroke
// 1.5 currentColor to match the kernel icon set. A rising bar chart reads as
// "ads / performance" without platform-specific iconography.
import type { Component } from "solid-js"

export const MetaAdsIcon: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 16
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {/* Bar chart rising — universally reads as "ads performance / analytics" */}
      <rect x="3" y="12" width="4" height="9" rx="1" />
      <rect x="10" y="7" width="4" height="14" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
      {/* Trend line over the bars */}
      <polyline points="5,12 12,7 19,3" />
    </svg>
  )
}
