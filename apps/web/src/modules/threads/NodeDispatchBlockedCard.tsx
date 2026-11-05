// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DISPATCH BLOCKED BY A FOLDER NOT SHARED (`metadata.kind:
// "node_dispatch_blocked"`). run_on_my_computer posts it when the folder the
// request names is not shared by the person's computer. For that person, from
// any device (a push on the phone lands here): "Fix it" opens the computer's
// Folders section searching for that name, and "Start again" runs the same
// request once the folder is shared. Anyone else reads the card's own line.

import { createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { nodeFoldersRoute, retryBlockedDispatch } from "~/modules/nodes/node-folders-api"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"

export interface NodeDispatchBlockedCardProps {
  messageId: string
  nodeId: string
  nodeName: string
  /** The folder (or repo) name the request named. */
  name: string
  ownerUserId: string
  currentUserId: string
  /** Set once "Start again" started it. */
  retriedSessionId?: string | null
  fallbackText?: string | null
}

type Outcome = "started" | "still_not_shared" | "already" | "failed"

export default function NodeDispatchBlockedCard(props: NodeDispatchBlockedCardProps) {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [busy, setBusy] = createSignal(false)
  const [outcome, setOutcome] = createSignal<Outcome | null>(
    props.retriedSessionId ? "already" : null,
  )
  const mine = () => props.ownerUserId === props.currentUserId

  function fix(): void {
    openTab({
      type: "kernel:settings",
      entityId: "settings",
      label: i18n.t("kernel.nav.section.computers"),
      routePath: nodeFoldersRoute(props.nodeId, props.name),
    })
  }

  async function again(): Promise<void> {
    if (!api || busy()) return
    setBusy(true)
    try {
      const { already } = await retryBlockedDispatch(api, props.messageId)
      setOutcome(already ? "already" : "started")
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined
      setOutcome(
        code === "still_not_shared"
          ? "still_not_shared"
          : code === "already_started"
            ? "already"
            : "failed",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="node-dispatch-blocked"
      data-outcome={outcome() ?? ""}
      class="rounded-md border border-border-subtle bg-surface px-3 py-3"
    >
      <Show
        when={mine()}
        fallback={<p class="text-[13px] text-text-secondary">{props.fallbackText}</p>}
      >
        <p class="text-[13px] font-medium text-text">
          {i18n.t("kernel.nodeSessions.blockedCard.title", { node: props.nodeName })}
        </p>
        <p class="mt-1 text-[12.5px] leading-relaxed text-text-secondary">
          {i18n.t("kernel.nodeSessions.blockedCard.body", { name: props.name })}
        </p>
        <Show
          when={outcome() !== "started" && outcome() !== "already"}
          fallback={
            <p data-testid="node-dispatch-blocked-started" class="mt-2 text-[12.5px] text-accent">
              {i18n.t(
                outcome() === "started"
                  ? "kernel.nodeSessions.blockedCard.started"
                  : "kernel.nodeSessions.blockedCard.already",
              )}
            </p>
          }
        >
          <div class="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              class="min-h-[44px] w-full sm:w-auto"
              data-testid="node-dispatch-blocked-fix"
              onClick={fix}
            >
              {i18n.t("kernel.nodeSessions.blockedCard.fix")}
            </Button>
            <Button
              class="min-h-[44px] w-full sm:w-auto"
              data-testid="node-dispatch-blocked-again"
              loading={busy()}
              onClick={() => void again()}
            >
              {i18n.t("kernel.nodeSessions.blockedCard.again")}
            </Button>
          </div>
          <Show when={outcome() === "still_not_shared" || outcome() === "failed"}>
            <p
              role="alert"
              data-testid="node-dispatch-blocked-error"
              class="mt-2 text-[12.5px] text-warning"
            >
              {outcome() === "still_not_shared"
                ? i18n.t("kernel.nodeSessions.blockedCard.stillNotShared", { name: props.name })
                : i18n.t("kernel.nodeSessions.blockedCard.failed")}
            </p>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
