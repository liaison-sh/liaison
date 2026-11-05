// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A beat that pointed into a dialog (a document's Share dialog) closes it
 * when the person moves on. Nothing on the next step tells them to close it,
 * and a modal dialog left open covers what that step points at, so it is
 * never ringed. The next beat keeps the dialog when its own anchor is inside
 * the same dialog (a walk through the dialog's controls).
 */
import { resolveVisibleAnchor } from "./visible-anchor"

/**
 * Close the dialog `leftAnchor` sat in, unless `nextAnchor` is inside it too.
 * Closes the way a person would (Escape), so the dialog's own close handling
 * runs and only the topmost layer goes. Returns whether a dialog was closed.
 */
export function putAwayDialogLeftBehind(
  leftAnchor: string | undefined,
  nextAnchor: string | undefined,
  root: Document = document,
): boolean {
  if (!leftAnchor) return false
  const dialog = resolveVisibleAnchor(leftAnchor, root)?.closest<HTMLElement>('[role="dialog"]')
  if (!dialog) return false
  const next = nextAnchor ? resolveVisibleAnchor(nextAnchor, root) : null
  if (next && dialog.contains(next)) return false
  dialog.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  )
  return true
}
