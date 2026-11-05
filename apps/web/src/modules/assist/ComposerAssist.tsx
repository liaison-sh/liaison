// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE MAGIC WAND OF A COMPOSER, with the formatting and tools buttons of the
// surface's control row. The dictation mic is NOT here: it sits immediately
// left of the surface's Send (RecorderBar.tsx `DictationMic`), and the row
// gives way to the recorder line while a take runs (`RecorderRow`).
import type { Component } from "solid-js"
import { type DictationTarget, targetElement } from "./dictation-insert"
import { MagicWandButton } from "./MagicWandButton"
import type { ProofreadFormat } from "./types"

function isField(t: DictationTarget): t is HTMLTextAreaElement | HTMLInputElement {
  return t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement
}

export const ComposerAssist: Component<{
  /** The field written in: a textarea, or the RichEditor's handle. */
  target: () => DictationTarget | undefined
  /** What the wand proofreads; a rich editor's markup by default, a field's text. */
  kind?: ProofreadFormat
  disabled?: boolean
  /** Classes for the button, to match the row's own icon buttons. */
  class?: string
  iconSize?: number
}> = (props) => {
  const kind = (): ProofreadFormat => {
    if (props.kind) return props.kind
    const t = props.target()
    return t && isField(t) ? "text" : "html"
  }
  return (
    <MagicWandButton
      getEl={() => {
        const t = props.target()
        return t ? targetElement(t) : undefined
      }}
      kind={kind()}
      disabled={props.disabled}
      class={props.class}
      iconSize={props.iconSize}
    />
  )
}
