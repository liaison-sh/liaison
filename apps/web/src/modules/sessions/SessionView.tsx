// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION VIEW (`/sessions/:id`; P2-T16, S8, charter). One session, live:
// header, pinned plan, transcript, the Files changed drawer, then the composer
// (P3's seam, SessionComposer.tsx). The list is the tab's sidebar.
//
// - `watchSession` on mount keeps the row and every event live (C4, D40);
//   `unwatchSession` on cleanup.
// - `?request=<id>` (the chat card's Review) is kept on the tab's route
//   (preserveSubRoutes) and highlights that request card. Without one, a
//   session that is waiting opens at its OLDEST pending request (P4-T12,
//   P-D4: a push's deep link carries no request id). The focus is taken again
//   on every activation of the session's tab (tabs stay mounted, so a second
//   push or deep link to an open tab must re-focus its NEW oldest request) and
//   whenever the tab's `?request=` changes. The card is scrolled into view and
//   ringed for FOCUS_RING_MS, then the ring fades. A request arriving while
//   the tab is already on screen does not steal the scroll.
// - States: loading; error (what failed, and Retry); "nothing yet" only when
//   the row says it has no events (lastSeq 0). A row with events none of which
//   could be pulled is the error state, never an empty one (charter).
// - Desktop: main column | Subagents rail | Files drawer. Below md the drawer
//   covers the column.
// - S53/S54 (D20, D21): the Subagents panel (rail, or a bottom sheet on the
//   phone) lists the subagents from the main thread's events; the header's
//   subagent chip shows it, and a row or an inline reference opens that
//   subagent's drawer, which alone fetches its events.
// - S58 (D34): the view tells the store whether it is on screen (its tab
//   active and the document visible; `showSession` / `hideSession`, with the
//   first row on screen when the owner scrolled up). Hidden 30 s, the store
//   lets the events go but for that screen and the open requests; shown
//   again they read back from the disk cache, then the server.
// - Phone (P4-T10): the shell's top bar is `SessionPhoneHeader` (back, title,
//   Stop), so the desktop header gives way to a chips row under it.

import type { NodeLevel } from "@liaison/shared"
import { ArrowDown } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { LevelConfirmDialog } from "~/modules/nodes/LevelConfirmDialog"
import { nodeById } from "~/modules/nodes/nodes-store"
import { tabStore } from "~/modules/shell/tab-store"
import { getAgentDisplay } from "~/modules/threads/agent-directory"
import { countText, sessionState } from "./display"
import FilesDrawer from "./FilesDrawer"
import { clientFilesChanged, type FileChange } from "./files-changed"
import { isPhone } from "./phone"
import SessionComposer from "./SessionComposer"
import SessionHeader, { sessionNodeOnline } from "./SessionHeader"
import { SessionPhoneChips } from "./SessionPhoneHeader"
import SessionPlan from "./SessionPlan"
import SessionTranscript from "./SessionTranscript"
import SubagentsPanel from "./SubagentsPanel"
import {
  fetchFilesChanged,
  hideSession,
  sessionStore,
  showSession,
  unwatchSession,
  watchSession,
} from "./session-store"
import { createStickToBottom } from "./stick-to-bottom"
import { pendingRequests, sessionPathContext } from "./transcript"

/** S53 (D29): the Files changed summary refreshes at most this often while the session moves. */
export const FILES_REFRESH_MS = 3000

/** How long a focused request card keeps its ring (then it fades). */
export const FOCUS_RING_MS = 2000

function sessionTab(entityId: string) {
  return tabStore.tabs.find((t) => t.entityId === entityId && /(^|:)session$/.test(t.type))
}

/** The `?request=` of this session's tab route, if any. */
function requestFromTab(entityId: string): string | undefined {
  const path = sessionTab(entityId)?.routePath ?? ""
  const q = path.indexOf("?")
  if (q < 0) return undefined
  return new URLSearchParams(path.slice(q + 1)).get("request") ?? undefined
}

interface PendingConfirm {
  level: NodeLevel
  resolve: (id: string | null) => void
}

export default function SessionView(props: { entityId: string; request?: string }) {
  const i18n = useI18n()
  const t = i18n.t
  const [phase, setPhase] = createSignal<"loading" | "ready" | "error">("loading")
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [confirm, setConfirm] = createSignal<PendingConfirm | null>(null)
  // S54: the subagent whose drawer is open, the phone's sheet, the rail's reveal.
  const [subagentOpen, setSubagentOpen] = createSignal<string | null>(null)
  const [sheetOpen, setSheetOpen] = createSignal(false)
  const [revealKey, setRevealKey] = createSignal(0)
  const showSubagents = () => {
    if (isPhone()) setSheetOpen(true)
    else setRevealKey((k) => k + 1)
  }
  const openSubagentDrawer = (toolUseId: string) => {
    setSheetOpen(false)
    setSubagentOpen(toolUseId)
  }

  const row = () => sessionStore.row(props.entityId)
  const events = () => sessionStore.events(props.entityId)
  // The transcript follows the session while the owner is at the bottom
  // (stick-to-bottom.ts); scrolled up, new events are counted instead.
  // S56: counted from what arrived, not the held window's length (bounded).
  const received = () => sessionStore.received(props.entityId)
  const stick = createStickToBottom(received)
  // The request card to scroll to and ring: `key` changes on every focus, so
  // the same card is scrolled again on a later activation.
  const [focus, setFocus] = createSignal<{ id: string; key: number } | undefined>()
  let focusKey = 0
  let fadeTimer: ReturnType<typeof setTimeout> | undefined
  const explicitRequest = () => props.request ?? requestFromTab(props.entityId)
  function takeFocus(): void {
    const id = explicitRequest() ?? pendingRequests(events())[0]?.requestId
    clearTimeout(fadeTimer)
    if (!id) {
      setFocus(undefined)
      // Shown again (tabs stay mounted; a hidden pane loses its offset).
      requestAnimationFrame(() => stick.pin())
      return
    }
    // The request card owns the view until it is in place (onFocusShown).
    stick.hold()
    setFocus({ id, key: ++focusKey })
    fadeTimer = setTimeout(() => setFocus(undefined), FOCUS_RING_MS)
  }
  /** Shown: its tab is the active one (or it is rendered outside a tab). */
  const active = () => {
    const tab = sessionTab(props.entityId)
    return !tab || tabStore.activeTabId === tab.id
  }
  // S58 (D34): the session is on screen while its tab is active and the
  // document visible. Hidden, the store lets its events go after a while
  // (keeping the screen the owner left); shown, it reads them back.
  const [documentVisible, setDocumentVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  )
  const onVisibility = () => setDocumentVisible(document.visibilityState !== "hidden")
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility))
  let scroller: HTMLElement | undefined
  /** The first row on screen when the owner scrolled up (undefined at the bottom). */
  function screenFirst(): number | undefined {
    if (!stick.away() || !scroller) return undefined
    const top = scroller.getBoundingClientRect().top
    const rows = scroller.querySelectorAll<HTMLElement>('[data-testid="session-event"]')
    // Rows go down the page: the first whose bottom is below the top, by halves.
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].getBoundingClientRect().bottom > top) hi = mid
      else lo = mid + 1
    }
    const seq = Number(rows[lo]?.dataset.seq)
    return Number.isFinite(seq) ? seq : undefined
  }
  let screenFrame = 0
  let lastScreen: number | undefined
  let onScreen = false
  createEffect(
    on(
      () => active() && documentVisible(),
      (shown) => {
        if (shown === onScreen) return
        onScreen = shown
        if (shown) showSession(props.entityId)
        else hideSession(props.entityId, lastScreen)
      },
    ),
  )
  onCleanup(() => {
    if (onScreen) hideSession(props.entityId)
    onScreen = false
  })
  createEffect(
    on([active, explicitRequest], ([isActive], prev) => {
      if (phase() !== "ready" || !isActive) return
      const [wasActive, prevRequest] = prev ?? [false, undefined]
      if (!wasActive || prevRequest !== explicitRequest()) takeFocus()
    }),
  )
  const online = () => {
    const r = row()
    return r ? sessionNodeOnline(r) : true
  }
  const pathContext = createMemo(() => {
    const r = row()
    return r ? sessionPathContext(r, events()) : null
  })
  // S53 (D29): Files changed comes from the server, which reads every event
  // (subagents' edits included; this client holds the main thread only). With
  // the drawer open it refreshes as the session moves on, at most every
  // FILES_REFRESH_MS, with the hunks. Closed, only the count shows: it is read
  // when the session's state changes (a turn settles), never on the timer
  // (D31d). An API without the route: the main thread's own edits, as before.
  const [serverFiles, setServerFiles] = createSignal<FileChange[] | null>(null)
  let filesTimer: ReturnType<typeof setTimeout> | undefined
  let filesAt = 0
  let filesBusy = false
  let filesAgain = false
  async function loadFiles(): Promise<void> {
    if (filesBusy) {
      filesAgain = true
      return
    }
    filesBusy = true
    filesAt = Date.now()
    try {
      const got = await fetchFilesChanged(props.entityId, drawerOpen())
      // batch-4 F7: a failed read keeps the server's last answer; the held
      // events' own figure only stands in while the server never answered.
      if (got) setServerFiles(got)
    } finally {
      filesBusy = false
      if (filesAgain) {
        filesAgain = false
        scheduleFiles()
      }
    }
  }
  function scheduleFiles(now = false): void {
    clearTimeout(filesTimer)
    const wait = now ? 0 : Math.max(0, filesAt + FILES_REFRESH_MS - Date.now())
    filesTimer = setTimeout(() => void loadFiles(), wait)
  }
  const filesTrigger = () => {
    const r = row()
    if (!r) return undefined
    return drawerOpen() ? `seq:${r.lastSeq}` : `state:${sessionState(r)}`
  }
  createEffect(
    on(filesTrigger, (key, prev) => {
      if (key === undefined) return
      const open = key.startsWith("seq:")
      const wasOpen = !!prev?.startsWith("seq:")
      // Opening reads the hunks at once; closing keeps what was read.
      if (prev !== undefined && !open && wasOpen) return
      scheduleFiles(prev !== undefined && open && !wasOpen)
    }),
  )
  onCleanup(() => clearTimeout(filesTimer))
  const files = createMemo(() => {
    const fromServer = serverFiles()
    if (fromServer) return fromServer
    const ctx = pathContext()
    return ctx ? clientFilesChanged(events(), ctx) : []
  })

  async function load(): Promise<void> {
    setPhase("loading")
    await watchSession(props.entityId)
    const r = sessionStore.row(props.entityId)
    const failed = !r || (r.lastSeq > 0 && sessionStore.received(props.entityId) === 0)
    setPhase(failed ? "error" : "ready")
    if (!failed) takeFocus()
  }

  // F5: a deep link to the session that is already on screen (the OS opens
  // the push's URL; the tab stays active, so the activation effect is silent)
  // re-focuses its pending request too.
  const onDeepLink = () => {
    if (phase() !== "ready" || !active()) return
    const path = window.location.pathname
    if (path === `/sessions/${props.entityId}`) takeFocus()
  }
  onMount(() => {
    window.addEventListener("popstate", onDeepLink)
    void load()
  })
  onCleanup(() => {
    window.removeEventListener("popstate", onDeepLink)
    clearTimeout(fadeTimer)
    unwatchSession(props.entityId)
    confirm()?.resolve(null)
  })

  const confirmLevel = (level: NodeLevel) =>
    new Promise<string | null>((resolve) => {
      confirm()?.resolve(null)
      setConfirm({ level, resolve })
    })
  const settle = (id: string | null) => {
    confirm()?.resolve(id)
    setConfirm(null)
  }

  return (
    <section data-testid="session-view" class="relative flex h-full min-w-0">
      <div class="flex min-w-0 flex-1 flex-col">
        <Switch>
          <Match when={phase() === "loading" && !row()}>
            <p class="px-4 py-6 text-[13px] text-text-tertiary">
              {t("kernel.nodeSessions.view.loading")}
            </p>
          </Match>
          <Match when={phase() === "error" && received() === 0}>
            <div data-testid="session-error" class="flex flex-col items-start gap-2 px-4 py-6">
              <p class="text-[13px] text-error">{t("kernel.nodeSessions.view.error")}</p>
              <button
                type="button"
                class="rounded-md border border-border px-2.5 py-1 text-[12.5px] text-text-secondary hover:bg-surface-hover"
                onClick={() => void load()}
              >
                {t("kernel.nodeSessions.view.retry")}
              </button>
            </div>
          </Match>
          <Match when={row()}>
            {(r) => (
              <>
                <Show
                  when={isPhone()}
                  fallback={
                    <SessionHeader
                      session={r()}
                      events={events()}
                      onOpenFiles={() => setDrawerOpen(true)}
                      onOpenSubagents={showSubagents}
                      filesCount={files().length}
                    />
                  }
                >
                  <SessionPhoneChips
                    session={r()}
                    events={events()}
                    onOpenFiles={() => setDrawerOpen(true)}
                    onOpenSubagents={showSubagents}
                    filesCount={files().length}
                  />
                </Show>
                <div class="relative flex min-h-0 flex-1 flex-col">
                  <div
                    ref={(el) => {
                      scroller = el
                      stick.container(el)
                    }}
                    onScroll={() => {
                      // S58: where the owner is, kept for a release while hidden.
                      if (screenFrame || !active()) return
                      screenFrame = requestAnimationFrame(() => {
                        screenFrame = 0
                        lastScreen = screenFirst()
                      })
                    }}
                    data-testid="session-scroller"
                    class="min-h-0 flex-1 overflow-y-auto px-4 py-3"
                  >
                    <div ref={stick.content} class="mx-auto flex max-w-3xl flex-col gap-3">
                      <SessionPlan
                        events={events()}
                        pathContext={pathContext() ?? sessionPathContext(r(), events())}
                      />
                      <Show
                        when={received() > 0}
                        fallback={
                          <Show
                            when={phase() === "ready" && r().lastSeq === 0}
                            fallback={
                              <p class="text-[13px] text-text-tertiary">
                                {t("kernel.nodeSessions.view.loading")}
                              </p>
                            }
                          >
                            <p data-testid="session-empty" class="text-[13px] text-text-tertiary">
                              {t("kernel.nodeSessions.view.empty")}
                            </p>
                          </Show>
                        }
                      >
                        <SessionTranscript
                          session={r()}
                          events={events()}
                          focusRequestId={focus()?.id}
                          focusKey={focus()?.key}
                          nodeOnline={online()}
                          agentName={getAgentDisplay(r().agentId)?.name}
                          onFocusShown={() => stick.settle()}
                          onAnswer={() => stick.jump()}
                          onOpenSubagent={openSubagentDrawer}
                        />
                      </Show>
                    </div>
                  </div>
                  <Show when={stick.away()}>
                    <button
                      type="button"
                      data-testid="jump-to-latest"
                      class="-translate-x-1/2 absolute bottom-3 left-1/2 z-10 inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-3 py-1 font-medium text-[12px] text-text shadow-popover hover:bg-surface-hover"
                      onClick={() => stick.jump()}
                    >
                      {stick.unseen() > 0
                        ? countText(
                            t,
                            "kernel.nodeSessions.transcript.jumpToLatestNew",
                            stick.unseen(),
                          )
                        : t("kernel.nodeSessions.transcript.jumpToLatest")}
                      <ArrowDown size={12} class="shrink-0" />
                    </button>
                  </Show>
                </div>
                <SessionComposer
                  session={r()}
                  pendingRequests={pendingRequests(events())}
                  nodeOnline={online()}
                  confirmLevel={confirmLevel}
                  hideStop={isPhone()}
                  compact={isPhone()}
                  onSend={() => stick.jump()}
                />
                <Show when={confirm()}>
                  {(c) => (
                    <LevelConfirmDialog
                      open
                      level={c().level}
                      purpose="session_raise"
                      sessionId={r().id}
                      nodes={
                        r().nodeId
                          ? [
                              {
                                nodeId: r().nodeId as string,
                                nodeName: nodeById(r().nodeId)?.name ?? "",
                              },
                            ]
                          : []
                      }
                      onConfirmed={(ids) => settle(ids[0] ?? null)}
                      onCancel={() => settle(null)}
                    />
                  )}
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </div>
      <Show when={row()}>
        {(r) => (
          <SubagentsPanel
            session={r()}
            events={events()}
            sheet={isPhone()}
            sheetOpen={sheetOpen()}
            onCloseSheet={() => setSheetOpen(false)}
            openToolUseId={subagentOpen()}
            onOpen={openSubagentDrawer}
            onCloseDrawer={() => setSubagentOpen(null)}
            revealKey={revealKey()}
          />
        )}
      </Show>
      <FilesDrawer open={drawerOpen()} files={files()} onClose={() => setDrawerOpen(false)} />
    </section>
  )
}
