// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The names behind a table's person cells. A person cell holds a user id; the grid reads its
// name from the org's member directory (`GET /mentions/members`), read once per session and
// topped up by every person picker search.
import { createSignal } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { type AssignableMember, fetchAssignableMembers } from "~/modules/members/assignable-members"

const [names, setNames] = createSignal<Record<string, string>>({})
let loading: Promise<void> | null = null

export function rememberPeople(people: AssignableMember[]): void {
  if (people.length === 0) return
  setNames((prev) => {
    const next = { ...prev }
    for (const p of people) next[p.id] = p.name || p.email
    return next
  })
}

export function personName(id: string): string | undefined {
  return names()[id]
}

/** Reads the directory once (a failure leaves ids unnamed; the next call tries again). */
export function loadPeople(api: Pick<ApiClient, "getEnvelope"> | undefined): Promise<void> {
  if (!api?.getEnvelope) return Promise.resolve()
  if (loading) return loading
  loading = fetchAssignableMembers(api, "", 200)
    .then((r) => rememberPeople(r.items))
    .catch(() => {
      loading = null
    })
  return loading
}

export function resetTablePeople(): void {
  setNames({})
  loading = null
}

onSessionTeardown(resetTablePeople)
