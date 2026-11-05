// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHETHER THE MIC SHOWS AT ALL. Two halves, both must hold: the org can
// transcribe (`GET /assist/capabilities`, asked once per session and shared by
// every composer on screen) and this browser or webview can record. When
// either fails the control is absent, never a disabled button.

import type { AssistCapabilities } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"

const UNAVAILABLE: AssistCapabilities = { dictation: false, autoClean: true }

// Keyed by the client: one answer per signed-in session.
const asked = new WeakMap<ApiClient, Promise<AssistCapabilities>>()

/** This runtime can capture audio (a webview without media capture cannot). */
export function canRecordAudio(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof globalThis.MediaRecorder === "function"
  )
}

/** The org's dictation capability and the user's auto clean-up setting. */
export function assistCapabilities(api: ApiClient): Promise<AssistCapabilities> {
  const known = asked.get(api)
  if (known) return known
  const pending = api
    .get<AssistCapabilities>("/assist/capabilities", { suppressGlobalError: true })
    .then((caps) => ({ dictation: caps.dictation === true, autoClean: caps.autoClean !== false }))
    .catch(() => {
      // Not remembered: the next composer to mount asks again.
      asked.delete(api)
      return UNAVAILABLE
    })
  asked.set(api, pending)
  return pending
}

/** The user changed "Clean up dictation automatically": later takes follow it. */
export function noteDictationAutoClean(api: ApiClient, autoClean: boolean): void {
  const known = asked.get(api)
  if (!known) return
  asked.set(
    api,
    known.then((caps) => ({ ...caps, autoClean })),
  )
}
