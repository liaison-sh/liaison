// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Display names for the people behind user ids: who resolved an incident
// (`resolvedBy`) and who wrote a comment (`authorId`). Read from the kernel's
// member directory; best effort: a reader without access, or a failure, leaves
// the names unknown and the UI says "a teammate".
import { fetch as hostFetch } from "@liaison/host"

interface Member {
  id: string
  name: string
}

export async function loadMemberNames(): Promise<Map<string, string>> {
  try {
    const members = await hostFetch<Member[]>("/api/mentions/members?limit=200")
    return new Map((Array.isArray(members) ? members : []).map((m) => [m.id, m.name]))
  } catch {
    return new Map()
  }
}
