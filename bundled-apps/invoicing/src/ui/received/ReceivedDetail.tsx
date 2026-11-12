// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One received supplier e-invoice (/invoicing/received/:receivedId): its facts and totals (the
// file's own figures shown beside the platform's when they differ), its files (the platform's PDF
// previewed, the original as received downloaded, an XML original never rendered), its status
// history, and the decisions the platform allows now. Refuse / dispute: an inline reason picker
// (the platform's reasons in plain words) and an optional note, then a confirmation; it asks for
// approval and the tab says it waits. On a refused, rejected or paid invoice no action is shown;
// the tab says why.
import { app, fetchBlob, openFile as hostOpenFile, navigate } from "@liaison/host"
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { tr } from "../i18n"
import { Button, ConfirmDialog, inputClass, SectionLabel, Select } from "../kit"
import { confirmText, detailView, type ReceivedDetailData } from "./view"

/** The invoice, or why it could not be read: missing is not the same as unreachable. */
type Loaded =
  | { ok: true; data: ReceivedDetailData }
  | { ok: false; notFound: boolean; message: string }

async function load(id: string): Promise<Loaded> {
  try {
    const res = await app.invokeTool<
      ReceivedDetailData & { error?: { code?: string; message?: string } }
    >("received_einvoices_get", { received_id: id })
    if (res && res.status === "ok") return { ok: true, data: res }
    return {
      ok: false,
      notFound: res?.error?.code === "not_found",
      message: res?.error?.message ?? tr("The invoice could not be loaded."),
    }
  } catch (e) {
    return {
      ok: false,
      notFound: false,
      message: e instanceof Error ? e.message : tr("The invoice could not be loaded."),
    }
  }
}

async function openFile(fileId: string, filename: string, preview: boolean): Promise<void> {
  const blob = await fetchBlob(`/api/files/${fileId}/inline`)
  // A PDF opens in the browser's viewer; anything else (the XML original) is only saved, typed as
  // opaque bytes so no browser ever renders it.
  const typed = new Blob([blob], { type: preview ? "application/pdf" : "application/octet-stream" })
  // The desktop webview opens no tab: there the host opens a PDF in the system viewer. The XML
  // original keeps the browser save below.
  if (/\.pdf$/i.test(filename) && (await hostOpenFile(typed, filename))) return
  const url = URL.createObjectURL(typed)
  if (preview) {
    window.open(url, "_blank", "noopener")
  } else {
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const InvoicingReceivedDetail: Component<{ entityId?: string }> = (props) => {
  const [loaded, { refetch }] = createResource(() => props.entityId ?? null, load)
  const view = () => {
    const l = loaded()
    return l && l.ok ? detailView(l.data) : null
  }
  const failure = () => {
    const l = loaded()
    return l && !l.ok ? l : null
  }
  const [choosing, setChoosing] = createSignal<string | null>(null)
  const [reason, setReason] = createSignal("")
  const [comment, setComment] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ text: string; isError: boolean } | null>(null)

  const chosen = () => view()?.actions.find((a) => a.action === choosing()) ?? null
  const chosenReasonLabel = () => chosen()?.reasons.find((r) => r.value === reason())?.label ?? null
  const canSubmit = () => {
    const a = chosen()
    return !!a && (!a.needsReason || reason() !== "")
  }

  const startAction = (action: string) => {
    setChoosing(action)
    setReason("")
    setComment("")
    setNote(null)
  }

  const submit = async () => {
    const a = chosen()
    if (!a || !props.entityId) return
    setBusy(true)
    try {
      const r = await app.invokeTool<{ status: string; error?: { message?: string } }>(
        "received_einvoice_action_request",
        {
          received_id: props.entityId,
          action: a.action,
          reason: a.needsReason ? reason() : null,
          comment: comment().trim() || null,
        },
      )
      if (r?.status === "error")
        setNote({ text: r.error?.message ?? tr("The request failed."), isError: true })
      else {
        // A request by someone who may decide it runs at once (approvals are for agents).
        setNote({
          text:
            r?.status === "staged"
              ? tr("Sent for approval. Nothing reaches the supplier before a person approves.")
              : tr("Done: the supplier's platform was told."),
          isError: false,
        })
        setChoosing(null)
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : tr("The request failed."), isError: true })
    } finally {
      setBusy(false)
      setConfirming(false)
      refetch()
    }
  }

  const refresh = async () => {
    if (!props.entityId) return
    setBusy(true)
    setNote(null)
    try {
      const r = await app.invokeTool<{
        status: string
        files_pending?: boolean
        error?: { message?: string }
      }>("received_einvoices_refresh", { received_id: props.entityId })
      if (r?.status === "error")
        setNote({
          text: tr("Refresh failed: {{reason}}", {
            reason: r.error?.message ?? tr("the platform could not be reached."),
          }),
          isError: true,
        })
    } catch (e) {
      setNote({
        text: tr("Refresh failed: {{reason}}", {
          reason: e instanceof Error ? e.message : tr("the platform could not be reached."),
        }),
        isError: true,
      })
    } finally {
      setBusy(false)
      refetch()
    }
  }

  return (
    <div
      data-testid="invoicing-received-detail"
      class="flex h-full min-h-0 flex-col gap-4 overflow-auto p-5 text-[12.5px]"
    >
      <Switch>
        <Match when={failure()?.notFound}>
          <div data-testid="received-detail-missing" class="text-text-tertiary">
            {tr("This received invoice could not be found.")}{" "}
            <a
              class="text-accent"
              href="/invoicing/received"
              onClick={(e) => (e.preventDefault(), navigate("/invoicing/received"))}
            >
              {tr("Back to Received")}
            </a>
          </div>
        </Match>
        <Match when={failure()}>
          {(f) => (
            <div
              data-testid="received-detail-error"
              class="flex max-w-[60ch] flex-col items-start gap-2 text-text-secondary"
            >
              <span>
                {tr("The invoice could not be loaded: {{reason}}", { reason: f().message })}
              </span>
              <Button testid="received-detail-retry" variant="ghost" onClick={() => refetch()}>
                {tr("Try again")}
              </Button>
            </div>
          )}
        </Match>
        <Match when={!loaded()}>
          <div data-testid="received-detail-loading" class="text-text-tertiary">
            {tr("Loading…")}
          </div>
        </Match>
      </Switch>
      <Show when={view()}>
        {(v) => (
          <>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <h1 data-testid="received-detail-title" class="text-[15px] font-semibold text-text">
                  {v().title}
                </h1>
                <span data-testid="received-detail-status" class="text-text-secondary">
                  {v().status}
                </span>
                <Show when={v().statusNote}>
                  <span class="text-text-tertiary">{v().statusNote}</span>
                </Show>
              </div>
              <Show when={v().canAct}>
                <Button
                  testid="received-detail-refresh"
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => void refresh()}
                >
                  {busy() ? tr("Checking…") : tr("Refresh")}
                </Button>
              </Show>
            </div>

            <div class="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
              <For each={v().facts}>
                {(f) => (
                  <div data-testid={f.testid} class="flex gap-2">
                    <span class="w-32 shrink-0 text-text-tertiary">{f.label}</span>
                    <span class="text-text">{f.value}</span>
                  </div>
                )}
              </For>
            </div>

            <div class="flex flex-col gap-1.5">
              <SectionLabel>{tr("Totals")}</SectionLabel>
              <For each={v().totals}>
                {(t) => (
                  <div data-testid={t.testid} class="flex gap-2">
                    <span class="w-40 shrink-0 text-text-tertiary">{t.label}</span>
                    <span class="font-mono tabular-nums text-text">{t.value}</span>
                    <Show when={t.file}>
                      <span class="text-text-secondary">
                        · {tr("the file says {{amount}}", { amount: t.file ?? "" })}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={v().mismatch}>
                <div data-testid="received-totals-mismatch" class="text-text-secondary">
                  {tr(
                    "The original file's totals differ from the platform's: check the invoice before paying it.",
                  )}
                </div>
              </Show>
            </div>

            <div class="flex flex-col gap-1.5">
              <SectionLabel>{tr("Files")}</SectionLabel>
              <Show
                when={v().files.length > 0}
                fallback={<span class="text-text-tertiary">{tr("No file yet.")}</span>}
              >
                <div class="flex flex-wrap gap-2">
                  <For each={v().files}>
                    {(f) => (
                      <Show
                        when={f.previewable}
                        fallback={
                          <Button
                            testid={`${f.testid}-download`}
                            variant="ghost"
                            onClick={() => void openFile(f.file_id, f.filename, false)}
                          >
                            {tr("Download {{what}}", { what: f.label })}
                          </Button>
                        }
                      >
                        <Button
                          testid={`${f.testid}-preview`}
                          variant="ghost"
                          onClick={() => void openFile(f.file_id, f.filename, true)}
                        >
                          {tr("Preview {{what}}", { what: f.label })}
                        </Button>
                        <Button
                          testid={`${f.testid}-download`}
                          variant="ghost"
                          onClick={() => void openFile(f.file_id, f.filename, false)}
                        >
                          {tr("Download")}
                        </Button>
                      </Show>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={v().filesNote}>
                <span data-testid="received-files-pending" class="text-text-tertiary">
                  {v().filesNote}
                </span>
              </Show>
            </div>

            <div class="flex flex-col gap-1.5">
              <SectionLabel>{tr("History")}</SectionLabel>
              <ol data-testid="received-history" class="flex flex-col gap-0.5 text-text-secondary">
                <For each={v().timeline}>
                  {(e) => (
                    <li data-testid="received-history-entry">
                      <span class="font-mono text-text-tertiary">{e.at}</span> {e.text}
                    </li>
                  )}
                </For>
              </ol>
            </div>

            <div class="flex flex-col gap-2">
              <SectionLabel>{tr("Decision")}</SectionLabel>
              <Show when={v().pending}>
                <div data-testid="received-pending" class="text-text-secondary">
                  {v().pending}
                </div>
              </Show>
              <Show when={v().noActionWhy}>
                <div data-testid="received-no-action" class="text-text-tertiary">
                  {v().noActionWhy}
                </div>
              </Show>
              <Show when={v().actions.length > 0 && !choosing()}>
                <div class="flex flex-wrap gap-2">
                  <For each={v().actions}>
                    {(a) => (
                      <Button
                        testid={`received-action-${a.action}`}
                        variant="ghost"
                        onClick={() => startAction(a.action)}
                      >
                        {a.label}
                      </Button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={chosen()}>
                {(a) => (
                  <div data-testid="received-action-form" class="flex max-w-[52ch] flex-col gap-2">
                    <Show when={a().needsReason}>
                      <label class="flex flex-col gap-1">
                        <span class="text-text-tertiary">{tr("Reason")}</span>
                        <Select
                          testid="received-action-reason"
                          value={reason()}
                          onChange={setReason}
                        >
                          <option value="">{tr("Choose the reason")}</option>
                          <For each={a().reasons}>
                            {(r) => <option value={r.value}>{r.label}</option>}
                          </For>
                        </Select>
                      </label>
                    </Show>
                    <label class="flex flex-col gap-1">
                      <span class="text-text-tertiary">
                        {tr("Note (kept in Liaison, optional)")}
                      </span>
                      <textarea
                        data-testid="received-action-comment"
                        class={`${inputClass} min-h-[60px]`}
                        maxLength={500}
                        value={comment()}
                        onInput={(e) => setComment(e.currentTarget.value)}
                      />
                    </label>
                    <div class="flex gap-2">
                      <Button
                        testid="received-action-submit"
                        disabled={!canSubmit() || busy()}
                        onClick={() => setConfirming(true)}
                      >
                        {tr("Continue")}
                      </Button>
                      <Button
                        testid="received-action-cancel"
                        variant="ghost"
                        onClick={() => setChoosing(null)}
                      >
                        {tr("Cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={note()}>
                {(n) => (
                  <div
                    data-testid="received-action-note"
                    class={n().isError ? "text-text" : "text-text-secondary"}
                  >
                    {n().text}
                  </div>
                )}
              </Show>
            </div>

            <ConfirmDialog
              open={confirming()}
              title={
                chosen()?.action === "refuse"
                  ? tr("Refuse this invoice?")
                  : chosen()?.action === "dispute"
                    ? tr("Dispute this invoice?")
                    : tr("Withdraw the dispute?")
              }
              body={confirmText(chosen()?.action ?? "", chosenReasonLabel())}
              confirmLabel={tr("Confirm")}
              busy={busy()}
              onConfirm={() => void submit()}
              onCancel={() => setConfirming(false)}
              testid="received-action-confirm"
            />
          </>
        )}
      </Show>
    </div>
  )
}
