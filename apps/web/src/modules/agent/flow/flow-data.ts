// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the flow list reads to name things: the project a routine's filter
 * names (its statuses and task fields, from the projects REST API) and the
 * org's people (the member directory the assignee pickers use).
 */
import type { ApiClient } from "~/lib/api-client"
import { fetchAssignableMembers } from "~/modules/members/assignable-members"
import type { FlowPerson, FlowProject } from "./flow-model"

interface ProjectReply {
  id: string
  name: string
  statuses?: Array<{ id: string; label: string; order?: number }>
  fields?: Array<{ key: string; label: string; type: string; choices?: string[] }>
}

export async function loadFlowProject(
  api: Pick<ApiClient, "get">,
  projectId: string,
): Promise<FlowProject | null> {
  try {
    const p = await api.get<ProjectReply>(`/projects/${projectId}`)
    if (!p?.id) return null
    const statuses = [...(p.statuses ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    return {
      id: p.id,
      name: p.name,
      statuses: statuses.map((s) => ({ id: s.id, label: s.label })),
      fields: (p.fields ?? []).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        ...(f.choices ? { choices: f.choices } : {}),
      })),
    }
  } catch {
    return null
  }
}

export async function loadFlowPeople(api: Pick<ApiClient, "getEnvelope">): Promise<FlowPerson[]> {
  try {
    const res = await fetchAssignableMembers(api, "")
    return res.items.map((m) => ({ id: m.id, name: m.name || m.email }))
  } catch {
    return []
  }
}
