// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `/demo/unsubscribe?token=...`, the page every message to a demo lead links.
//
// ONE BUTTON, NOT A GET. Mail scanners follow links in incoming mail, so opening
// the page must never opt anybody out by itself: the visitor presses the button
// and that POSTs the token (`POST /api/demo/leads/opt-out`, which a mail
// client's List-Unsubscribe-Post can also call directly). The server answers the
// same for any token, so the page never says whether a token names a lead.
import { useSearchParams } from "@solidjs/router"
import { type Component, createSignal, Match, Show, Switch } from "solid-js"
import { anonApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

type UnsubscribeState = "idle" | "sending" | "done" | "failed"

const DemoUnsubscribe: Component = () => {
  const i18n = useI18n()
  const [params] = useSearchParams()
  const [state, setState] = createSignal<UnsubscribeState>("idle")

  const token = (): string => {
    const raw = params.token
    return typeof raw === "string" ? raw : ""
  }

  async function unsubscribe(): Promise<void> {
    if (state() === "sending" || state() === "done") return
    setState("sending")
    try {
      await anonApiClient.post(
        "/demo/leads/opt-out",
        { token: token() },
        { suppressGlobalError: true },
      )
      setState("done")
    } catch {
      setState("failed")
    }
  }

  return (
    <div
      data-testid="demo-unsubscribe"
      class="min-h-screen overflow-y-auto bg-bg px-4 py-10 sm:px-6 sm:py-16"
    >
      <section class="mx-auto flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <h1 class="text-lg font-semibold text-text">{i18n.t("kernel.demo.unsubscribeTitle")}</h1>
        <Switch>
          <Match when={token().length < 32}>
            <p data-testid="demo-unsubscribe-missing" class="text-sm text-text-secondary">
              {i18n.t("kernel.demo.unsubscribeMissing")}
            </p>
          </Match>
          <Match when={state() === "done"}>
            <p data-testid="demo-unsubscribe-done" role="status" class="text-sm text-text">
              {i18n.t("kernel.demo.unsubscribeDone")}
            </p>
          </Match>
          <Match when={true}>
            <p class="text-sm leading-relaxed text-text-secondary">
              {i18n.t("kernel.demo.unsubscribeBody")}
            </p>
            <Button
              fullWidth
              data-testid="demo-unsubscribe-button"
              loading={state() === "sending"}
              disabled={state() === "sending"}
              onClick={() => void unsubscribe()}
            >
              {i18n.t("kernel.demo.unsubscribeButton")}
            </Button>
            <Show when={state() === "failed"}>
              <p data-testid="demo-unsubscribe-failed" role="alert" class="text-xs text-error">
                {i18n.t("kernel.demo.unsubscribeFailed")}
              </p>
            </Show>
          </Match>
        </Switch>
      </section>
    </div>
  )
}

export default DemoUnsubscribe
