// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `/demo/verify?t=<token>`: the link in the code mail.
//
// IT NEVER VERIFIES BY ITSELF. Mail scanners follow links, and some run the
// page's JavaScript, so opening this page does nothing but show one button.
// Only the visitor's press runs a fresh invisible Turnstile (`demo_verify`)
// and POSTs the token; the token is single use on the server, consumed by
// that first POST whether it succeeds or not.
import { useSearchParams } from "@solidjs/router"
import { type Component, createSignal, onMount, Show } from "solid-js"
import {
  confirmDemoLink,
  type DemoCodeFailure,
  ensureDemoDoorSettings,
} from "~/modules/demo/demo-store"
import { createTurnstile } from "~/modules/demo/Turnstile"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

type LinkState = "idle" | "confirming" | "done" | "expired" | "error"

const DemoVerifyRoute: Component = () => {
  const i18n = useI18n()
  const [params] = useSearchParams()
  const turnstile = createTurnstile()
  const [state, setState] = createSignal<LinkState>("idle")
  const token = () => {
    const t = params.t
    return typeof t === "string" ? t : ""
  }

  onMount(() => {
    void ensureDemoDoorSettings()
  })

  async function confirm(): Promise<void> {
    if (state() === "confirming" || !token()) return
    setState("confirming")
    try {
      const turnstileToken = await turnstile.token("demo_verify")
      await confirmDemoLink(token(), turnstileToken)
      setState("done")
    } catch (err) {
      setState((err as DemoCodeFailure).kind === "expired" ? "expired" : "error")
    }
  }

  return (
    <div data-testid="demo-verify-link" class="min-h-screen bg-bg px-4 py-10 sm:py-16">
      <div class="mx-auto flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <h1 class="text-base font-semibold text-text">{i18n.t("kernel.demo.verifyLinkTitle")}</h1>
        <Show
          when={token()}
          fallback={
            <p data-testid="demo-verify-link-missing" class="text-[13px] text-text-secondary">
              {i18n.t("kernel.demo.verifyLinkMissing")}
            </p>
          }
        >
          <Show when={state() !== "done"}>
            <p class="text-[13px] leading-relaxed text-text-secondary">
              {i18n.t("kernel.demo.verifyLinkBody")}
            </p>
            <Button
              fullWidth
              data-testid="demo-verify-link-confirm"
              loading={state() === "confirming"}
              disabled={state() === "confirming" || state() === "expired"}
              onClick={() => void confirm()}
            >
              {i18n.t("kernel.demo.verifyLinkConfirm")}
            </Button>
            <turnstile.Widget />
          </Show>
          <Show when={state() === "done"}>
            <p data-testid="demo-verify-link-done" role="status" class="text-[13px] text-text">
              {i18n.t("kernel.demo.verifyLinkDone")}
            </p>
          </Show>
          <Show when={state() === "expired"}>
            <p data-testid="demo-verify-link-expired" role="alert" class="text-[13px] text-error">
              {i18n.t("kernel.demo.verifyLinkExpired")}
            </p>
          </Show>
          <Show when={state() === "error"}>
            <p data-testid="demo-verify-link-error" role="alert" class="text-[13px] text-error">
              {i18n.t("kernel.demo.verifyFailed")}
            </p>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default DemoVerifyRoute
