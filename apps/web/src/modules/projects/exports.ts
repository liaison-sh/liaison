// SPDX-License-Identifier: FSL-1.1-ALv2
import { lazy } from "solid-js"
import {
  registerBulkUiCustomForm,
  registerBulkUiSelection,
  registerSavedViewsHandler,
} from "~/framework/app-registry"
import { crossProjectTasksStore } from "~/modules/projects/cross-project-tasks-store"
import { ProjectsIcon } from "~/modules/projects/ProjectsIcon"
import { projectStore } from "~/modules/projects/project-store"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import {
  clearSelection as clearProjectsSelection,
  selectedIds as projectsSelectedIds,
  replaceSelection as replaceProjectsSelection,
} from "~/modules/projects/projects-selection-store"
import { SetTaskLabelsForm } from "~/modules/projects/SetTaskLabelsForm"

export const ProjectsHome = lazy(() =>
  import("~/modules/projects/ProjectsHome").then((m) => ({ default: m.ProjectsHome })),
)
export const ProjectWorkspace = lazy(() =>
  import("~/modules/projects/ProjectWorkspace").then((m) => ({ default: m.ProjectWorkspace })),
)
export const TaskDetail = lazy(() =>
  import("~/modules/projects/TaskDetail").then((m) => ({ default: m.TaskDetail })),
)
export const ProjectAutomations = lazy(() =>
  import("~/modules/projects/ProjectAutomations").then((m) => ({
    default: m.ProjectAutomations,
  })),
)
export const ProjectsSidebar = lazy(() =>
  import("~/modules/projects/ProjectsSidebar").then((m) => ({ default: m.ProjectsSidebar })),
)

export { registerEntityPreviews } from "~/modules/projects/entity-preview-renderers"

/**
 * A task tab's name: the task's title, once a store holds the task (its project's list, the
 * cross-project list), however the tab was opened (a link, a dashboard drill, its address).
 */
export function resolveTaskTabLabel(entityId: string): string | undefined {
  if (!entityId) return undefined
  const title =
    projectStore.task(entityId)?.title ??
    crossProjectTasksStore.items().find((t) => t.id === entityId)?.title
  return title?.trim() ? title : undefined
}

export function registerAppHooks(): void {
  const handler = {
    capture: () => projectsFilterStore.currentParams(),
    apply: (payload: unknown) =>
      projectsFilterStore.applyParams((payload ?? {}) as Record<string, unknown>),
  }
  registerSavedViewsHandler("projects", "home", handler)
  registerSavedViewsHandler("projects", "project", handler)

  const selection = {
    accessor: () => projectsSelectedIds(),
    clear: () => clearProjectsSelection(),
    replace: (ids: string[]) => replaceProjectsSelection(ids),
  }
  registerBulkUiSelection("projects", "home", selection)
  registerBulkUiSelection("projects", "project", selection)
  // The bulk "Set labels…" action collects one value per label group.
  registerBulkUiCustomForm("projects", "setLabels", SetTaskLabelsForm)
}
export {
  handleChecklistItemEvent,
  handleLabelEvent,
  handleProjectEvent,
  handleProjectStatusEvent,
  handleTaskEvent,
} from "~/modules/projects/projects-ws-handlers"
export { ProjectsIcon }
