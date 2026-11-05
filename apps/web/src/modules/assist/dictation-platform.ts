// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where a refused microphone is switched back on depends on what the app runs
// in: the browser's site settings, the OS privacy panel for the desktop app,
// or the phone's app settings for the mobile shell.
import { isNativeShell } from "~/lib/native-bridge"

export type MicPlatform = "browser" | "macos" | "windows" | "ios" | "android"

export function micPlatform(): MicPlatform {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
  if (isNativeShell()) return /android/i.test(ua) ? "android" : "ios"
  const g = globalThis as Record<string, unknown>
  if (g.__TAURI_INTERNALS__ !== undefined || g.__TAURI__ !== undefined) {
    return /windows/i.test(ua) ? "windows" : "macos"
  }
  return "browser"
}
