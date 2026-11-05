// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createEffect, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

/** Which of the Slack/Buzz pair this dialog is editing. */
export type ChannelDetailsField = "topic" | "description"

interface ChannelDetailsDialogProps {
  /** Null closes it. The FIELD is the open state, so one dialog serves both
   *  menu entries and neither can be open while the other is. */
  field: ChannelDetailsField | null
  /** The value on the row right now. Null is unset, and stays distinct from
   *  "": an emptied field SAVES as null, which is the clear. */
  initialValue: string | null
  onSave: (value: string | null) => void | Promise<void>
  onClose: () => void
}

/** The topic's own cap, mirroring `kernel.threads.topic`'s CHECK. */
const TOPIC_MAX = 250
/** The description's, mirroring `kernel.threads.description`'s CHECK. */
const DESCRIPTION_MAX = 2000

/**
 * The one small dialog behind "Set topic" and "Edit description".
 *
 * A topic is a LINE and a description is a PARAGRAPH, so the topic gets the
 * single-line Input and the description a textarea: the control tells the
 * member how much they are expected to write before they start writing, which
 * a shared text box never could.
 *
 * Saving an emptied field sends `null`, not "". The API treats the two
 * differently on purpose (null clears, "" would be a channel whose topic is an
 * empty line), and the clear is the whole reason a member reopens this dialog.
 */
export const ChannelDetailsDialog: Component<ChannelDetailsDialogProps> = (props) => {
  const i18n = useI18n()
  const [value, setValue] = createSignal(props.initialValue ?? "")
  const [saving, setSaving] = createSignal(false)

  // Re-seed whenever the dialog is (re)opened on a field: the signal is created
  // once, so without this the second open would show the first open's draft.
  createEffect(() => {
    if (props.field) setValue(props.initialValue ?? "")
  })

  const isTopic = () => props.field === "topic"
  const max = () => (isTopic() ? TOPIC_MAX : DESCRIPTION_MAX)

  async function save() {
    const trimmed = value().trim()
    setSaving(true)
    try {
      await props.onSave(trimmed === "" ? null : trimmed)
      props.onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={props.field !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content class="w-80" data-testid="channel-details-dialog">
        <Dialog.Title>
          {isTopic() ? i18n.t("kernel.threadSetTopic") : i18n.t("kernel.threadEditDescription")}
        </Dialog.Title>
        <div class="mt-3 flex flex-col gap-3">
          <Show
            when={isTopic()}
            fallback={
              <textarea
                data-testid="channel-details-textarea"
                aria-label={i18n.t("kernel.threadDescription")}
                rows={5}
                maxLength={DESCRIPTION_MAX}
                placeholder={i18n.t("kernel.threadDescriptionPlaceholder")}
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
                class="w-full resize-none rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-[13px] text-text outline-none placeholder:text-text-tertiary focus:border-accent"
              />
            }
          >
            <Input
              data-testid="channel-details-input"
              label={i18n.t("kernel.threadTopic")}
              maxLength={TOPIC_MAX}
              placeholder={i18n.t("kernel.threadTopicPlaceholder")}
              value={value()}
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          </Show>
          <p class="text-[11px] leading-snug text-text-tertiary">
            {isTopic() ? i18n.t("kernel.threadTopicHelp") : i18n.t("kernel.threadDescriptionHelp")}
          </p>
          <div class="mt-1 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={props.onClose}
              data-testid="channel-details-cancel"
            >
              {i18n.t("kernel.threadDetailsCancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={saving() || value().length > max()}
              data-testid="channel-details-save"
            >
              {i18n.t("kernel.threadDetailsSave")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
