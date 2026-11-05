// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A memory file, read or edited in place.
 *
 * Read: the shell's own renderer (`markdown-content`), so a memory file reads
 * exactly as a message does. A read only file (a checkpoint) shows only this,
 * with no editable control of any kind: hiding the save button while leaving
 * the field typeable would read as an editor that silently discards work.
 *
 * Edit: the shared rich editor, and, since these are technical files an
 * agent also writes, a "Markdown source" toggle onto the same text as typed.
 */
import { FileCode } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { RichEditor } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import { Toggle } from "~/ui/Toggle"

interface Props {
  value: string
  onInput: (next: string) => void
  readOnly?: boolean
}

const FIELD = "rounded-md border border-border-subtle bg-surface px-3 py-2"

const MarkdownEditor: Component<Props> = (props) => {
  const api = useApi()
  return (
    <div class="flex min-w-0 flex-col gap-2" data-testid="agent-memory-editor">
      <Show
        when={!props.readOnly}
        fallback={
          <div class={`min-w-0 overflow-x-auto ${FIELD}`}>
            <MarkdownContent
              data-testid="agent-memory-body"
              content={props.value.length > 0 ? props.value : " "}
              api={api as never}
            />
          </div>
        }
      >
        <Editing value={props.value} onInput={props.onInput} />
      </Show>
    </div>
  )
}

/** One editing session: each opens on the formatted text. */
const Editing: Component<Omit<Props, "readOnly">> = (props) => {
  const i18n = useI18n()
  const [source, setSource] = createSignal(false)
  return (
    <>
      <Toggle
        pressed={source()}
        onChange={setSource}
        data-testid="agent-memory-source-toggle"
        class="gap-1.5 self-end px-2 py-1 text-[12px]"
      >
        <FileCode class="h-3.5 w-3.5" />
        {i18n.t("kernel.editor.markdownSource")}
      </Toggle>
      <Show
        when={source()}
        fallback={
          <RichEditor
            preset="full"
            autofocus
            value={props.value}
            onChange={(markdown) => props.onInput(markdown)}
            aria-label={i18n.t("kernel.agentMemoryEdit")}
            data-testid="agent-memory-editor-input"
            class={`[--editor-bg:var(--color-surface)] ${FIELD}`}
            editorClass="min-h-[14rem]"
          />
        }
      >
        <textarea
          data-testid="agent-memory-source"
          aria-label={i18n.t("kernel.editor.markdownSource")}
          value={props.value}
          rows={14}
          spellcheck={false}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          class={`min-h-[14rem] resize-y font-mono text-[12px] leading-relaxed text-text outline-none focus:border-accent-muted ${FIELD}`}
        />
      </Show>
    </>
  )
}

export default MarkdownEditor
