// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One page of A-09: a link that cannot be used. The state in plain words, who
// sent it (never on `notfound` or `down`), and the next step. Every text the
// server gave (a sender's name) is rendered as text, never as markup.

import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type FrameAction, type FrameFacts, frameActions, frameWords, NAMELESS } from "./frames"

export interface TokenFrameProps {
  facts: FrameFacts
  /** The masked address the link was sent to, when the page knew it (`wrong`). */
  invitedEmail?: string | null
  /** Runs a frame's next step; resolves once the server answered. */
  onAction: (action: FrameAction, extra: { email?: string }) => Promise<void>
}

export const TokenFrame: Component<TokenFrameProps> = (props) => {
  const i18n = useI18n()
  const [done, setDone] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [email, setEmail] = createSignal("")
  const frame = () => props.facts.frame
  const words = () => frameWords(props.facts)
  const sender = () => props.facts.sender
  const params = () => ({
    org: sender()?.org ?? "",
    sender: sender()?.name ?? sender()?.org ?? "",
    email: props.facts.copyTo ?? props.invitedEmail ?? "",
    time: props.facts.retryAt
      ? i18n.fmtDate(new Date(props.facts.retryAt), { hour: "2-digit", minute: "2-digit" })
      : "",
  })
  const label = (a: FrameAction) =>
    a.kind === "request" && a.type === "not_me"
      ? i18n.t("client-action.page.frame.used.notMe")
      : i18n.t(`client-action.page.frame.${words()}.action`, params())

  async function run(a: FrameAction) {
    if (busy()) return
    setBusy(true)
    try {
      await props.onAction(a, { email: email().trim() || undefined })
      setDone(i18n.t(`client-action.page.frame.${words()}.done`, params()))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid={`token-frame-${frame()}`}
      class="mx-auto w-full max-w-[520px] rounded-lg border border-border bg-surface"
    >
      <div class="flex items-center gap-2 border-b border-border px-5 py-3 text-[13px]">
        <Show
          when={!NAMELESS.has(frame()) && sender()}
          fallback={
            <span data-testid="token-frame-nameless" class="text-text-secondary">
              {i18n.t("client-action.page.secureLink")}
            </span>
          }
        >
          {(s) => (
            <span data-testid="token-frame-sender" class="font-medium text-text">
              {s().org}
            </span>
          )}
        </Show>
      </div>
      <div class="flex flex-col gap-3 px-5 py-5">
        <h1 data-testid="token-frame-title" class="text-[17px] font-semibold text-text">
          {i18n.t(`client-action.page.frame.${words()}.title`, params())}
        </h1>
        <p data-testid="token-frame-why" class="text-[13.5px] leading-5 text-text-secondary">
          {frame() === "signed" && props.facts.copy
            ? i18n.t(`client-action.page.copy.${props.facts.copy}`, params())
            : i18n.t(`client-action.page.frame.${words()}.why`, params())}
        </p>
        <Show when={frame() === "wrong" && !done()}>
          <label class="flex flex-col gap-1 text-[13px] text-text">
            {i18n.t("client-action.page.frame.wrong.email")}
            <input
              data-testid="token-frame-email"
              type="email"
              autocomplete="email"
              class="rounded-md border border-border bg-bg px-3 py-2 text-[14px] text-text"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          </label>
        </Show>
        <Show
          when={done()}
          fallback={
            <div class="flex flex-wrap gap-2">
              <For each={frameActions(props.facts)}>
                {(a, i) => (
                  <button
                    type="button"
                    data-testid={
                      a.kind === "request" && a.type === "not_me"
                        ? "token-frame-not-me"
                        : "token-frame-action"
                    }
                    disabled={busy()}
                    class={
                      i() === 0
                        ? "min-h-[44px] rounded-md bg-accent px-4 text-[13.5px] font-medium text-accent-foreground disabled:opacity-60"
                        : "min-h-[44px] rounded-md border border-border px-4 text-[13.5px] text-text disabled:opacity-60"
                    }
                    onClick={() => run(a)}
                  >
                    {label(a)}
                  </button>
                )}
              </For>
            </div>
          }
        >
          {(text) => (
            <p data-testid="token-frame-done" role="status" class="text-[13.5px] text-text">
              {text()}
            </p>
          )}
        </Show>
      </div>
    </section>
  )
}
