// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  applyLevels as checklistApplyLevels,
  handleChecklistItemEvent as checklistStoreHandleItem,
} from "~/modules/projects/checklist-store"
import { handleLabelEvent as catalogHandleLabelEvent } from "~/modules/projects/label-catalog-store"
import {
  handleProjectEvent as projectStoreHandleProject,
  handleProjectStatusEvent as projectStoreHandleStatus,
  handleTaskEvent as projectStoreHandleTask,
} from "~/modules/projects/project-store"
import { type Project, projectsStore } from "~/modules/projects/projects-store"
import { attentionStore, getAttentionApi } from "~/modules/shell/attention-store"

function reloadAttention(): void {
  const api = getAttentionApi()
  if (api) attentionStore.markStaleAndReload(api)
}

export function handleProjectEvent(action: string, data: any): void {
  projectStoreHandleProject(action, data)
  // A level change arrives as project:updated carrying the saved list.
  if (data?.id && Array.isArray(data.validationLevels)) {
    checklistApplyLevels(data.id, data.validationLevels)
  }
  if (data && typeof data === "object" && "id" in data) {
    const isCreate = action === "create" || action === "created"
    const isUpdate = action === "update" || action === "updated"
    const isRestore = action === "restore" || action === "restored"
    const isArchive = action === "archive" || action === "archived"
    if (isRestore) {
      // The restore event carries only the id: keep what the client knows.
      projectsStore.markRestored(data.id)
    } else if (isArchive) {
      projectsStore.markArchived(data.id, data.archivedAt ?? new Date().toISOString())
    } else if (isCreate || isUpdate) {
      // An update event carries only the patched fields ({ id, ...patch }).
      // Overlay what is present; never blank a name or description the event
      // did not mention.
      const existing = projectsStore.byId(data.id)
      const patch: Partial<Project> = {}
      if (typeof data.name === "string") patch.name = data.name
      if (data.description !== undefined) patch.description = data.description
      if (data.icon !== undefined) patch.icon = data.icon
      if (data.color !== undefined) patch.color = data.color
      const ownerId = data.ownerId ?? data.owner_id
      if (typeof ownerId === "string") patch.ownerId = ownerId
      if (typeof data.taskCount === "number") patch.taskCount = data.taskCount
      if (data.archivedAt !== undefined) patch.archivedAt = data.archivedAt
      const updatedAt = new Date().toISOString()
      if (existing) {
        projectsStore.upsert({ ...existing, ...patch, updatedAt })
      } else if (isCreate) {
        projectsStore.upsert({
          id: data.id,
          name: "",
          description: null,
          icon: null,
          color: null,
          ownerId: "",
          taskCount: 0,
          archivedAt: null,
          ...patch,
          updatedAt,
        })
      }
    }
  }
  reloadAttention()
}

export function handleTaskEvent(action: string, data: any): void {
  projectStoreHandleTask(action, data)
  reloadAttention()
}

export function handleProjectStatusEvent(action: string, data: any): void {
  projectStoreHandleStatus(action, data)
  reloadAttention()
}

/** `task_checklist_item` created/updated/deleted: item and counters follow. */
export function handleChecklistItemEvent(action: string, data: any): void {
  checklistStoreHandleItem(action, data)
}

/** `label` created/updated/archived/restored/reordered: the catalog refetches. */
export function handleLabelEvent(action: string, data: any): void {
  catalogHandleLabelEvent(action, data)
}
