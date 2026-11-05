// SPDX-License-Identifier: FSL-1.1-ALv2
// The editor is its own chunk: ProseMirror and the markdown parser load with
// the first module that uses it (on idle), not with the app. The boundary is
// local, so a field still loading never suspends the page around it.
//
// While the chunk is still on its way the field is a stand-in that takes the
// focus and the keys: it shows the field's text, typed keys are the field's
// edits at once (a surface's own placeholder, shown while its value is empty,
// sat over them), and no key reaches the app's shortcuts meanwhile ("n"
// opened a new message). The editor opens on that text when it arrives.
import { type Component, createSignal, lazy, Show, Suspense, splitProps, untrack } from "solid-js"
import { cn } from "~/lib/cn"
import type { RichEditorProps } from "./RichEditor"

export type {
  MentionQuery,
  RichEditorHandle,
  RichEditorProps,
  TextAnchor,
  TextRange,
} from "./RichEditor"

const LazyRichEditor = lazy(() => import("./RichEditor"))

if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1))
  idle(() => void LazyRichEditor.preload())
}

export const RichEditor: Component<RichEditorProps> = (props) => {
  const [local, rest] = splitProps(props, ["autofocus", "ref"])
  // The text the field opened with, and what was typed after it meanwhile.
  const opened = untrack(() => props.value)
  const [typed, setTyped] = createSignal("")
  const type = (next: string) => {
    setTyped(next)
    props.onChange?.(opened + next)
  }
  // Until a key is typed, the field's value as it is now (a late prefill).
  const shown = () => (typed() ? opened + typed() : props.value)
  let held = false

  const standIn = (
    // biome-ignore lint/a11y/noStaticElementInteractions: a placeholder for the textbox while it loads.
    <div
      ref={(el) => {
        if (local.autofocus) queueMicrotask(() => el.focus())
      }}
      tabIndex={-1}
      aria-busy="true"
      data-testid="rich-editor.loading"
      class={cn("rich-editor outline-none", props.class)}
      onFocus={() => {
        held = true
      }}
      onBlur={(e) => {
        if (e.relatedTarget) held = false
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
        if (e.key === "Backspace") type(typed().slice(0, -1))
        else if (e.key.length === 1) type(typed() + e.key)
        else return
        e.preventDefault()
      }}
    >
      <div class={cn("prose-thread min-w-0", props.editorClass)}>
        <Show when={shown()} fallback={<span class="text-text-tertiary">{props.placeholder}</span>}>
          <span class="whitespace-pre-wrap">{shown()}</span>
        </Show>
      </div>
    </div>
  )

  return (
    <Suspense fallback={standIn}>
      <LazyRichEditor
        {...rest}
        autofocus={local.autofocus || held}
        ref={(handle) => {
          // A surface that keeps its value opened the editor on the typed
          // text already; one that does not gets it typed in.
          if (typed() && untrack(() => props.value) !== opened + typed()) {
            handle.insertText(typed())
          }
          local.ref?.(handle)
        }}
      />
    </Suspense>
  )
}
