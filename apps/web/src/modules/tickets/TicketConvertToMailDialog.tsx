// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketConvertToMailDialog — escalates a ticket to a mail conversation.

import type { Component } from "solid-js"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { loadAccounts, mailAccountStore } from "~/modules/mail/mail-account-store"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface Props {
  ticketId: string
  onClose: () => void
}

export const TicketConvertToMailDialog: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [accountId, setAccountId] = createSignal("")
  const [note, setNote] = createSignal("")
  let noteField: HTMLTextAreaElement | undefined
  const noteFieldDictation = useDictation({ target: () => noteField })
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    void loadAccounts(api).then(() => {
      const first = availableAccounts()[0]
      if (first) setAccountId(first.id)
    })
  })

  const availableAccounts = createMemo(() => {
    const userId = userFromToken()?.userId ?? null
    return Object.values(mailAccountStore.byId).filter(
      (account) => account.ownerType === "user" && (!userId || account.ownerId === userId),
    )
  })

  async function submit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      const out = await runTool<{ mailConversationId: string }>(api, "tickets:convertToMail", {
        ticketId: props.ticketId,
        accountId: accountId(),
        note: note() || undefined,
      })
      props.onClose()
      // Freshly created by the conversion — open as a permanent tab.
      openTab({
        type: "mail:conversation",
        entityId: out.mailConversationId,
        label: i18n.t("tickets.mail"),
        preview: false,
      })
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content>
        <div data-testid="tickets-convert-to-mail-dialog">
          <Dialog.Title class="mb-3">{i18n.t("tickets.convertToMailConversation")}</Dialog.Title>
          <Show
            when={availableAccounts().length > 0}
            fallback={
              <p class="mb-2 text-sm text-text-secondary" data-testid="tickets-convert-no-accounts">
                {i18n.t("tickets.connectAPersonalMailAccountBefore")}
              </p>
            }
          >
            <label class="mb-2 flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.sendFromAccount")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-convert-account"
                value={accountId()}
                onChange={(e) => setAccountId(e.currentTarget.value)}
              >
                <For each={availableAccounts()}>
                  {(account) => <option value={account.id}>{account.emailAddress}</option>}
                </For>
              </select>
            </label>
          </Show>
          <label class="flex flex-col gap-1 text-sm">
            <span>{i18n.t("tickets.noteOptional")}</span>
            <textarea
              ref={noteField}
              class="min-h-[80px] rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid="tickets-convert-note"
              value={note()}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          </label>
          {/* The wand stays with the field; the mic sits left of Convert, in
              the footer a take turns into the recorder line. */}
          <div class="mt-1 flex justify-end gap-0.5">
            <ComposerAssist target={() => noteField} />
          </div>
          {error() && (
            <div class="mt-2 text-sm text-red-500" data-testid="tickets-convert-error">
              {error()}
            </div>
          )}
          <div class="mt-3 flex items-center justify-end gap-2">
            <RecorderRow dictation={noteFieldDictation}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="tickets-convert-cancel"
                onClick={() => props.onClose()}
              >
                {i18n.t("kernel.common.cancel")}
              </Button>
              <DictationMic dictation={noteFieldDictation} />
              <Button
                type="button"
                size="sm"
                data-testid="tickets-convert-submit"
                disabled={submitting() || !accountId().trim()}
                onClick={() => submit()}
              >
                {submitting() ? i18n.t("tickets.converting") : i18n.t("tickets.convert")}
              </Button>
            </RecorderRow>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
