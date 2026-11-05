// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PHONE SESSION SCREEN'S TOP BAR (P4-T10; charter "Phone"). Registered as
// the session tab type's `phoneHeader`, so at phone tier it owns the shell's
// whole top bar: back to the Sessions list (the phone's first screen), the
// session title truncated, Stop while the session can still be stopped, and a
// menu with Mark done (S7), the bell (S14) and Run on its own (S33) when the
// API serves the fields they rest on (the desktop header's rules,
// SessionHeader.tsx).
// Stop is P3's `stop` action from the session-actions registry (D55); on a
// desktop only the composer carries Stop (D27). A second tap while it is on
// its way sends nothing.
//
// `SessionPhoneChips` is the row under the bar: status, Autonomous (S30), who
// else drives the session (S51), folder, model, Files
// changed with its count (which opens the files drawer full height), and a
// Details toggle (44 px) that opens every other chip the desktop header shows
// (branch, pull request, level, node, Claude Code, reasoning level,
// subagents, tokens, prompt cache, context, elapsed, origin). Under it, as on
// the desktop header, a Needs-you session's reason (S32, S36, S57) and an
// Atelier session's stepper (S35).
//
// W3 (S41, A45, A49): the menu also offers Take over (a follow-mode import),
// Stop following (a followed session) and Delete from Liaison (an import,
// behind the same confirmation as the desktop's); the chips row says
// "Imported" and "Following VS Code".

import type { NodeSessionEvent } from "@liaison/shared"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  FileDiff,
  Folder,
  MoreHorizontal,
  Sparkles,
  Square,
} from "lucide-solid"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import { PopupMenu } from "~/ui/PopupMenu"
import { AtelierStepper } from "./AtelierStepper"
import { sessionState, sessionTitle } from "./display"
import { clientFilesChanged } from "./files-changed"
import { TAP_TARGET } from "./phone"
import {
  AutonomousChip,
  canDeleteImport,
  canMarkDone,
  canStopFollowing,
  canTakeOver,
  DeleteImportDialog,
  DriverBadge,
  hasAutonomy,
  hasBell,
  ImportChips,
  markSessionDone,
  NeedsYouReasonLine,
  SessionDetailChips,
  StatusPill,
  stopFollowing,
  takeOverSession,
  toggleSessionAutonomy,
  toggleSessionMuted,
} from "./SessionHeader"
import { sessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import { sessionStore } from "./session-store"
import "./session-steering"
import { startCwd } from "./transcript"

/** The statuses a Stop still acts on (the composer's: D36). */
const STOPPABLE: ReadonlySet<string> = new Set(["queued", "running", "waiting", "paused"])

/** The phone's first screen: the Sessions list. */
export function openSessionsList(): void {
  openTab({
    type: "kernel:sessions",
    entityId: "sessions",
    label: "Sessions",
    routePath: "/sessions",
  })
}

export default function SessionPhoneHeader(props: { entityId: string }) {
  const t = useI18n().t
  const row = () => sessionStore.row(props.entityId)
  const [stopping, setStopping] = createSignal(false)
  const canStop = () => {
    const r = row()
    return !!r && !!sessionActions().stop && STOPPABLE.has(sessionState(r))
  }
  const [menuOpen, setMenuOpen] = createSignal(false)
  const offersDone = () => {
    const r = row()
    return !!r && canMarkDone(r)
  }
  const offersBell = () => {
    const r = row()
    return !!r && hasBell(r)
  }
  const offersAutonomy = () => {
    const r = row()
    return !!r && hasAutonomy(r)
  }
  const offersTakeOver = () => {
    const r = row()
    return !!r && canTakeOver(r)
  }
  const offersStopFollowing = () => {
    const r = row()
    return !!r && canStopFollowing(r)
  }
  const offersDelete = () => {
    const r = row()
    return !!r && canDeleteImport(r)
  }
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  // A session that left the stoppable states clears "stopping".
  createEffect(() => {
    if (!canStop()) setStopping(false)
  })

  const stop = async () => {
    if (stopping()) return
    setStopping(true)
    try {
      await sessionActions().stop?.(props.entityId)
    } catch {
      // The action told the owner (a toast); the button is live again.
      setStopping(false)
    }
  }

  return (
    <div data-testid="session-phone-header" class="flex min-w-0 flex-1 items-center gap-1">
      <button
        type="button"
        data-testid="session-phone-back"
        aria-label={t("kernel.nodeSessions.phone.back")}
        class={cn(
          "flex shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover",
          TAP_TARGET,
        )}
        onClick={openSessionsList}
      >
        <ChevronLeft size={20} />
      </button>
      <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">
        {(() => {
          const r = row()
          return r ? sessionTitle(r) : t("kernel.nodeSessions.view.title")
        })()}
      </h1>
      <Show
        when={
          offersDone() ||
          offersBell() ||
          offersAutonomy() ||
          offersTakeOver() ||
          offersStopFollowing() ||
          offersDelete()
        }
      >
        <PopupMenu open={menuOpen()} onOpenChange={setMenuOpen}>
          <PopupMenu.Trigger
            aria-label={t("kernel.nodeSessions.phone.more")}
            data-testid="session-phone-more"
            class={cn(
              "flex shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover",
              TAP_TARGET,
            )}
          >
            <MoreHorizontal size={18} />
          </PopupMenu.Trigger>
          <PopupMenu.Content aria-label={t("kernel.nodeSessions.phone.more")} class="w-64">
            <Show when={offersTakeOver()}>
              <PopupMenu.Item onSelect={() => void takeOverSession(props.entityId)}>
                {t("kernel.nodeSessions.importActions.takeOver")}
              </PopupMenu.Item>
            </Show>
            <Show when={offersStopFollowing()}>
              <PopupMenu.Item onSelect={() => void stopFollowing(props.entityId)}>
                {t("kernel.nodeSessions.importActions.stopFollowing")}
              </PopupMenu.Item>
            </Show>
            <Show when={offersDone()}>
              <PopupMenu.Item onSelect={() => void markSessionDone(props.entityId)}>
                {t("kernel.nodeSessions.header.markDone")}
              </PopupMenu.Item>
            </Show>
            <Show when={offersBell()}>
              <PopupMenu.Item
                onSelect={() => {
                  const r = row()
                  if (r) void toggleSessionMuted(r)
                }}
              >
                {row()?.muted
                  ? t("kernel.nodeSessions.header.unmute")
                  : t("kernel.nodeSessions.header.mute")}
              </PopupMenu.Item>
            </Show>
            <Show when={offersAutonomy()}>
              <PopupMenu.Item
                onSelect={() => {
                  const r = row()
                  if (r) void toggleSessionAutonomy(r)
                }}
              >
                <span class="flex-1">{t("kernel.nodeSessions.autonomy.runOnItsOwn")}</span>
                <Show when={row()?.autonomy === "autonomous"}>
                  <Check size={14} aria-hidden="true" />
                </Show>
              </PopupMenu.Item>
            </Show>
            <Show when={offersDelete()}>
              <PopupMenu.Item onSelect={() => setConfirmingDelete(true)}>
                {t("kernel.nodeSessions.importActions.delete")}
              </PopupMenu.Item>
            </Show>
          </PopupMenu.Content>
        </PopupMenu>
      </Show>
      <Show when={offersDelete()}>
        <DeleteImportDialog
          sessionId={props.entityId}
          open={confirmingDelete()}
          onOpenChange={setConfirmingDelete}
        />
      </Show>
      <Show when={canStop()}>
        <button
          type="button"
          data-testid="session-phone-stop"
          aria-label={t("kernel.nodeSessions.phone.stop")}
          disabled={stopping()}
          class={cn(
            "flex shrink-0 items-center justify-center rounded-md text-error hover:bg-error-glow disabled:opacity-50",
            TAP_TARGET,
          )}
          onClick={() => void stop()}
        >
          <Square class="h-4 w-4" />
        </button>
      </Show>
    </div>
  )
}

export function SessionPhoneChips(props: {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
  onOpenFiles: () => void
  /** S20/D21: the subagent chip opens the Subagents panel (its owner wires it). */
  onOpenSubagents?: () => void
  /** S53 (D29): the server's file count (every event's); absent, the held events' own. */
  filesCount?: number
}) {
  const t = useI18n().t
  const files = createMemo(() =>
    props.filesCount !== undefined
      ? []
      : clientFilesChanged(props.events, {
          cwd: startCwd(props.events),
          folderName: props.session.folderName,
          sessionId: props.session.id,
          repo: props.session.repo,
        }),
  )
  const [details, setDetails] = createSignal(false)
  const chip =
    "inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[12px] text-text-secondary"
  return (
    <div class="border-b border-border px-3 py-1.5">
      <div data-testid="session-phone-chips" class="flex min-w-0 flex-wrap items-center gap-1.5">
        <StatusPill session={props.session} />
        <AutonomousChip session={props.session} />
        <ImportChips session={props.session} events={props.events} />
        <DriverBadge session={props.session} events={props.events} />
        <Show when={props.session.folderName ?? props.session.repo}>
          {(name) => (
            <span class={chip}>
              <Folder class="h-3 w-3 shrink-0" />
              <span class="min-w-0 max-w-[10rem] truncate">{name()}</span>
            </span>
          )}
        </Show>
        <span class={chip}>
          <Sparkles class="h-3 w-3 shrink-0" />
          <span class="min-w-0 max-w-[10rem] truncate">{props.session.model}</span>
        </span>
        <button
          type="button"
          data-testid="session-phone-files"
          class={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-[12.5px] text-text-secondary hover:bg-surface-hover",
            TAP_TARGET,
          )}
          onClick={() => props.onOpenFiles()}
        >
          <FileDiff class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.header.filesChanged")}
          <b class="tabular-nums text-text">{props.filesCount ?? files().length}</b>
        </button>
        <button
          type="button"
          data-testid="session-phone-details-toggle"
          aria-expanded={details()}
          class={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] text-text-secondary hover:bg-surface-hover",
            TAP_TARGET,
          )}
          onClick={() => setDetails(!details())}
        >
          {t("kernel.nodeSessions.phone.details")}
          <ChevronDown
            class="h-3.5 w-3.5 transition-transform"
            classList={{ "rotate-180": details() }}
          />
        </button>
      </div>
      <div class="flex min-w-0 flex-col gap-1 pt-1.5 empty:hidden">
        <NeedsYouReasonLine session={props.session} />
        <AtelierStepper session={props.session} events={props.events} />
      </div>
      <Show when={details()}>
        <div class="pt-1.5">
          <SessionDetailChips
            session={props.session}
            events={props.events}
            onOpenSubagents={props.onOpenSubagents}
            omitFolderAndModel
            testId="session-phone-details"
          />
        </div>
      </Show>
    </div>
  )
}
