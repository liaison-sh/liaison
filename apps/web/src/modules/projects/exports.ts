// SPDX-License-Identifier: FSL-1.1-ALv2
import { lazy } from "solid-js"
import {
  registerBulkUiCustomForm,
  registerBulkUiSelection,
  registerSavedViewsHandler,
} from "~/framework/app-registry"
import { ProjectsIcon } from "~/modules/projects/ProjectsIcon"
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
export const CapacityView = lazy(() =>
  import("~/modules/projects/CapacityView").then((m) => ({ default: m.CapacityView })),
)
export const TimesheetView = lazy(() =>
  import("~/modules/projects/TimesheetView").then((m) => ({ default: m.TimesheetView })),
)
// The note under the "Time and budgets" settings section (the section's id, then "SettingsNote").
export const TimeSettingsNote = lazy(() =>
  import("~/modules/projects/TimeSettingsNote").then((m) => ({ default: m.TimeSettingsNote })),
)
export const TaskDetail = lazy(() =>
  import("~/modules/projects/TaskDetail").then((m) => ({ default: m.TaskDetail })),
)
// The Work section of a company's page — registered via manifest `slots.company_detail`.
export const CompanyWorkPanel = lazy(() =>
  import("~/modules/projects/CompanyWorkPanel").then((m) => ({ default: m.CompanyWorkPanel })),
)
export const ProjectsSidebar = lazy(() =>
  import("~/modules/projects/ProjectsSidebar").then((m) => ({ default: m.ProjectsSidebar })),
)

export { registerEntityPreviews } from "~/modules/projects/entity-preview-renderers"

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
