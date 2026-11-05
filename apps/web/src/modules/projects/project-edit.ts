// SPDX-License-Identifier: FSL-1.1-ALv2
// Edit a project's own fields through PATCH /projects/:id, then reflect the
// saved project in both stores (the open workspace and the project list), as
// archive and restore do (project-archive.ts).

import type { ApiClient } from "~/lib/api-client"
import { summaryFrom } from "~/modules/projects/project-archive"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"
import { projectsStore } from "~/modules/projects/projects-store"

export interface ProjectEditPatch {
  name?: string
  key?: string
  description?: string | null
  icon?: string | null
  color?: string | null
  group?: string | null
}

export async function updateProjectFields(
  api: ApiClient,
  projectId: string,
  patch: ProjectEditPatch,
): Promise<ProjectDetail> {
  const detail = await api.patch<ProjectDetail>(`/projects/${projectId}`, patch)
  projectStore.handleProjectEvent("updated", detail)
  const summary = summaryFrom(detail, projectId)
  if (summary) projectsStore.upsert(summary)
  return detail
}
