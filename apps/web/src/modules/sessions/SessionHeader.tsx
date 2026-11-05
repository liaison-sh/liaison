// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION HEADER (P2-T09; charter, Sessions app). Title, status pill
// (Paused while the node is offline, P2-D3), who else drives the session
// (S51: "Open in VS Code", its reason in the title), Files changed with its
// count, Open in VS Code (S52: the desktop app, a session of this computer in
// its folder), Mark done while the session is in the Needs-you group (S7) and
// the bell (S14), the Autonomous chip and the Run on its own switch (S30,
// S33), each only when the API serves the field it rests on (`state`,
// `muted`, `autonomy`: a new client on an older API shows none of them); under
// the title row, a Needs-you session's reason (its code in words, else its
// own words: S32, S36, S57) and an Atelier session's stepper (S35,
// AtelierStepper.tsx). No Stop
// here: the composer carries it beside Send (D27); the phone's top bar keeps
// its own. The desktop header lays these out in four quiet layers (see
// SessionHeader below): title row with its actions, callouts, one plain
// context line (SessionContextLine), the telemetry (SessionTelemetry) with
// Files changed at its right edge. The phone's Details keep the chips
// (SessionDetailChips): folder, branch (pushed, pull request), model,
// level, node (online dot), Claude Code version and source (its path only in
// that chip's tooltip), reasoning level (D7, when set), subagents
// ("n running · n stuck · n done", S20/D21: a click calls `onOpenSubagents`,
// the panel's opener), tokens ("in · out" with a breakdown popover, D23; an
// older row keeps its single total), prompt cache countdown and context
// (S22), elapsed (ticking while it runs), origin. The figures come from
// header-info.ts.
//
// W3 (S41, A44, A45, A49): an import says so ("Imported") and, while Liaison
// follows it, who drives it ("Following VS Code"); a follow-mode import offers
// Take over, a followed session Stop following, and an import Delete from
// Liaison behind a confirmation (the transcript stays on the computer).

import { isNeedsYouStatus, type NodeSessionEvent, type NodeSessionOrphan } from "@liaison/shared"
import {
  Bell,
  BellOff,
  Bot,
  Brain,
  Check,
  CircleCheck,
  Coins,
  Cpu,
  Database,
  Ellipsis,
  Eye,
  FileDiff,
  Folder,
  Gauge,
  GitBranch,
  GitPullRequest,
  Info,
  MessageCircleQuestion,
  Play,
  Shield,
  Sparkles,
  SquareArrowOutUpRight,
  Terminal,
  Timer,
  Trash2,
  Zap,
} from "lucide-solid"
import { createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { log } from "~/lib/logger"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { currentNodeId } from "~/modules/nodes/node-session"
import { nodeById, nodeOnline, nodesStatus } from "~/modules/nodes/nodes-store"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { getAttentionApi } from "~/modules/shell/attention-store"
import { addToast } from "~/modules/shell/toast-store"
import { getAgentDisplay } from "~/modules/threads/agent-directory"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { FloatingPanel } from "~/ui/FloatingPanel"
import { PopupMenu } from "~/ui/PopupMenu"
import { Switch } from "~/ui/Switch"
import { Tooltip } from "~/ui/Tooltip"
import { AtelierStepper } from "./AtelierStepper"
import {
  displayStatus,
  elapsedMs,
  followingVia,
  followReadOnly,
  formatDuration,
  formatTokens,
  isImport,
  needsYouReason,
  originLabel,
  parseClaudeCode,
  reasonLineText,
  sessionState,
  sessionTitle,
  startedByLabel,
  toneOf,
} from "./display"
import { clientFilesChanged } from "./files-changed"
import {
  type CacheState,
  cacheState,
  context,
  drivenElsewhere,
  driverKey,
  formatCountdown,
  markOrphanStopped,
  middleTruncate,
  subagents,
  tokenSplit,
} from "./header-info"
import { deleteImportedSession, type NodeSessionRow } from "./session-api"
import { markDone, sendCommand, setAutonomy, setMuted, stopSession } from "./session-commands"
import { removeSessionRow } from "./session-store"
import { sessionPathContext, startFolderRel } from "./transcript"

const TICKING: ReadonlySet<string> = new Set(["running", "waiting"])

/** S7: Mark done is offered in the Needs-you group, once the API serves `state`. */
export function canMarkDone(session: Pick<NodeSessionRow, "status" | "state">): boolean {
  return session.state != null && isNeedsYouStatus(sessionState(session))
}

/** S14: the bell, once the API serves `muted`. */
export function hasBell(session: Pick<NodeSessionRow, "muted">): boolean {
  return typeof session.muted === "boolean"
}

/**
 * S52: the folder "Open in VS Code" names, or null when the button is hidden:
 * outside the desktop app (or a shell without the opener), on a session of
 * another computer, or a session run for others (isolated, not in place).
 */
export function editorFolder(
  session: Pick<NodeSessionRow, "nodeId" | "configKind" | "folderName">,
): string | null {
  if (!getDesktopBridge()?.openFolderInEditor) return null
  const local = currentNodeId()
  if (!local || session.nodeId !== local) return null
  if (session.configKind !== "owner") return null
  return session.folderName || null
}

/**
 * S52: a session's working directory below its shared folder, as the path
 * relative to that folder, or undefined for the folder itself. The node
 * matched it against the folder's real path (batch-4 F5: never by finding the
 * folder's name in the cwd, which a subfolder may bear too); a start event
 * without it (an older node) opens the folder itself. Only the relative part
 * crosses the bridge; the shell resolves the folder from its own map and
 * refuses anything that leaves it.
 */
export function editorSubPath(folderRel: string | null): string | undefined {
  return folderRel || undefined
}

/** S52: the shell opens the folder; one it does not share is said, never silent. */
async function openInEditor(folderName: string, relativePath?: string): Promise<void> {
  const bridge = getDesktopBridge()
  const opened = await (relativePath
    ? bridge?.openFolderInEditor?.(folderName, relativePath)
    : bridge?.openFolderInEditor?.(folderName)
  )?.catch(() => false)
  if (!opened) {
    addToast({
      message: tNow("kernel.nodeSessions.header.openInEditorFailed", { folder: folderName }),
      type: "error",
    })
  }
}

/**
 * D33: "Stop it" is offered for an orphan holding a session of this computer,
 * in a desktop shell that can stop it.
 */
function canStopOrphan(session: Pick<NodeSessionRow, "nodeId">): boolean {
  if (!getDesktopBridge()?.stopOrphanClaude) return false
  const local = currentNodeId()
  return !!local && session.nodeId === local
}

/**
 * D33: the owner's click: the shell checks the pid against the CLI's registry
 * and the process table, then stops it. Stopped, the badge clears and a
 * message the orphan refused resumes the session (the composer); refused, a
 * toast says so and the badge stays.
 */
async function stopOrphan(sessionId: string, orphan: NodeSessionOrphan): Promise<void> {
  const stopped = orphan.cliSessionId
    ? await getDesktopBridge()
        ?.stopOrphanClaude?.(orphan.cliSessionId, orphan.pid)
        .catch(() => false)
    : false
  if (stopped) {
    markOrphanStopped(sessionId, orphan.pid)
    return
  }
  addToast({
    message: tNow("kernel.nodeSessions.header.stopOrphanFailed", { pid: orphan.pid }),
    type: "error",
  })
}

/** S51: who else drives the session ("Driven from VS Code"), its reason in the title. */
export function DriverBadge(props: {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
}) {
  const t = useI18n().t
  const driven = createMemo(() => drivenElsewhere(props.session, props.events))
  const [stopping, setStopping] = createSignal(false)
  return (
    <Show when={driven()}>
      {(d) => (
        <>
          <span
            data-testid="session-driver"
            title={t(`kernel.nodeSessions.header.driverReason.${driverKey(d())}`, {
              pid: d().orphan?.pid ?? 0,
            })}
            class="inline-flex min-w-0 items-center rounded-full bg-warning-glow px-2 py-0.5 text-[12px] font-medium text-warning"
          >
            {t(`kernel.nodeSessions.header.driver.${driverKey(d())}`, {
              pid: d().orphan?.pid ?? 0,
            })}
          </span>
          <Show when={canStopOrphan(props.session) && d().orphan?.cliSessionId ? d().orphan : null}>
            {(orphan) => (
              <button
                type="button"
                disabled={stopping()}
                class="inline-flex shrink-0 items-center rounded-md border border-border px-2 py-1 text-[12.5px] text-error hover:border-error disabled:opacity-50"
                onClick={() => {
                  setStopping(true)
                  void stopOrphan(props.session.id, orphan()).finally(() => setStopping(false))
                }}
              >
                {t("kernel.nodeSessions.header.stopOrphan")}
              </button>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}

/** Run an owner action; a failure is a toast, never a silent no-op. */
async function ownerAction(
  sessionId: string,
  run: () => Promise<unknown>,
  /** The sentence for a node too old for this command (409 node_outdated, English only). */
  outdatedKey?: string,
): Promise<void> {
  try {
    await run()
  } catch (err) {
    log.warn({ err, sessionId }, "a session action failed")
    addToast({
      message:
        outdatedKey && err instanceof ApiError && err.code === "node_outdated"
          ? tNow(outdatedKey)
          : tNow("kernel.nodeSessions.steer.composer.sendFailed", {
              error: err instanceof Error ? err.message : String(err),
            }),
      type: "error",
    })
  }
}

/** S7: the owner marks the session Done. */
export const markSessionDone = (sessionId: string) =>
  ownerAction(sessionId, () => markDone(sessionId), "kernel.nodeSessions.header.markDoneOutdated")

/** S14: the bell flips the session's mute. */
export const toggleSessionMuted = (session: Pick<NodeSessionRow, "id" | "muted">) =>
  ownerAction(session.id, () => setMuted(session.id, !session.muted))

/**
 * S30: the autonomy chip and switch, once the API serves `autonomy`. Never on
 * a read-only follow (S41): Liaison does not drive it, so how it would run on
 * its own cannot apply; they come back once it is taken over.
 */
export function hasAutonomy(
  session: Pick<NodeSessionRow, "autonomy"> &
    Partial<Pick<NodeSessionRow, "source" | "importMode">>,
): boolean {
  if (session.source === "import" && session.importMode === "follow") return false
  return session.autonomy === "guided" || session.autonomy === "autonomous"
}

/**
 * S33: the switch flips the session's autonomy. The row changes at once; a
 * live process on a computer whose Liaison predates the command keeps its
 * mode until its next run (`row_only`), which a toast says.
 */
export const toggleSessionAutonomy = (session: Pick<NodeSessionRow, "id" | "autonomy">) =>
  ownerAction(
    session.id,
    async () => {
      const next = session.autonomy === "autonomous" ? "guided" : "autonomous"
      const sent = await setAutonomy(session.id, next)
      if (sent.applied === "row_only") {
        addToast({ message: tNow("kernel.nodeSessions.autonomy.nextRun"), type: "info" })
      }
    },
    "kernel.nodeSessions.autonomy.outdated",
  )

/** S30: "Autonomous" while the session runs on its own. */
export function AutonomousChip(props: {
  session: Pick<NodeSessionRow, "autonomy"> & Partial<Pick<NodeSessionRow, "source" | "importMode">>
}) {
  const t = useI18n().t
  return (
    <Show when={props.session.autonomy === "autonomous" && hasAutonomy(props.session)}>
      <span
        data-testid="session-autonomous"
        class="inline-flex shrink-0 items-center rounded-full bg-accent-glow px-2 py-0.5 text-[12px] font-medium text-accent"
      >
        {t("kernel.nodeSessions.autonomy.autonomous")}
      </span>
    </Show>
  )
}

/** S41: Take over is offered on a follow-mode import. */
export const canTakeOver = followReadOnly

/** A45: Stop following, while a follow job of the session holds its lease. */
export function canStopFollowing(session: Pick<NodeSessionRow, "following">): boolean {
  return session.following === true
}

/** A49: Delete from Liaison is offered on imports only. */
export const canDeleteImport = isImport

/** A44: the owner turns a Follow into a Take over (server-applied). */
export const takeOverSession = (sessionId: string) =>
  ownerAction(sessionId, () => sendCommand(sessionId, { type: "take_over", payload: {} }))

/** A45: Stop ends the follow (the session waits as `follow_ended`). */
export const stopFollowing = (sessionId: string) =>
  ownerAction(sessionId, () => stopSession(sessionId))

/** S40, A45: "Imported" on an import; "Following VS Code" while Liaison follows. */
export function ImportChips(props: {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
}) {
  const t = useI18n().t
  const via = createMemo(() => followingVia(props.session, props.events))
  return (
    <>
      <Show when={isImport(props.session)}>
        <span
          data-testid="session-imported"
          class="inline-flex shrink-0 items-center rounded-full bg-surface-hover px-2 py-0.5 text-[12px] font-medium text-text-secondary"
        >
          {t("kernel.nodeSessions.importActions.imported")}
        </span>
      </Show>
      <Show when={via()}>
        {(v) => (
          <span
            data-testid="session-following"
            class="inline-flex shrink-0 items-center rounded-full bg-accent-glow px-2 py-0.5 text-[12px] font-medium text-accent"
          >
            {t(`kernel.nodeSessions.importActions.following.${v()}`)}
          </span>
        )}
      </Show>
    </>
  )
}

/**
 * A49: the confirmation before an import is deleted from Liaison. Deleted,
 * the row leaves the store and its tab closes; refused, a toast says why.
 */
export function DeleteImportDialog(props: {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useI18n().t
  const api = useOptionalApi() ?? getAttentionApi()
  const [busy, setBusy] = createSignal(false)
  const confirm = async () => {
    if (busy() || !api) return
    setBusy(true)
    try {
      const outcome = await deleteImportedSession(api, props.sessionId)
      if (outcome.ok || outcome.code === "not_found") {
        props.onOpenChange(false)
        removeSessionRow(props.sessionId)
        return
      }
      addToast({
        message: t(
          outcome.code === "not_import" || outcome.code === "session_live"
            ? `kernel.nodeSessions.importActions.deleteRefused.${outcome.code}`
            : "kernel.nodeSessions.importActions.deleteRefused.failed",
        ),
        type: "error",
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content>
        <div data-testid="session-delete-dialog">
          <Dialog.Title>{t("kernel.nodeSessions.importActions.deleteTitle")}</Dialog.Title>
          <Dialog.Description>
            {t("kernel.nodeSessions.importActions.deleteBody")}
          </Dialog.Description>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => props.onOpenChange(false)}>
              {t("kernel.nodeSessions.importActions.cancel")}
            </Button>
            <Button variant="danger" disabled={busy()} onClick={() => void confirm()}>
              {t("kernel.nodeSessions.importActions.deleteConfirm")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

/** The desktop header's import actions: Take over, Stop following, Delete from Liaison. */
function ImportActions(props: { session: NodeSessionRow }) {
  const t = useI18n().t
  const [confirming, setConfirming] = createSignal(false)
  return (
    <>
      <Show when={canTakeOver(props.session)}>
        <Button
          variant="outline"
          size="sm"
          class="gap-1.5"
          onClick={() => void takeOverSession(props.session.id)}
        >
          <Play class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.importActions.takeOver")}
        </Button>
      </Show>
      <Show when={canStopFollowing(props.session)}>
        <Button
          variant="outline"
          size="sm"
          class="gap-1.5"
          onClick={() => void stopFollowing(props.session.id)}
        >
          <Eye class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.importActions.stopFollowing")}
        </Button>
      </Show>
      <Show when={canDeleteImport(props.session)}>
        <Button variant="ghost" size="sm" class="gap-1.5" onClick={() => setConfirming(true)}>
          <Trash2 class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.importActions.delete")}
        </Button>
        <DeleteImportDialog
          sessionId={props.session.id}
          open={confirming()}
          onOpenChange={setConfirming}
        />
      </Show>
    </>
  )
}

/**
 * S32, S36, S57: why a Needs-you session waits, its code in words, else its
 * own words. `callout` (the desktop header) sets it apart as a tinted box under
 * the title; the phone keeps the plain line.
 */
export function NeedsYouReasonLine(props: {
  session: Pick<NodeSessionRow, "status" | "state" | "reasonCode" | "resultSummary">
  callout?: boolean
}) {
  const t = useI18n().t
  const reason = () => needsYouReason(props.session, t, REASON_MAX)
  return (
    <Show when={reason()}>
      {(r) => {
        const text = () => reasonLineText(r(), t)
        return (
          <Show
            when={props.callout}
            fallback={
              <p
                data-testid="session-header-reason"
                class="min-w-0 truncate text-[12.5px] text-warning"
              >
                {text()}
              </p>
            }
          >
            <div class="flex min-w-0 items-start gap-2 rounded-md border border-warning-border bg-warning-glow px-2.5 py-1.5 text-warning">
              <MessageCircleQuestion class="mt-px h-3.5 w-3.5 shrink-0" />
              <p
                data-testid="session-header-reason"
                title={text()}
                class="line-clamp-2 min-w-0 break-words text-[12.5px] leading-snug"
              >
                {text()}
              </p>
            </div>
          </Show>
        )
      }}
    </Show>
  )
}

/** The node of a session reads online until the nodes store knows otherwise. */
export function sessionNodeOnline(session: Pick<NodeSessionRow, "nodeId">): boolean {
  if (nodesStatus() !== "ready") return true
  return nodeOnline(session.nodeId)
}

export function StatusPill(props: { session: NodeSessionRow }) {
  const t = useI18n().t
  const status = () => displayStatus(props.session, sessionNodeOnline(props.session))
  return (
    <span
      data-testid="status-pill"
      data-status={status()}
      class={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium ${toneOf(status()).text} ${toneOf(status()).soft}`}
    >
      <span class={`h-1.5 w-1.5 rounded-full ${toneOf(status()).dot}`} />
      {t(`kernel.nodeSessions.status.${status()}`)}
    </span>
  )
}

function Chip(props: { icon?: JSX.Element; title?: string; chip?: string; children: JSX.Element }) {
  return (
    <span
      data-chip={props.chip}
      title={props.title}
      class="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[12px] text-text-secondary"
    >
      {props.icon}
      <span class="min-w-0 truncate">{props.children}</span>
    </span>
  )
}

export interface SessionHeaderProps {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
  /** Kept for callers; the desktop header adapts to its own width (a container query). */
  compact?: boolean
  onOpenFiles?: () => void
  /** S20/D21: the subagent chip opens the Subagents panel (its owner wires it). */
  onOpenSubagents?: () => void
  /** S53 (D29): the server's file count (every event's); absent, the held events' own. */
  filesCount?: number
}

const ICON = "h-3 w-3 shrink-0"
/** The reason line's own words, clipped like the list's (one line). */
const REASON_MAX = 300
/** A branch name longer than this is cut in its middle (full name on hover). */
const BRANCH_MAX = 28
/** The desktop header's icon-only buttons. */
const ICON_BUTTON = "h-7 w-7 p-0"
/**
 * The context line's middots. Every item opens with a 1rem dot box and the row
 * is shifted left by that box (plus the item's gap) inside a clipping parent,
 * so the dot opening each visual line, the first one included, falls outside
 * the clip: a wrapped line never starts with a stray "·", and a missing item
 * (no branch, no effort) never leaves a double one.
 */
const DOTTED =
  "[&>*]:before:inline-block [&>*]:before:w-4 [&>*]:before:shrink-0 [&>*]:before:text-center [&>*]:before:text-text-tertiary [&>*]:before:content-['·']"
const CONTEXT_ITEM = "inline-flex min-w-0 items-center gap-1"
const STAT = "inline-flex min-w-0 items-center gap-1"

/**
 * The desktop header, four quiet layers (owner's pass, 2026-10-16):
 * 1. the title (two lines, then cut, the whole of it on hover) and its status
 *    pill, the actions at the right: Mark done the one tinted button, Open in
 *    VS Code and the bell icon buttons with hints, Run on its own a labelled
 *    switch; a narrow header folds the secondary ones into a More menu;
 * 2. the Needs-you reason as a callout, the driver badge, the Atelier stepper;
 * 3. one line of plain context: folder · branch · model · level · reasoning ·
 *    node · who started it, the Claude Code build behind an info hint;
 * 4. the telemetry, small and tabular, with Files changed at its right edge,
 *    the edge the transcript starts at (hidden while nothing changed).
 */
export default function SessionHeader(props: SessionHeaderProps) {
  const t = useI18n().t
  const files = createMemo(() =>
    props.filesCount === undefined
      ? clientFilesChanged(props.events, sessionPathContext(props.session, props.events))
      : [],
  )
  const filesN = () => props.filesCount ?? files().length
  const title = () => sessionTitle(props.session)

  return (
    <header
      data-testid="session-header"
      class="@container flex flex-col gap-2 border-b border-border px-4 pt-3 pb-2"
    >
      {/* The title row wraps rather than overflows (walk 3: with the subagent
          drawer open, Take over sat on the Following chip): the title and its
          chips keep at least 16rem, the chips go under the title when they do
          not fit beside it, and the actions go under both, right-aligned. */}
      <div
        data-testid="session-title-row"
        class="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2"
      >
        <div
          data-testid="session-title-block"
          class="flex min-w-0 flex-[1_1_16rem] flex-wrap items-start gap-x-2 gap-y-1"
        >
          <h1
            title={title()}
            class="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-snug text-text"
          >
            {title()}
          </h1>
          <div class="flex min-w-0 flex-wrap items-center gap-1.5 pt-px">
            <StatusPill session={props.session} />
            <AutonomousChip session={props.session} />
            <ImportChips session={props.session} events={props.events} />
          </div>
        </div>
        <HeaderActions session={props.session} events={props.events} />
      </div>
      <NeedsYouReasonLine session={props.session} callout />
      <Show when={drivenElsewhere(props.session, props.events)}>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <DriverBadge session={props.session} events={props.events} />
        </div>
      </Show>
      <AtelierStepper session={props.session} events={props.events} />
      <SessionContextLine session={props.session} />
      <div class="flex min-w-0 items-center gap-3">
        <SessionTelemetry
          session={props.session}
          events={props.events}
          onOpenSubagents={props.onOpenSubagents}
        />
        <Show when={filesN() > 0}>
          <Button
            variant="ghost"
            size="sm"
            class="ml-auto shrink-0 gap-1.5 px-2 text-[12px]"
            onClick={() => props.onOpenFiles?.()}
          >
            <FileDiff class="h-3.5 w-3.5" />
            {t("kernel.nodeSessions.header.filesChanged")}
            <span class="rounded-full bg-surface-hover px-1.5 text-[11px] tabular-nums text-text">
              {filesN()}
            </span>
          </Button>
        </Show>
      </div>
    </header>
  )
}

/**
 * The title row's actions. Mark done stays in view at every width; Open in VS
 * Code, the bell and Run on its own fold into a More menu once the header is
 * narrower than 42rem (a container query, so a wide window with a wide list
 * folds too), before anything wraps under the title.
 */
function HeaderActions(props: { session: NodeSessionRow; events: readonly NodeSessionEvent[] }) {
  const t = useI18n().t
  const [menu, setMenu] = createSignal(false)
  const editor = () => editorFolder(props.session)
  const openEditor = (folder: string) =>
    void openInEditor(folder, editorSubPath(startFolderRel(props.events)))
  const muteLabel = () =>
    props.session.muted
      ? t("kernel.nodeSessions.header.unmute")
      : t("kernel.nodeSessions.header.mute")
  const autonomous = () => props.session.autonomy === "autonomous"
  const folds = () => !!editor() || hasBell(props.session) || hasAutonomy(props.session)
  return (
    <div
      data-testid="session-header-actions"
      class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1"
    >
      <ImportActions session={props.session} />
      <Show when={canMarkDone(props.session)}>
        <Button
          variant="primary"
          size="sm"
          class="gap-1.5"
          onClick={() => void markSessionDone(props.session.id)}
        >
          <CircleCheck class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.header.markDone")}
        </Button>
      </Show>
      <div class="flex items-center gap-1 @max-2xl:hidden">
        <Show when={editor()}>
          {(folder) => (
            <Tooltip content={t("kernel.nodeSessions.header.openInEditor")}>
              <Button
                variant="ghost"
                size="sm"
                class={ICON_BUTTON}
                aria-label={t("kernel.nodeSessions.header.openInEditor")}
                onClick={() => openEditor(folder())}
              >
                <SquareArrowOutUpRight class="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
        </Show>
        <Show when={hasBell(props.session)}>
          <Tooltip content={muteLabel()}>
            <Button
              variant="ghost"
              size="sm"
              class={ICON_BUTTON}
              aria-pressed={props.session.muted === true}
              aria-label={t("kernel.nodeSessions.header.mute")}
              onClick={() => void toggleSessionMuted(props.session)}
            >
              <Show when={props.session.muted} fallback={<Bell class="h-3.5 w-3.5" />}>
                <BellOff class="h-3.5 w-3.5" />
              </Show>
            </Button>
          </Tooltip>
        </Show>
        <Show when={hasAutonomy(props.session)}>
          <span aria-hidden="true" class="mx-1.5 h-4 w-px bg-border" />
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch inside is a <button>, a labelable control, so a click on the words flips it too. */}
          <label class="inline-flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-text-secondary">
            {t("kernel.nodeSessions.autonomy.runOnItsOwn")}
            <Switch
              checked={autonomous()}
              label={t("kernel.nodeSessions.autonomy.runOnItsOwn")}
              onChange={() => void toggleSessionAutonomy(props.session)}
            />
          </label>
        </Show>
      </div>
      <Show when={folds()}>
        <div class="hidden @max-2xl:block">
          <PopupMenu open={menu()} onOpenChange={setMenu}>
            <PopupMenu.Trigger
              aria-label={t("kernel.nodeSessions.header.moreActions")}
              data-testid="session-more"
              class="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <Ellipsis class="h-4 w-4" />
            </PopupMenu.Trigger>
            <PopupMenu.Content class="min-w-48">
              <Show when={editor()}>
                {(folder) => (
                  <PopupMenu.Item onSelect={() => openEditor(folder())}>
                    <SquareArrowOutUpRight class="h-3.5 w-3.5" />
                    {t("kernel.nodeSessions.header.openInEditor")}
                  </PopupMenu.Item>
                )}
              </Show>
              <Show when={hasBell(props.session)}>
                <PopupMenu.Item onSelect={() => void toggleSessionMuted(props.session)}>
                  <Show when={props.session.muted} fallback={<BellOff class="h-3.5 w-3.5" />}>
                    <Bell class="h-3.5 w-3.5" />
                  </Show>
                  {muteLabel()}
                </PopupMenu.Item>
              </Show>
              <Show when={hasAutonomy(props.session)}>
                <PopupMenu.Item onSelect={() => void toggleSessionAutonomy(props.session)}>
                  <Check class="h-3.5 w-3.5" classList={{ invisible: !autonomous() }} />
                  {t("kernel.nodeSessions.autonomy.runOnItsOwn")}
                </PopupMenu.Item>
              </Show>
            </PopupMenu.Content>
          </PopupMenu>
        </div>
      </Show>
    </div>
  )
}

/**
 * The desktop header's context, one quiet line of plain text: folder, branch
 * (pushed, pull request; cut in its middle, whole on hover), model, level,
 * reasoning level (D7), node (online dot), who started it and when. The
 * Claude Code version, source and path sit behind the info hint at its end
 * (still read by screen readers), not in the line.
 */
export function SessionContextLine(props: { session: NodeSessionRow }) {
  const i18n = useI18n()
  const t = i18n.t
  const cc = () => parseClaudeCode(props.session.claudeCode)
  const node = () => nodeById(props.session.nodeId)
  const online = () => sessionNodeOnline(props.session)
  const agentName = () =>
    getAgentDisplay(props.session.agentId)?.name ?? t("kernel.nodeSessions.newDialog.agent")
  const started = () => startedByLabel(props.session, agentName(), i18n)
  const source = (s: string) =>
    s === "installed" || s === "bundled" ? t(`kernel.nodeSessions.view.claudeCodeSource.${s}`) : s
  const ccText = (c: NonNullable<ReturnType<typeof cc>>) =>
    // D15: a version the node could not read is left out, never "unknown".
    c.version === "unknown"
      ? t("kernel.nodeSessions.view.claudeCodeNoVersion", { source: source(c.source) })
      : t("kernel.nodeSessions.view.claudeCode", { version: c.version, source: source(c.source) })

  return (
    <div
      data-testid="session-context"
      class="min-w-0 overflow-hidden text-[12px] text-text-secondary"
    >
      <div class={`-ml-5 flex min-w-0 flex-wrap items-center gap-y-0.5 ${DOTTED}`}>
        <Show when={props.session.folderName ?? props.session.repo}>
          {(name) => (
            <span class={CONTEXT_ITEM} title={name()}>
              <Folder class={ICON} />
              <span class="truncate font-medium text-text">{name()}</span>
            </span>
          )}
        </Show>
        <Show when={props.session.branch}>
          {(branch) => (
            <span class={CONTEXT_ITEM} title={branch()}>
              <GitBranch class={ICON} />
              <span class="truncate">{middleTruncate(branch(), BRANCH_MAX)}</span>
              <Show when={props.session.pushed}>
                <span class="shrink-0 text-text-tertiary">
                  ({t("kernel.nodeSessions.header.pushed")})
                </span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={props.session.prUrl}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              class={`${CONTEXT_ITEM} text-accent hover:underline`}
            >
              <GitPullRequest class={ICON} />
              {t("kernel.nodeSessions.header.pr")}
            </a>
          )}
        </Show>
        <span class={CONTEXT_ITEM}>
          <Sparkles class={ICON} />
          <span class="truncate">{props.session.model}</span>
        </span>
        <span class={CONTEXT_ITEM}>
          <Shield class={ICON} />
          {t(`kernel.nodeSessions.level.${props.session.level}`)}
        </span>
        <Show when={props.session.effort}>
          {(effort) => (
            <span class={CONTEXT_ITEM} data-chip="effort">
              <Brain class={ICON} />
              {t("kernel.nodeSessions.header.effort", {
                level: t(`kernel.nodeSessions.effort.${effort()}`),
              })}
            </span>
          )}
        </Show>
        <Show when={node()}>
          {(n) => (
            <span class={CONTEXT_ITEM}>
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                classList={{ "bg-success": online(), "bg-text-tertiary": !online() }}
              />
              <span class="truncate">{n().name}</span>
            </span>
          )}
        </Show>
        <Show when={started()}>
          {(s) => <span class={`${CONTEXT_ITEM} text-text-tertiary`}>{s()}</span>}
        </Show>
        <Show when={cc()}>
          {(c) => (
            <span
              data-chip="claude-code"
              title={[ccText(c()), c().path].filter(Boolean).join("\n")}
              class="inline-flex shrink-0 cursor-help items-center gap-1 text-text-tertiary hover:text-text-secondary"
            >
              <Info class="h-3.5 w-3.5" />
              <span class="sr-only">{ccText(c())}</span>
            </span>
          )}
        </Show>
      </div>
    </div>
  )
}

/**
 * The figures every header reads and the clock that ticks them (S22): the
 * countdown ticks every second while the view is open; the subagents' stuck
 * clock (D21) rides the same tick.
 */
function useHeaderFigures(props: { session: NodeSessionRow; events: readonly NodeSessionEvent[] }) {
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())
  const cache = createMemo(() => cacheState(props.events, now()))
  const subs = createMemo(() => subagents(props.events, now()))
  const timer = setInterval(() => {
    if (
      TICKING.has(sessionState(props.session)) ||
      cache().state === "warm" ||
      subs().running > 0
    ) {
      setNow(Date.now())
    }
  }, 1000)
  onCleanup(() => clearInterval(timer))
  return {
    now,
    cache,
    subs,
    ctx: createMemo(() => context(props.events)),
    tokens: createMemo(() => tokenSplit(props.session)),
    fmt: (n: number) => formatTokens(n, i18n.locale()),
  }
}

/** The cache figure's words: its countdown while warm, "cold" after. */
function cacheText(t: (key: string, params?: Record<string, string>) => string, c: CacheState) {
  return c.state === "warm"
    ? t("kernel.nodeSessions.header.cacheWarm", { time: formatCountdown(c.remainingMs) })
    : t("kernel.nodeSessions.header.cacheCold")
}

function cacheTitle(t: (key: string, params?: Record<string, string>) => string, c: CacheState) {
  return c.state === "warm"
    ? t("kernel.nodeSessions.header.cacheTitle", {
        ttl: t(`kernel.nodeSessions.header.cacheTtl.${c.ttl}`),
      })
    : undefined
}

/**
 * The desktop header's telemetry: subagents (when any; a click opens the
 * panel), tokens (in · out, the breakdown on click), the prompt cache
 * countdown, the context as a small bar, the elapsed time. Quiet and tabular;
 * the cache figure keeps its width so the countdown does not shift the rest.
 */
export function SessionTelemetry(props: {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
  onOpenSubagents?: () => void
}) {
  const t = useI18n().t
  const f = useHeaderFigures(props)
  return (
    <div
      data-testid="session-telemetry"
      class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[12px] tabular-nums text-text-tertiary"
    >
      <Show when={f.subs().list.length > 0}>
        <button
          type="button"
          data-chip="subagents"
          class={`${STAT} -mx-1 rounded-sm px-1 hover:bg-surface-hover hover:text-text`}
          classList={{
            "text-warning": f.subs().stuck > 0,
            "text-text-secondary": f.subs().stuck === 0,
          }}
          onClick={() => props.onOpenSubagents?.()}
        >
          <Bot class={ICON} />
          <span class="min-w-0 truncate">
            {t("kernel.nodeSessions.header.subagents", {
              running: f.subs().running,
              stuck: f.subs().stuck,
              done: f.subs().done,
            })}
          </span>
        </button>
      </Show>
      <TokensChip split={f.tokens()} fmt={f.fmt} quiet />
      <span data-chip="cache" class={STAT} title={cacheTitle(t, f.cache())}>
        <Database class={ICON} />
        <span class="inline-block min-w-[9ch]">{cacheText(t, f.cache())}</span>
      </span>
      <Show when={f.ctx()}>
        {(c) => (
          <span data-chip="context" class={`${STAT} gap-1.5`}>
            <Gauge class={ICON} />
            <span>
              {t("kernel.nodeSessions.header.context", {
                used: f.fmt(c().tokens),
                window: f.fmt(c().window),
                percent: c().percent,
              })}
            </span>
            <span
              aria-hidden="true"
              class="relative h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border"
            >
              <span
                class="absolute inset-y-0 left-0 rounded-full"
                classList={{
                  "bg-text-tertiary": c().percent < 80,
                  "bg-warning": c().percent >= 80 && c().percent < 95,
                  "bg-error": c().percent >= 95,
                }}
                style={{ width: `${Math.min(100, Math.max(2, c().percent))}%` }}
              />
            </span>
          </span>
        )}
      </Show>
      <Show when={props.session.startedAt}>
        <span class={STAT}>
          <Timer class={ICON} />
          {formatDuration(elapsedMs(props.session, f.now()))}
        </span>
      </Show>
    </div>
  )
}

/**
 * The detail chips: folder, branch (pushed, pull request), model, level, node
 * (online dot), Claude Code version and source (its path only in the
 * tooltip), reasoning level, subagents, tokens, prompt cache, context,
 * elapsed (ticking while it runs), origin. The phone (P4) shows them under its
 * Details toggle, without folder and model, which its chips row already
 * carries; the desktop header reads the same figures as a context line and a
 * telemetry row (SessionContextLine, SessionTelemetry).
 */
export function SessionDetailChips(props: {
  session: NodeSessionRow
  events: readonly NodeSessionEvent[]
  onOpenSubagents?: () => void
  compact?: boolean
  omitFolderAndModel?: boolean
  testId?: string
}) {
  const i18n = useI18n()
  const t = i18n.t
  const f = useHeaderFigures(props)
  const cc = () => parseClaudeCode(props.session.claudeCode)
  const node = () => nodeById(props.session.nodeId)
  const online = () => sessionNodeOnline(props.session)
  const agentName = () =>
    getAgentDisplay(props.session.agentId)?.name ?? t("kernel.nodeSessions.newDialog.agent")
  const source = (s: string) =>
    s === "installed" || s === "bundled" ? t(`kernel.nodeSessions.view.claudeCodeSource.${s}`) : s

  return (
    <div
      data-testid={props.testId}
      class="flex min-w-0 gap-1.5"
      classList={{ "flex-col items-start": props.compact, "flex-wrap": !props.compact }}
    >
      <Show when={!props.omitFolderAndModel && (props.session.folderName ?? props.session.repo)}>
        {(name) => (
          <Chip icon={<Folder class={ICON} />} title={name()}>
            <b class="font-medium text-text">{name()}</b>
          </Chip>
        )}
      </Show>
      <Show when={props.session.branch}>
        {(branch) => (
          <Chip icon={<GitBranch class={ICON} />} title={t("kernel.nodeSessions.header.branch")}>
            {branch()}
            <Show when={props.session.pushed}> · {t("kernel.nodeSessions.header.pushed")}</Show>
          </Chip>
        )}
      </Show>
      <Show when={props.session.prUrl}>
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[12px] text-accent hover:underline"
          >
            <GitPullRequest class={ICON} />
            {t("kernel.nodeSessions.header.pr")}
          </a>
        )}
      </Show>
      <Show when={!props.omitFolderAndModel}>
        <Chip icon={<Sparkles class={ICON} />}>{props.session.model}</Chip>
      </Show>
      <Chip icon={<Shield class={ICON} />}>
        {t(`kernel.nodeSessions.level.${props.session.level}`)}
      </Chip>
      <Show when={node()}>
        {(n) => (
          <Chip icon={<Cpu class={ICON} />}>
            <span class="inline-flex items-center gap-1">
              <span
                class="h-1.5 w-1.5 rounded-full"
                classList={{ "bg-success": online(), "bg-text-tertiary": !online() }}
              />
              {n().name}
            </span>
          </Chip>
        )}
      </Show>
      <Show when={cc()}>
        {(c) => (
          <Chip icon={<Terminal class={ICON} />} chip="claude-code" title={c().path || undefined}>
            {/* D15: a version the node could not read is left out, never "unknown". */}
            {c().version === "unknown"
              ? t("kernel.nodeSessions.view.claudeCodeNoVersion", { source: source(c().source) })
              : t("kernel.nodeSessions.view.claudeCode", {
                  version: c().version,
                  source: source(c().source),
                })}
          </Chip>
        )}
      </Show>
      <Show when={props.session.effort}>
        {(effort) => (
          <Chip icon={<Brain class={ICON} />} chip="effort">
            {t("kernel.nodeSessions.header.effort", {
              level: t(`kernel.nodeSessions.effort.${effort()}`),
            })}
          </Chip>
        )}
      </Show>
      <Show when={f.subs().list.length > 0}>
        <button
          type="button"
          data-chip="subagents"
          class="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[12px] text-text-secondary hover:bg-surface-hover"
          classList={{ "border-warning-border": f.subs().stuck > 0 }}
          onClick={() => props.onOpenSubagents?.()}
        >
          <Bot class={ICON} />
          <span class="min-w-0 truncate tabular-nums">
            {t("kernel.nodeSessions.header.subagents", {
              running: f.subs().running,
              stuck: f.subs().stuck,
              done: f.subs().done,
            })}
          </span>
        </button>
      </Show>
      <TokensChip split={f.tokens()} fmt={f.fmt} />
      <Chip icon={<Database class={ICON} />} chip="cache" title={cacheTitle(t, f.cache())}>
        <span class="tabular-nums">{cacheText(t, f.cache())}</span>
      </Chip>
      <Show when={f.ctx()}>
        {(c) => (
          <Chip icon={<Gauge class={ICON} />} chip="context">
            <span class="tabular-nums">
              {t("kernel.nodeSessions.header.context", {
                used: f.fmt(c().tokens),
                window: f.fmt(c().window),
                percent: c().percent,
              })}
            </span>
          </Chip>
        )}
      </Show>
      <Show when={props.session.startedAt}>
        <Chip>
          <span class="tabular-nums">{formatDuration(elapsedMs(props.session, f.now()))}</span>
        </Chip>
      </Show>
      <Chip icon={<Zap class={ICON} />}>{originLabel(props.session, agentName(), i18n)}</Chip>
    </div>
  )
}

/**
 * D23: the Tokens chip. With the split, "in X · out Y" (in = uncached input +
 * cache writes, what the model processed fresh) and a popover with the
 * breakdown and the cache hit rate; without it, the old single total. `quiet`
 * (the desktop telemetry) drops the chip's border.
 */
function TokensChip(props: {
  split: ReturnType<typeof tokenSplit>
  fmt: (n: number) => string
  quiet?: boolean
}) {
  const t = useI18n().t
  const [open, setOpen] = createSignal(false)
  const total = () =>
    t("kernel.nodeSessions.header.tokensTotal", {
      count: props.fmt(props.split.kind === "total" ? props.split.total : 0),
    })
  return (
    <Show
      when={props.split.kind === "split" ? props.split : null}
      fallback={
        <Show
          when={props.quiet}
          fallback={
            <Chip icon={<Coins class={ICON} />} chip="tokens">
              <span class="tabular-nums">{total()}</span>
            </Chip>
          }
        >
          <span data-chip="tokens" class={STAT}>
            <Coins class={ICON} />
            <span class="min-w-0 truncate">{total()}</span>
          </span>
        </Show>
      }
    >
      {(s) => (
        <FloatingPanel open={open()} onOpenChange={setOpen}>
          <FloatingPanel.Trigger
            data-chip="tokens"
            class={
              props.quiet
                ? `${STAT} -mx-1 rounded-sm px-1 hover:bg-surface-hover hover:text-text`
                : "inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[12px] text-text-secondary hover:bg-surface-hover"
            }
          >
            <Coins class={ICON} />
            <span class="min-w-0 truncate tabular-nums">
              {t("kernel.nodeSessions.header.tokensInOut", {
                in: props.fmt(s().in),
                out: props.fmt(s().out),
              })}
            </span>
          </FloatingPanel.Trigger>
          <FloatingPanel.Content class="w-64 p-2">
            <dl
              data-testid="session-tokens-breakdown"
              class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[12px]"
            >
              {(
                [
                  ["uncached", s().uncached],
                  ["cacheWrite5m", s().cacheWrite5m],
                  ["cacheWrite1h", s().cacheWrite1h],
                  ["cacheRead", s().cacheRead],
                  ["output", s().out],
                ] as const
              ).map(([key, value]) => (
                <>
                  <dt class="text-text-secondary">
                    {t(`kernel.nodeSessions.header.tokensBreakdown.${key}`)}
                  </dt>
                  <dd class="text-right tabular-nums text-text">{props.fmt(value)}</dd>
                </>
              ))}
              <Show when={s().hitRate !== null}>
                <dt class="text-text-secondary">
                  {t("kernel.nodeSessions.header.tokensBreakdown.hitRate")}
                </dt>
                <dd class="text-right tabular-nums text-text">
                  {`${Math.round((s().hitRate ?? 0) * 100)}%`}
                </dd>
              </Show>
            </dl>
          </FloatingPanel.Content>
        </FloatingPanel>
      )}
    </Show>
  )
}
