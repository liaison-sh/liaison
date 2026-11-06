// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ROUTINE RUN WAITING FOR ITS OWNER'S PRIVATE MAILBOX, in the owner's
// approvals list (attention kind `routine_mailbox_wait`).
//
// A private mailbox is readable only in its owner's own unlocked window, so a
// routine run that needed it waits (the server's routine-mailbox-wait.ts). This
// row says so in the approvals list's own anatomy (DecisionRow): a "Private
// mailbox" pill, "<routine> waits for you", what started it and why it waits,
// how long is left, Run now and Dismiss, and Details for the run's facts. A Run now while this window's mailbox is locked shows the
// mailbox's own unlock card right here, and the run starts by itself once the
// mailbox opens: never a dead end. "Locked" means KNOWN locked: while the lock
// state is still unknown (the startup restore of a mailbox unlocked earlier in
// this login may not have finished), the row runs that same restore and waits
// for it, so an open mailbox never shows a card.
//
// Several waiting runs show as one row (RoutineMailboxWaitsRow); this row is
// the single case, and each run's line under that row's Details.
//
// Pressing it opens a turn scope in THIS browser (the same nonce a typed turn
// gets) and asks the server to run the routine with it. The answer carries the
// run's request for the email that started it (the handoff), which this
// window's responder answers right away, inside the same bounds as any turn's
// read: after that the run needs no browser for it, and the owner may close
// the window. Once Run now answered, the row leaves the list at once and a
// toast says the routine is running (or, when another run of it is running,
// that it starts right after). Nothing here decrypts anything itself.
//
//   POST /agent/routines/:routineId/mailbox-waits/:runId/run   { turnNonce }
//     → { started, runId, queued, handoff: { requestId, messageIds, expiresAt } | null }
//   POST /agent/routines/:routineId/mailbox-waits/:runId/dismiss

import type { AttentionItem } from "@liaison/shared"
import { Lock, Play, X } from "lucide-solid"
import { type Component, createEffect, createSignal, Show, untrack } from "solid-js"
import { ApiError } from "~/lib/api-error"
import type { RoutineMailboxWait } from "~/modules/agent/routine-mailbox-wait-item"
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
  DecisionDetailsCard,
  DecisionRow,
  type DecisionRowAction,
} from "~/modules/shell/DecisionRow"
import { markAttentionRead } from "~/modules/shell/entity-opener"
import { addToast } from "~/modules/shell/toast-store"
import { createNow } from "~/primitives/createNow"

export {
  isExpiredMailboxWait,
  type RoutineMailboxWait,
  routineMailboxWaitOf,
} from "~/modules/agent/routine-mailbox-wait-item"

export {
  MAILBOX_WAIT_TOAST_MS,
  MAILBOX_WAIT_TURN_OPEN_MS,
  type MailboxWaitRunResponse,
  mailboxWaitDismissPath,
  mailboxWaitRunPath,
} from "~/modules/agent/routine-mailbox-wait-run"

/** A new email is any mail app message or email create event. */
function isNewEmail(trigger: RoutineMailboxWait["trigger"]): boolean {
  return (
    trigger?.app === "mail" &&
    trigger.action === "create" &&
    (trigger.entity === "message" || trigger.entity === "email")
  )
}

/** What the toast says once Run now answered (the row has left the list). */
export function startedKey(queued: boolean, handedOff: boolean): string {
  if (queued) {
    return handedOff
      ? "kernel.routineMailboxWait.queuedHandoff"
      : "kernel.routineMailboxWait.queued"
  }
  return handedOff
    ? "kernel.routineMailboxWait.startedHandoff"
    : "kernel.routineMailboxWait.started"
}

const RoutineMailboxWaitRow: Component<{ item: AttentionItem; wait: RoutineMailboxWait }> = (
  props,
) => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const rowLocale = () => rowLocaleFrom(i18n)
  const [submitting, setSubmitting] = createSignal(false)
  // Run now answered, or Dismiss did: the row has left the list.
  const [gone, setGone] = createSignal(false)
  const [expiredByServer, setExpiredByServer] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  // Run now was pressed while this window's mailbox is locked: the unlock card
  // shows here, and the run starts once the mailbox opens.
  const [awaitingUnlock, setAwaitingUnlock] = createSignal(false)
  const now = createNow(60_000)
  const expiresAtMs = (): number =>
    props.wait.expiresAt ? Date.parse(props.wait.expiresAt) : Number.NaN
  const expired = (): boolean => {
    if (expiredByServer()) return true
    const at = expiresAtMs()
    return Number.isFinite(at) && at <= now()
  }
  /** "21h left", the deadline metric every approval row shows. */
  const metric = (): string | null => {
    const at = expiresAtMs()
    if (!Number.isFinite(at) || expired()) return null
    return formatTimeLeft(Math.max(60, (at - now()) / 1000), rowLocale())
  }

  const triggerLine = (): string => {
    const trigger = props.wait.trigger
    if (!trigger) return t("kernel.routineMailboxWait.triggerSchedule")
    if (isNewEmail(trigger)) return t("kernel.routineMailboxWait.triggerEmail")
    return t("kernel.routineMailboxWait.triggerEvent", {
      event: `${trigger.app} ${trigger.entity} ${trigger.action}`.replace(/_/g, " "),
    })
  }
  const name = (): string => props.wait.routineName || t("kernel.routineMailboxWait.yourRoutine")
  const age = (): string => formatRelativeTime(props.item.occurredAt, { i18n: rowLocale() })
  const dateTime = (iso: string): string => {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return ""
    return new Intl.DateTimeFormat(i18n.locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(at))
  }

  // The mailbox opened after Run now asked for it: the run starts by itself.
  createEffect(() => {
    if (awaitingUnlock() && isMailboxUnlocked()) {
      setAwaitingUnlock(false)
      untrack(() => void runNow())
    }
  })

  /** The row leaves the list now; the feed reload confirms. */
  function leaveList(): void {
    setGone(true)
    setAwaitingUnlock(false)
    attentionStore.resolveLocally(props.item.id)
    markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
  }

  async function runNow() {
    if (submitting() || gone() || expired()) return
    setSubmitting(true)
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
      const started = await startMailboxWaitRun(api, props.wait)
      if (!started) {
        addToast({ message: t("kernel.routineMailboxWait.notReady"), type: "error" })
        return
      }
      addToast({
        message: t(startedKey(started.queued, started.handedOff), { name: name() }),
        type: "info",
        durationMs: MAILBOX_WAIT_TOAST_MS,
      })
      leaveList()
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        setExpiredByServer(true)
        return
      }
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : t("kernel.routineMailboxWait.failed")
      addToast({ message, type: "error" })
    } finally {
      setSubmitting(false)
    }
  }

  async function dismiss() {
    if (submitting() || gone()) return
    setSubmitting(true)
    try {
      await api.post(mailboxWaitDismissPath(props.wait), {})
      addToast({ message: t("kernel.routineMailboxWait.dismissed"), type: "info" })
      leaveList()
    } catch {
      addToast({ message: t("kernel.routineMailboxWait.dismissFailed"), type: "error" })
    } finally {
      setSubmitting(false)
    }
  }

  const runAction = (): DecisionRowAction => ({
    label: t("kernel.routineMailboxWait.runNow"),
    testid: "routine-mailbox-wait-run",
    icon: Play,
    disabled: submitting(),
    onClick: () => void runNow(),
  })
  const dismissAction = (): DecisionRowAction => ({
    label: t("kernel.routineMailboxWait.dismiss"),
    testid: "routine-mailbox-wait-dismiss",
    icon: X,
    disabled: submitting(),
    onClick: () => void dismiss(),
  })
  const status = (): string | null =>
    expired()
      ? t("kernel.routineMailboxWait.expiredStatus")
      : awaitingUnlock()
        ? t("kernel.routineMailboxWait.waitingForUnlock")
        : null
  const pill = () => ({ appId: null, label: t("kernel.routineMailboxWait.pill") })
  const why = () =>
    expired() ? t("kernel.routineMailboxWait.expired") : t("kernel.routineMailboxWait.whyShort")

  const facts = () => [
    {
      label: t("kernel.routineMailboxWait.factRoutine"),
      value: name(),
      testid: "routine-mailbox-wait-fact-routine",
    },
    {
      label: t("kernel.routineMailboxWait.factStartedBy"),
      value: triggerLine(),
      testid: "routine-mailbox-wait-fact-trigger",
    },
    {
      label: t("kernel.routineMailboxWait.factWaitingSince"),
      value: `${dateTime(props.item.occurredAt)} (${age()})`,
      testid: "routine-mailbox-wait-fact-since",
    },
    ...(props.wait.expiresAt
      ? [
          {
            label: t("kernel.routineMailboxWait.factExpires"),
            value: metric()
              ? `${dateTime(props.wait.expiresAt)} (${metric()})`
              : dateTime(props.wait.expiresAt),
            testid: "routine-mailbox-wait-fact-expires",
          },
        ]
      : []),
    {
      label: t("kernel.routineMailboxWait.factState"),
      value: expired()
        ? t("kernel.routineMailboxWait.expiredStatus")
        : awaitingUnlock()
          ? t("kernel.routineMailboxWait.stateUnlock")
          : t("kernel.routineMailboxWait.stateWaiting"),
      testid: "routine-mailbox-wait-fact-state",
    },
    {
      label: t("kernel.routineMailboxWait.factBusy"),
      value: t("kernel.routineMailboxWait.busyQueues"),
      testid: "routine-mailbox-wait-fact-busy",
    },
  ]

  return (
    <Show when={!gone()}>
      <DecisionRow
        testId="routine-mailbox-wait-row"
        kind={props.item.kind}
        ariaLabel={t("kernel.routineMailboxWait.label")}
        icon={Lock}
        pill={pill()}
        title={t("kernel.routineMailboxWait.title", { name: name() })}
        lines={[triggerLine(), why()]}
        compactLine={why()}
        meta={[t("kernel.routineMailboxWait.yourRoutine"), age()]}
        compactMeta={[triggerLine(), age()]}
        metric={metric()}
        status={status()}
        primary={runAction()}
        secondary={dismissAction()}
        expanded={expanded()}
        onToggle={() => setExpanded((v) => !v)}
        attrs={{ "data-expired": expired() ? "true" : "false" }}
        details={
          <DecisionDetailsCard
            testId="routine-mailbox-wait-card"
            icon={Lock}
            pill={pill()}
            handle={props.wait.runId.slice(0, 8)}
            title={name()}
            subtitle={t("kernel.routineMailboxWait.why")}
            facts={facts()}
            technical={`routine ${props.wait.routineId} · run ${props.wait.runId}`}
            actions={
              <Show when={!status()}>
                <DecisionCardActions primary={runAction()} secondary={dismissAction()} />
              </Show>
            }
          />
        }
        footer={
          awaitingUnlock() && !expired() ? (
            <div class="w-full" data-testid="routine-mailbox-wait-locked">
              <MailboxLockedPanel
                variant="card"
                body={t("kernel.routineMailboxWait.unlockBody")}
                unlockTestId="routine-mailbox-wait-unlock"
              />
            </div>
          ) : undefined
        }
      />
    </Show>
  )
}

export default RoutineMailboxWaitRow
