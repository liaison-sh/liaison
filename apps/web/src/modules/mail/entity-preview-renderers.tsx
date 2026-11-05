// SPDX-License-Identifier: FSL-1.1-ALv2
import { Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { requestMailboxUnlock } from "~/modules/mailbox/mailbox-unlock-bus"
import { isSealedRow, openSealedRow, type SealedRowFields } from "~/modules/mailbox/sealed-row"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface MailConversationPreviewData extends Partial<SealedRowFields> {
  subject?: string | null
  snippet?: string | null
  /** Above 0, the subject is ciphertext until the mailbox opens it. */
  encVersion?: number | null
  messageCount?: number | null
  account?: { email?: string | null } | null
  /** Set by `fetch` on a sealed conversation: opened here, or the mailbox is locked. */
  encState?: "opened" | "locked"
}

export function registerEntityPreviews(): void {
  registerEntityPreview<MailConversationPreviewData>({
    app: "mail",
    entityType: "conversation",
    fetch: async (id, api) => {
      const res = await api.getEnvelope<
        { conversation?: MailConversationPreviewData } & MailConversationPreviewData
      >(`/mail/conversations/${id}?messageLimit=0`)
      const conversation = res.data?.conversation ?? res.data
      if (!conversation || !isSealedRow({ ...conversation, id: conversation.id ?? id })) {
        return conversation
      }
      // The same worker path the inbox list opens its rows with.
      const opened = await openSealedRow({ ...conversation, id: conversation.id ?? id })
      if (!opened) return { ...conversation, encState: "locked" }
      return {
        ...conversation,
        subject: opened.subject ?? "",
        snippet: opened.snippet ?? "",
        encState: "opened",
      }
    },
    render: (conversation) => {
      const i18n = useI18n()
      const unopened = () =>
        Number(conversation.encVersion ?? 0) > 0 && conversation.encState !== "opened"
      return (
        <div>
          <div class="font-medium text-text">
            {conversation.subject ||
              i18n.t(unopened() ? "mail.lockedConversation" : "mail.noSubject")}
          </div>
          <div class="text-text-secondary text-[12px]">{conversation.snippet}</div>
          <Show when={unopened() && !conversation.subject}>
            <button
              type="button"
              data-testid="mail-preview-unlock"
              class="mt-1 text-[12px] text-accent hover:text-accent-hover"
              onClick={() => requestMailboxUnlock()}
            >
              {i18n.t("kernel.mailboxEncryption.locked.panelButton")}
            </button>
          </Show>
          <div class="text-text-tertiary text-[11px]">
            {conversation.account?.email} ·{" "}
            {i18n.t("mail.messageCount", { count: conversation.messageCount ?? 0 })}
          </div>
        </div>
      )
    },
  })
}
