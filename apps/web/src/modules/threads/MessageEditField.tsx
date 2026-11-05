// SPDX-License-Identifier: FSL-1.1-ALv2
// Editing a sent message: the composer's editor in message mode, so typed
// formatting, pastes and line breaks follow the same rules as when it was
// written, and a message saved untouched is stored exactly as it was.
import { Check, X } from "lucide-solid"
import { type Component, createSignal } from "solid-js"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"

export const MessageEditField: Component<{
  content: string
  onSave: (content: string) => void
  onCancel: () => void
}> = (props) => {
  const i18n = useI18n()
  const [text, setText] = createSignal(props.content)
  let editor: RichEditorHandle | undefined
  const dictation = useDictation({ target: () => editor })

  const save = () => {
    const content = text().trim()
    if (content) props.onSave(content)
  }

  return (
    <div class="mt-0.5">
      {/* Escape is the edit's (the editor takes it from a host listening on
          the document, such as the reply panel); Enter saves, Shift+Enter
          starts the next line. */}
      <RichEditor
        preset="minimal"
        toolbar="none"
        ref={(handle) => {
          editor = handle
        }}
        value={text()}
        onChange={setText}
        onSubmit={save}
        enterSubmits
        onCancel={() => props.onCancel()}
        autofocus
        aria-label={i18n.t("kernel.editor.editMessage")}
        data-testid="message-edit-field"
        class="rounded border border-border bg-bg px-2 py-1.5 focus-within:border-accent"
        editorClass="max-h-[176px] overflow-y-auto text-[13.5px] leading-relaxed"
      />
      <div class="mt-1 flex items-center gap-2">
        <RecorderRow dictation={dictation}>
          <ComposerAssist target={() => editor} />
          {/* The mic immediately left of Save, the row's primary action. */}
          <span class="flex items-center gap-0.5">
            <DictationMic dictation={dictation} />
            <button
              type="button"
              data-testid="message-edit-save"
              onClick={save}
              class="flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium text-accent hover:bg-accent/10"
            >
              <Check size={12} /> {i18n.t("kernel.common.save")}
            </button>
          </span>
          <button
            type="button"
            onClick={() => props.onCancel()}
            class="flex items-center gap-1 rounded px-2 py-0.5 text-[12px] text-text-secondary hover:bg-surface-hover"
          >
            <X size={12} /> {i18n.t("kernel.common.cancel")}
          </button>
          <span class="text-[11px] text-text-tertiary">
            {i18n.t("kernel.enterToSaveEscToCancel")}
          </span>
        </RecorderRow>
      </div>
    </div>
  )
}
