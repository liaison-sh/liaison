// SPDX-License-Identifier: FSL-1.1-ALv2
// Archive / restore a project through the existing HTTP routes
// (POST /projects/:id/archive and /restore), then reflect the confirmed state
// in both stores: the open workspace (project-store) and the project list
// (projects-store), so the project leaves or rejoins the sidebar and home
// without waiting for the WebSocket echo.

import type { ApiClient } from "~/lib/api-client"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"
import { type Project, projectsStore } from "~/modules/projects/projects-store"

export function summaryFrom(
  detail: ProjectDetail | null | undefined,
  id: string,
): Project | undefined {
  if (!detail?.id) return undefined
  const known = projectsStore.byId(id) ?? projectsStore.archivedItems.find((p) => p.id === id)
  return {
    id: detail.id,
    key: detail.key ?? known?.key ?? null,
    name: detail.name,
    description: detail.description ?? null,
    icon: detail.icon ?? null,
    color: detail.color ?? null,
    group: detail.group ?? null,
    ownerId: detail.ownerId,
    taskCount: known?.taskCount ?? 0,
    archivedAt: detail.archivedAt ?? null,
    updatedAt: detail.updatedAt ?? new Date().toISOString(),
  }
}

export async function archiveProject(api: ApiClient, projectId: string): Promise<void> {
  const detail = await api.post<ProjectDetail>(`/projects/${projectId}/archive`)
  const archivedAt = detail?.archivedAt ?? new Date().toISOString()
  projectStore.setArchivedAt(projectId, archivedAt)
  projectsStore.markArchived(projectId, archivedAt, summaryFrom(detail, projectId))
}

export async function restoreProject(api: ApiClient, projectId: string): Promise<void> {
  const detail = await api.post<ProjectDetail>(`/projects/${projectId}/restore`)
  projectStore.setArchivedAt(projectId, null)
  projectsStore.markRestored(projectId, summaryFrom(detail, projectId))
}
