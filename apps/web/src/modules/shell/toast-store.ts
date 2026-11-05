// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

const MAX_VISIBLE = 3
const AUTO_DISMISS_MS = 5000

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: "success" | "error" | "warning" | "info"
  action?: ToastAction
  /**
   * The Undo window's length, when the toast carries an action that expires:
   * the toast draws a bar that empties over it, so the person sees how long
   * they have left (the decision commits when it reaches zero).
   */
  countdownMs?: number
}

interface ToastInput {
  message: string
  type: Toast["type"]
  action?: ToastAction
  /** Auto-dismiss after this many ms, even with an action (an Undo window). */
  durationMs?: number
}

let nextId = 0
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const [store, setStore] = createSignal<Toast[]>([])

export const toasts = store

export function addToast(input: ToastInput): string {
  const id = String(++nextId)
  const { durationMs, ...rest } = input
  const toast: Toast = {
    id,
    ...rest,
    ...(rest.action && durationMs !== undefined && durationMs > 0
      ? { countdownMs: durationMs }
      : {}),
  }

  setStore((prev) => {
    const next = [...prev, toast]
    return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
  })

  // Actioned toasts must NOT auto-dismiss — the user needs time to click the
  // action (e.g. "Request access"). They stay until explicitly dismissed,
  // unless the caller bounds the action's window (an Undo).
  if (!toast.action || durationMs !== undefined) {
    const timer = setTimeout(() => dismissToast(id), durationMs ?? AUTO_DISMISS_MS)
    timers.set(id, timer)
  }

  return id
}

export function dismissToast(id: string): void {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  setStore((prev) => prev.filter((t) => t.id !== id))
}

export function resetToastStore(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  setStore([])
}
onSessionTeardown(resetToastStore)
