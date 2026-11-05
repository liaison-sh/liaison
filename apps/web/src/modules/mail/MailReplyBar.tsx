// SPDX-License-Identifier: FSL-1.1-ALv2

import { markdownToEmail } from "@liaison/shared"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { connectionErrorKey } from "~/lib/connection-errors"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { AttachmentUploadButton } from "~/modules/files/AttachmentUploadButton"
import {
  createUploadHold,
  type FileRow,
  inFlightUploadsFor,
  parentKeyOf,
  uploadHoldLabel,
} from "~/modules/files/file-service"
import {
  attachmentErrorMessage,
  restoreStaged,
  StagedAttachmentChips,
} from "~/modules/files/StagedAttachmentChips"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openDraftBody } from "~/modules/mail/draft-body"
import { allAccounts, personalAccounts } from "~/modules/mail/mail-account-store"
import { conversationStore } from "~/modules/mail/mail-conversation-store"
import {
  createDraft,
  discardDraft,
  getDraftForConversation,
  scheduleDraftSave,
  sendDraft,
} from "~/modules/mail/mail-draft-store"
import { getMessages } from "~/modules/mail/mail-message-store"
import { useApi } from "~/modules/shell/ApiContext"
import { Composer } from "~/ui/Composer"
import { DockedComposer } from "~/ui/DockedComposer"

interface MailReplyBarProps {
  conversationId: string
  /** Which tab the composer opens on. The phone action bar names the mode on
   *  the button the reader pressed, so the composer must not reset it. */
  initialMode?: "reply" | "reply-all"
  /** Skip the collapsed "Reply…" affordance. A phone opens this composer
   *  inside a sheet the reader already asked for: a second tap to expand it
   *  would be a tap on nothing. */
  startExpanded?: boolean
}

export const MailReplyBar: Component<MailReplyBarProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [draftId, setDraftId] = createSignal<string | null>(null)
  const [mode, setMode] = createSignal<"reply" | "reply-all">(props.initialMode ?? "reply")
  const [to, setTo] = createSignal<Array<{ email: string }>>([])
  const [cc, setCc] = createSignal<Array<{ email: string }>>([])
  // The reply as written (markdown); markdownToEmail makes the email.
  const [body, setBody] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [collapsed, setCollapsed] = createSignal(!props.startExpanded)
  const [pendingFiles, setPendingFiles] = createSignal<FileRow[]>([])
  const [attachError, setAttachError] = createSignal<string | null>(null)
  let editor: RichEditorHandle | undefined
  const dictation = useDictation({ target: () => editor })

  // A draft this bar created and that has held nothing since. Only such a
  // draft is thrown away when it is left empty: one restored from the server
  // may carry attachments this bar never saw.
  let ownDraft = false
  let creating: Promise<string | null> | null = null

  /** Who the reply goes to: the last inbound sender, plus its copies for
   *  reply-all. */
  function replyRecipients(currentMode: "reply" | "reply-all") {
    const inbound = lastInbound()
    return {
      to: inbound?.fromAddress?.email ? [{ email: inbound.fromAddress.email }] : [],
      cc:
        currentMode === "reply-all"
          ? (inbound?.ccAddresses ?? []).map((e) => ({ email: e.email }))
          : [],
    }
  }

  const lastInbound = createMemo(() =>
    [...getMessages(props.conversationId)].reverse().find((m) => m.direction === "inbound"),
  )

  createEffect(
    on(
      () => [props.conversationId, mode()] as const,
      ([conversationId, currentMode]) => {
        const existing = getDraftForConversation(conversationId)
        if (existing) {
          // A draft this bar did not create stays, whatever it holds.
          if (existing.id !== draftId()) ownDraft = false
          setDraftId(existing.id)
          setTo(existing.to)
          setCc(existing.cc)
          void openDraftBody(existing, { draftId, body, setBody })
          return
        }

        setDraftId(null)
        setBody("")
        const recipients = replyRecipients(currentMode)
        setTo(recipients.to)
        setCc(recipients.cc)
      },
    ),
  )

  // The subject the send gives the reply (mail service sendReply), so the
  // draft reads as that reply in Drafts, never "(No subject)".
  const replySubject = (): string | undefined => {
    const subject = conversationStore.byId[props.conversationId]?.subject?.trim()
    if (!subject) return undefined
    return subject.startsWith("Re:") ? subject : `Re: ${subject}`
  }

  async function ensureDraft(): Promise<string | null> {
    if (draftId()) return draftId()
    // Two callers at once (the attach button and the first keystroke) must
    // get the same draft, not two.
    creating ??= (async () => {
      const accountId =
        conversationStore.byId[props.conversationId]?.accountId ??
        personalAccounts()[0]?.id ??
        allAccounts()[0]?.id
      if (!accountId) return null
      // The bar may have mounted before the conversation's messages loaded,
      // when there was nobody to reply to yet.
      if (to().length === 0) {
        const recipients = replyRecipients(mode())
        setTo(recipients.to)
        if (cc().length === 0) setCc(recipients.cc)
      }
      // Created WITH its recipients and subject: a draft that got its file
      // before its first keystroke used to sit in Drafts as "(No recipients)
      // / (No subject)", since those were only saved with the body.
      const draft = await createDraft(api, {
        accountId,
        conversationId: props.conversationId,
        replyToMessageId: lastInbound()?.id,
        to: to(),
        cc: cc(),
        subject: replySubject(),
      })
      ownDraft = !draft.htmlBody && !draft.textBody
      setDraftId(draft.id)
      return draft.id
    })().finally(() => {
      creating = null
    })
    return creating
  }

  const draftParentKey = () => {
    const id = draftId()
    return id ? parentKeyOf({ app: "mail", entityType: "draft", entityId: id }) : null
  }
  // The send sends the draft with the files already on it: one still
  // uploading went out missing and landed on the sent draft afterwards. Hold
  // the send until every picked file is on the draft.
  const uploadHold = createUploadHold(draftParentKey)

  /** Throws away a draft this bar created once it holds nothing: no text,
   *  no staged file, nothing uploading. Attaching a file then removing it
   *  used to leave an empty draft in Drafts that its view could not discard. */
  function discardIfEmpty(): void {
    const id = draftId()
    if (!id || !ownDraft || sending()) return
    if (body().trim() !== "") return
    if (pendingFiles().length > 0 || inFlightUploadsFor(draftParentKey()).length > 0) return
    ownDraft = false
    setDraftId(null)
    void discardDraft(api, id).catch(() => {
      // Already gone, or offline: nothing here to show it on.
    })
  }

  onCleanup(discardIfEmpty)

  async function updateBody(next: string): Promise<void> {
    // An edit makes it a different message than the one queued.
    uploadHold.cancel()
    setBody(next)
    setError(null)
    const id = await ensureDraft()
    if (!id) return
    scheduleDraftSave(api, id, { to: to(), cc: cc(), markdown: next })
  }

  async function handleSend(): Promise<void> {
    // While a picked file uploads, Send queues the send (or, pressed again,
    // cancels it); it fires by itself once the files are on the draft.
    if (uploadHold.press(() => void handleSend())) return
    const id = await ensureDraft()
    if (!id) return
    setSending(true)
    setError(null)
    try {
      const email = markdownToEmail(body())
      await sendDraft(api, id, {
        to: to(),
        cc: cc(),
        htmlBody: email.html,
        textBody: email.text,
      })
      setDraftId(null)
      setBody("")
      setPendingFiles([])
      setAttachError(null)
    } catch (err: any) {
      // A mailbox that cannot send says how to fix it, in the person's language.
      const fixable = connectionErrorKey(err)
      setError(fixable ? i18n.t(fixable) : (err.message ?? "Failed to send"))
    } finally {
      setSending(false)
    }
  }

  return (
    // pb-dock-clearance: the send button sits in the panel's bottom right
    // corner, under the dock's bar (index.css).
    <DockedComposer
      data-testid="mail-reply-bar"
      class="shrink-0 border-t border-border px-3 pt-3 pb-dock-clearance"
    >
      <Show when={collapsed()}>
        <button
          type="button"
          data-testid="mail-reply-expand"
          class="flex w-full items-center gap-2 rounded-xl bg-surface-sunken px-4 py-2.5 text-left text-[13px] text-text-tertiary ring-1 ring-border transition-colors hover:bg-surface-emphasis hover:text-text-secondary"
          onClick={() => setCollapsed(false)}
        >
          {i18n.t("mail.reply")}
        </button>
      </Show>
      <Show when={!collapsed()}>
        <Composer disabled={sending()}>
          <Composer.Tabs aria-label={i18n.t("mail.replyMode")}>
            <Composer.Tab
              active={mode() === "reply"}
              onClick={() => setMode("reply")}
              testId="mail-reply-tab-reply"
            >
              {i18n.t("mail.reply2")}
            </Composer.Tab>
            <Composer.Tab
              active={mode() === "reply-all"}
              onClick={() => setMode("reply-all")}
              testId="mail-reply-tab-reply-all"
            >
              {i18n.t("mail.replyAll")}
            </Composer.Tab>
          </Composer.Tabs>

          {/* Staged files on top, left at the text's edge, as in chat. */}
          <StagedAttachmentChips
            files={pendingFiles()}
            onRemoved={(f) => {
              uploadHold.cancel()
              setPendingFiles((p) => p.filter((x) => x.id !== f.id))
            }}
            onRestored={(f, i) => setPendingFiles((p) => restoreStaged(p, f, i))}
            // Once the file is really gone, a draft left with nothing in it
            // goes too, so attaching then removing leaves nothing behind.
            onRemoveSettled={discardIfEmpty}
            error={attachError()}
            disabled={sending()}
            uploadParentKey={draftParentKey()}
          />

          <Composer.EditorSlot class="!py-1.5">
            <div data-testid="mail-reply-editor">
              <RichEditor
                preset="full"
                value={body()}
                onChange={(next) => void updateBody(next)}
                ref={(handle) => {
                  editor = handle
                }}
                placeholder={i18n.t("mail.reply")}
                // The text scrolls under a toolbar that stays put: the row
                // needs no background of its own.
                class="[--editor-bg:transparent]"
                editorClass="max-h-[240px] overflow-y-auto text-[13.5px] leading-5"
              />
            </div>
          </Composer.EditorSlot>

          <Composer.Footer>
            <RecorderRow dictation={dictation}>
              <AttachmentUploadButton
                parent={() =>
                  uploadHold.track(async () => {
                    const id = await ensureDraft()
                    if (!id) throw new Error("No mail account available for this conversation")
                    return { app: "mail", entityType: "draft", entityId: id }
                  })
                }
                onUploaded={(row) => {
                  setAttachError(null)
                  setPendingFiles((p) => [...p, row])
                }}
                onError={(err) => setAttachError(attachmentErrorMessage(err))}
                disabled={sending()}
              />
              <ComposerAssist target={() => editor} disabled={sending()} />
              <Show when={error()}>
                <span
                  data-testid="mail-reply-error"
                  class="truncate text-[11px] text-red-400"
                  title={error() ?? undefined}
                >
                  {error()}
                </span>
              </Show>
              <div class="ml-auto flex shrink-0 items-center gap-1">
                <DictationMic dictation={dictation} disabled={sending()} />
                <Composer.Submit
                  class="ml-0"
                  onClick={() => void handleSend()}
                  // A file on its way counts as something to send: the press queues.
                  disabled={
                    sending() ||
                    (!body().trim() && pendingFiles().length === 0 && !uploadHold.held())
                  }
                  loading={sending()}
                  label={uploadHoldLabel(i18n.t, uploadHold)}
                  pressed={uploadHold.held() ? uploadHold.queued() : undefined}
                  testId="mail-reply-send"
                >
                  {sending()
                    ? i18n.t("kernel.common.sending")
                    : uploadHold.queued()
                      ? i18n.t("kernel.filesUi.sendQueued")
                      : i18n.t("kernel.common.send")}
                </Composer.Submit>
              </div>
            </RecorderRow>
          </Composer.Footer>
        </Composer>
      </Show>
    </DockedComposer>
  )
}
