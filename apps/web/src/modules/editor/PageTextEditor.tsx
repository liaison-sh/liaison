// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The editor of a Knowledge page's text: the rich editor (document preset) when it
// writes the stored text back byte for byte, else the source editor. Decided once,
// when the page's text is first shown.
import { type Component, createSignal, Show } from "solid-js"
import { RichEditor, type RichEditorHandle, type RichEditorProps } from "./RichEditor"
import { SourceEditor } from "./SourceEditor"

export type PageTextEditorProps = Omit<RichEditorProps, "preset">

export const PageTextEditor: Component<PageTextEditorProps> = (props) => {
  const [source, setSource] = createSignal(false)
  return (
    <Show
      when={!source()}
      fallback={
        <SourceEditor
          value={props.value}
          onChange={props.onChange}
          onEdit={props.onEdit}
          disabled={props.disabled}
          ref={props.ref}
          class={props.editorClass}
          data-testid={props["data-testid"] ? `${props["data-testid"]}-source` : undefined}
        />
      }
    >
      <RichEditor
        {...props}
        preset="document"
        ref={(handle: RichEditorHandle) => {
          if (!handle.roundTrips) setSource(true)
          else props.ref?.(handle)
        }}
      />
    </Show>
  )
}

export default PageTextEditor
