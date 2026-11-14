// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the Help tab shows: the page (and anchor) open in it and the search
 * query. Shared by the tab and its sidebar, so a page picked in either shows in
 * the tab and stays lit in the nav.
 */
import { createSignal } from "solid-js"
import { openTab } from "~/modules/shell/tab-store"
import type { HelpTarget } from "./help-docs"

export const HELP_TAB_TYPE = "kernel:help"

const [helpTarget, setHelpTarget] = createSignal<HelpTarget>({ url: "", hash: "" })
const [helpQuery, setHelpQuery] = createSignal("")
/** Bumped on every navigation, so going to the anchor already shown scrolls again. */
const [helpNavSeq, setHelpNavSeq] = createSignal(0)

export { helpNavSeq, helpQuery, helpTarget, setHelpQuery }

/** Shows a page in the Help tab (the tab need not be open). */
export function showHelpPage(target: HelpTarget): void {
  setHelpTarget(target)
  setHelpNavSeq((n) => n + 1)
}

/** Opens the Help tab, on `target` when given (else where it was). */
export function openHelp(target?: HelpTarget, label = "Help"): void {
  if (target) showHelpPage(target)
  openTab({ type: HELP_TAB_TYPE, entityId: "help", label, preview: false })
}
