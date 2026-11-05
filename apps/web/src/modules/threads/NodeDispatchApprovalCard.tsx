// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DISPATCH TO THE PERSON'S COMPUTER WAITING FOR THEIR APPROVAL. run_on_my_computer parks for
// approval outside a turn the person typed (or once the turn read outside text). The approval is
// answered here, in the conversation: the card says what runs, on which computer, where and with
// which model, with Approve and Reject. Approved, the same card becomes the session card
// (NodeSessionCard) once the approval names the session it started; rejected, it says so.
//
// It is drawn at the END of the agent's turn (TurnEndApprovals), after the words the agent wrote
// once the tool answered, so the summary never pushes it out of sight.
//
// An approve is bound to the version of the request this person saw (the store's reviewed
// payload hash), exactly as on every other approval card.

import {
  type ApprovalRequestSummary,
  canDecidePure,
  factsFromSummary,
  isSharedSurfaceFacts,
} from "@liaison/shared"
import { createMemo, createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { dispatchApprovalId } from "~/modules/agent/ToolCallRow"
import { getApproval } from "~/modules/approvals/approvals-service"
import {
  acknowledgePayloadChanges,
  decide,
  ensureLoaded,
  getById,
  handleWsUpdate,
  payloadChangedSinceReview,
} from "~/modules/approvals/approvals-store"
import { decideErrorToast } from "~/modules/approvals/decide-error"
import { isDecisionUndone } from "~/modules/approvals/decision-queue"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import type { ToolCallState } from "~/modules/threads/message-store"
import NodeSessionCard from "~/modules/threads/NodeSessionCard"
import { Button } from "~/ui/Button"

const TASK_MAX = 400

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export interface NodeDispatchApprovalCardProps {
  requestId: string
  /** The call's own arguments: what the card shows until the request has loaded. */
  args?: Record<string, unknown> | null
}

export default function NodeDispatchApprovalCard(props: NodeDispatchApprovalCardProps) {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [busy, setBusy] = createSignal<"approve" | "deny" | null>(null)
  // After this person's own approve: the row is read again for the session it started.
  const [settling, setSettling] = createSignal(false)

  if (api) {
    void ensureLoaded(api, props.requestId).catch(() => setLoadFailed(true))
  }

  const row = createMemo<ApprovalRequestSummary | undefined>(() => getById(props.requestId))
  const payload = (): Record<string, unknown> =>
    (row()?.currentPayload as Record<string, unknown> | undefined) ?? props.args ?? {}
  const sessionId = () => str(row()?.metadata?.nodeSessionId)
  const nodeName = () => {
    const meta = str(row()?.metadata?.nodeName)
    if (meta) return meta
    const summary = row()?.summary
    return summary?.kind === "node_dispatch" ? str(summary.subtitle) : null
  }
  const where = () => {
    const p = payload()
    const folder = str(p.folder)
    if (folder) return folder
    const repo = str(p.repo)
    if (repo) return repo
    return p.noFolder === true ? i18n.t("kernel.nodeSessions.approvalCard.noFolder") : null
  }
  const status = () => row()?.status ?? (loadFailed() ? null : "pending")

  const canDecide = () => {
    const r = row()
    const uid = userFromToken()?.userId
    if (!r || !uid) return false
    const facts = factsFromSummary(r)
    return canDecidePure(
      facts,
      { userId: uid, hasScope },
      { sharedSurface: isSharedSurfaceFacts(facts) },
    )
  }

  async function onDecide(decision: "approve" | "deny"): Promise<void> {
    if (!api || busy()) return
    setBusy(decision)
    try {
      // No payload hash passed: the store binds the approve to the version this person saw.
      await decide(api, props.requestId, decision)
      if (decision === "approve") {
        setSettling(true)
        try {
          handleWsUpdate(await getApproval(api, props.requestId))
        } finally {
          setSettling(false)
        }
      }
    } catch (err) {
      // Undone inside its window: nothing was sent.
      if (isDecisionUndone(err)) return
      if (err instanceof ApiError) addToast(decideErrorToast(err, i18n.t).toast)
      else addToast({ message: i18n.t("kernel.approvalsUi.couldnTReachServer"), type: "error" })
    } finally {
      setBusy(null)
    }
  }

  const chip = "rounded bg-surface-hover px-1.5 py-0.5 text-[11.5px] text-text-secondary"

  return (
    <Show
      when={sessionId()}
      fallback={
        <div
          data-testid="node-dispatch-approval"
          data-request-id={props.requestId}
          data-state={status() ?? "unavailable"}
          class="mt-1 flex max-w-xl flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
        >
          <span class="text-[13.5px] font-medium text-text">
            {(() => {
              const node = nodeName()
              return node
                ? i18n.t("kernel.nodeSessions.approvalCard.title", { node })
                : i18n.t("kernel.nodeSessions.approvalCard.titleNoNode")
            })()}
          </span>
          <Show when={str(payload().task)}>
            {(task) => (
              <p
                data-testid="node-dispatch-approval-task"
                class="whitespace-pre-wrap text-[12.5px] text-text"
              >
                {clip(task(), TASK_MAX)}
              </p>
            )}
          </Show>
          <div class="flex flex-wrap items-center gap-1.5">
            <For
              each={[where(), str(payload().model), nodeName()].filter(
                (v): v is string => v !== null,
              )}
            >
              {(value) => <span class={chip}>{value}</span>}
            </For>
          </div>
          <Show when={status() === "pending" && row()?.lastFailure}>
            {(failure) => (
              <p class="text-[12.5px] text-error">
                {i18n.t("kernel.approvalsUi.lastAttemptFailed")} {failure().message}
              </p>
            )}
          </Show>
          <Show when={status() === "pending" && payloadChangedSinceReview(props.requestId)}>
            <div
              role="status"
              data-testid="node-dispatch-approval-changed"
              class="text-[12px] text-text"
            >
              <p>{i18n.t("kernel.approvalsUi.changedSinceOpened")}</p>
              <button
                type="button"
                class="mt-1 text-[12px] font-medium text-accent hover:underline"
                onClick={() => acknowledgePayloadChanges([props.requestId])}
              >
                {i18n.t("kernel.approvalsUi.readTheNewVersion")}
              </button>
            </div>
          </Show>
          <p
            data-testid="node-dispatch-approval-line"
            class="text-[12.5px]"
            classList={{
              "text-warning": status() === "pending",
              "text-text-secondary": status() !== "pending",
            }}
          >
            {(() => {
              const s = status()
              const key = "kernel.nodeSessions.approvalCard"
              if (s === null) return i18n.t("kernel.approvalsUi.couldnTLoadApprovalRequest")
              if (s === "pending" || s === "deferred")
                return i18n.t(canDecide() ? `${key}.waitingYou` : `${key}.waitingApproval`)
              if (s === "approving" || settling()) return i18n.t(`${key}.starting`)
              if (s === "approved") return i18n.t(`${key}.notStarted`)
              if (s === "denied") {
                const by = row()?.decidedByName
                return by ? i18n.t(`${key}.rejectedBy`, { name: by }) : i18n.t(`${key}.rejected`)
              }
              if (s === "expired") return i18n.t(`${key}.expired`)
              return i18n.t(`${key}.withdrawn`)
            })()}
          </p>
          <Show when={status() === "pending" && canDecide()}>
            <div class="flex flex-col gap-2 sm:flex-row">
              <Button
                class="min-h-[44px] w-full sm:min-h-0 sm:w-auto"
                data-testid="node-dispatch-approval-approve"
                data-entity-id={props.requestId}
                loading={busy() === "approve"}
                disabled={busy() !== null}
                onClick={() => void onDecide("approve")}
              >
                {i18n.t("kernel.nodeSessions.approvalCard.approve")}
              </Button>
              <Button
                variant="outline"
                class="min-h-[44px] w-full sm:min-h-0 sm:w-auto"
                data-testid="node-dispatch-approval-reject"
                data-entity-id={props.requestId}
                loading={busy() === "deny"}
                disabled={busy() !== null}
                onClick={() => void onDecide("deny")}
              >
                {i18n.t("kernel.nodeSessions.approvalCard.reject")}
              </Button>
            </div>
          </Show>
        </div>
      }
    >
      {(id) => (
        <div data-testid="node-dispatch-approval" data-state="started">
          <NodeSessionCard sessionId={id()} nodeName={nodeName()} />
        </div>
      )}
    </Show>
  )
}

/**
 * The dispatch approvals a turn raised, drawn after everything the turn wrote. Each tool call that
 * parked one keeps a plain row where it happened; its card lives here.
 */
export function TurnEndApprovals(props: { toolCalls: readonly ToolCallState[] | undefined }) {
  // Ids, not wrapper objects: a streaming turn recomputes this on every chunk, and <For> keeps a
  // card mounted only while its element is the same value.
  const pinned = () =>
    (props.toolCalls ?? []).flatMap((tc) => {
      const id = dispatchApprovalId(tc)
      return id ? [id] : []
    })
  const argsOf = (id: string) =>
    ((props.toolCalls ?? []).find((tc) => dispatchApprovalId(tc) === id)?.args ?? null) as Record<
      string,
      unknown
    > | null
  return (
    <Show when={pinned().length > 0}>
      <div data-testid="turn-end-approvals" class="flex flex-col gap-1.5">
        <For each={pinned()}>
          {(id) => <NodeDispatchApprovalCard requestId={id} args={argsOf(id)} />}
        </For>
      </div>
    </Show>
  )
}
