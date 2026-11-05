// SPDX-License-Identifier: FSL-1.1-ALv2
// MailConvertToTicketDialog — converts a mail conversation to a new
// ticket. Hosted in the Mail conversation slot.

import type { Component } from "solid-js"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { useI18n } from "~/modules/i18n/i18n-context"
import { conversationStore, upsertConversation } from "~/modules/mail/mail-conversation-store"
import { getMessages } from "~/modules/mail/mail-message-store"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { loadInboxes, ticketInboxStore } from "~/modules/tickets/ticket-inbox-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface Props {
  mailConversationId: string
  onClose: () => void
}

export const MailConvertToTicketDialog: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [priority, setPriority] = createSignal("normal")
  const [inboxId, setInboxId] = createSignal("")
  const [note, setNote] = createSignal("")
  let noteField: HTMLTextAreaElement | undefined
  const noteFieldDictation = useDictation({ target: () => noteField })
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    void loadInboxes(api).then(() => {
      const active = ticketInboxStore.inboxes.filter((i) => !i.archivedAt)
      const defaultInboxId =
        active.length === 1 ? active[0].id : active.find((i) => i.isDefaultForCreate)?.id
      if (defaultInboxId) setInboxId((current) => current || defaultInboxId)
    })
  })

  const activeInboxes = createMemo(() => ticketInboxStore.inboxes.filter((i) => !i.archivedAt))

  async function submit(): Promise<void> {
    if (!inboxId()) {
      setError("Choose a tickets inbox")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const out = await runTool<{ ticketId: string; ticketHandle?: string }>(
        api,
        "mail:convertToTicket",
        {
          conversationId: props.mailConversationId,
          inboxId: inboxId(),
          priority: priority(),
          note: note().trim() || undefined,
          idempotencyKey: `mail:convert:${props.mailConversationId}`,
        },
      )
      const existing = conversationStore.byId[props.mailConversationId]
      if (existing) {
        upsertConversation({
          ...existing,
          status: "escalated",
          escalatedTicketId: out.ticketId,
          escalatedTicketHandle: out.ticketHandle ?? null,
          escalatedTicketStatus: "open",
        })
      }
      props.onClose()
      // Freshly created by the conversion — open as a permanent tab.
      openTab({
        type: "tickets:ticket",
        entityId: out.ticketId,
        label: out.ticketHandle ?? i18n.t("tickets.ticket"),
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
        <div data-testid="mail-convert-to-ticket-dialog">
          <Dialog.Title class="mb-3">{i18n.t("tickets.convertToTicket")}</Dialog.Title>
          <Show
            when={activeInboxes().length > 0}
            fallback={
              <p class="mb-3 text-sm text-text-secondary" data-testid="mail-convert-no-inboxes">
                {i18n.t("tickets.connectASupportInboxBeforeConverting")}
              </p>
            }
          >
            <label class="mb-2 flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.ticketsInbox")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="mail-convert-inbox"
                value={inboxId()}
                onChange={(e) => setInboxId(e.currentTarget.value)}
              >
                <option value="">{i18n.t("tickets.chooseInbox")}</option>
                {activeInboxes().map((i) => (
                  <option value={i.id}>{i.name}</option>
                ))}
              </select>
            </label>
          </Show>
          <label class="flex flex-col gap-1 text-sm">
            <span>{i18n.t("tickets.priority")}</span>
            <select
              class="rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid="mail-convert-priority"
              value={priority()}
              onChange={(e) => setPriority(e.currentTarget.value)}
            >
              <option value="low">{i18n.t("tickets.low")}</option>
              <option value="normal">{i18n.t("tickets.normal")}</option>
              <option value="high">{i18n.t("tickets.high")}</option>
              <option value="urgent">{i18n.t("tickets.urgent")}</option>
            </select>
          </label>
          <label class="mt-2 flex flex-col gap-1 text-sm">
            <span>{i18n.t("tickets.noteOptional")}</span>
            <textarea
              ref={noteField}
              class="min-h-[70px] rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid="mail-convert-note"
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
            <div class="mt-2 text-sm text-red-500" data-testid="mail-convert-error">
              {error()}
            </div>
          )}
          <div class="mt-3 flex items-center justify-end gap-2">
            <RecorderRow dictation={noteFieldDictation}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="mail-convert-cancel"
                onClick={() => props.onClose()}
              >
                {i18n.t("kernel.common.cancel")}
              </Button>
              <DictationMic dictation={noteFieldDictation} />
              <Button
                type="button"
                size="sm"
                data-testid="mail-convert-submit"
                disabled={submitting() || !inboxId()}
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

export interface MailConvertSlotProps {
  mailConversationId: string
}

// Banner + action slot hosts — registered into Mail's conversation slots
// via the manifest `slots` entries (`mail.conversation.banner|actions`).
export const MailConvertToTicketBanner: Component<MailConvertSlotProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [show, setShow] = createSignal(false)
  const [pulling, setPulling] = createSignal(false)
  const [pulled, setPulled] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const conversation = createMemo(() => conversationStore.byId[props.mailConversationId])
  const latestPullableMessage = createMemo(() => {
    const inbound = getMessages(props.mailConversationId).filter((m) => m.direction === "inbound")
    return inbound.length > 1 ? inbound[inbound.length - 1] : null
  })

  function openEscalatedTicket(): void {
    const c = conversation()
    if (!c?.escalatedTicketId) return
    openTab({
      type: "tickets:ticket",
      entityId: c.escalatedTicketId,
      label: c.escalatedTicketHandle ?? i18n.t("tickets.ticket"),
    })
  }

  async function pullLatestReply(): Promise<void> {
    const c = conversation()
    const msg = latestPullableMessage()
    if (!c?.escalatedTicketId || !msg) return
    setPulling(true)
    setError(null)
    try {
      await runTool(api, "tickets:pullMailReplyFromBanner", {
        ticketId: c.escalatedTicketId,
        mailMessageId: msg.id,
        idempotencyKey: `tickets:pullMailReply:${c.escalatedTicketId}:${msg.id}`,
      })
      setPulled(true)
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setPulling(false)
    }
  }

  return (
    <>
      <Show
        when={conversation()?.escalatedTicketId}
        fallback={
          // K5: at phone tier the conversation's own "..." sheet already
          // offers Convert to ticket (`mail-more-convert`), so this prompt
          // line is a second, redundant invitation to the same action:
          // hidden there, unchanged on desktop and tablet.
          <Show when={shellTier() !== "phone"}>
            <div
              class="border-b border-border bg-surface-emphasis p-2 text-sm"
              data-testid="mail-convert-banner"
            >
              <span>{i18n.t("tickets.needFollowUpTracking")} </span>
              <button
                type="button"
                class="text-accent underline"
                data-testid="mail-convert-banner-button"
                onClick={() => setShow(true)}
              >
                {i18n.t("tickets.convertToTicket")}
              </button>
            </div>
          </Show>
        }
      >
        <div
          class="flex items-center gap-2 border-b border-border bg-surface-emphasis p-2 text-sm"
          data-testid="mail-escalated-banner"
        >
          <span>
            {i18n.t("tickets.escalatedToTicket")}{" "}
            {conversation()?.escalatedTicketHandle ?? conversation()?.escalatedTicketId} (
            {conversation()?.escalatedTicketStatus ?? "open"})
          </span>
          <button
            type="button"
            class="text-accent underline"
            data-testid="mail-escalated-open-ticket"
            onClick={openEscalatedTicket}
          >
            {i18n.t("tickets.openTicket")}
          </button>
          <Show when={latestPullableMessage() && !pulled()}>
            <button
              type="button"
              class="text-accent underline disabled:opacity-60"
              data-testid="mail-pull-reply-button"
              disabled={pulling()}
              onClick={() => void pullLatestReply()}
            >
              {pulling() ? i18n.t("tickets.pulling") : i18n.t("tickets.pullThisReplyIntoTheTicket")}
            </button>
          </Show>
          <Show when={pulled()}>
            <span class="text-text-secondary" data-testid="mail-pull-reply-done">
              {i18n.t("tickets.pulledIntoTicket")}
            </span>
          </Show>
          <Show when={error()}>
            <span class="text-red-500" data-testid="mail-pull-reply-error">
              {error()}
            </span>
          </Show>
        </div>
      </Show>
      {show() && (
        <MailConvertToTicketDialog
          mailConversationId={props.mailConversationId}
          onClose={() => setShow(false)}
        />
      )}
    </>
  )
}

export const MailConvertToTicketAction: Component<MailConvertSlotProps> = (props) => {
  const i18n = useI18n()
  const [show, setShow] = createSignal(false)
  const conversation = createMemo(() => conversationStore.byId[props.mailConversationId])
  return (
    <>
      <Show
        when={conversation()?.escalatedTicketId}
        fallback={
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-sm"
            data-testid="mail-convert-action-button"
            onClick={() => setShow(true)}
          >
            {i18n.t("tickets.convertToTicket")}
          </button>
        }
      >
        <button
          type="button"
          class="rounded border border-border px-2 py-1 text-sm"
          data-testid="mail-convert-action-open-ticket"
          onClick={() => {
            const c = conversation()
            if (!c?.escalatedTicketId) return
            openTab({
              type: "tickets:ticket",
              entityId: c.escalatedTicketId,
              label: c.escalatedTicketHandle ?? i18n.t("tickets.ticket"),
            })
          }}
        >
          {i18n.t("tickets.openTicket")}
        </button>
      </Show>
      {show() && (
        <MailConvertToTicketDialog
          mailConversationId={props.mailConversationId}
          onClose={() => setShow(false)}
        />
      )}
    </>
  )
}
