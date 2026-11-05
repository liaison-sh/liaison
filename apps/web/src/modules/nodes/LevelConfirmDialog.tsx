// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE LEVEL CONFIRMATION (D24, D41, D42): the one in-app dialog for every
// level raise, and for every choice of Open. It names the level and what it
// allows, and the computers it applies to; nothing changes until Confirm,
// which posts one confirmation per computer (POST /api/me/node-level-
// confirmations, an interactive-session-only route) and hands the ids back.
// Cancel creates nothing. A failed confirmation keeps the dialog open with
// the error. No dialog ever appears on the node computer.
//
// Used by the profile editor (`profile_raise`), the New session dialog
// (`session_start`) and P3's composer level switch (`session_raise`).

import type { NodeLevel } from "@liaison/shared"
import { type Component, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { type ConfirmLevelRequest, confirmLevel } from "./node-api"

export type LevelConfirmPurpose = "profile_raise" | "session_start" | "session_raise"

export interface LevelConfirmNode {
  nodeId: string
  nodeName: string
}

export interface LevelConfirmDialogProps {
  open: boolean
  level: NodeLevel
  purpose: LevelConfirmPurpose
  /** The agent, for `profile_raise` and `session_start`. */
  agentId?: string
  agentName?: string
  /** The session, for `session_raise`. */
  sessionId?: string
  /** The computers to confirm on: one confirmation each. */
  nodes: LevelConfirmNode[]
  onConfirmed: (confirmationIds: string[]) => void
  onCancel: () => void
}

function requestFor(props: LevelConfirmDialogProps, nodeId: string): ConfirmLevelRequest | null {
  if (props.purpose === "session_raise") {
    if (!props.sessionId) return null
    return { nodeId, level: props.level, purpose: "session_raise", sessionId: props.sessionId }
  }
  if (!props.agentId) return null
  return { nodeId, level: props.level, purpose: props.purpose, agentId: props.agentId }
}

export const LevelConfirmDialog: Component<LevelConfirmDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const levelLabel = () => i18n.t(`kernel.nodeSessions.level.${props.level}`)
  const nodeNames = () => props.nodes.map((n) => n.nodeName).join(", ")
  const forProfile = () => props.purpose === "profile_raise"
  // Walk D18: a running session is raised (it restarts), not started.
  const forRaise = () => props.purpose === "session_raise"

  const title = () =>
    forProfile()
      ? i18n.t("kernel.nodeSessions.confirm.title", {
          agent: props.agentName ?? "",
          level: levelLabel(),
        })
      : i18n.t(
          forRaise()
            ? "kernel.nodeSessions.confirm.raiseTitle"
            : "kernel.nodeSessions.confirm.sessionTitle",
          { level: levelLabel() },
        )

  const body = () =>
    i18n.t(
      forProfile()
        ? "kernel.nodeSessions.confirm.body"
        : forRaise()
          ? "kernel.nodeSessions.confirm.raiseBody"
          : "kernel.nodeSessions.confirm.sessionBody",
      {
        levelAllows: i18n.t(`kernel.nodeSessions.levelAllows.${props.level}`),
        node: nodeNames(),
        level: levelLabel(),
      },
    )

  const confirmLabel = () =>
    i18n.t(
      forProfile() || forRaise()
        ? "kernel.nodeSessions.confirm.confirm"
        : "kernel.nodeSessions.confirm.sessionConfirm",
      { level: levelLabel() },
    )

  function cancel(): void {
    if (busy()) return
    setError(null)
    props.onCancel()
  }

  async function confirm(): Promise<void> {
    if (busy()) return
    setError(null)
    setBusy(true)
    const ids: string[] = []
    if (props.nodes.some((node) => !requestFor(props, node.nodeId))) {
      setError(i18n.t("kernel.nodeSessions.confirm.missingTarget"))
      setBusy(false)
      return
    }
    try {
      for (const node of props.nodes) {
        const request = requestFor(props, node.nodeId) as ConfirmLevelRequest
        const { confirmationId } = await confirmLevel(api, request)
        ids.push(confirmationId)
      }
    } catch (err) {
      // The server's sentence when it gave one; a lost connection in words, never raw.
      setError(
        err instanceof ApiError && err.message
          ? i18n.t("kernel.nodeSessions.confirm.failed", { error: err.message })
          : i18n.t("kernel.nodeSessions.confirm.unreachable"),
      )
      setBusy(false)
      return
    }
    setBusy(false)
    props.onConfirmed(ids)
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && cancel()}>
      <Dialog.Content>
        <div data-testid="node-level-confirm" data-level={props.level} data-purpose={props.purpose}>
          <Dialog.Title>{title()}</Dialog.Title>
          <Dialog.Description>{body()}</Dialog.Description>
          <Show when={error()}>
            {(message) => (
              <p
                role="alert"
                data-testid="node-level-confirm-error"
                class="mt-3 text-[12.5px] text-error"
              >
                {message()}
              </p>
            )}
          </Show>
          <div class="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              data-testid="node-level-confirm-cancel"
              disabled={busy()}
              onClick={cancel}
            >
              {i18n.t("kernel.nodeSessions.confirm.cancel")}
            </Button>
            <Button
              data-testid="node-level-confirm-yes"
              loading={busy()}
              disabled={props.nodes.length === 0}
              onClick={() => void confirm()}
            >
              {confirmLabel()}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

export default LevelConfirmDialog
