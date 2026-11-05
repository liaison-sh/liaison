// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's update check, asked for by the page (src-tauri/src/updater.rs,
// `check_for_updates`). The page asks when an app runs in compatibility mode
// because the server moved past the web build this app carries (apps/web
// framework/compat-mode.ts):
// quietly at once, or as the menu's "Check for Updates" on a click. Nothing
// installs without the user's yes either way; that stays the shell's rule.

import { invoke } from "./tauri"

export const CHECK_FOR_UPDATES_COMMAND = "check_for_updates"

/** Runs the shell's update check now. Never throws: a failed ask leaves the schedule. */
export async function checkForUpdates(options: { manual: boolean }): Promise<void> {
  try {
    await invoke(CHECK_FOR_UPDATES_COMMAND, { manual: options.manual === true })
  } catch {
    // The six hourly check and the menu item are still there.
  }
}

/**
 * Tauri's own app version (tauri.conf.json's `version`, or the version a test
 * build was given), the call `getVersion()` of `@tauri-apps/api/app` makes.
 * The page compares it with the oldest version the server supports (apps/web
 * lib/client-version.ts). Granted by `core:app:allow-version` alone.
 */
export const APP_VERSION_COMMAND = "plugin:app|version"

export async function appVersion(): Promise<string> {
  const version = await invoke(APP_VERSION_COMMAND)
  if (typeof version !== "string") throw new Error("The shell answered no version")
  return version
}
