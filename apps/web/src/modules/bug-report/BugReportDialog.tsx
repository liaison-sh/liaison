// SPDX-License-Identifier: FSL-1.1-ALv2
// In-app bug reporter — files a ticket into the deployment's bug inbox with the
// user's description, optional screenshots/recordings, plus the recent client
// log buffer for forensics.
//
// When the server allows it, the reporter may also send the report to the
// Liaison team: an unticked box; the first tick freezes the client logs and
// shows the exact payload (the server freezes its errors in a snapshot), a
// second box adds the reporter's email, and each attachment has its own
// unticked box. Every change re-requests the preview from the same snapshot;
// the submit carries the previewed digest, which the server checks before it
// files anything (docs/self-hosting/liaison-team.md).
//
// When the operator sends bug reports only to the Liaison team (team-only), the
// box is replaced by a fixed line: the preview is always on, the email box is
// ticked (and can be unticked), nothing is filed on this server, and the
// reports an agent prepared for the reporter are listed with their Send card.

import { Paperclip, X } from "lucide-solid"
import type { Component } from "solid-js"
import { batch, createEffect, createResource, createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { getRecentLogs } from "~/lib/logger"
import {
  type AttachmentRejection,
  encodeFileBase64,
  formatFileSize,
  MAX_ATTACHMENTS,
  MAX_FORWARD_ATTACHMENT_BYTES,
  mergeSelection,
} from "~/modules/bug-report/attachment-encoding"
import { type BugReportDraft, BugReportDraftCard } from "~/modules/bug-report/BugReportDraftCard"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface BugReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const REJECTION_KEYS: Record<AttachmentRejection, string> = {
  too_many: "kernel.bugReport.tooManyFiles",
  file_too_large: "kernel.bugReport.fileTooLarge",
  total_too_large: "kernel.bugReport.totalTooLarge",
}

/** What `POST /bug-reports/forward-preview` answers. */
interface ForwardPreview {
  snapshotId: string
  data: unknown
  attachments: Array<{ index: number; tooLarge: boolean; blocked: boolean }>
  digest: string
}

const PREVIEW_DEBOUNCE_MS = 400

export const BugReportDialog: Component<BugReportDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [description, setDescription] = createSignal("")
  const [files, setFiles] = createSignal<File[]>([])
  const [sending, setSending] = createSignal(false)
  let fileInputRef: HTMLInputElement | undefined

  // ── Forwarding to the Liaison team ────────────────────────────────────────
  const OFF = { available: false, teamOnly: false }
  const [forwarding, { mutate: setForwarding, refetch: refetchForwarding }] = createResource(
    () => props.open,
    async () => {
      try {
        const res = await api.get<{ available: boolean; teamOnly?: boolean }>(
          "/bug-reports/forwarding",
        )
        const available = res?.available === true
        return { available, teamOnly: available && res?.teamOnly === true }
      } catch {
        return OFF
      }
    },
  )
  const teamOnly = () => forwarding()?.teamOnly === true
  // Reports an agent prepared for this reporter (team-only), each with its own Send card.
  const [drafts] = createResource(
    () => (props.open && teamOnly() ? true : null),
    async () => {
      try {
        return (await api.get<BugReportDraft[]>("/bug-reports/drafts")) ?? []
      } catch {
        return []
      }
    },
  )
  const [forward, setForward] = createSignal(false)
  const [includeEmail, setIncludeEmail] = createSignal(false)
  const [tickedFiles, setTickedFiles] = createSignal<number[]>([])
  const [preview, setPreview] = createSignal<ForwardPreview | null>(null)
  const [previewFailed, setPreviewFailed] = createSignal(false)
  // Frozen at the first tick, then used for both the local report and the forward.
  let frozenLogs: string[] | null = null
  let snapshotId: string | undefined
  let previewSeq = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  const encoded = new WeakMap<File, Promise<string>>()

  const encode = (file: File): Promise<string> => {
    let p = encoded.get(file)
    if (!p) {
      p = encodeFileBase64(file)
      encoded.set(file, p)
    }
    return p
  }

  async function formBody(): Promise<Record<string, unknown>> {
    const attachments = await Promise.all(
      files().map(async (file) => ({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        bytesBase64: await encode(file),
      })),
    )
    return {
      description: description().trim(),
      clientLogs: frozenLogs ?? getRecentLogs(),
      context: {
        url: window.location.href,
        userAgent: navigator.userAgent,
      },
      ...(attachments.length > 0 ? { attachments } : {}),
    }
  }

  function forwardUnavailable(): void {
    // Already switched off (a preview and a send can both be refused): one message only.
    if (!forward() && forwarding()?.available !== true) return
    const wasTeamOnly = teamOnly()
    // Nothing still pending may ask again: a scheduled or in-flight preview is dropped.
    previewSeq++
    if (debounce) clearTimeout(debounce)
    // One batch, forwarding OFF included: unbatched, `setForward(false)` alone ran the
    // team-only effect below while team-only still read true, which ticked the box back on
    // and sent a fresh preview, refused in turn with a second message.
    batch(() => {
      setForwarding(OFF)
      setForward(false)
      setIncludeEmail(false)
      setTickedFiles([])
      setPreview(null)
    })
    addToast({
      message: i18n.t(
        wasTeamOnly
          ? "kernel.bugReport.teamOnlyUnavailable"
          : "kernel.bugReport.forwardUnavailable",
      ),
      type: "error",
    })
  }

  function showNewPreview(details: Record<string, unknown> | undefined): boolean {
    const next = details as ForwardPreview | undefined
    if (!next?.snapshotId || !next.digest) return false
    snapshotId = next.snapshotId
    setPreview(next)
    return true
  }

  async function requestPreview(): Promise<void> {
    if (!forward()) return
    const seq = ++previewSeq
    setPreviewFailed(false)
    try {
      const next = await api.post<ForwardPreview>(
        "/bug-reports/forward-preview",
        {
          ...(await formBody()),
          includeEmail: includeEmail(),
          attachmentIndexes: tickedFiles(),
          ...(snapshotId ? { snapshotId } : {}),
        },
        { suppressGlobalError: true },
      )
      if (seq !== previewSeq || !forward()) return
      snapshotId = next.snapshotId
      setPreview(next)
    } catch (err) {
      if (seq !== previewSeq) return
      if (err instanceof ApiError && err.code === "FORWARDING_UNAVAILABLE") forwardUnavailable()
      else {
        setPreview(null)
        setPreviewFailed(true)
      }
    }
  }

  function schedulePreview(): void {
    if (!forward()) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void requestPreview(), PREVIEW_DEBOUNCE_MS)
  }

  function toggleForward(on: boolean): void {
    setForward(on)
    if (on) {
      frozenLogs ??= getRecentLogs()
      void requestPreview()
    } else {
      previewSeq++
      setIncludeEmail(false)
      setTickedFiles([])
      setPreview(null)
      setPreviewFailed(false)
    }
  }

  // Team-only: the preview is always on and the email ticked by default (D5).
  createEffect(() => {
    if (props.open && teamOnly() && !forward()) {
      setIncludeEmail(true)
      toggleForward(true)
    }
  })

  function toggleFile(index: number, on: boolean): void {
    setTickedFiles((prev) =>
      on ? [...new Set([...prev, index])].sort((a, b) => a - b) : prev.filter((i) => i !== index),
    )
    void requestPreview()
  }

  const fileState = (file: File, index: number) => {
    const listed = preview()?.attachments.find((a) => a.index === index)
    const tooLarge = file.size > MAX_FORWARD_ATTACHMENT_BYTES || listed?.tooLarge === true
    return { tooLarge, blocked: !tooLarge && listed?.blocked === true }
  }

  // ── The form ──────────────────────────────────────────────────────────────
  function handleFilePick(e: Event): void {
    const list = (e.target as HTMLInputElement).files
    if (!list || list.length === 0) return
    const { files: merged, rejections } = mergeSelection(files(), Array.from(list))
    setFiles(merged)
    for (const rejection of rejections) {
      addToast({ message: i18n.t(REJECTION_KEYS[rejection]), type: "error" })
    }
    if (fileInputRef) fileInputRef.value = ""
    schedulePreview()
  }

  function removeFile(index: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    // Indexes shift: nothing stays ticked by accident.
    setTickedFiles([])
    schedulePreview()
  }

  function reset(): void {
    setDescription("")
    setFiles([])
    setForward(false)
    setIncludeEmail(false)
    setTickedFiles([])
    setPreview(null)
    frozenLogs = null
    snapshotId = undefined
  }

  async function submit(): Promise<void> {
    if (!description().trim() || sending()) return
    const approved = forward() ? preview() : null
    if (forward() && !approved) return
    setSending(true)
    try {
      const result = await api.post<{
        attachmentsSkipped?: Array<{ filename: string }>
        forwarded?: string
        teamOnly?: boolean
        messageId?: string
      }>(
        "/bug-reports",
        {
          ...(await formBody()),
          ...(approved
            ? {
                forward: {
                  includeEmail: includeEmail(),
                  snapshotId: approved.snapshotId,
                  digest: approved.digest,
                  attachmentIndexes: tickedFiles(),
                  ...(teamOnly() ? { teamOnly: true } : {}),
                },
              }
            : {}),
        },
        { suppressGlobalError: true },
      )
      if (result?.teamOnly) {
        addToast({
          message: i18n.t("kernel.bugReport.teamOnlySent", { reference: result.messageId ?? "" }),
          type: "success",
        })
      } else if (result?.attachmentsSkipped && result.attachmentsSkipped.length > 0) {
        addToast({ message: i18n.t("kernel.bugReport.attachmentsSkipped"), type: "error" })
      } else if (result?.forwarded === "queued") {
        addToast({ message: i18n.t("kernel.bugReport.forwardQueued"), type: "success" })
      } else {
        addToast({ message: i18n.t("kernel.bugReport.sent"), type: "success" })
      }
      // One batch: the team-only effect must not re-open the preview of a closing dialog.
      batch(() => {
        reset()
        props.onOpenChange(false)
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === "FORWARD_PAYLOAD_CHANGED") {
        if (showNewPreview(err.details)) {
          addToast({ message: i18n.t("kernel.bugReport.forwardChanged"), type: "error" })
          return
        }
      }
      if (err instanceof ApiError && err.code === "FORWARDING_UNAVAILABLE") {
        forwardUnavailable()
        return
      }
      if (err instanceof ApiError && err.code === "FORWARD_REQUIRED") {
        // Team-only went on while the dialog was open: show its preview first.
        void refetchForwarding()
        addToast({ message: i18n.t("kernel.bugReport.teamOnlyLine"), type: "error" })
        return
      }
      addToast({ message: i18n.t("kernel.bugReport.failed"), type: "error" })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Capped at the viewport and scrolling: a long report or a stack of agent drafts once
          pushed Send below the screen with no way to reach it. */}
      <Dialog.Content
        class="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto"
        data-testid="bug-report-dialog"
      >
        <Dialog.Title>{i18n.t("kernel.bugReport.title")}</Dialog.Title>
        <Dialog.Description>{i18n.t("kernel.bugReport.description")}</Dialog.Description>
        <Show when={teamOnly() && (drafts() ?? []).length > 0}>
          <div class="mt-3" data-testid="bug-report-drafts">
            <p class="text-xs font-medium text-text-secondary">
              {i18n.t("kernel.bugReport.draftsTitle")}
            </p>
            <For each={drafts() ?? []}>{(d) => <BugReportDraftCard draftId={d.draftId} />}</For>
          </div>
        </Show>
        <textarea
          class="mt-4 min-h-[140px] w-full resize-y rounded border border-border bg-surface-sunken px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="bug-report-description"
          placeholder={i18n.t("kernel.bugReport.placeholder")}
          value={description()}
          onInput={(e) => {
            setDescription(e.currentTarget.value)
            schedulePreview()
          }}
        />
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <label
            data-testid="bug-report-attach-button"
            class="inline-flex cursor-pointer items-center gap-1 rounded-sm border border-border bg-surface px-2 py-1 text-[11px] text-text hover:bg-surface-hover"
            aria-disabled={sending() || files().length >= MAX_ATTACHMENTS}
          >
            <Paperclip size={12} />
            <span>{i18n.t("kernel.bugReport.attach")}</span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              data-testid="bug-report-attach-input"
              class="hidden"
              onChange={handleFilePick}
              disabled={sending() || files().length >= MAX_ATTACHMENTS}
            />
          </label>
          <span class="text-xs text-text-tertiary">{i18n.t("kernel.bugReport.attachHint")}</span>
        </div>
        <Show when={files().length > 0}>
          <ul class="mt-2 flex flex-wrap gap-2" data-testid="bug-report-attachment-list">
            <For each={files()}>
              {(file, index) => (
                <li class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-sunken px-2 py-1 text-[11px] text-text">
                  <span class="max-w-[180px] truncate">{file.name}</span>
                  <span class="text-text-tertiary">{formatFileSize(file.size)}</span>
                  <button
                    type="button"
                    class="text-text-tertiary hover:text-text"
                    aria-label={`${i18n.t("kernel.bugReport.removeFile")} ${file.name}`}
                    disabled={sending()}
                    onClick={() => removeFile(index())}
                  >
                    <X size={12} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p class="mt-2 text-xs text-text-tertiary">{i18n.t("kernel.bugReport.logsNotice")}</p>

        <Show when={forwarding()?.available === true}>
          <div class="mt-3 flex flex-col gap-2">
            <Show
              when={!teamOnly()}
              fallback={
                <p class="text-sm text-text" data-testid="bug-report-team-only-line">
                  {i18n.t("kernel.bugReport.teamOnlyLine")}
                </p>
              }
            >
              <label class="flex items-start gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  data-testid="bug-report-forward"
                  checked={forward()}
                  disabled={sending()}
                  onChange={(e) => toggleForward(e.currentTarget.checked)}
                />
                <span>{i18n.t("kernel.bugReport.forward")}</span>
              </label>
            </Show>
            <Show when={forward()}>
              <label class="ml-5 flex items-start gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  data-testid="bug-report-forward-email"
                  checked={includeEmail()}
                  disabled={sending()}
                  onChange={(e) => {
                    setIncludeEmail(e.currentTarget.checked)
                    void requestPreview()
                  }}
                />
                <span>{i18n.t("kernel.bugReport.forwardEmail")}</span>
              </label>
              <Show when={files().length > 0}>
                <div class="ml-5" data-testid="bug-report-forward-files">
                  <p class="text-xs text-text-secondary">
                    {i18n.t("kernel.bugReport.forwardFiles")}
                  </p>
                  <ul class="mt-1 flex flex-col gap-1">
                    <For each={files()}>
                      {(file, index) => (
                        <li class="text-xs text-text">
                          <label class="flex items-start gap-2">
                            <input
                              type="checkbox"
                              data-testid={`bug-report-forward-file-${index()}`}
                              checked={tickedFiles().includes(index())}
                              disabled={
                                sending() ||
                                fileState(file, index()).tooLarge ||
                                fileState(file, index()).blocked
                              }
                              onChange={(e) => toggleFile(index(), e.currentTarget.checked)}
                            />
                            <span class="max-w-[220px] truncate">{file.name}</span>
                            <span class="text-text-tertiary">{formatFileSize(file.size)}</span>
                          </label>
                          <Show when={fileState(file, index()).tooLarge}>
                            <p class="ml-5 text-text-tertiary">
                              {i18n.t("kernel.bugReport.forwardFileTooLarge")}
                            </p>
                          </Show>
                          <Show when={fileState(file, index()).blocked}>
                            <p class="ml-5 text-text-tertiary">
                              {i18n.t("kernel.bugReport.forwardFileBlocked")}
                            </p>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <div class="ml-5">
                <p class="text-xs text-text-secondary">
                  {i18n.t("kernel.bugReport.forwardPreviewTitle")}
                </p>
                <Show
                  when={preview()}
                  fallback={
                    <p class="text-xs text-text-tertiary">
                      {previewFailed()
                        ? i18n.t("kernel.bugReport.forwardPreviewFailed")
                        : i18n.t("kernel.bugReport.forwardPreviewLoading")}
                    </p>
                  }
                >
                  {(p) => (
                    <pre
                      data-testid="bug-report-forward-preview"
                      class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface-sunken p-2 text-[11px] text-text"
                    >
                      {JSON.stringify(p().data, null, 2)}
                    </pre>
                  )}
                </Show>
                <p class="mt-1 text-xs text-text-tertiary">
                  {i18n.t("kernel.bugReport.forwardEnvelopeNote")}
                </p>
              </div>
            </Show>
          </div>
        </Show>

        <div class="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            {i18n.t("kernel.bugReport.cancel")}
          </Button>
          <Button
            size="sm"
            data-testid="bug-report-send"
            loading={sending()}
            disabled={!description().trim() || (forward() && !preview())}
            onClick={() => submit()}
          >
            {i18n.t("kernel.bugReport.send")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
