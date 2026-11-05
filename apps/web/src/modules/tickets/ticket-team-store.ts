// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket team store — the live team set used by the inbox filter bar.
//
// Unlike categories and inboxes, teams have no table and no id: the label IS
// the key, and the set is derived from the tickets themselves (see the backend
// `teams.list` tool). Two consequences shape this store:
//
//  - Labels are passed through UNTOUCHED. A team really can be named " Acme"
//    with a leading space, and trimming it anywhere between here and the query
//    turns the filter into one that matches nothing.
//  - `loaded` with an empty list is meaningful — it means "this org files no
//    tickets by team", which is what tells the filter bar to hide the control
//    rather than offer a menu that will never fill in. A FAILED load must
//    therefore leave `loaded` false, so a transient error is never mistaken for
//    a desk that doesn't use teams.
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface TicketTeam {
  team: string
  /** Not closed, not merged away. What the menu badges. */
  openCount: number
  totalCount: number
}

interface TeamState {
  teams: TicketTeam[]
  loaded: boolean
  loading: boolean
}

const [ticketTeamStore, setTicketTeamStore] = createStore<TeamState>({
  teams: [],
  loaded: false,
  loading: false,
})

export { ticketTeamStore }

export async function loadTeams(api: ApiClient): Promise<void> {
  setTicketTeamStore("loading", true)
  try {
    const list = await runTool<TicketTeam[]>(api, "tickets:teams.list", {})
    setTicketTeamStore(
      produce((s) => {
        s.teams = Array.isArray(list) ? list : []
        s.loaded = true
      }),
    )
  } finally {
    setTicketTeamStore("loading", false)
  }
}

/**
 * Fold a team rename into the loaded set without a refetch. The backend emits
 * `team:rename` after an org-wide rename, which can arrive while someone has
 * the inbox open; without this their menu keeps offering a label that no longer
 * matches any ticket.
 */
export function handleTeamEvent(action: string, data: any): void {
  if (action !== "rename" || !data?.from || !data?.to) return
  setTicketTeamStore(
    produce((s) => {
      const fromIdx = s.teams.findIndex((t) => t.team === data.from)
      if (fromIdx < 0) return
      const moved = s.teams[fromIdx]!
      const toIdx = s.teams.findIndex((t) => t.team === data.to)
      if (toIdx >= 0) {
        // A merge: the two rows become one.
        s.teams[toIdx] = {
          team: data.to,
          openCount: s.teams[toIdx]!.openCount + moved.openCount,
          totalCount: s.teams[toIdx]!.totalCount + moved.totalCount,
        }
        s.teams.splice(fromIdx, 1)
      } else {
        s.teams[fromIdx] = { ...moved, team: data.to }
        s.teams.sort((a, b) => a.team.localeCompare(b.team))
      }
    }),
  )
}

export function resetTicketTeamStore(): void {
  setTicketTeamStore({ teams: [], loaded: false, loading: false })
}

onSessionTeardown(resetTicketTeamStore)
