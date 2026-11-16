// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TOKEN PAGE (`/a#t=<token>`): what a person outside the organization opens
// from a mail to sign, accept or approve one document. Its own lazy chunk: no
// shell, no agent, no tab, no dock, no member session. It talks only to the
// public client action routes, the token in POST bodies.
//
// Steps: read (or review), identity, then sign (or accept, approve), with decline
// open from each; then done or declined. A link that cannot be used shows one of
// the twelve frames of `frames.ts`. Opening the page changes nothing on the
// server; the first gesture marks it opened, and the end of the document coming
// into view (after a gesture) is recorded once. Continue stays off until then.
// The consent words are the server's, in the page's language, shown as given.

import { type Component, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type DocumentContent, DocumentView, type PageEntry } from "./DocumentView"
import { type FrameAction, type FrameFacts, frameOfAnswer } from "./frames"
import { takeLinkToken } from "./link-token"
import { type PublicAnswer, postPublic, postPublicFile } from "./public-api"
import { TokenFrame } from "./TokenFrame"

type Kind = "sign" | "accept" | "approve"
type Step = "read" | "identity" | "confirm" | "decline" | "done" | "declined"

export interface OpenBody {
  state: "open"
  kind: Kind
  sender: { name: string; org: string }
  title: string
  ref: string
  valid_until: string
  summary: Array<{ k: string; v: string }>
  invited_email_masked: string
  phrase?: string | null
  steps: string[]
}

interface PageState {
  phase: "loading" | "flow" | "frame"
  step: Step
  /** Where Decline's "Go back" returns. */
  back: Step
  open: OpenBody | null
  facts: FrameFacts | null
  doc: DocumentContent | "loading" | "failed"
  reached: boolean
  codeTo: string | null
  nextCodeAt: string | null
  code: string
  name: string
  capacity: string
  typedName: string
  typedPhrase: string
  reason: string
  proof: string | null
  words: string | null
  note: string | null
  busy: boolean
  copyTo: string | null
  pdfMissing: boolean
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ")
const fold = (t: string) => norm(t).normalize("NFD").replace(/[̀-ͯ]/g, "")

function errCode(a: PublicAnswer): string | null {
  const c = (a.body?.error as { code?: unknown } | undefined)?.code
  return typeof c === "string" ? c : null
}

function isOpenBody(b: Record<string, unknown> | null): b is Record<string, unknown> & OpenBody {
  return !!b && b.state === "open" && typeof b.title === "string" && typeof b.kind === "string"
}

const ClientActionPage: Component = () => {
  const i18n = useI18n()
  const [s, set] = createStore<PageState>({
    phase: "loading",
    step: "read",
    back: "read",
    open: null,
    facts: null,
    doc: "loading",
    reached: false,
    codeTo: null,
    nextCodeAt: null,
    code: "",
    name: "",
    capacity: "",
    typedName: "",
    typedPhrase: "",
    reason: "",
    proof: null,
    words: null,
    note: null,
    busy: false,
    copyTo: null,
    pdfMissing: false,
  })
  const [token, setToken] = createSignal<string | null>(null)
  let gestured = false
  let endPending = false
  let endSent = false

  const kind = (): Kind => s.open?.kind ?? "sign"
  const senderName = () => s.open?.sender.name ?? s.open?.sender.org ?? ""
  const org = () => s.open?.sender.org ?? ""
  const until = () =>
    s.open ? i18n.fmtDate(new Date(s.open.valid_until), { dateStyle: "long" }) : ""

  function showFrame(facts: FrameFacts) {
    set({ phase: "frame", facts, busy: false })
  }

  /** An answer that is a frame shows it; returns true when it did. */
  function frameIfDead(a: PublicAnswer): boolean {
    const facts = frameOfAnswer(a, s.open?.sender ?? null)
    if (!facts) return false
    showFrame(facts)
    return true
  }

  async function loadDocument(t: string) {
    set("doc", "loading")
    const blocks = await postPublic("document", { t, format: "blocks" })
    if (blocks.status === 200 && Array.isArray(blocks.body?.content)) {
      set("doc", { format: "blocks", blocks: blocks.body.content as unknown[] })
      return
    }
    if (blocks.status !== 404 && frameIfDead(blocks)) return
    const pages = await postPublic("document", { t, format: "pages" })
    if (pages.status === 200 && Array.isArray(pages.body?.content)) {
      set("doc", { format: "pages", pages: pages.body.content as PageEntry[] })
      return
    }
    if (pages.status !== 404 && frameIfDead(pages)) return
    set("doc", "failed")
  }

  async function load() {
    const t = token()
    if (!t) {
      showFrame({ frame: "notfound", sender: null })
      return
    }
    set({ phase: "loading" })
    const a = await postPublic("open", { t })
    if (a.status === 200 && isOpenBody(a.body)) {
      set({ open: a.body as OpenBody, phase: "flow", step: "read" })
      await loadDocument(t)
      return
    }
    if (!frameIfDead(a)) showFrame({ frame: "down", sender: null })
  }

  onMount(() => {
    setToken(takeLinkToken())
    void load()
  })

  // Only a person's gesture marks the link opened: a scanner that renders the page
  // and never touches it changes nothing.
  function onGesture() {
    const t = token()
    if (gestured || !t || s.phase !== "flow") return
    gestured = true
    void postPublic("seen", { t })
    if (endPending) sendEnd()
  }

  function sendEnd() {
    const t = token()
    if (endSent || !t) return
    endSent = true
    void postPublic("seen", { t, reached_end: true })
  }

  function onReachedEnd() {
    set("reached", true)
    if (gestured) sendEnd()
    else endPending = true
  }

  async function sendCode() {
    const t = token()
    if (!t) return
    set({ note: null, codeTo: null })
    const a = await postPublic("code", { t })
    if (a.status === 202) {
      set({
        codeTo: typeof a.body?.sent_to === "string" ? a.body.sent_to : null,
        nextCodeAt: typeof a.body?.next_at === "string" ? a.body.next_at : null,
      })
      return
    }
    const code = errCode(a)
    if (code === "rate_limited") {
      const at = (a.body?.error as { retry_at?: unknown } | undefined)?.retry_at
      set({
        nextCodeAt: typeof at === "string" ? at : null,
        codeTo: s.open?.invited_email_masked ?? null,
      })
      return
    }
    if (code === "DOCUMENT_NOT_SHOWN") {
      set({ note: i18n.t("client-action.page.identity.notShown"), step: "read" })
      return
    }
    if (code === "send_failed") {
      set("note", i18n.t("client-action.page.identity.sendFailed"))
      return
    }
    frameIfDead(a)
  }

  async function toIdentity() {
    if (!s.reached) return
    set({ step: "identity", proof: null, words: null, note: null })
    await sendCode()
  }

  async function verify() {
    const t = token()
    if (!t || s.busy) return
    set({ busy: true, note: null })
    const a = await postPublic("verify", {
      t,
      code: s.code.replace(/\D/g, ""),
      name: s.name.trim(),
      ...(kind() === "sign" && s.capacity.trim() ? { capacity: s.capacity.trim() } : {}),
      lang: i18n.locale(),
    })
    set("busy", false)
    if (a.status === 200 && typeof a.body?.proof === "string") {
      set({
        proof: a.body.proof,
        words: typeof a.body.words === "string" ? a.body.words : null,
        step: "confirm",
        typedName: "",
      })
      return
    }
    const code = errCode(a)
    if (code === "wrong_code") {
      const left = (a.body?.error as { left?: unknown } | undefined)?.left
      set("note", i18n.t("client-action.page.identity.wrongCode", { left: String(left ?? "") }))
      return
    }
    if (code === "code_ended") {
      set("note", i18n.t("client-action.page.identity.codeEnded"))
      return
    }
    if (code === "invalid_text" || code === "invalid_body") {
      set("note", i18n.t("client-action.page.identity.invalidText"))
      return
    }
    if (!frameIfDead(a)) set("note", i18n.t("client-action.page.identity.codeEnded"))
  }

  async function decide() {
    const t = token()
    if (!t || s.busy || !canConfirm()) return
    set({ busy: true, note: null })
    const a = await postPublic("decide", {
      t,
      proof: s.proof,
      decision: kind(),
      typed_name: s.typedName.trim(),
      ...(s.open?.phrase ? { typed_phrase: s.typedPhrase.trim() } : {}),
    })
    set("busy", false)
    if (a.status === 200) {
      set({ step: "done", copyTo: typeof a.body?.copy_to === "string" ? a.body.copy_to : null })
      return
    }
    const code = errCode(a)
    if (code === "name_mismatch") {
      set("note", i18n.t("client-action.page.sign.nameMismatch"))
      return
    }
    if (code === "phrase_mismatch") {
      set("note", i18n.t("client-action.page.sign.phraseMismatch"))
      return
    }
    if (code === "bad_proof" || code === "code_required") {
      set({
        step: "identity",
        proof: null,
        words: null,
        code: "",
        note: i18n.t("client-action.page.sign.proofEnded"),
      })
      return
    }
    if (code === "invalid_text") {
      set("note", i18n.t("client-action.page.identity.invalidText"))
      return
    }
    if (!frameIfDead(a)) showFrame({ frame: "down", sender: null })
  }

  async function decline() {
    const t = token()
    if (!t || s.busy) return
    set({ busy: true, note: null })
    const reason = s.reason.trim()
    const a = await postPublic("decide", {
      t,
      decision: "decline",
      ...(reason ? { reason } : {}),
    })
    set("busy", false)
    if (a.status === 200) {
      set("step", "declined")
      return
    }
    if (errCode(a) === "invalid_text") {
      set("note", i18n.t("client-action.page.identity.invalidText"))
      return
    }
    if (!frameIfDead(a)) showFrame({ frame: "down", sender: null })
  }

  async function notForMe() {
    const t = token()
    if (t) await postPublic("request", { t, type: "not_me" })
    showFrame({ frame: "wrong", sender: s.open?.sender ?? null })
  }

  async function onFrameAction(action: FrameAction, extra: { email?: string }) {
    const t = token()
    if (!t) return
    if (action.kind === "retry") {
      await load()
      return
    }
    if (action.kind === "identity") {
      if (s.open) set({ phase: "flow", step: "identity", note: null })
      else await load()
      return
    }
    if (action.kind === "invite") {
      await postPublic("request", {
        t,
        type: "invite_asked",
        ...(extra.email ? { email: extra.email } : {}),
      })
      return
    }
    await postPublic("request", { t, type: action.type })
  }

  async function downloadPdf() {
    const t = token()
    if (!t) return
    const out = await postPublicFile({ t, format: "pdf" })
    if (!out.blob) {
      set("pdfMissing", true)
      return
    }
    const url = URL.createObjectURL(out.blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${s.open?.ref ?? "document"}.pdf`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const canIdentity = () =>
    s.code.replace(/\D/g, "").length === 6 &&
    s.name.trim() !== "" &&
    (kind() !== "sign" || s.capacity.trim() !== "")
  const canConfirm = () =>
    !!s.proof &&
    s.typedName.trim() !== "" &&
    norm(s.typedName) === norm(s.name) &&
    (!s.open?.phrase || fold(s.typedPhrase) === fold(s.open.phrase))

  const stepState = (name: "read" | "identity" | "confirm") => {
    const order = ["read", "identity", "confirm"]
    const at = order.indexOf(s.step)
    if (at < 0) return "todo"
    const me = order.indexOf(name)
    return me < at ? "done" : me === at ? "now" : "todo"
  }
  const stepLabel = (name: "read" | "identity" | "confirm") =>
    name === "read"
      ? i18n.t(`client-action.page.steps.${kind() === "sign" ? "read" : "review"}`)
      : name === "identity"
        ? i18n.t("client-action.page.steps.identity")
        : i18n.t(`client-action.page.steps.${kind()}`)
  const closed = () => s.step === "done" || s.step === "declined"
  const input =
    "w-full rounded-md border border-border bg-bg px-3 py-2 text-[14px] text-text focus:border-accent focus:outline-none"
  const primary =
    "min-h-[44px] rounded-md bg-accent px-4 text-[13.5px] font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
  const secondary =
    "min-h-[44px] rounded-md border border-border px-4 text-[13.5px] text-text disabled:opacity-50"
  const link =
    "inline-flex min-h-[44px] items-center text-[13px] text-accent underline-offset-2 hover:underline"

  return (
    <div
      data-testid="client-action-page"
      class="min-h-screen overflow-x-hidden bg-bg text-text"
      onPointerDown={onGesture}
      onKeyDown={onGesture}
      onTouchStart={onGesture}
    >
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-8">
        <span data-testid="client-action-org" class="truncate text-[14px] font-semibold">
          <Show when={s.phase === "flow"}>{org()}</Show>
        </span>
        <div
          role="group"
          aria-label={i18n.t("client-action.page.language")}
          class="flex shrink-0 gap-1 text-[12.5px]"
        >
          <For each={["en", "fr"] as const}>
            {(lang) => (
              <button
                type="button"
                data-testid={`client-action-lang-${lang}`}
                aria-pressed={i18n.locale() === lang}
                class={
                  i18n.locale() === lang
                    ? "min-h-[36px] rounded-md bg-surface px-2 font-medium text-text"
                    : "min-h-[36px] rounded-md px-2 text-text-secondary"
                }
                onClick={() => i18n.setLocale(lang)}
              >
                {lang.toUpperCase()}
              </button>
            )}
          </For>
        </div>
      </header>

      <Switch>
        <Match when={s.phase === "loading"}>
          <p data-testid="client-action-loading" class="px-4 py-16 text-center text-text-secondary">
            {i18n.t("client-action.page.doc.loading")}
          </p>
        </Match>
        <Match when={s.phase === "frame" && s.facts}>
          {(_facts) => (
            <main class="px-4 py-10 sm:py-16">
              <TokenFrame
                facts={s.facts as FrameFacts}
                invitedEmail={s.open?.invited_email_masked ?? null}
                onAction={onFrameAction}
              />
            </main>
          )}
        </Match>
        <Match when={s.phase === "flow" && s.open}>
          {(open) => (
            <main class="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-8">
              <div class="mb-5 flex flex-col gap-1">
                <p data-testid="client-action-ask" class="text-[13px] text-text-secondary">
                  {i18n.t(`client-action.page.ask.${kind()}`, {
                    sender: senderName(),
                    org: org(),
                  })}
                </p>
                <h1 data-testid="client-action-title" class="text-[22px] font-semibold break-words">
                  {open().title}
                </h1>
                <p class="flex flex-wrap gap-x-4 text-[12.5px] text-text-secondary">
                  <span>{i18n.t("client-action.page.ref", { ref: open().ref })}</span>
                  <span>
                    {closed()
                      ? i18n.t("client-action.page.closed")
                      : i18n.t("client-action.page.validUntil", { date: until() })}
                  </span>
                </p>
                <Show when={kind() === "sign"}>
                  <p data-testid="level-sentence" class="mt-1 text-[13.5px] leading-5">
                    <b class="font-medium">{i18n.t("client-action.page.levelLead")}</b>{" "}
                    {i18n.t("client-action.page.levelBody")}
                  </p>
                </Show>
              </div>

              <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
                <div
                  data-testid="client-action-document"
                  class={
                    s.step === "read"
                      ? "min-w-0 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-2"
                      : "hidden min-w-0 lg:block lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-2"
                  }
                >
                  <Switch>
                    <Match when={s.doc === "loading"}>
                      <p class="py-10 text-center text-text-secondary">
                        {i18n.t("client-action.page.doc.loading")}
                      </p>
                    </Match>
                    <Match when={s.doc === "failed"}>
                      <div data-testid="doc-failed" class="flex flex-col items-start gap-2 py-6">
                        <p class="text-text-secondary">{i18n.t("client-action.page.doc.failed")}</p>
                        <button
                          type="button"
                          class={secondary}
                          onClick={() => {
                            const t = token()
                            if (t) void loadDocument(t)
                          }}
                        >
                          {i18n.t("client-action.page.doc.retry")}
                        </button>
                      </div>
                    </Match>
                    <Match when={typeof s.doc === "object"}>
                      <DocumentView
                        token={token() ?? ""}
                        content={s.doc as DocumentContent}
                        onReachedEnd={onReachedEnd}
                      />
                    </Match>
                  </Switch>
                </div>

                <aside data-testid="client-action-panel" class="flex min-w-0 flex-col gap-4">
                  <Show when={!closed() && s.step !== "decline"}>
                    <ol
                      aria-label={i18n.t("client-action.page.stepsLabel")}
                      class="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]"
                    >
                      <For each={["read", "identity", "confirm"] as const}>
                        {(name) => (
                          <li
                            data-testid={`step-${name}`}
                            data-state={stepState(name)}
                            class={
                              stepState(name) === "now"
                                ? "font-medium text-text"
                                : "text-text-secondary"
                            }
                          >
                            {stepLabel(name)}
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>

                  <Show when={s.note}>
                    {(note) => (
                      <p
                        data-testid="client-action-note"
                        role="alert"
                        class="text-[13px] text-text"
                      >
                        {note()}
                      </p>
                    )}
                  </Show>

                  <Switch>
                    <Match when={s.step === "read"}>
                      <div data-testid="step-read-panel" class="flex flex-col gap-3">
                        <h2 class="text-[16px] font-semibold">
                          {kind() === "sign"
                            ? i18n.t("client-action.page.read.heading")
                            : i18n.t("client-action.page.read.reviewHeading")}
                        </h2>
                        <Show when={open().summary.length > 0}>
                          <p class="text-[13px] text-text-secondary">
                            {i18n.t("client-action.page.read.body")}
                          </p>
                          <dl
                            data-testid="client-action-summary"
                            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]"
                          >
                            <For each={open().summary}>
                              {(row) => (
                                <>
                                  <dt class="text-text-secondary">{row.k}</dt>
                                  <dd class="break-words">{row.v}</dd>
                                </>
                              )}
                            </For>
                          </dl>
                        </Show>
                        <button
                          type="button"
                          data-testid="read-continue"
                          class={primary}
                          disabled={!s.reached}
                          onClick={() => void toIdentity()}
                        >
                          {kind() === "sign"
                            ? i18n.t("client-action.page.read.continue")
                            : i18n.t("client-action.page.read.continueOther")}
                        </button>
                        <Show when={!s.reached}>
                          <p data-testid="read-wait" class="text-[12.5px] text-text-secondary">
                            {i18n.t("client-action.page.read.wait")}
                          </p>
                        </Show>
                        <div class="flex flex-wrap gap-x-4">
                          <button
                            type="button"
                            data-testid="read-download"
                            class={link}
                            onClick={() => void downloadPdf()}
                          >
                            {i18n.t("client-action.page.read.download")}
                          </button>
                          <button
                            type="button"
                            data-testid="to-decline"
                            class={link}
                            onClick={() => set({ back: "read", step: "decline", note: null })}
                          >
                            {i18n.t("client-action.page.read.decline")}
                          </button>
                        </div>
                        <Show when={s.pdfMissing}>
                          <p class="text-[12.5px] text-text-secondary">
                            {i18n.t("client-action.page.read.noPdf")}
                          </p>
                        </Show>
                        <p class="text-[12.5px] text-text-secondary">
                          {i18n.t("client-action.page.read.question", {
                            sender: senderName(),
                            date: until(),
                          })}
                        </p>
                      </div>
                    </Match>

                    <Match when={s.step === "identity"}>
                      <div data-testid="step-identity-panel" class="flex flex-col gap-3">
                        <h2 class="text-[16px] font-semibold">
                          {i18n.t("client-action.page.identity.heading")}
                        </h2>
                        <p data-testid="identity-sent" class="text-[13px] text-text-secondary">
                          {s.codeTo
                            ? i18n.t("client-action.page.identity.sent", { email: s.codeTo })
                            : i18n.t("client-action.page.identity.sending", {
                                email: open().invited_email_masked,
                              })}
                        </p>
                        <label class="flex flex-col gap-1 text-[13px]">
                          {i18n.t("client-action.page.identity.code")}
                          <input
                            data-testid="code-input"
                            class={`${input} font-mono tracking-widest`}
                            inputmode="numeric"
                            autocomplete="one-time-code"
                            maxLength={12}
                            value={s.code}
                            onInput={(e) => set("code", e.currentTarget.value)}
                          />
                        </label>
                        <div class="flex flex-wrap items-center gap-x-3">
                          <button
                            type="button"
                            data-testid="code-resend"
                            class={link}
                            onClick={() => void sendCode()}
                          >
                            {i18n.t("client-action.page.identity.resend")}
                          </button>
                          <Show when={s.nextCodeAt}>
                            {(at) => (
                              <span class="text-[12px] text-text-secondary">
                                {i18n.t("client-action.page.identity.resendAt", {
                                  time: i18n.fmtDate(new Date(at()), {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }),
                                })}
                              </span>
                            )}
                          </Show>
                        </div>
                        <label class="flex flex-col gap-1 text-[13px]">
                          {i18n.t("client-action.page.identity.name")}
                          <input
                            data-testid="identity-name"
                            class={input}
                            autocomplete="name"
                            maxLength={200}
                            value={s.name}
                            onInput={(e) => set("name", e.currentTarget.value)}
                          />
                        </label>
                        <Show when={kind() === "sign"}>
                          <label class="flex flex-col gap-1 text-[13px]">
                            {i18n.t("client-action.page.identity.capacity")}
                            <input
                              data-testid="identity-capacity"
                              class={input}
                              autocomplete="organization-title"
                              maxLength={200}
                              value={s.capacity}
                              onInput={(e) => set("capacity", e.currentTarget.value)}
                            />
                          </label>
                        </Show>
                        <button
                          type="button"
                          data-testid="identity-continue"
                          class={primary}
                          disabled={!canIdentity() || s.busy}
                          onClick={() => void verify()}
                        >
                          {i18n.t("client-action.page.identity.continue")}
                        </button>
                        <div class="flex flex-wrap gap-x-4">
                          <button
                            type="button"
                            data-testid="identity-back"
                            class={link}
                            onClick={() => set({ step: "read", note: null })}
                          >
                            {i18n.t("client-action.page.identity.back")}
                          </button>
                          <button
                            type="button"
                            data-testid="identity-not-me"
                            class={link}
                            onClick={() => void notForMe()}
                          >
                            {i18n.t("client-action.page.identity.notMe")}
                          </button>
                        </div>
                      </div>
                    </Match>

                    <Match when={s.step === "confirm"}>
                      <div data-testid="step-confirm-panel" class="flex flex-col gap-3">
                        <h2 class="text-[16px] font-semibold">
                          {i18n.t(`client-action.page.${kind()}.heading`)}
                        </h2>
                        <div
                          data-testid="consent-words"
                          class="rounded-md border border-border bg-surface px-3 py-3 text-[13.5px] leading-5"
                        >
                          {s.words ?? ""}
                        </div>
                        <Show when={open().phrase}>
                          {(phrase) => (
                            <label class="flex flex-col gap-1 text-[13px]">
                              {i18n.t("client-action.page.sign.typePhrase", { phrase: phrase() })}
                              <input
                                data-testid="sign-phrase"
                                class={input}
                                autocomplete="off"
                                maxLength={200}
                                value={s.typedPhrase}
                                onInput={(e) => set("typedPhrase", e.currentTarget.value)}
                              />
                              <span class="text-[12px] text-text-secondary">
                                {i18n.t("client-action.page.sign.phraseHint", {
                                  sender: senderName(),
                                })}
                              </span>
                            </label>
                          )}
                        </Show>
                        <label class="flex flex-col gap-1 text-[13px]">
                          {i18n.t(`client-action.page.${kind()}.typeName`)}
                          <input
                            data-testid="sign-name"
                            class={input}
                            autocomplete="off"
                            maxLength={200}
                            value={s.typedName}
                            onInput={(e) => set("typedName", e.currentTarget.value)}
                          />
                          <Show when={kind() === "sign"}>
                            <span class="text-[12px] text-text-secondary">
                              {i18n.t("client-action.page.sign.nameHint")}
                            </span>
                          </Show>
                        </label>
                        <div class="flex flex-wrap gap-2">
                          <button
                            type="button"
                            data-testid="sign-decline"
                            class={secondary}
                            onClick={() => set({ back: "confirm", step: "decline", note: null })}
                          >
                            {i18n.t("client-action.page.sign.decline")}
                          </button>
                          <button
                            type="button"
                            data-testid="sign-confirm"
                            class={primary}
                            disabled={!canConfirm() || s.busy}
                            onClick={() => void decide()}
                          >
                            {i18n.t(`client-action.page.${kind()}.confirm`)}
                          </button>
                        </div>
                        <p class="text-[12.5px] text-text-secondary">
                          {kind() === "sign"
                            ? i18n.t("client-action.page.sign.onlyYou")
                            : i18n.t(`client-action.page.${kind()}.onlyYou`)}
                        </p>
                        <Show when={kind() === "sign"}>
                          <p class="text-[12.5px] text-text-secondary">
                            {i18n.t("client-action.page.sign.capacityNote")}
                          </p>
                        </Show>
                        <p data-testid="recorded-note" class="text-[12.5px] text-text-secondary">
                          {kind() === "sign"
                            ? i18n.t("client-action.page.sign.recorded")
                            : i18n.t(`client-action.page.${kind()}.recorded`)}
                        </p>
                      </div>
                    </Match>

                    <Match when={s.step === "decline"}>
                      <div data-testid="step-decline-panel" class="flex flex-col gap-3">
                        <h2 class="text-[16px] font-semibold">
                          {i18n.t("client-action.page.decline.heading")}
                        </h2>
                        <p class="text-[13px] text-text-secondary">
                          {i18n.t(
                            kind() === "sign"
                              ? "client-action.page.decline.bodySign"
                              : "client-action.page.decline.bodyOther",
                            { sender: senderName() },
                          )}
                        </p>
                        <label class="flex flex-col gap-1 text-[13px]">
                          {i18n.t("client-action.page.decline.reason", { sender: senderName() })}
                          <textarea
                            data-testid="decline-reason"
                            class={input}
                            rows={3}
                            maxLength={2000}
                            value={s.reason}
                            onInput={(e) => set("reason", e.currentTarget.value)}
                          />
                        </label>
                        <div class="flex flex-wrap gap-2">
                          <button
                            type="button"
                            data-testid="decline-back"
                            class={secondary}
                            onClick={() => set({ step: s.back, note: null })}
                          >
                            {i18n.t("client-action.page.decline.back")}
                          </button>
                          <button
                            type="button"
                            data-testid="decline-confirm"
                            class={primary}
                            disabled={s.busy}
                            onClick={() => void decline()}
                          >
                            {i18n.t("client-action.page.decline.confirm")}
                          </button>
                        </div>
                      </div>
                    </Match>

                    <Match when={s.step === "done"}>
                      <div data-testid="step-done-panel" class="flex flex-col gap-3" role="status">
                        <h2 class="text-[16px] font-semibold">
                          {i18n.t(`client-action.page.done.${kind()}`)}
                        </h2>
                        <p data-testid="done-copy" class="text-[13.5px]">
                          {kind() === "sign"
                            ? i18n.t("client-action.page.done.signCopy", {
                                email: s.copyTo ?? open().invited_email_masked,
                                org: org(),
                              })
                            : i18n.t("client-action.page.done.otherCopy", {
                                email: s.copyTo ?? open().invited_email_masked,
                              })}
                        </p>
                        <p class="text-[13px] text-text-secondary">
                          {i18n.t("client-action.page.done.told", { sender: senderName() })}
                        </p>
                      </div>
                    </Match>

                    <Match when={s.step === "declined"}>
                      <div
                        data-testid="step-declined-panel"
                        class="flex flex-col gap-3"
                        role="status"
                      >
                        <h2 class="text-[16px] font-semibold">
                          {i18n.t("client-action.page.declined.heading")}
                        </h2>
                        <p class="text-[13.5px]">
                          {i18n.t(
                            kind() === "sign"
                              ? "client-action.page.declined.bodySign"
                              : "client-action.page.declined.bodyOther",
                            { sender: senderName() },
                          )}
                        </p>
                        <p class="text-[13px] text-text-secondary">
                          {i18n.t("client-action.page.declined.again", { sender: senderName() })}
                        </p>
                      </div>
                    </Match>
                  </Switch>
                </aside>
              </div>
              <footer class="mt-10 border-t border-border pt-4 text-[12px] text-text-tertiary">
                {i18n.t("client-action.page.foot", { org: org() })}
              </footer>
            </main>
          )}
        </Match>
      </Switch>
    </div>
  )
}

export default ClientActionPage
