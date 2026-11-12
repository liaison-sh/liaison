// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The card under a tool call that answered an app page handle: one button that
 * opens the page (open-page.ts). A handle is used once and lasts minutes: an
 * opened or expired card says so and asks the agent for a new one.
 */
import { ExternalLink } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { openAppPage, type PageHandle } from "~/modules/app-pages/open-page"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export const PageHandleCard: Component<{ handle: PageHandle; title?: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [state, setState] = createSignal<"idle" | "busy" | "opened" | "blocked" | "failed">("idle")

  async function open(): Promise<void> {
    if (!api || state() === "busy") return
    setState("busy")
    setState(await openAppPage(api, props.handle))
  }

  return (
    <div
      data-testid="page-handle-card"
      class="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
    >
      <Show
        when={state() !== "opened"}
        fallback={<span class="text-text-muted">{i18n.t("kernel.appPage.opened")}</span>}
      >
        <Button
          size="sm"
          data-testid="page-handle-open"
          disabled={state() === "busy"}
          onClick={() => void open()}
        >
          <ExternalLink size={14} />
          {props.title ?? i18n.t("kernel.appPage.open")}
        </Button>
        <Show when={state() === "blocked"}>
          <span class="text-text-muted">{i18n.t("kernel.appPage.popupBlocked")}</span>
        </Show>
        <Show when={state() === "failed"}>
          <span class="text-text-muted">{i18n.t("kernel.appPage.failed")}</span>
        </Show>
      </Show>
    </div>
  )
}
