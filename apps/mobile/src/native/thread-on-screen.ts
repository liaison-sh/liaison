// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The conversation the wrapped app has on screen, as it last said (apps/web
// modules/notifications/thread-on-screen.ts pushes it through the bridge on
// every change, and null when none is or the page is hidden).
//
// Two readers. On iOS the native presenter (ForegroundPushPresenter.swift)
// shows the system banner for a push that lands while the app is open, and
// nothing for the conversation the user is already reading, so every report
// is forwarded to it. Elsewhere the push client reads it for the same rule.
// It is one slot in memory: a relaunch starts at null, which is the safe
// answer (a banner too many, never one too few).

import { nativeThreadOnScreen } from "./liaison-native"

let current: string | null = null

/** Bridge member: the page's report. Anything but a non-empty string is null. */
export function setThreadOnScreen(threadId: unknown): void {
  current = typeof threadId === "string" && threadId.length > 0 ? threadId : null
  nativeThreadOnScreen(current)
}

/** The conversation on screen, or null. */
export function threadOnScreen(): string | null {
  return current
}
