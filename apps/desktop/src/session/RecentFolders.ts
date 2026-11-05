// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The folders this agent has worked in, newest first, AS THE SHELL REMEMBERS
// THEM (P6d-FX2, SK-1).
//
// It used to be `localStorage`, described here as "a per machine convenience
// and nothing else". It stopped being that the moment the shell began refusing
// to start a session in a folder it had not chosen: the recent list is half of
// that set, and `localStorage` is written by every script in apps/web, so a
// list the page could edit would have been no check at all. The list lives in
// the shell's own config directory now, owner-only beside the token and the
// server address, written by the native picker and by nothing else.
//
// Scoped by agent id the way it always was: two agents on one machine are two
// working lives, and a shared list would offer one agent the other's folders.
// The SHELL still checks a start against every agent's folders, because the
// window names the agent too.

import { recentFolders } from "./sidecar-client"

/** How many folders one agent is remembered in (`sidecar.rs` owns the cap). */
export const RECENT_FOLDERS_LIMIT = 5

/** The folders this agent has run in, newest first. Empty with no shell. */
export function getRecentFolders(agentId: string): Promise<string[]> {
  if (!agentId) return Promise.resolve([])
  return recentFolders(agentId)
}
