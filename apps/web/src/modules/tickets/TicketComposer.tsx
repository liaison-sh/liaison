// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketComposer — reply / internal note tabs, draft autosave to
// localStorage. A person's reply runs on their own scopes: it sends, or the
// server refuses it (403) and the composer says so. Uses the
// shared `Composer` primitive so footer (follow-up + send) lives
// inside the same bordered card as the editor.

import { markdownToEmail } from "@liaison/shared"
import { MessageSquareText } from "lucide-solid"
import type { Component } from "solid-js"
import { batch, createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { cn } from "~/lib/cn"
import { connectionErrorKey } from "~/lib/connection-errors"
import { runTool } from "~/lib/run-tool"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { AttachmentUploadButton } from "~/modules/files/AttachmentUploadButton"
import {
  createUploadHold,
  createUploadSession,
  type FileRow,
  parentKeyOf,
  type UploadSession,
  uploadHoldLabel,
} from "~/modules/files/file-service"
import {
  attachmentErrorMessage,
  restoreStaged,
  StagedAttachmentChips,
} from "~/modules/files/StagedAttachmentChips"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { clearDraft, getDraft, saveDraft } from "~/modules/tickets/ticket-draft-store"
import { loadMessages, TICKET_REPLY_APPROVAL_EVENT } from "~/modules/tickets/ticket-message-store"
import type { ReplyTemplate, ReplyTemplateRow } from "~/modules/tickets/ticket-types"
import { Composer } from "~/ui/Composer"
import { DockedComposer } from "~/ui/DockedComposer"
import { PopupMenu } from "~/ui/PopupMenu"

interface Props {
  ticketId: string
  /** Effective reply signature (inbox first, else the user's own) — prefilled
   *  into the reply box so what the agent sees is exactly what sends; the
   *  backend appends nothing at send time. */
  signatureText?: string | null
  onFileUploaded?: () => void
  /** Which tab the composer opens on. The phone screen opens it from two
   *  separate bottom-bar buttons (Note and Reply), so the caller picks. */
  initialMode?: "reply" | "note"
  /** The people the customer's latest email copied. A reply starts with them
   *  in Cc so nobody silently drops off the thread; each one is removable. */
  defaultCc?: string[]
  /** Who the reply goes to (the ticket's contact, name else email): the
   *  footer names the recipients next to Send, Cc included. */
  recipientName?: string | null
  /** The note was posted or the reply went out (not one parked for a second
   *  approver): the phone's full-screen composer closes on it. */
  onSubmitted?: (mode: "reply" | "note") => void
}

const CC_ADDRESS_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

/** Split typed Cc text into addresses (comma, semicolon or whitespace separated). */
export function parseCcInput(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  for (const part of text.split(/[\s,;]+/)) {
    const addr = part.trim()
    if (!addr) continue
    if (CC_ADDRESS_RE.test(addr)) valid.push(addr)
    else invalid.push(addr)
  }
  return { valid, invalid }
}

/** Most addresses one reply may copy (the server refuses more). */
export const MAX_REPLY_CC = 10

/** Append addresses to a Cc list, skipping case insensitive duplicates. */
export function mergeCc(list: string[], add: string[]): string[] {
  const seen = new Set(list.map((a) => a.toLowerCase()))
  const out = [...list]
  for (const a of add) {
    const key = a.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/** The scopes of the tools the two tabs run (tickets:reply, tickets:addNote).
 *  A person's own send is decided by these alone, so a tab they cannot use is
 *  not shown: they can still read the ticket. */
export const TICKET_REPLY_SCOPE = "tickets:tickets:reply"
export const TICKET_NOTE_SCOPE = "tickets:tickets:write"
export const canReplyOnTickets = (): boolean => hasScope(TICKET_REPLY_SCOPE)
export const canNoteOnTickets = (): boolean => hasScope(TICKET_NOTE_SCOPE)

export const TicketComposer: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const currentUserId = () => userFromToken()?.userId ?? "unknown"
  const canReply = canReplyOnTickets()
  const canNote = canNoteOnTickets()
  const startMode: "reply" | "note" =
    (props.initialMode ?? "reply") === "reply"
      ? canReply
        ? "reply"
        : "note"
      : canNote
        ? "note"
        : "reply"
  const [mode, setMode] = createSignal<"reply" | "note">(startMode)
  const [body, setBody] = createSignal(getDraft(currentUserId(), props.ticketId, startMode))
  // True once the user typed in the current body — a pristine (untouched)
  // empty reply box may still receive the late-arriving signature prefill.
  const [touched, setTouched] = createSignal(false)

  // The visible-and-editable signature block the reply box starts with. The
  // leading blank lines are an empty first paragraph to type in, as in mail
  // clients.
  function replyPrefill(): string {
    const sig = props.signatureText?.trim()
    return sig ? `\n\n${sig}` : ""
  }

  // Prefill the signature once it arrives (tickets:get resolves after mount),
  // but never clobber a saved draft or anything the user typed. Keys typed
  // before it arrived keep their place: the signature then goes after them,
  // in its own paragraph as on an empty box, once.
  let signatureSettled = false
  let signaturePending = false
  let appendingSignature = false
  function appendSignature(): void {
    const sig = props.signatureText?.trim()
    // Typed in the stand-in while the editor chunk loads: added once it mounts.
    if (!editor) {
      signaturePending = true
      return
    }
    signaturePending = false
    if (!sig || mode() !== "reply" || body().includes(sig)) return
    appendingSignature = true
    try {
      editor.appendMarkdown(sig)
    } finally {
      appendingSignature = false
    }
  }
  createEffect(() => {
    const prefill = replyPrefill()
    if (!prefill || mode() !== "reply") return
    if (!touched()) {
      signatureSettled = true
      if (!body().trim()) setBody(prefill)
      return
    }
    if (signatureSettled) return
    signatureSettled = true
    untrack(appendSignature)
  })
  // Cc recipients of the reply. Seeded from the customer's latest email once
  // it is known, until the person edits the list themselves.
  // At most MAX_REPLY_CC are kept from the seed (the server refuses more), and
  // the composer says how many were left out rather than dropping them silently.
  const seedCc = () => mergeCc([], props.defaultCc ?? [])
  const [cc, setCc] = createSignal<string[]>(seedCc().slice(0, MAX_REPLY_CC))
  const [ccEdited, setCcEdited] = createSignal(false)
  const [ccDraft, setCcDraft] = createSignal("")
  const [ccError, setCcError] = createSignal<string | null>(null)
  const [ccLeftOut, setCcLeftOut] = createSignal(Math.max(0, seedCc().length - MAX_REPLY_CC))
  createEffect(() => {
    const seed = seedCc()
    if (ccEdited()) return
    setCc(seed.slice(0, MAX_REPLY_CC))
    setCcLeftOut(Math.max(0, seed.length - MAX_REPLY_CC))
  })
  function commitCcDraft(): boolean {
    const { valid, invalid } = parseCcInput(ccDraft())
    if (valid.length > 0) {
      const next = mergeCc(cc(), valid)
      if (next.length > MAX_REPLY_CC) {
        setCcError(i18n.t("tickets.ccTooMany", { max: MAX_REPLY_CC }))
        return false
      }
      setCc(next)
      setCcEdited(true)
    }
    if (invalid.length > 0) {
      setCcDraft(invalid.join(", "))
      setCcError(i18n.t("tickets.ccInvalidAddress", { address: invalid[0] }))
      return false
    }
    setCcDraft("")
    setCcError(null)
    return true
  }
  function removeCc(addr: string): void {
    setCc((list) => list.filter((a) => a !== addr))
    setCcEdited(true)
  }
  // Cc folds into a button showing how many addresses it holds and opens its
  // field in the header row. It starts open when the customer's email already
  // copied someone, until the person opens or closes it themselves.
  const [ccOpenChoice, setCcOpenChoice] = createSignal<boolean | null>(null)
  const ccOpen = () => ccOpenChoice() ?? (cc().length > 0 || ccLeftOut() > 0)
  let ccInput: HTMLInputElement | undefined
  function openCc(): void {
    setCcOpenChoice(true)
    ccInput?.focus()
  }
  /** Closes the field unless an address typed in it is still not accepted. */
  function closeCc(): void {
    if (ccDraft().trim() && !commitCcDraft()) return
    setCcOpenChoice(false)
  }
  // The header row is one line on a phone too: the tools then scroll sideways
  // instead of folding into a menu, and an open Cc field takes its own row.
  const [narrow, setNarrow] = createSignal(false)
  const [toolbarHost, setToolbarHost] = createSignal<HTMLElement>()
  let root: HTMLDivElement | undefined
  onMount(() => {
    if (!root || typeof ResizeObserver === "undefined") return
    const el = root
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < 480)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  const recipientsLabel = (): string => {
    const name = props.recipientName?.trim()
    const count = cc().length
    if (name) {
      return count > 0
        ? i18n.t("tickets.toRecipientCc", { name, count })
        : i18n.t("tickets.toRecipient", { name })
    }
    return count > 0 ? i18n.t("tickets.toCustomerCc", { count }) : i18n.t("tickets.toCustomer")
  }
  const [followupEnabled, setFollowupEnabled] = createSignal(false)
  const [followupAt, setFollowupAt] = createSignal("")
  const [followupReason, setFollowupReason] = createSignal("")
  const [followupTrigger, setFollowupTrigger] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [session, setSession] = createSignal<UploadSession | null>(null)
  const [pendingFiles, setPendingFiles] = createSignal<FileRow[]>([])
  const [attachError, setAttachError] = createSignal<string | null>(null)

  // Staged uploads ride the reply/note itself (attachmentSessionId -> the
  // server sends them with the customer email and moves them onto the
  // message). Lazily created on the first file pick.
  function ensureSession(): Promise<UploadSession> {
    return uploadHold.track(async () => {
      const existing = session()
      if (existing) return existing
      // Bound to THIS ticket: the server only sends a session's files with a
      // reply or note on the ticket the session was started on.
      const s = await createUploadSession(api, {
        targetApp: "tickets",
        targetEntityType: "ticket",
        targetEntityId: props.ticketId,
      })
      setSession(s)
      return s
    })
  }
  const sessionParentKey = (): string | null => {
    const s = session()
    return s
      ? parentKeyOf({ app: "kernel", entityType: "file_upload_session", entityId: s.id })
      : null
  }
  // A file still uploading is not on the session yet: posting now would send
  // the note or reply WITHOUT it and leave the file staged once it lands. Hold
  // the send until every picked file is staged, from the moment it is picked;
  // a press meanwhile queues it (createUploadHold).
  const uploadHold = createUploadHold(sessionParentKey)
  // A reply parked under the org's two-approver policy: the one case a
  // person's own send waits. Holds the approval id until it is decided.
  const [awaitingSecond, setAwaitingSecond] = createSignal<string | null>(null)
  const [replyOutcome, setReplyOutcome] = createSignal<"denied" | "expired" | null>(null)
  const onReplyApproval = (e: Event) => {
    const d = (e as CustomEvent<{ ticketId: string; approvalId: string; status: string }>).detail
    if (!d || d.ticketId !== props.ticketId || d.approvalId !== awaitingSecond()) return
    if (d.status === "approved") {
      setAwaitingSecond(null)
      void loadMessages(api, props.ticketId, { fresh: true })
    } else if (d.status === "denied" || d.status === "expired" || d.status === "cancelled") {
      setAwaitingSecond(null)
      setReplyOutcome(d.status === "expired" ? "expired" : "denied")
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener(TICKET_REPLY_APPROVAL_EVENT, onReplyApproval)
    onCleanup(() => window.removeEventListener(TICKET_REPLY_APPROVAL_EVENT, onReplyApproval))
  }
  const [macroOpen, setMacroOpen] = createSignal(false)
  const [macros, setMacros] = createSignal<ReplyTemplate[]>([])
  const [macrosLoaded, setMacrosLoaded] = createSignal(false)
  const [macrosLoading, setMacrosLoading] = createSignal(false)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  // Both tabs write in the shared editor, which takes the tab's preset: a
  // note is markdown read as such in the conversation, a reply goes out as
  // formatted email (markdownToEmail, as the server converts agent replies).
  let editor: RichEditorHandle | undefined
  const dictation = useDictation({ target: () => editor })

  function replyFollowup(): { at?: string; reason?: string; trigger?: string } | undefined {
    if (!followupEnabled()) return undefined
    const followup = {
      at: followupAt().trim() || undefined,
      reason: followupReason().trim() || undefined,
      trigger: followupTrigger().trim() || undefined,
    }
    return followup.at || followup.reason || followup.trigger ? followup : undefined
  }

  function saveCurrentDraft(): void {
    // A pristine signature prefill is not a draft — persisting it would make
    // every visited ticket look like it has a reply in progress.
    if (mode() === "reply" && body() === replyPrefill()) return
    saveDraft(currentUserId(), props.ticketId, mode(), body(), {
      htmlBody: mode() === "reply" ? markdownToEmail(body()).html : undefined,
      followup: mode() === "reply" ? replyFollowup() : undefined,
    })
  }

  function scheduleDraftSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveCurrentDraft, 5000)
  }

  function switchMode(next: "reply" | "note"): void {
    // Another tab is another message (its own draft): a queued send is dropped.
    uploadHold.cancel()
    // One change: the editor the new tab mounts opens on that tab's text.
    batch(() => {
      setMode(next)
      setTouched(false)
      const draft = getDraft(currentUserId(), props.ticketId, next)
      setBody(draft || (next === "reply" ? replyPrefill() : ""))
    })
  }

  function handleInput(value: string): void {
    // An edit makes it a different message than the one queued; the late
    // signature is not the person's edit.
    if (!appendingSignature) uploadHold.cancel()
    setTouched(true)
    setBody(value)
    scheduleDraftSave()
  }

  // Lazy-load saved reply templates (canned-response macros) the first time the
  // picker opens. Reuses the existing user-trust `templates.list` tool (no new
  // backend), mirroring ticket-category-store.loadCategories. The wire rows are
  // snake_case (`body_text`/`created_at`); map them to the camelCase
  // ReplyTemplate shape the UI consumes.
  async function ensureMacrosLoaded(): Promise<void> {
    if (macrosLoaded() || macrosLoading()) return
    setMacrosLoading(true)
    try {
      const rows = await runTool<ReplyTemplateRow[]>(api, "tickets:templates.list", {})
      const mapped: ReplyTemplate[] = (Array.isArray(rows) ? rows : []).map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category ?? null,
        bodyText: r.body_text ?? "",
        createdAt: r.created_at ?? null,
      }))
      setMacros(mapped)
      setMacrosLoaded(true)
    } finally {
      setMacrosLoading(false)
    }
  }

  function handleMacroOpenChange(open: boolean): void {
    setMacroOpen(open)
    if (open) void ensureMacrosLoaded()
  }

  // Insert the macro body where the caret was, as typed text would be.
  function insertMacro(template: ReplyTemplate): void {
    setMacroOpen(false)
    editor?.insertMarkdown(template.bodyText)
  }

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (body().trim().length > 0) saveCurrentDraft()
  })

  // A reply that is nothing but the pristine signature prefill has no actual
  // message — treat it as empty for both the submit guard and the button.
  function hasComposedText(): boolean {
    const text = body().trim()
    if (!text) return false
    if (mode() === "reply" && text === (props.signatureText?.trim() ?? "")) return false
    return true
  }

  // The refusal names the permission the server asked for, when it says.
  function forbiddenMessage(err: ApiError): string {
    const base = i18n.t(mode() === "reply" ? "tickets.replyForbidden" : "tickets.noteForbidden")
    const scope = err.details?.missingScope
    return typeof scope === "string" && scope
      ? `${base} ${i18n.t("tickets.missingPermission", { scope })}`
      : base
  }

  async function submit(): Promise<void> {
    // While a picked file uploads, the button queues the send (or, pressed
    // again, cancels it); it fires by itself once the files are staged.
    if (uploadHold.press(() => void submit())) return
    const text = body().trim()
    const attachmentSessionId = pendingFiles().length > 0 ? (session()?.id ?? undefined) : undefined
    if (!hasComposedText() && !attachmentSessionId) return
    // An address still typed in the Cc box counts: never send without it.
    if (mode() === "reply" && ccDraft().trim() && !commitCcDraft()) return
    const replyCc = mode() === "reply" && cc().length > 0 ? [...cc()] : undefined
    setSubmitting(true)
    setError(null)
    setReplyOutcome(null)
    let submitted: "reply" | "note" | null = null
    try {
      if (mode() === "note") {
        await runTool(api, "tickets:addNote", {
          ticketId: props.ticketId,
          text,
          attachmentSessionId,
        })
        submitted = "note"
        setPendingFiles([])
        setSession(null)
        setAttachError(null)
      } else {
        // The body as written (markdown) is kept as the text part; the HTML
        // is what the customer receives.
        const htmlBody = markdownToEmail(text).html
        const followup = replyFollowup()
        const result = await runTool<{ blocked?: { approvalRequestId?: string } } | undefined>(
          api,
          "tickets:reply",
          {
            ticketId: props.ticketId,
            htmlBody,
            textBody: text,
            followup,
            attachmentSessionId,
            cc: replyCc,
          },
        )
        setPendingFiles([])
        setSession(null)
        setAttachError(null)
        // Under an org two-approver policy the reply waits for a second
        // person; it goes out (and shows in the conversation) once approved.
        if (result?.blocked?.approvalRequestId) setAwaitingSecond(result.blocked.approvalRequestId)
        else submitted = "reply"
      }
      clearDraft(currentUserId(), props.ticketId, mode())
      setBody(mode() === "reply" ? replyPrefill() : "")
      if (mode() === "reply") setTouched(false)
      void loadMessages(api, props.ticketId, { fresh: true })
      if (submitted) props.onSubmitted?.(submitted)
    } catch (err: any) {
      // A refusal for a missing scope, or an inbox whose mailbox cannot send,
      // says so in the user's language; the typed text stays in the box so
      // nothing is lost.
      const fixable = connectionErrorKey(err)
      setError(
        err instanceof ApiError && err.status === 403
          ? forbiddenMessage(err)
          : fixable
            ? i18n.t(fixable)
            : String(err?.message ?? err),
      )
    } finally {
      setSubmitting(false)
    }
  }

  // Neither tab's tool is theirs: the ticket stays readable, with no input.
  if (!canReply && !canNote) return null

  return (
    // pb-dock-clearance: the send button sits in the panel's bottom right
    // corner, where the tablet's Chats opener floats (index.css).
    <DockedComposer
      ref={(el) => {
        root = el
      }}
      class="border-t border-border px-3 pt-3 pb-dock-clearance"
      data-testid="tickets-composer"
    >
      <Composer variant={mode() === "note" ? "note" : "default"} disabled={submitting()}>
        {/* ONE ROW: the mode toggle on the left, Cc as a button (or its open
            field), the formatting tools on the right. */}
        <div
          data-testid="tickets-composer-header"
          class={cn(
            "flex min-h-[37px] items-center gap-2 border-b py-1 pr-1.5 pl-2",
            mode() === "note" ? "border-amber-900/40" : "border-border/40",
            narrow() && mode() === "reply" && ccOpen() && "flex-wrap gap-y-1",
          )}
        >
          <Composer.Tabs
            aria-label={i18n.t("tickets.ticketReplyMode")}
            class="shrink-0 border-0 p-0"
          >
            <Show when={canReply}>
              <Composer.Tab
                active={mode() === "reply"}
                onClick={() => switchMode("reply")}
                testId="tickets-composer-mode-reply"
              >
                {i18n.t("tickets.reply")}
              </Composer.Tab>
            </Show>
            <Show when={canNote}>
              <Composer.Tab
                active={mode() === "note"}
                tone="amber"
                onClick={() => switchMode(mode() === "note" && canReply ? "reply" : "note")}
                testId="tickets-composer-mode-note"
              >
                {i18n.t("tickets.internalNote")}
              </Composer.Tab>
            </Show>
          </Composer.Tabs>

          <Show when={mode() === "reply"}>
            <span class="contents" data-testid="tickets-composer-cc">
              <Show
                when={ccOpen()}
                fallback={
                  <button
                    type="button"
                    class="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                    aria-expanded="false"
                    aria-controls="tickets-composer-cc-field"
                    aria-label={
                      cc().length > 0
                        ? i18n.t("tickets.ccEdit", { addresses: cc().join(", ") })
                        : i18n.t("tickets.ccAdd")
                    }
                    disabled={submitting()}
                    data-testid="tickets-composer-cc-toggle"
                    onClick={openCc}
                  >
                    {i18n.t("tickets.cc")}
                    <Show when={cc().length > 0}>
                      <span
                        class="inline-grid h-4 min-w-4 place-items-center rounded px-1 font-mono text-[10.5px] text-text bg-accent/15"
                        data-testid="tickets-composer-cc-count"
                      >
                        {cc().length}
                      </span>
                    </Show>
                  </button>
                }
              >
                <div
                  id="tickets-composer-cc-field"
                  class={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[12px]",
                    narrow() && "order-last basis-full flex-wrap py-0.5",
                  )}
                  data-testid="tickets-composer-cc-field"
                  onFocusOut={(e) => {
                    const next = e.relatedTarget as Node | null
                    if (next && e.currentTarget.contains(next)) return
                    // A removed chip's button leaves the page with the focus.
                    if (!next && !(e.target as Node).isConnected) return
                    closeCc()
                  }}
                >
                  <label for="tickets-composer-cc-input" class="shrink-0 text-text-tertiary">
                    {i18n.t("tickets.cc")}
                  </label>
                  <For each={cc()}>
                    {(addr) => (
                      <span
                        class="inline-flex min-w-0 max-w-[14rem] items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-text"
                        data-testid="tickets-composer-cc-chip"
                      >
                        <span class="truncate" title={addr}>
                          {addr}
                        </span>
                        <button
                          type="button"
                          class="shrink-0 text-text-tertiary hover:text-text"
                          aria-label={i18n.t("tickets.ccRemove", { address: addr })}
                          data-testid="tickets-composer-cc-remove"
                          disabled={submitting()}
                          onClick={() => removeCc(addr)}
                        >
                          ×
                        </button>
                      </span>
                    )}
                  </For>
                  <input
                    ref={ccInput}
                    id="tickets-composer-cc-input"
                    type="text"
                    inputMode="email"
                    autocomplete="off"
                    class="min-w-[7.5rem] flex-1 bg-transparent text-text outline-none placeholder:text-text-tertiary"
                    placeholder={i18n.t("tickets.ccPlaceholder")}
                    value={ccDraft()}
                    disabled={submitting()}
                    data-testid="tickets-composer-cc-input"
                    onInput={(e) => {
                      setCcDraft(e.currentTarget.value)
                      setCcError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "," || e.key === ";") {
                        e.preventDefault()
                        commitCcDraft()
                      } else if (e.key === "Escape") {
                        e.preventDefault()
                        e.stopPropagation()
                        closeCc()
                      } else if (e.key === "Backspace" && !ccDraft() && cc().length > 0) {
                        removeCc(cc()[cc().length - 1]!)
                      }
                    }}
                  />
                </div>
              </Show>
            </span>
          </Show>

          <div
            ref={setToolbarHost}
            class="flex min-w-0 flex-1 justify-end"
            data-testid="tickets-composer-toolbar"
          />
        </div>

        <Show when={mode() === "reply"}>
          <Show when={ccLeftOut() > 0}>
            <div
              class="px-3 pt-1 text-[11px] text-text-tertiary"
              data-testid="tickets-composer-cc-left-out"
            >
              {i18n.t("tickets.ccLeftOut", { count: ccLeftOut(), max: MAX_REPLY_CC })}
            </div>
          </Show>
          <Show when={ccError()}>
            <div
              class="px-3 pt-1 text-[11px] text-red-400"
              role="alert"
              data-testid="tickets-composer-cc-error"
            >
              {ccError()}
            </div>
          </Show>
        </Show>

        {/* Staged files on top, left at the text's edge, as in chat. */}
        <StagedAttachmentChips
          files={pendingFiles()}
          onRemoved={(f) => {
            uploadHold.cancel()
            setPendingFiles((p) => p.filter((x) => x.id !== f.id))
          }}
          onRestored={(f, i) => setPendingFiles((p) => restoreStaged(p, f, i))}
          error={attachError()}
          disabled={submitting()}
          uploadParentKey={sessionParentKey()}
        />

        <Composer.EditorSlot class="!py-1.5">
          {/* Keyed on the tab: the editor takes its preset when it mounts. */}
          <Show when={mode()} keyed>
            {(m) => (
              <div class="min-w-0">
                <RichEditor
                  preset={m === "note" ? "full" : "minimal"}
                  toolbar="always"
                  toolbarMount={toolbarHost()}
                  toolbarOverflow={narrow() ? "scroll" : "more"}
                  // Scrolling, the row starts at its first tool; folding, it
                  // ends at the header's right edge.
                  toolbarClass={narrow() ? "w-full shrink" : "w-full shrink justify-end"}
                  value={body()}
                  onChange={handleInput}
                  onSubmit={m === "note" ? () => void submit() : undefined}
                  ref={(handle) => {
                    editor = handle
                    if (signaturePending) appendSignature()
                  }}
                  placeholder={
                    m === "note"
                      ? i18n.t("tickets.internalNoteVisibleToAgentsOnly")
                      : i18n.t("tickets.replyToCustomer")
                  }
                  editorClass={
                    m === "note"
                      ? "max-h-60 min-h-[2.5rem] overflow-y-auto text-[13.5px]"
                      : "max-h-[240px] overflow-y-auto text-[13.5px] leading-5"
                  }
                  data-testid="tickets-composer-body"
                />
              </div>
            )}
          </Show>
        </Composer.EditorSlot>

        <Show when={mode() === "reply" && followupEnabled()}>
          <div
            class="grid gap-2 border-t border-border/40 px-3 py-2 sm:grid-cols-3"
            data-testid="tickets-followup-fields"
          >
            <input
              type="datetime-local"
              class="rounded-md bg-surface px-2 py-1 text-[12px] text-text ring-1 ring-border focus:ring-accent/40 focus:outline-none"
              data-testid="tickets-followup-at"
              value={followupAt()}
              onInput={(e) => {
                setFollowupAt(e.currentTarget.value)
                scheduleDraftSave()
              }}
            />
            <input
              type="text"
              class="rounded-md bg-surface px-2 py-1 text-[12px] text-text ring-1 ring-border focus:ring-accent/40 focus:outline-none"
              data-testid="tickets-followup-reason"
              placeholder={i18n.t("tickets.reason")}
              value={followupReason()}
              onInput={(e) => {
                setFollowupReason(e.currentTarget.value)
                scheduleDraftSave()
              }}
            />
            <input
              type="text"
              class="rounded-md bg-surface px-2 py-1 text-[12px] text-text ring-1 ring-border focus:ring-accent/40 focus:outline-none"
              data-testid="tickets-followup-trigger"
              placeholder={i18n.t("tickets.triggerOptional")}
              value={followupTrigger()}
              onInput={(e) => {
                setFollowupTrigger(e.currentTarget.value)
                scheduleDraftSave()
              }}
            />
          </div>
        </Show>

        <Composer.Footer>
          <RecorderRow dictation={dictation}>
            <AttachmentUploadButton
              parent={async () => ({
                app: "kernel",
                entityType: "file_upload_session",
                entityId: (await ensureSession()).id,
              })}
              onUploaded={(row) => {
                setAttachError(null)
                setPendingFiles((p) => [...p, row])
                props.onFileUploaded?.()
              }}
              onError={(err) => setAttachError(attachmentErrorMessage(err))}
              disabled={submitting()}
            />
            <ComposerAssist target={() => editor} disabled={submitting()} />
            <Show when={mode() === "reply"}>
              <PopupMenu open={macroOpen()} onOpenChange={handleMacroOpenChange}>
                <PopupMenu.Trigger
                  aria-label={i18n.t("tickets.insertMacro")}
                  class="inline-flex items-center justify-center rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
                >
                  <button
                    type="button"
                    data-testid="tickets-composer-macro-picker"
                    title={i18n.t("tickets.insertMacro")}
                    disabled={submitting()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void ensureMacrosLoaded()}
                    class="inline-flex items-center justify-center"
                  >
                    <MessageSquareText size={16} aria-hidden="true" />
                  </button>
                </PopupMenu.Trigger>
                <PopupMenu.Content aria-label={i18n.t("tickets.insertMacro")} class="w-64">
                  <Show
                    when={!macrosLoading()}
                    fallback={
                      <div
                        class="px-3 py-2 text-[12px] text-text-tertiary"
                        data-testid="tickets-macro-loading"
                      >
                        {i18n.t("tickets.loadingMacros")}
                      </div>
                    }
                  >
                    <Show
                      when={macros().length > 0}
                      fallback={
                        <div
                          class="px-3 py-2 text-[12px] text-text-tertiary"
                          data-testid="tickets-macro-empty"
                        >
                          {i18n.t("tickets.noSavedMacros")}
                        </div>
                      }
                    >
                      <For each={macros()}>
                        {(template) => (
                          <PopupMenu.Item
                            textValue={template.name}
                            onSelect={() => insertMacro(template)}
                          >
                            <span
                              data-testid={`tickets-macro-${template.id}`}
                              class="flex min-w-0 flex-col"
                            >
                              <span class="truncate text-text">{template.name}</span>
                              <Show when={template.category}>
                                <span class="truncate text-[11px] text-text-tertiary">
                                  {template.category}
                                </span>
                              </Show>
                            </span>
                          </PopupMenu.Item>
                        )}
                      </For>
                    </Show>
                  </Show>
                </PopupMenu.Content>
              </PopupMenu>
            </Show>
            <Show when={mode() === "reply"}>
              <label class="inline-flex items-center gap-1.5 text-text-secondary">
                <input
                  type="checkbox"
                  data-testid="tickets-followup-toggle"
                  checked={followupEnabled()}
                  onChange={(e) => {
                    setFollowupEnabled(e.currentTarget.checked)
                    scheduleDraftSave()
                  }}
                  class="h-3 w-3 rounded border-border bg-surface accent-accent"
                />
                {i18n.t("tickets.setFollowUp")}
              </label>
            </Show>
            <Show when={awaitingSecond()}>
              <span
                class="text-[11px] text-amber-300"
                data-testid="tickets-composer-awaiting-second-approver"
              >
                {i18n.t("tickets.awaitingSecondApprover")}
              </span>
            </Show>
            <Show when={replyOutcome()}>
              {(outcome) => (
                <span
                  class="text-[11px] text-red-400"
                  data-testid="tickets-composer-reply-outcome"
                  data-outcome={outcome()}
                >
                  {outcome() === "expired"
                    ? i18n.t("tickets.replyApprovalExpired")
                    : i18n.t("tickets.replyApprovalDenied")}
                </span>
              )}
            </Show>
            <Show when={error()}>
              <span
                class="text-[11px] text-red-400 truncate"
                data-testid="tickets-composer-error"
                title={error() ?? undefined}
              >
                {error()}
              </span>
            </Show>
            {/* Who the press reaches, next to Send: the customer and how many
                in Cc, or the team for a note. */}
            <Show
              when={mode() === "reply"}
              fallback={
                <span
                  class={cn(
                    "ml-auto min-w-0 truncate text-[10px] uppercase tracking-wider text-text-tertiary",
                    narrow() && "sr-only",
                  )}
                >
                  {i18n.t("tickets.postsImmediately")}
                </span>
              }
            >
              <span
                class={cn(
                  "ml-auto min-w-0 truncate text-[10px] uppercase tracking-wider text-text-tertiary",
                  narrow() && "sr-only",
                )}
                data-testid="tickets-composer-recipients"
              >
                {recipientsLabel()}
              </span>
            </Show>
            {/* The mic immediately left of Send; the pair at the row's end. */}
            <div class="flex shrink-0 items-center gap-1">
              <DictationMic dictation={dictation} disabled={submitting()} />
              <Composer.Submit
                class="ml-0"
                onClick={() => void submit()}
                // A file on its way counts as something to send: the press queues.
                disabled={
                  submitting() ||
                  (!hasComposedText() && pendingFiles().length === 0 && !uploadHold.held())
                }
                loading={submitting()}
                label={uploadHoldLabel(i18n.t, uploadHold)}
                pressed={uploadHold.held() ? uploadHold.queued() : undefined}
                testId="tickets-composer-submit"
                // Says whether the press reaches the customer (a tour guard checks it).
                action={mode() === "note" ? "add-note" : "send-reply"}
              >
                {submitting()
                  ? i18n.t("kernel.common.sending")
                  : uploadHold.queued()
                    ? i18n.t("kernel.filesUi.sendQueued")
                    : mode() === "reply"
                      ? i18n.t("tickets.sendReply")
                      : i18n.t("tickets.addNote")}
              </Composer.Submit>
            </div>
          </RecorderRow>
        </Composer.Footer>
      </Composer>
    </DockedComposer>
  )
}
