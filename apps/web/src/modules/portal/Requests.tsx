// SPDX-License-Identifier: FSL-1.1-ALv2
//
// R-04: the person's own requests and the replies on them, and a new request.
// A request is an ordinary ticket on the staff side. Text the client typed is
// shown as text. A send that fails keeps the text and offers Send again (R-10).

import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { day } from "./format"
import { ContactLine, PartFailed, requestState, Section } from "./Pages"
import { portalPost } from "./portal-api"
import type { PortalHome, PortalRequest } from "./types"

const inputClass =
  "w-full rounded-md border border-border bg-bg px-3 py-2 text-[14px] text-text focus:outline-none focus:ring-2 focus:ring-accent/40"
const primaryClass =
  "min-h-[44px] rounded-md bg-accent px-4 text-[14px] font-medium text-accent-foreground disabled:opacity-60"

type SendState = "idle" | "busy" | "failed" | "sent"

/** Stages each chosen file; answers the staged ids, or null when one was refused. */
async function stageFiles(files: File[]): Promise<{ ids: string[] } | { refused: string }> {
  const ids: string[] = []
  for (const f of files) {
    const form = new FormData()
    form.append("file", f, f.name)
    const out = await portalPost<{ fileId?: string }>("/requests/attachments", form)
    if (out.status !== 200 || !out.data?.fileId) return { refused: f.name }
    ids.push(out.data.fileId)
  }
  return { ids }
}

const NewRequest: Component<{ onSent: () => void }> = (props) => {
  const i18n = useI18n()
  const [subject, setSubject] = createSignal("")
  const [text, setText] = createSignal("")
  const [files, setFiles] = createSignal<File[]>([])
  const [state, setState] = createSignal<SendState>("idle")
  const [refusedFile, setRefusedFile] = createSignal<string | null>(null)
  const submit = async (e: Event) => {
    e.preventDefault()
    if (state() === "busy" || !subject().trim() || !text().trim()) return
    setState("busy")
    setRefusedFile(null)
    const staged = await stageFiles(files())
    if ("refused" in staged) {
      setRefusedFile(staged.refused)
      setState("failed")
      return
    }
    const out = await portalPost("/requests", {
      subject: subject().trim(),
      text: text().trim(),
      ...(staged.ids.length > 0 ? { attachmentFileIds: staged.ids } : {}),
    })
    if (out.status !== 200) {
      setState("failed")
      return
    }
    setSubject("")
    setText("")
    setFiles([])
    setState("sent")
    props.onSent()
  }
  return (
    <form data-testid="portal-new-request" class="flex flex-col gap-3" onSubmit={submit}>
      <label class="flex flex-col gap-1 text-[13px] text-text">
        {i18n.t("portal.requests.subject")}
        <input
          data-testid="portal-request-subject"
          class={inputClass}
          maxLength={200}
          value={subject()}
          onInput={(e) => setSubject(e.currentTarget.value)}
        />
      </label>
      <label class="flex flex-col gap-1 text-[13px] text-text">
        {i18n.t("portal.requests.text")}
        <textarea
          data-testid="portal-request-text"
          rows={5}
          class={inputClass}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <label class="flex flex-col gap-1 text-[13px] text-text-secondary">
        {i18n.t("portal.requests.files")}
        <input
          data-testid="portal-request-files"
          type="file"
          multiple
          class="text-[13px]"
          onChange={(e) => setFiles([...(e.currentTarget.files ?? [])].slice(0, 8))}
        />
      </label>
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          data-testid="portal-request-send"
          class={primaryClass}
          disabled={state() === "busy"}
        >
          {state() === "failed"
            ? i18n.t("portal.requests.sendAgain")
            : i18n.t("portal.requests.send")}
        </button>
        <Show when={state() === "failed"}>
          <p data-testid="portal-request-failed" role="status" class="text-[13px] text-text">
            {refusedFile()
              ? i18n.t("portal.requests.fileRefused", { name: refusedFile() ?? "" })
              : i18n.t("portal.requests.failed")}
          </p>
        </Show>
        <Show when={state() === "sent"}>
          <p data-testid="portal-request-sent" role="status" class="text-[13px] text-text">
            {i18n.t("portal.requests.sent")}
          </p>
        </Show>
      </div>
    </form>
  )
}

const Reply: Component<{ request: PortalRequest; onSent: () => void }> = (props) => {
  const i18n = useI18n()
  const [text, setText] = createSignal("")
  const [state, setState] = createSignal<SendState>("idle")
  const submit = async (e: Event) => {
    e.preventDefault()
    if (state() === "busy" || !text().trim()) return
    setState("busy")
    const out = await portalPost(`/requests/${props.request.id}/reply`, { text: text().trim() })
    if (out.status !== 200) return setState("failed")
    setText("")
    setState("sent")
    props.onSent()
  }
  return (
    <form class="mt-2 flex flex-col gap-2" onSubmit={submit}>
      <textarea
        data-testid={`portal-reply-text-${props.request.id}`}
        rows={2}
        class={inputClass}
        placeholder={i18n.t("portal.requests.replyPlaceholder")}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="flex items-center gap-3">
        <button
          type="submit"
          data-testid={`portal-reply-send-${props.request.id}`}
          class="min-h-[40px] rounded-md border border-border px-3 text-[13.5px] text-text disabled:opacity-60"
          disabled={state() === "busy"}
        >
          {state() === "failed"
            ? i18n.t("portal.requests.sendAgain")
            : i18n.t("portal.requests.reply")}
        </button>
        <Show when={state() === "failed"}>
          <p role="status" class="text-[13px] text-text">
            {i18n.t("portal.requests.failed")}
          </p>
        </Show>
      </div>
    </form>
  )
}

export const RequestsPage: Component<{ home: PortalHome; reload: () => void }> = (props) => {
  const i18n = useI18n()
  return (
    <div data-testid="portal-requests" class="flex flex-col gap-4">
      <div>
        <h1 class="text-[20px] font-semibold text-text">{i18n.t("portal.nav.requests")}</h1>
        <ContactLine name={props.home.me?.contactName} />
      </div>
      <Show when={props.home.requestsOpen}>
        <Section title={i18n.t("portal.requests.new")} testid="portal-requests-new">
          <NewRequest onSent={props.reload} />
        </Section>
      </Show>
      <Section title={i18n.t("portal.requests.yours")} testid="portal-requests-list">
        <Show when={props.home.requests} fallback={<PartFailed part="requests" />}>
          {(requests) => (
            <Show
              when={requests().length > 0}
              fallback={
                <p class="text-[13px] text-text-secondary">{i18n.t("portal.requests.none")}</p>
              }
            >
              <ul class="flex flex-col gap-4">
                <For each={requests()}>
                  {(r) => (
                    <li data-testid={`portal-request-${r.id}`} class="flex flex-col gap-2">
                      <div class="flex flex-wrap items-baseline justify-between gap-2">
                        <p class="text-[14.5px] font-medium text-text">{r.subject}</p>
                        <span class="text-[12.5px] text-text-secondary">
                          {i18n.t(`portal.requests.status.${requestState(r.status)}`)}
                        </span>
                      </div>
                      <Show when={r.messages} fallback={<PartFailed part="messages" />}>
                        {(messages) => (
                          <ol class="flex flex-col gap-2">
                            <For each={messages()}>
                              {(m) => (
                                <li
                                  data-testid={`portal-message-${m.id}`}
                                  class={
                                    m.kind === "outbound"
                                      ? "rounded-md bg-surface-hover px-3 py-2"
                                      : "rounded-md border border-border px-3 py-2"
                                  }
                                >
                                  <p class="text-[12px] text-text-tertiary">
                                    {m.kind === "outbound"
                                      ? (m.authorLabel ?? m.fromName ?? "")
                                      : i18n.t("portal.requests.you")}
                                    {m.sentAt ? ` · ${day(m.sentAt, i18n.locale())}` : ""}
                                  </p>
                                  <p class="whitespace-pre-line text-[14px] text-text">
                                    {m.textBody}
                                  </p>
                                </li>
                              )}
                            </For>
                          </ol>
                        )}
                      </Show>
                      <Show when={requestState(r.status) !== "closed"}>
                        <Reply request={r} onSent={props.reload} />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </Section>
    </div>
  )
}
