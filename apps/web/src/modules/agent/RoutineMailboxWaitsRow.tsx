// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY ROUTINE RUN WAITING FOR ITS OWNER'S PRIVATE MAILBOX, AS ONE ROW.
//
// These are not decisions: each run would have started by itself if the mailbox
// were not private, and only needs the owner's window to be open. So when
// several wait, the list shows one row with Run all and Dismiss all, and Details
// lists each run with its own Run now and Dismiss (RoutineMailboxWaitRow). One
// waiting run keeps its own row.
//
// Run all is still a press in the owner's window, as every run's turn scope
// must be (routine-mailbox-wait-run.ts). It starts the runs one by one, oldest
// first; the server queues the runs of a routine behind each other. A locked
// mailbox shows its unlock card here, and the batch starts once it opens.
//
// The batch's state lives outside the row: the list keeps the oldest waiting
// item as this row, so the row is remounted each time a started run leaves.

import type { AttentionItem } from "@liaison/shared"
import { Lock, Play, X } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import RoutineMailboxWaitRow, { startedKey } from "~/modules/agent/RoutineMailboxWaitRow"
import {
  pendingMailboxWaitItems,
  type RoutineMailboxWait,
  routineMailboxWaitOf,
} from "~/modules/agent/routine-mailbox-wait-item"
import {
  knownMailboxStatus,
  MAILBOX_WAIT_TOAST_MS,
  mailboxWaitDismissPath,
  startMailboxWaitRun,
} from "~/modules/agent/routine-mailbox-wait-run"
import { useI18n } from "~/modules/i18n/i18n-context"
import { MailboxLockedPanel } from "~/modules/mailbox/MailboxLockedPanel"
import { isMailboxUnlocked } from "~/modules/mailbox/mailbox-store"
import { useApi } from "~/modules/shell/ApiContext"
import {
  formatRelativeTime,
  formatTimeLeft,
  rowLocaleFrom,
} from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import {
  DecisionCardActions,
  DecisionRow,
  type DecisionRowAction,
} from "~/modules/shell/DecisionRow"
import { markAttentionRead } from "~/modules/shell/entity-opener"
import { addToast } from "~/modules/shell/toast-store"
import { createNow } from "~/primitives/createNow"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

const [progress, setProgress] = createSignal<{ done: number; total: number } | null>(null)
const [awaitingUnlock, setAwaitingUnlock] = createSignal(false)

/** Test seam: the batch's state outlives a row, so it outlives a test too. */
export function resetMailboxWaitsBatchForTest(): void {
  setProgress(null)
  setAwaitingUnlock(false)
}

interface WaitingRun {
  item: AttentionItem
  wait: RoutineMailboxWait
}

const isNewEmail = (wait: RoutineMailboxWait): boolean =>
  wait.trigger?.app === "mail" &&
  wait.trigger.action === "create" &&
  (wait.trigger.entity === "message" || wait.trigger.entity === "email")

const RoutineMailboxWaitsGroup: Component<{ runs: WaitingRun[] }> = (props) => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const rowLocale = () => rowLocaleFrom(i18n)
  const now = createNow(60_000)
  const [expanded, setExpanded] = createSignal(false)
  const [confirmingDismiss, setConfirmingDismiss] = createSignal(false)
  const [dismissing, setDismissing] = createSignal(false)
  const busy = (): boolean => progress() !== null || dismissing()

  const routineNames = createMemo(() => {
    const counts = new Map<string, number>()
    for (const { wait } of props.runs) {
      const name = wait.routineName || t("kernel.routineMailboxWait.yourRoutine")
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts]
  })
  const title = (): string => {
    const names = routineNames()
    const count = String(props.runs.length)
    return names.length === 1
      ? t("kernel.routineMailboxWait.group.titleOne", { name: names[0]?.[0] ?? "", count })
      : t("kernel.routineMailboxWait.group.titleMany", { count })
  }
  /** Which routines wait, or what started them when it is all one routine. */
  const firstLine = (): string => {
    const names = routineNames()
    if (names.length > 1) return names.map(([name, n]) => `${name} (${n})`).join(", ")
    return props.runs.every(({ wait }) => isNewEmail(wait))
      ? t("kernel.routineMailboxWait.group.triggerEmails")
      : t("kernel.routineMailboxWait.group.triggerMixed")
  }
  const why = () => t("kernel.routineMailboxWait.group.why")
  /** The soonest deadline: from then on, runs start to lapse. */
  const metric = (): string | null => {
    const deadlines = props.runs
      .map(({ wait }) => (wait.expiresAt ? Date.parse(wait.expiresAt) : Number.NaN))
      .filter((at) => Number.isFinite(at))
    if (deadlines.length === 0) return null
    return formatTimeLeft(Math.max(60, (Math.min(...deadlines) - now()) / 1000), rowLocale())
  }
  const age = (): string => {
    const newest = props.runs[props.runs.length - 1]
    return newest ? formatRelativeTime(newest.item.occurredAt, { i18n: rowLocale() }) : ""
  }

  // The mailbox opened after Run all asked for it: the batch starts by itself.
  createEffect(() => {
    if (awaitingUnlock() && isMailboxUnlocked()) {
      setAwaitingUnlock(false)
      untrack(() => void runAll())
    }
  })

  /** The run has left the list; the feed reload confirms. */
  function leaveList(item: AttentionItem): void {
    attentionStore.resolveLocally(item.id)
    markAttentionRead(api, item.app, item.entity, item.entityId)
  }

  async function runAll() {
    if (busy()) return
    const batch = props.runs
    setProgress({ done: 0, total: batch.length })
    try {
      const status = await knownMailboxStatus(api)
      if (status === "locked") {
        setAwaitingUnlock(true)
        return
      }
      if (status !== "unlocked") {
        addToast({ message: t("kernel.routineMailboxWait.statusUnknown"), type: "error" })
        return
      }
      let failed = 0
      let lastStart: { queued: boolean; handedOff: boolean; name: string } | null = null
      let started = 0
      let allHandedOff = true
      for (const [index, { item, wait }] of batch.entries()) {
        setProgress({ done: index + 1, total: batch.length })
        try {
          const start = await startMailboxWaitRun(api, wait)
          if (!start) {
            failed += 1
            continue
          }
          started += 1
          allHandedOff &&= start.handedOff
          lastStart = { ...start, name: wait.routineName }
          leaveList(item)
        } catch (error) {
          // Gone (404), already running (409) or lapsed (410): nothing left to
          // run. Anything else stays listed, and its own row says why.
          if (error instanceof ApiError && [404, 409, 410].includes(error.status)) leaveList(item)
          else failed += 1
        }
      }
      if (failed > 0) {
        addToast({
          message:
            started === 0
              ? t("kernel.routineMailboxWait.failed")
              : t("kernel.routineMailboxWait.group.partial", {
                  started: String(started),
                  total: String(batch.length),
                }),
          type: "error",
        })
      } else if (started === 1 && lastStart) {
        addToast({
          message: t(startedKey(lastStart.queued, lastStart.handedOff), { name: lastStart.name }),
          type: "info",
          durationMs: MAILBOX_WAIT_TOAST_MS,
        })
      } else if (started > 1) {
        addToast({
          message: t(
            allHandedOff
              ? "kernel.routineMailboxWait.group.startedHandoff"
              : "kernel.routineMailboxWait.group.started",
            { count: String(started) },
          ),
          type: "info",
          durationMs: MAILBOX_WAIT_TOAST_MS,
        })
      }
    } finally {
      setProgress(null)
    }
  }

  async function dismissAll() {
    if (busy()) return
    setConfirmingDismiss(false)
    setDismissing(true)
    const batch = props.runs
    let dismissed = 0
    for (const { item, wait } of batch) {
      try {
        await api.post(mailboxWaitDismissPath(wait), {})
        dismissed += 1
        leaveList(item)
      } catch {
        // Stays listed: said below.
      }
    }
    setDismissing(false)
    if (dismissed === batch.length) {
      addToast({
        message: t("kernel.routineMailboxWait.group.dismissed", { count: String(dismissed) }),
        type: "info",
      })
    } else {
      addToast({
        message:
          dismissed === 0
            ? t("kernel.routineMailboxWait.dismissFailed")
            : t("kernel.routineMailboxWait.group.dismissPartial", {
                dismissed: String(dismissed),
                total: String(batch.length),
              }),
        type: "error",
      })
    }
  }

  const runAction = (): DecisionRowAction => ({
    label: t("kernel.routineMailboxWait.group.runAll"),
    testid: "routine-mailbox-waits-run-all",
    icon: Play,
    disabled: busy(),
    onClick: () => void runAll(),
  })
  const dismissAction = (): DecisionRowAction => ({
    label: t("kernel.routineMailboxWait.group.dismissAll"),
    testid: "routine-mailbox-waits-dismiss-all",
    icon: X,
    disabled: busy(),
    onClick: () => setConfirmingDismiss(true),
  })
  const status = (): string | null => {
    const running = progress()
    if (running && !awaitingUnlock()) {
      return t("kernel.routineMailboxWait.group.starting", {
        done: String(running.done),
        total: String(running.total),
      })
    }
    return awaitingUnlock() ? t("kernel.routineMailboxWait.waitingForUnlock") : null
  }

  return (
    <>
      <DecisionRow
        testId="routine-mailbox-waits-row"
        kind="routine_mailbox_wait"
        ariaLabel={t("kernel.routineMailboxWait.group.label")}
        icon={Lock}
        pill={{ appId: null, label: t("kernel.routineMailboxWait.pill") }}
        title={title()}
        lines={[firstLine(), why()]}
        compactLine={why()}
        meta={[t("kernel.routineMailboxWait.group.yourRoutines"), age()]}
        compactMeta={[firstLine(), age()]}
        metric={metric()}
        status={status()}
        primary={runAction()}
        secondary={dismissAction()}
        expanded={expanded()}
        onToggle={() => setExpanded((v) => !v)}
        attrs={{ "data-count": String(props.runs.length) }}
        details={
          <div data-testid="routine-mailbox-waits-list" class="mt-1 flex flex-col gap-2">
            <Show when={!status()}>
              <div class="flex gap-2">
                <DecisionCardActions primary={runAction()} secondary={dismissAction()} />
              </div>
            </Show>
            <ul class="max-h-[60vh] divide-y divide-border-subtle overflow-y-auto rounded-lg border border-border-subtle">
              <For each={props.runs}>
                {(run) => <RoutineMailboxWaitRow item={run.item} wait={run.wait} />}
              </For>
            </ul>
          </div>
        }
        footer={
          awaitingUnlock() ? (
            <div class="w-full" data-testid="routine-mailbox-waits-locked">
              <MailboxLockedPanel
                variant="card"
                body={t("kernel.routineMailboxWait.group.unlockBody")}
                unlockTestId="routine-mailbox-waits-unlock"
              />
            </div>
          ) : undefined
        }
      />
      <Dialog
        open={confirmingDismiss()}
        onOpenChange={(open) => !open && setConfirmingDismiss(false)}
      >
        <Dialog.Content>
          <div data-testid="routine-mailbox-waits-dismiss-confirm">
            <Dialog.Title>
              {t("kernel.routineMailboxWait.group.dismissTitle", {
                count: String(props.runs.length),
              })}
            </Dialog.Title>
            <Dialog.Description class="mt-1 text-[13px] text-text-secondary">
              {t("kernel.routineMailboxWait.group.dismissBody")}
            </Dialog.Description>
            <div class="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDismiss(false)}
              >
                {t("kernel.common.cancel")}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-testid="routine-mailbox-waits-dismiss-confirm-btn"
                onClick={() => void dismissAll()}
              >
                {t("kernel.routineMailboxWait.group.dismissAll")}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog>
    </>
  )
}

/** One waiting run keeps its own row; two or more are one row. */
const RoutineMailboxWaitsRow: Component<{ item: AttentionItem; wait: RoutineMailboxWait }> = (
  props,
) => {
  const now = createNow(60_000)
  const runs = createMemo<WaitingRun[]>(() =>
    pendingMailboxWaitItems(attentionStore.items, now()).flatMap((item) => {
      const wait = routineMailboxWaitOf(item)
      return wait ? [{ item, wait }] : []
    }),
  )
  return (
    <Show
      when={runs().length > 1 || (progress() !== null && runs().length > 0)}
      fallback={<RoutineMailboxWaitRow item={props.item} wait={props.wait} />}
    >
      <RoutineMailboxWaitsGroup runs={runs()} />
    </Show>
  )
}

export default RoutineMailboxWaitsRow
