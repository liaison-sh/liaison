// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ProofreadFormat } from "./types"

type Editable = HTMLTextAreaElement | HTMLInputElement | HTMLElement

/**
 * A region to proofread, snapshotted at click time. The correction is applied
 * back over THIS captured region — not whatever the live selection happens to
 * be after the async LLM call — so a caret/selection move during the call (the
 * rich contentEditable surfaces stay editable) can't misplace the replacement.
 */
export interface WandTarget {
  el: Editable
  kind: ProofreadFormat
  region:
    | { type: "textarea"; start: number; end: number }
    | { type: "range"; range: Range }
    | { type: "all" }
}

function isTextField(el: Editable): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
}

/** Read the proofread target: the selection if any, else the whole input. */
export function readTarget(
  el: Editable,
  kind: ProofreadFormat,
): { text: string; format: ProofreadFormat; target: WandTarget } {
  if (isTextField(el)) {
    const { selectionStart, selectionEnd, value } = el
    const hasSel = selectionStart != null && selectionEnd != null && selectionStart !== selectionEnd
    const start = hasSel ? selectionStart : 0
    const end = hasSel ? selectionEnd : value.length
    return {
      text: value.slice(start, end),
      format: "text",
      target: { el, kind: "text", region: { type: "textarea", start, end } },
    }
  }
  const sel = window.getSelection()
  const hasSel = !!sel && !sel.isCollapsed && sel.rangeCount > 0 && el.contains(sel.anchorNode)
  if (hasSel) {
    const range = sel.getRangeAt(0)
    let text: string
    if (kind === "html") {
      const holder = document.createElement("div")
      holder.appendChild(range.cloneContents())
      text = holder.innerHTML
    } else {
      text = sel.toString()
    }
    return {
      text,
      format: kind,
      // cloneRange() snapshots the boundaries so a later caret move is ignored.
      target: { el, kind, region: { type: "range", range: range.cloneRange() } },
    }
  }
  return {
    text: kind === "html" ? el.innerHTML : (el.textContent ?? ""),
    format: kind,
    target: { el, kind, region: { type: "all" } },
  }
}

/**
 * Write the correction back over the captured region, preserving the browser's
 * native undo stack (execCommand). Restores the snapshotted selection first.
 */
export function applyCorrection(target: WandTarget, corrected: string): void {
  const { el, kind, region } = target
  el.focus()
  if (region.type === "textarea" && isTextField(el)) {
    el.setSelectionRange(region.start, region.end)
    document.execCommand("insertText", false, corrected)
    return
  }
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    if (region.type === "range") {
      sel.addRange(region.range)
    } else {
      const whole = document.createRange()
      whole.selectNodeContents(el)
      sel.addRange(whole)
    }
  }
  document.execCommand(kind === "html" ? "insertHTML" : "insertText", false, corrected)
}
