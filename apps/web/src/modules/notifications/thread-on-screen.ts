// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CONVERSATION ON SCREEN, the one question every "new message" notice has
// to ask before it interrupts: is the user already reading that conversation?
// It is the active tab (the phone tier renders the active tab full screen, the
// desktop tier in the main panel) of a page that is visible. Anything else,
// including a thread open in a background tab or a hidden page, is not on
// screen, and its notices still fire.
//
// Three readers: the `notify` frame handler here in the page (desktop.ts), the
// phone shell's push client, which lives outside the page's modules and is
// told through the native bridge on every change, and the SERVER, which holds
// a device push back while the user is reading the thread on any client: the
// viewing report (`viewingReport`) rides the realtime presence frame, sent on
// every change and with the heartbeat.

import { createEffect, createRoot, createSignal } from "solid-js"
import { nativeSetThreadOnScreen } from "~/lib/native-bridge"
import {
  activeThreadId as dockActiveThreadId,
  dockAvailable,
  visibleTabs as dockVisibleTabs,
} from "~/modules/shell/dock-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { makeTabId, tabStore } from "~/modules/shell/tab-store"
import { userIsLookingAtWindow } from "~/modules/threads/reading-focus"
import { getOpenReplyPanel } from "~/modules/threads/reply-panel-store"

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

/**
 * The node session tab type as the Sessions app opens it (SessionList,
 * NewSessionDialog, the `/sessions/:id` route): the qualified
 * `kernel:session`, so the id matches with or without the registry's alias.
 */
const SESSION_TAB_TYPE = "kernel:session"

/**
 * The id of the conversation or node session the active tab shows, visible
 * or not. Ids are UUIDs, so a thread id and a session id cannot collide in the
 * one on-screen slot the phone shell holds (P4, P-D3).
 */
function activeEntityOnScreen(): string | null {
  const active = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId)
  if (!active?.entityId) return null
  // The same id every other "is this conversation the active one" check
  // compares (bootstrap's surfacing and read marking), so the type aliases
  // resolve exactly as they do there.
  if (active.id === makeTabId("thread", active.entityId)) return active.entityId
  if (active.id === makeTabId(SESSION_TAB_TYPE, active.entityId)) return active.entityId
  return null
}

/**
 * The thread or node session the user is looking at right now, or null. The
 * desktop `notify` path compares it with thread routes only, so a session id
 * never matches there.
 */
export function threadOnScreen(): string | null {
  return documentVisible() ? activeEntityOnScreen() : null
}

/**
 * The thread a `notify` route names (`thread/<id>` or
 * `thread/<id>?replyRoot=<root>`), or null for any other route.
 */
export function threadOfRoute(route: unknown): string | null {
  if (typeof route !== "string") return null
  const match = /^\/?threads?\/([^/?#]+)/.exec(route)
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * The conversation the dock shows: its open floating window at desktop tier
 * (what is actually VISIBLE: the Chats roster covers the window), else the
 * conversation the tablet Chats sheet shows. Null at phone tier, where a
 * thread is the active tab itself.
 */
function dockConversationOnScreen(): string | null {
  if (dockAvailable()) return dockVisibleTabs().find((tab) => tab.expanded)?.threadId ?? null
  if (shellTier() === "phone") return null
  return dockActiveThreadId()
}

/**
 * Every conversation or session on screen right now: the active tab's, and
 * the conversation open in the dock's floating window (desktop tier), which is
 * where the personal agent chat lives, or in the tablet Chats sheet. An open
 * reply pane adds its ROOT message id (the key a reply that lives only in its
 * reply thread is checked on); where the pane covers the conversation (the
 * dock, the sheet, a phone) the conversation itself is not on screen. Empty
 * while the page is hidden.
 */
export function threadsOnScreen(): string[] {
  if (!documentVisible()) return []
  const ids: string[] = []
  const add = (threadId: string, paneBeside: boolean) => {
    const pane = getOpenReplyPanel(threadId)
    if (!pane || paneBeside) {
      if (!ids.includes(threadId)) ids.push(threadId)
    }
    if (pane && !ids.includes(pane.rootId)) ids.push(pane.rootId)
  }
  const main = activeEntityOnScreen()
  if (main) add(main, shellTier() !== "phone")
  const docked = dockConversationOnScreen()
  if (docked) add(docked, false)
  return ids
}

/**
 * The conversations the user is READING here: on screen AND in the focused
 * window. This is what a `notify` frame is held back on. On screen alone is
 * not enough: a desktop window left open on a conversation behind other apps
 * keeps its page `visible` (macOS reports an occluded window as visible), and
 * the notice for that conversation is exactly the one the user needs.
 */
export function threadsBeingRead(): string[] {
  return userIsLookingAtWindow() ? threadsOnScreen() : []
}

/** What this window tells the server it shows (the presence frame's `viewing`). */
export interface ViewingReport {
  threadIds: string[]
  focused: boolean
}

export function viewingReport(): ViewingReport {
  return { threadIds: threadsOnScreen(), focused: userIsLookingAtWindow() }
}

/**
 * Calls `onChange` whenever the viewing report changes (a tab switch, the dock
 * window opening or closing, the window gaining or losing focus, the page
 * hidden or shown), so the server knows within a frame rather than at the
 * next heartbeat. Returns the uninstaller.
 */
export function installViewingReport(onChange: () => void): () => void {
  return createRoot((dispose) => {
    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((n) => n + 1)
    if (typeof window !== "undefined") {
      window.addEventListener("focus", bump)
      window.addEventListener("blur", bump)
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", bump)
    let last: string | undefined
    createEffect(() => {
      tick()
      const next = JSON.stringify(viewingReport())
      if (next === last) return
      const first = last === undefined
      last = next
      // The hello carries the first report; only a change is sent from here.
      if (!first) onChange()
    })
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", bump)
        window.removeEventListener("blur", bump)
      }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", bump)
      dispose()
    }
  })
}

/** The reply thread root a `notify` route names (`?replyRoot=<root>`), or null. */
export function replyRootOfRoute(route: unknown): string | null {
  if (typeof route !== "string") return null
  const match = /[?&]replyRoot=([^&#]+)/.exec(route)
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * Keeps the native shell told which conversation or session is on screen. Visibility is
 * not reactive, so the page's visibility changes are fed in as a signal.
 * Returns the uninstaller. A no-op outside a native shell (the bridge call is).
 */
export function installThreadOnScreenReport(): () => void {
  return createRoot((dispose) => {
    const [visible, setVisible] = createSignal(documentVisible())
    const onVisibility = () => setVisible(documentVisible())
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility)
    }
    let last: string | null | undefined
    createEffect(() => {
      const next = visible() ? activeEntityOnScreen() : null
      if (next === last) return
      last = next
      nativeSetThreadOnScreen(next)
    })
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility)
      }
      dispose()
    }
  })
}
