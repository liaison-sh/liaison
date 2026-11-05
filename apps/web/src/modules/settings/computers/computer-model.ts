// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What Settings > Computers derives from the node routes' answers, in one
// place so the list, the computer's page and their tests agree.

import type { NodeFolderList } from "@liaison/shared"
import type { NodeAttachmentSummary, NodeProfileSummary } from "~/modules/nodes/node-api"
import { localizeAgentName } from "~/modules/threads/agent-name"

export const COMPUTERS_ROUTE = "/settings/computers"

export type ComputerTab = "folders" | "agents" | "settings"
export const COMPUTER_TABS: readonly ComputerTab[] = ["folders", "agents", "settings"]

/** A computer's page, on one of its tabs (Folders by default). */
export function computerRoute(nodeId: string, tab: ComputerTab = "folders"): string {
  const base = `${COMPUTERS_ROUTE}/${encodeURIComponent(nodeId)}`
  return tab === "folders" ? base : `${base}/${tab}`
}

/** `/settings/computers/<id>[/<tab>]` read back; null for the list itself. */
export function parseComputerPath(pathname: string): { nodeId: string; tab: ComputerTab } | null {
  const m = pathname.match(/^\/settings\/computers\/([^/?#]+)(?:\/(agents|settings|folders))?\/?$/)
  if (!m) return null
  return { nodeId: decodeURIComponent(m[1]), tab: (m[2] as ComputerTab | undefined) ?? "folders" }
}

export type OsKey = "macos" | "windows" | "linux"
export function osKey(os: string | null | undefined): OsKey {
  return os === "windows" || os === "linux" ? os : "macos"
}

/** `~/Documents, ~/Desktop` as the reader knows them: `Documents, Desktop`. */
export function placesLabel(denied: readonly string[]): string {
  return denied.map((p) => p.replace(/^~\//, "")).join(", ")
}

/** The home folder's full path, when a search root shows as `~`. */
function homeOf(list: NodeFolderList | null): string | null {
  if (!list) return null
  const i = list.search.display.indexOf("~")
  return i >= 0 ? (list.search.roots[i] ?? null) : null
}

/** A shared root as `~/…` when the home folder is known; null otherwise (tooltip only). */
export function tildePath(path: string, list: NodeFolderList | null): string | null {
  const home = homeOf(list)
  if (!home) return null
  const h = home.replace(/[\\/]+$/, "")
  if (path === h) return "~"
  if (path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) return `~${path.slice(h.length)}`
  return null
}

/** What kind a shared root is, when the computer said: a repository (and its branch) or a folder. */
export function rootKind(
  path: string,
  list: NodeFolderList | null,
): { repo: true; branch: string | null } | { repo: false } | null {
  const repos = list?.shared.repos
  if (!repos) return null
  const hit = repos.find((r) => r.path === path)
  return hit ? { repo: true, branch: hit.defaultBranch } : { repo: false }
}

/** One agent that can run on a computer: an attachment, or a profile with none. */
export interface AgentRow {
  key: string
  agentId: string
  agentName: string
  agentModel: string | null
  attachment: NodeAttachmentSummary | null
  profile: NodeProfileSummary | null
}

/**
 * The agents that can run on `nodeId`, each once: those attached to it (or to
 * any of the owner's computers), then those with a profile and no attachment
 * (walk D14), which only the owner can ask.
 */
export function agentRowsFor(
  nodeId: string,
  attachments: readonly NodeAttachmentSummary[],
  profiles: readonly NodeProfileSummary[],
): AgentRow[] {
  const profileOf = (agentId: string) => profiles.find((p) => p.agentId === agentId) ?? null
  const rows: AgentRow[] = []
  const listed = new Set<string>()
  for (const a of attachments) {
    if (a.nodeId && a.nodeId !== nodeId) continue
    if (listed.has(a.agentId)) continue
    listed.add(a.agentId)
    rows.push({
      key: a.id,
      agentId: a.agentId,
      agentName: localizeAgentName(a.agentName ?? a.agentId),
      agentModel: a.agentModel ?? null,
      attachment: a,
      profile: profileOf(a.agentId),
    })
  }
  for (const p of profiles) {
    if (listed.has(p.agentId)) continue
    listed.add(p.agentId)
    rows.push({
      key: `profile-${p.agentId}`,
      agentId: p.agentId,
      agentName: localizeAgentName(p.agentName ?? p.agentId),
      agentModel: null,
      attachment: null,
      profile: p,
    })
  }
  return rows
}
