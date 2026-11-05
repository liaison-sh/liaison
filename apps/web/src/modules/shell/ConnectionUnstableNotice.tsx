// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Your connection keeps dropping", while something between this window and
// the server (a VPN, a split-tunnel proxy, a network filter) cuts every live
// connection a few seconds after it opens (createWebSocket's `unstable`). The
// app cannot stop that, so it says what is going on and what fixes it.
//
// One calm line at the top of the content, beside the offline banner: no
// alarm colour, no modal. Dismissing it hides it until the connection has
// recovered; if the cuts start again later it comes back.
import { type Component, createSignal, Show } from "solid-js"
import { absoluteApiBase } from "~/lib/env"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalWs } from "~/modules/shell/WsContext"

/** The server this window talks to, as the user would type it into a VPN's exclusions. */
function serverHost(): string {
  try {
    return new URL(absoluteApiBase()).host
  } catch {
    return typeof window !== "undefined" ? window.location.host : ""
  }
}

const NoticeCard: Component = () => {
  const i18n = useI18n()
  // Lives as long as one unstable episode: the Show above remounts this card,
  // and so forgets the dismissal, when the connection turns unstable again.
  const [dismissed, setDismissed] = createSignal(false)
  return (
    <Show when={!dismissed()}>
      <div
        data-testid="connection-unstable-notice"
        // A standing condition, not an interruption (see OfflineBanner.tsx).
        role="status"
        class="flex shrink-0 items-start gap-3 border-b border-border-subtle bg-surface-active px-4 py-2 text-[13px] text-text-secondary"
      >
        <div class="min-w-0 flex-1">
          <p data-testid="connection-unstable-title" class="font-medium text-text">
            {i18n.t("kernel.connectionUnstableTitle")}
          </p>
          <p data-testid="connection-unstable-body">
            {i18n.t("kernel.connectionUnstableBody", { host: serverHost() })}
          </p>
        </div>
        <button
          type="button"
          data-testid="connection-unstable-dismiss"
          aria-label={i18n.t("kernel.dismiss")}
          onClick={() => setDismissed(true)}
          class="shrink-0 rounded px-1 text-text-tertiary transition-colors hover:text-text"
        >
          ×
        </button>
      </div>
    </Show>
  )
}

export const ConnectionUnstableNotice: Component = () => {
  // Optional: outside the shell (a baseline render, a test) there is no socket
  // and nothing to say.
  const ws = useOptionalWs()
  return (
    <Show when={ws?.unstable() ?? false}>
      <NoticeCard />
    </Show>
  )
}
