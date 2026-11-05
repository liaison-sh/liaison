// SPDX-License-Identifier: FSL-1.1-ALv2
// Kept apart from EntityDiscussion.tsx so a page can size its rail without
// pulling the lazily loaded discussion (and its editor) into its own chunk.

/** A discussion rail's own bottom padding (the task and contact pages): its
 *  box sits above the dock's bar where that bar lies over the corner, with a
 *  little air. An open dock window is not reserved: it covers the box until
 *  the person collapses it. */
export const DISCUSSION_RAIL_BOTTOM_PAD =
  "max(1.5rem, calc(var(--shell-dock-strip, 0px) + 0.75rem))"
