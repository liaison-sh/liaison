// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE MODE A (AGENT, FOLDER) PAIR RAN IN LAST (spec-runtime.md, "Local session
// model").
//
// It used to live inside `OpenFolderWithAgent.tsx`, the entry point A33 moved
// into apps/web. Three of that component's exports were never pixels: this
// memory is behaviour, it belongs beside `RecentFolders.ts` and
// `SessionResumeStore.ts`, and the bridge exposes it to whoever renders the
// control now.
//
// Auto is the first-use answer for every new pair: Liaison tools and ordinary
// commands run without a question, destructive ones and anything outside the
// folder still ask (sidecar/auto-policy.ts). Every failure here falls back to
// it, never to Bypass.
//
// NO MIGRATION of a stored "manual". This memory is only ever written by an
// explicit choice in the mode menu (bridge.ts `setPermissionMode`), never by a
// session start, so a stored Manual is a person's own choice and is kept.
//
// Keyed by the folder's DIGEST, exactly as the resume store is
// (`folder-hash.ts`): the path never leaves this machine and the two per-pair
// memories cannot disagree about which folder they mean.

import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "./sidecar-client"

/** Where one pair's mode is remembered. */
export function permissionModeKey(agentId: string, folderHash: string): string {
  return `liaison-desktop:permission-mode:${agentId}:${folderHash}`
}

const MODES: PermissionMode[] = ["auto", "manual", "edit", "plan", "bypass"]

/**
 * THE STORAGE THIS MEMORY READS, NAMED RATHER THAN INHERITED (P6d-FX7, SK-1).
 *
 * A bare `localStorage` is resolved off whatever the scope chain hands the
 * module, and under a multi file runner that is not always the object a caller
 * (or a test) is holding: the runner leaves one file's Storage on the global
 * while the module resolves the next file's window. A guard that reads a
 * different object from the one a test arranges is a guard that pins nothing,
 * which is exactly how "Manual, never Bypass" came to assert a lie.
 *
 * So the object is named here, once, resolved on every call: `globalThis` is
 * the one the browser, the shell and the runner all agree on.
 */
function storage(): Storage | null {
  return (globalThis as { localStorage?: Storage | null }).localStorage ?? null
}

/** The mode that pair was last explicitly set to. Auto when nobody chose one,
 * or when this window refuses storage. */
export function recallPermissionMode(agentId: string, folderHash: string): PermissionMode {
  try {
    const stored = storage()?.getItem(permissionModeKey(agentId, folderHash)) ?? null
    return MODES.includes(stored as PermissionMode)
      ? (stored as PermissionMode)
      : DEFAULT_PERMISSION_MODE
  } catch {
    return DEFAULT_PERMISSION_MODE
  }
}

/** Remembers the mode a session just ran in, for the next one on that pair. */
export function rememberPermissionMode(
  agentId: string,
  folderHash: string,
  mode: PermissionMode,
): void {
  try {
    storage()?.setItem(permissionModeKey(agentId, folderHash), mode)
  } catch {
    // A window that refuses storage falls back to the default next time,
    // never to Bypass.
  }
}
