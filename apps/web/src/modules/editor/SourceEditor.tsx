// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A page whose stored text the rich editor would not write back byte for byte
// (RichEditorHandle.roundTrips false) is edited as that text, in a plain textarea
// with the same handle, so editing one line never rewrites the rest.
import { replaceFileIds } from "@liaison/shared"
import { type Component, createEffect, on, onMount } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { RichEditorHandle, TextRange } from "./RichEditor"

export interface SourceEditorProps {
  value: string
  onChange?: (markdown: string) => void
  onEdit?: () => void
  disabled?: boolean
  ref?: (handle: RichEditorHandle) => void
  class?: string
  "data-testid"?: string
}

export const SourceEditor: Component<SourceEditorProps> = (props) => {
  const i18n = useI18n()
  let area!: HTMLTextAreaElement
  let emitted = props.value

  /** A newer text from elsewhere: the caret keeps its offset from the nearer end. */
  const applyRemote = (markdown: string) => {
    const { selectionStart, selectionEnd, value } = area
    const tail = value.length - selectionEnd
    area.value = markdown
    emitted = markdown
    const fromEnd = selectionStart > value.length / 2
    const start = fromEnd
      ? Math.max(0, markdown.length - (value.length - selectionStart))
      : selectionStart
    const end = fromEnd
      ? Math.max(start, markdown.length - tail)
      : Math.min(selectionEnd, markdown.length)
    area.setSelectionRange(Math.min(start, markdown.length), end)
  }

  onMount(() => {
    area.value = props.value
    const insertAt = (range: TextRange, text: string): TextRange => {
      area.setRangeText(text, range.from, range.to, "end")
      area.dispatchEvent(new Event("input", { bubbles: true }))
      return { from: range.from, to: range.from + text.length }
    }
    props.ref?.({
      element: area,
      focus: () => area.focus(),
      insertText: (text) => insertAt({ from: area.value.length, to: area.value.length }, text),
      insert: (text) => insertAt({ from: area.selectionStart, to: area.selectionEnd }, text),
      insertMarkdown: (text) =>
        insertAt({ from: area.selectionStart, to: area.selectionEnd }, text),
      appendMarkdown: (text) =>
        insertAt({ from: area.value.length, to: area.value.length }, `\n\n${text}`),
      mention: (chip) =>
        insertAt(
          { from: area.selectionStart, to: area.selectionEnd },
          `@[${chip.label}](${chip.ref}) `,
        ),
      anchor: () => {
        const range = { from: area.selectionStart, to: area.selectionEnd }
        return { range: () => range, release: () => {} }
      },
      replaceText: insertAt,
      tint: () => {},
      markdown: () => area.value,
      roundTrips: true,
      applyRemote,
      // The text as written: a file goes in through the page's Attachments.
      insertFiles: () => {},
      replaceFileIds: (map) => {
        const next = replaceFileIds(area.value, map)
        if (next === area.value) return
        const { selectionStart, selectionEnd } = area
        area.value = next
        emitted = next
        area.setSelectionRange(selectionStart, selectionEnd)
      },
    })
  })

  createEffect(
    on(
      () => props.value,
      (value) => {
        if (value !== emitted) applyRemote(value)
      },
      { defer: true },
    ),
  )

  return (
    <textarea
      ref={area}
      class={cn(
        "min-h-64 w-full resize-y bg-transparent font-mono text-sm outline-none",
        props.class,
      )}
      aria-label={i18n.t("kernel.editor.sourceEditor")}
      spellcheck
      disabled={props.disabled}
      data-testid={props["data-testid"]}
      onInput={() => {
        emitted = area.value
        props.onEdit?.()
        props.onChange?.(area.value)
      }}
    />
  )
}

export default SourceEditor
