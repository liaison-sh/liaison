// SPDX-License-Identifier: FSL-1.1-ALv2
import { Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface ProjectPreviewData {
  id?: string
  name?: string
  description?: string | null
}

interface TaskPreviewData {
  id?: string
  title?: string
  statusId?: string
}

export function registerEntityPreviews(): void {
  registerEntityPreview<ProjectPreviewData>({
    app: "projects",
    entityType: "project",
    fetch: async (id, api) => {
      const out = await runTool<ProjectPreviewData>(api as ApiClient, "projects:get", {
        projectId: id,
      })
      return out ?? { id }
    },
    render: (p) => (
      <div data-testid={`projects-project-preview-${p.id ?? ""}`}>
        <div class="font-medium text-text">{p.name ?? "(unnamed)"}</div>
        <Show when={p.description}>
          <div class="text-text-secondary text-[12px]">{p.description}</div>
        </Show>
      </div>
    ),
  })

  registerEntityPreview<TaskPreviewData>({
    app: "projects",
    entityType: "task",
    fetch: async (id, api) => {
      const out = await runTool<TaskPreviewData>(api as ApiClient, "projects:get", { taskId: id })
      return out ?? { id }
    },
    render: (t) => (
      <div data-testid={`projects-task-preview-${t.id ?? ""}`}>
        <div class="font-medium text-text">{t.title ?? "(untitled)"}</div>
      </div>
    ),
  })
}
