// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DEMO'S RECORDED COMPUTER. A demo org's developer scenario plays a recorded
// session on a simulated node (no machine behind it, `simulated` on the node
// row). Wherever that node or its session shows, a "Recorded session" badge
// says so, so nobody mistakes the replay for a live machine; once the replay
// ended, the end card offers the desktop app, to pair a real computer.

import { MonitorDown } from "lucide-solid"
import { Show } from "solid-js"
import {
  desktopDownloadUrl,
  detectDesktopOs,
  orderedDesktopDownloads,
} from "~/lib/desktop-downloads"
import { useI18n } from "~/modules/i18n/i18n-context"
import { nodeById } from "./nodes-store"

/** Whether the node is a demo's recorded computer. */
export function isRecordedNode(nodeId: string | null | undefined): boolean {
  return nodeById(nodeId)?.simulated === true
}

/** The "Recorded session" badge: a calm chip, never an alarm. */
export function RecordedSessionBadge(props: { testId?: string }) {
  const t = useI18n().t
  return (
    <span
      data-testid={props.testId ?? "recorded-session-badge"}
      title={t("kernel.nodes.recordedSessionHint")}
      class="inline-flex shrink-0 items-center rounded bg-surface-hover px-1.5 py-0.5 text-[11px] font-medium text-text-secondary"
    >
      {t("kernel.nodes.recordedSession")}
    </span>
  )
}

/** The visitor's own installer: their OS family first, the macOS one when it cannot be told. */
function installerUrl(): string {
  const os =
    typeof navigator === "undefined"
      ? null
      : detectDesktopOs({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          maxTouchPoints: navigator.maxTouchPoints,
        })
  return desktopDownloadUrl(orderedDesktopDownloads(os)[0])
}

/** The replay's end card: pair your own computer, with the desktop download. */
export function DemoPairComputerCard() {
  const t = useI18n().t
  return (
    <div
      data-testid="demo-pair-computer"
      class="mx-3 mb-2 flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5"
    >
      <span class="text-[13px] font-medium text-text">
        {t("kernel.nodes.recordedSessionPairTitle")}
      </span>
      <span class="text-[12.5px] text-text-secondary">
        {t("kernel.nodes.recordedSessionPairBody")}
      </span>
      <Show when={installerUrl()}>
        {(href) => (
          <a
            data-testid="demo-pair-computer-download"
            href={href()}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex w-fit items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-foreground hover:bg-accent-hover"
          >
            <MonitorDown class="h-3.5 w-3.5" />
            {t("kernel.nodes.recordedSessionPairAction")}
          </a>
        )}
      </Show>
    </div>
  )
}
