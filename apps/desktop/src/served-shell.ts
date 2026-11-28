// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page's asks of the shell about the SERVED shell (src-tauri/src/
// served_shell.rs): which build the window runs, that the page rendered, and a
// refresh when the page saw a newer server build. None of them throws: a
// failed ask leaves the window on what it runs.

import type { DesktopShellStatus } from "@liaison/web/lib/desktop-shell-contract"
import { invoke } from "./tauri"

export const SHELL_READY_COMMAND = "shell_ready"
export const SHELL_STATUS_COMMAND = "shell_status"
export const REFRESH_SHELL_COMMAND = "refresh_shell"

/** The page rendered: the shell marks a served build good (D9). */
export async function shellReady(buildId: string): Promise<void> {
  try {
    await invoke(SHELL_READY_COMMAND, { buildId })
  } catch {
    // An older shell, or none to mark.
  }
}

function isStatus(value: unknown): value is DesktopShellStatus {
  if (value === null || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  const optional = (x: unknown) => x === null || typeof x === "string"
  return (
    typeof v.served === "boolean" &&
    typeof v.pending === "boolean" &&
    optional(v.buildId) &&
    optional(v.reason)
  )
}

/** Served (and which build) or bundled (and why); null when the shell cannot say. */
export async function shellStatus(): Promise<DesktopShellStatus | null> {
  try {
    const status = await invoke(SHELL_STATUS_COMMAND)
    return isStatus(status) ? status : null
  } catch {
    return null
  }
}

/** Asks the shell to fetch the server's newer build; the build pending for the next load, or null. */
export async function refreshShell(): Promise<string | null> {
  try {
    const pending = await invoke(REFRESH_SHELL_COMMAND)
    return typeof pending === "string" ? pending : null
  } catch {
    return null
  }
}
