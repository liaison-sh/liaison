// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSIONS LIST (P2-T10; S8 list, S10, charter). The Sessions app's left
// list, also a full-width screen (no fixed width: P4 seats it as the phone
// list):
//
// - "Sessions" with New (the caller opens the dialog) and Import from a
//   computer (S8: opens the Import sessions tab, ImportSessionsView.tsx),
//   and the node line: each
//   enabled node, online or offline, live from the nodes store;
// - Needs you / Running (titled Paused when every row's node is offline,
//   P2-D3) / Done / Failed or stopped (S9), each with a tabular count, its own
//   loading, error with Retry, and Load more; Needs you and Failed only when
//   they hold a row (or failed to load); Older collapsed below, loaded on
//   first open;
// - a row: status dot, title, folder · model · elapsed (the end time once it
//   ended); a row in Needs you is highlighted and says why in one line: what
//   a waiting session waits for, a needs_you session's reason code in the
//   reader's language (another driver, its token limit: S51; stuck or
//   capped on its own, Atelier waiting, no pull request, push failed: S32,
//   S36, S57), or else (no code, or a code this client does not know) its
//   own words, plain text, labelled as such (A11);
// - empty states: no node (how to set one up), else nothing running (with an
//   example and New session). A failed load is never shown as empty;
// - a demo's recorded computer (a simulated node) and its sessions carry a
//   "Recorded session" badge, and once its replay ended the end card offers
//   the desktop app (nodes/RecordedNode.tsx).

import { ChevronRight, Plus } from "lucide-solid"
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { hasEnabledNode, nodes, nodesStatus } from "~/modules/nodes/nodes-store"
import {
  DemoPairComputerCard,
  isRecordedNode,
  RecordedSessionBadge,
} from "~/modules/nodes/RecordedNode"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { Skeleton } from "~/ui/Skeleton"
import {
  displayStatus,
  elapsedMs,
  formatDuration,
  formatTimeWithZone,
  isEnded,
  needsYouReason,
  reasonLineText,
  sessionState,
  sessionTitle,
  toneOf,
} from "./display"
import { importSupported } from "./import-support"
import { NewSessionDialog } from "./NewSessionDialog"
import { phoneTap } from "./phone"
import { sessionNodeOnline } from "./SessionHeader"
import type { NodeSessionGroup, NodeSessionRow } from "./session-api"
import {
  ensureListLoaded,
  groupRows,
  groupState,
  LIVE_GROUPS,
  loadGroup,
  loadMore,
} from "./session-list"

/**
 * The Import button beside New session: opens the Import
 * sessions tab (S8). Hidden without an enabled computer, and once the API
 * answered that it has no import route (D42 pattern).
 */
export function ImportEntry(props: { class?: string }) {
  const t = useI18n().t
  return (
    <Show when={importSupported() && hasEnabledNode()}>
      <button
        type="button"
        data-testid="import-entry"
        class={cn(
          "inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-0.5 text-[12.5px] text-text-secondary hover:bg-surface-hover",
          phoneTap(),
          props.class,
        )}
        onClick={() =>
          openTab({
            type: "kernel:session-import",
            entityId: "session-import",
            label: t("kernel.nodeSessions.import.tabTitle"),
            routePath: "/import-sessions",
          })
        }
      >
        {t("kernel.nodeSessions.import.entry")}
      </button>
    </Show>
  )
}

/** The model's own words on a needs_you row: one line, at most 300 characters (A11). */
const SAYS_MAX = 300

export function openSession(
  row: Pick<NodeSessionRow, "id" | "title"> & Partial<Pick<NodeSessionRow, "folderName" | "repo">>,
): void {
  openTab({
    type: "kernel:session",
    entityId: row.id,
    label: sessionTitle({ folderName: null, repo: null, ...row }),
    routePath: `/sessions/${encodeURIComponent(row.id)}`,
  })
}

/** "Waiting on you: permission for Bash", from the row's waiting reason. */
export function waitingLine(
  reason: string | null,
  t: (k: string, p?: Record<string, string>) => string,
) {
  if (!reason) return t("kernel.nodeSessions.card.waitingQuestion")
  const sep = reason.indexOf(":")
  const kind = sep > 0 ? reason.slice(0, sep) : reason
  const rest = sep > 0 ? reason.slice(sep + 1).trim() : ""
  if (kind === "permission") return t("kernel.nodeSessions.card.waitingPermission", { tool: rest })
  if (kind === "plan") return t("kernel.nodeSessions.card.waitingPlan")
  return t("kernel.nodeSessions.card.waitingQuestion")
}

function SessionRowButton(props: { row: NodeSessionRow; now: number; selected: boolean }) {
  const i18n = useI18n()
  const t = i18n.t
  const status = () => displayStatus(props.row, sessionNodeOnline(props.row))
  const state = () => sessionState(props.row)
  const ended = () => isEnded(state())
  const needsYou = () => state() === "waiting" || state() === "needs_you"
  // S32, S57: a known reason code in words; an unknown one, the session's own words (D14).
  const reason = () => needsYouReason(props.row, t, SAYS_MAX)
  const coded = () => {
    const r = reason()
    return r && r.kind !== "says" ? reasonLineText(r, t) : null
  }
  const says = () => (reason()?.kind === "says" ? reason()?.text : null)
  const endAt = () => props.row.endedAt ?? props.row.updatedAt
  return (
    <button
      type="button"
      data-testid="session-row"
      data-id={props.row.id}
      data-waiting={String(needsYou())}
      aria-current={props.selected ? "true" : undefined}
      class={cn(
        "flex w-full min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-hover",
        phoneTap(),
      )}
      classList={{
        "bg-surface-active": props.selected,
        "bg-warning-glow": needsYou() && !props.selected,
      }}
      onClick={() => openSession(props.row)}
    >
      <span class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneOf(status()).dot}`} />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="truncate text-[13px] font-medium text-text">{sessionTitle(props.row)}</span>
          <Show when={isRecordedNode(props.row.nodeId)}>
            <RecordedSessionBadge testId="session-recorded-badge" />
          </Show>
        </span>
        <span class="truncate text-[12px] text-text-tertiary">
          {[props.row.folderName ?? props.row.repo, props.row.model].filter(Boolean).join(" · ")}
          {" · "}
          <Show
            when={ended()}
            fallback={
              <span class="tabular-nums">{formatDuration(elapsedMs(props.row, props.now))}</span>
            }
          >
            <time
              class="tabular-nums"
              datetime={endAt()}
              title={formatTimeWithZone(endAt(), i18n.locale())}
            >
              {i18n.fmtDate(Date.parse(endAt()), {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </Show>
        </span>
        <Show when={state() === "waiting"}>
          <span class="truncate text-[12px] text-warning">
            {waitingLine(props.row.waitingReason, t)}
          </span>
        </Show>
        <Show when={coded()}>
          {(text) => (
            <span data-testid="session-reason" class="truncate text-[12px] text-warning">
              {text()}
            </span>
          )}
        </Show>
        <Show when={says()}>
          {(text) => (
            <span data-testid="session-says" class="truncate text-[12px] text-warning">
              {t("kernel.nodeSessions.notice.sessionSays", { text: text() })}
            </span>
          )}
        </Show>
      </span>
    </button>
  )
}

function GroupBody(props: {
  group: NodeSessionGroup
  rows: NodeSessionRow[]
  now: number
  selectedId?: string
  empty?: JSX.Element
}) {
  const t = useI18n().t
  const state = () => groupState(props.group)
  return (
    <>
      <For each={props.rows}>
        {(r) => <SessionRowButton row={r} now={props.now} selected={r.id === props.selectedId} />}
      </For>
      <Show when={state().status === "loading" && props.rows.length === 0}>
        <div
          role="status"
          class="flex flex-col gap-1.5 px-2.5 py-2"
          aria-label={t("kernel.nodeSessions.list.loading")}
        >
          <Skeleton class="h-4 w-3/4" />
          <Skeleton class="h-3 w-1/2" />
        </div>
      </Show>
      <Show when={state().status === "error"}>
        <div class="flex flex-col items-start gap-1.5 px-2.5 py-2">
          <p class="text-[12.5px] text-error">{t("kernel.nodeSessions.list.error")}</p>
          <button
            type="button"
            class={cn(
              "rounded-md border border-border px-2 py-0.5 text-[12px] text-text-secondary hover:bg-surface-hover",
              phoneTap(),
            )}
            onClick={() => void loadGroup(props.group, true)}
          >
            {t("kernel.nodeSessions.list.retry")}
          </button>
        </div>
      </Show>
      <Show when={state().status === "ready" && props.rows.length === 0 && props.empty}>
        {props.empty}
      </Show>
      <Show when={state().nextCursor && state().status !== "loading"}>
        <button
          type="button"
          class={cn("mx-2.5 my-1 self-start text-[12px] text-accent hover:underline", phoneTap())}
          onClick={() => void loadMore(props.group)}
        >
          {t("kernel.nodeSessions.list.loadMore")}
        </button>
      </Show>
    </>
  )
}

/** Nothing to show: how to set up a node, or what sessions are. */
export function SessionsEmpty(props: { onNew?: () => void }) {
  const t = useI18n().t
  return (
    <Show
      when={hasEnabledNode() || nodesStatus() !== "ready"}
      fallback={
        <div data-testid="sessions-empty" class="flex flex-col gap-2 px-4 py-6">
          <p class="text-[14px] font-semibold text-text">
            {t("kernel.nodeSessions.empty.noNodeTitle")}
          </p>
          <p class="text-[12.5px] text-text-secondary">
            {t("kernel.nodeSessions.empty.noNodeBody")}
          </p>
        </div>
      }
    >
      <div data-testid="sessions-empty" class="flex flex-col items-start gap-2 px-4 py-6">
        <p class="text-[14px] font-semibold text-text">{t("kernel.nodeSessions.empty.title")}</p>
        <p class="text-[12.5px] text-text-secondary">{t("kernel.nodeSessions.empty.body")}</p>
        <p class="text-[12.5px] italic text-text-tertiary">
          {t("kernel.nodeSessions.empty.example")}
        </p>
        <button
          type="button"
          class={cn(
            "mt-1 inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-foreground hover:bg-accent-hover",
            phoneTap(),
          )}
          onClick={() => props.onNew?.()}
        >
          <Plus class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.app.newSession")}
        </button>
      </div>
    </Show>
  )
}

/** True once the live groups loaded and none holds a row. */
export function noSessionsAtAll(): boolean {
  return LIVE_GROUPS.every((g) => groupState(g).status === "ready" && groupRows(g).length === 0)
}

export interface SessionListProps {
  onNew?: () => void
  selectedId?: string
}

/** The session open in the active tab: the shell renders this list as a sidebar with no props. */
function activeSessionId(): string | undefined {
  const active = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId)
  return active && /(^|:)session$/.test(active.type) ? active.entityId : undefined
}

export default function SessionList(props: SessionListProps) {
  const t = useI18n().t
  const selectedId = () => props.selectedId ?? activeSessionId()
  const [now, setNow] = createSignal(Date.now())
  const [olderOpen, setOlderOpen] = createSignal(false)
  // Without a caller-owned dialog, this list opens its own New session dialog.
  const [newOpen, setNewOpen] = createSignal(false)
  const onNew = () => (props.onNew ? props.onNew() : setNewOpen(true))
  const timer = setInterval(() => setNow(Date.now()), 15_000)
  onCleanup(() => clearInterval(timer))
  onMount(() => void ensureListLoaded())

  const enabled = () => nodes().filter((n) => n.enabled)
  const rows = (g: NodeSessionGroup) => groupRows(g, now())
  const runningPaused = () => {
    const r = rows("running").filter((x) => sessionState(x) !== "queued")
    return r.length > 0 && r.every((x) => !sessionNodeOnline(x))
  }
  // A demo's recorded session has ended: the end card offers a real computer.
  const recordedReplayEnded = () =>
    LIVE_GROUPS.some((g) =>
      rows(g).some((r) => isRecordedNode(r.nodeId) && isEnded(sessionState(r))),
    )
  const openOlder = () => {
    const next = !olderOpen()
    setOlderOpen(next)
    if (next && groupState("older").status === "idle") void loadGroup("older")
  }
  // An empty group is hidden, whatever its name (walk W1: Needs you hid while
  // Running 0 and Done 0 showed); the shown ones keep the S9 order. A failed
  // load shows its Retry, and the first load keeps Running and Done as
  // placeholders so the list never paints blank.
  const firstLoad = () => LIVE_GROUPS.every((x) => groupState(x).status !== "ready")
  const showGroup = (g: NodeSessionGroup) =>
    rows(g).length > 0 ||
    groupState(g).status === "error" ||
    (firstLoad() && (g === "running" || g === "done"))

  const titleOf = (g: NodeSessionGroup) => {
    switch (g) {
      case "needs_you":
        return t("kernel.nodeSessions.list.needsYou")
      case "running":
        return runningPaused()
          ? t("kernel.nodeSessions.list.paused")
          : t("kernel.nodeSessions.list.running")
      case "failed":
        return t("kernel.nodeSessions.list.failed")
      default:
        return t("kernel.nodeSessions.list.done")
    }
  }

  return (
    <nav data-testid="session-list" class="flex h-full min-w-0 flex-col overflow-y-auto">
      <div class="flex items-center gap-2 px-3 pb-1 pt-3">
        <h2 class="flex-1 text-[14px] font-semibold text-text">
          {t("kernel.nodeSessions.app.title")}
        </h2>
        <button
          type="button"
          data-testid="session-list-new"
          class={cn(
            "inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-0.5 text-[12.5px] text-text-secondary hover:bg-surface-hover",
            phoneTap(),
          )}
          onClick={onNew}
        >
          <Plus class="h-3.5 w-3.5" />
          {t("kernel.nodeSessions.app.new")}
        </button>
        <ImportEntry />
      </div>
      <div
        data-testid="node-line"
        class="flex flex-wrap gap-x-3 gap-y-0.5 px-3 pb-2 text-[12px] text-text-tertiary"
      >
        <Show
          when={enabled().length > 0}
          fallback={<span>{t("kernel.nodeSessions.app.noNode")}</span>}
        >
          <For each={enabled()}>
            {(n) => (
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  classList={{ "bg-success": n.online, "bg-text-tertiary": !n.online }}
                />
                {n.online
                  ? t("kernel.nodeSessions.app.nodeOnline", { node: n.name })
                  : t("kernel.nodeSessions.app.nodeOffline", { node: n.name })}
                <Show when={n.simulated}>
                  <RecordedSessionBadge testId="node-recorded-badge" />
                </Show>
              </span>
            )}
          </For>
        </Show>
      </div>
      <Show when={recordedReplayEnded()}>
        <DemoPairComputerCard />
      </Show>
      <Show when={!noSessionsAtAll()} fallback={<SessionsEmpty onNew={onNew} />}>
        <For each={LIVE_GROUPS}>
          {(g) => (
            <Show when={showGroup(g)}>
              <section
                data-testid="session-group"
                data-group={g}
                data-count={rows(g).length}
                class="flex flex-col px-1 pb-2"
              >
                <h3 class="flex items-center gap-2 px-2.5 py-1 text-[11.5px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {titleOf(g)}
                  <span class="tabular-nums">{rows(g).length}</span>
                </h3>
                <GroupBody group={g} rows={rows(g)} now={now()} selectedId={selectedId()} />
              </section>
            </Show>
          )}
        </For>
      </Show>
      <section class="mt-auto flex flex-col border-t border-border-subtle px-1 py-1">
        <button
          type="button"
          aria-expanded={olderOpen()}
          class={cn(
            "flex items-center gap-1.5 px-2.5 py-1 text-left text-[12px] text-text-tertiary hover:text-text-secondary",
            phoneTap(),
          )}
          onClick={openOlder}
        >
          <ChevronRight
            class="h-3.5 w-3.5 transition-transform"
            classList={{ "rotate-90": olderOpen() }}
          />
          {t("kernel.nodeSessions.list.older")}
        </button>
        <Show when={olderOpen()}>
          <GroupBody
            group="older"
            rows={rows("older")}
            now={now()}
            selectedId={selectedId()}
            empty={
              <p class="px-2.5 py-1 text-[12px] text-text-tertiary">
                {t("kernel.nodeSessions.list.olderEmpty")}
              </p>
            }
          />
        </Show>
      </section>
      <Show when={!props.onNew && newOpen()}>
        <NewSessionDialog open onOpenChange={setNewOpen} />
      </Show>
    </nav>
  )
}
