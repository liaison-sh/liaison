// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings API of Settings -> Notifications (plans/P2 "API contract"):
//   GET   /api/notifications/settings  -> NotificationSettingsData
//   PATCH /api/notifications/settings  body: any subset of NotificationSettingsPatch,
//                                       answers the same shape as GET.
// Every write is targeted: a grid cell, the cadence, the approval reminder
// frequency, or the work hours alone.
import { type ApprovalReminderFrequency, NOTIFICATION_GROUP_SECTIONS } from "@liaison/shared"
import type { useApi } from "~/modules/shell/ApiContext"

type Api = ReturnType<typeof useApi>

export type DigestCadence = "immediate" | "hourly" | "daily" | "off"
export type Grid = Record<string, Record<string, boolean>>

export interface WorkHours {
  start: string
  end: string
  /** 0 = Sunday .. 6 = Saturday. */
  days: number[]
  timezone: string
  /** False while the person is on the default hours. */
  explicit: boolean
  /** Where `timezone` came from; absent from an older API. */
  timezoneSource?: "user" | "org" | "unknown"
  /** False when this server has no default quiet hours and the person set none. */
  quiet?: boolean
}

/** How a kind reaches the person (rule 10): interrupt, inbox only, or off (muted). */
export type KindMode = "interrupt" | "inbox" | "off"
export const KIND_MODES: readonly KindMode[] = ["interrupt", "inbox", "off"]

export interface NotificationGroupRow {
  id: string
  /** English, for readers that do not translate. */
  label: string
  /** Relative to the kernel catalog: "notifications.groups.<id>". */
  labelKey?: string
}

/** A heading of the grid and the groups listed under it. */
export interface NotificationGroupSectionRow {
  id: string
  /** English, for readers that do not translate. */
  label: string
  /** Relative to the kernel catalog: "notifications.sections.<id>". */
  labelKey: string
  groups: string[]
}

export interface NotificationSettingsData {
  channels: string[]
  groups: NotificationGroupRow[]
  /** Absent from an API that predates sections: `gridLayout` falls back to the shared table. */
  sections?: NotificationGroupSectionRow[]
  grid: Grid
  defaults: Grid
  workHours: WorkHours
  digestCadence: DigestCadence
  /** How often the agent reminds the person of their waiting requests; absent from an older API (= daily). */
  approvalReminder?: ApprovalReminderFrequency
  /** Groups set to off; absent from an older API. */
  mutedGroups?: string[]
  /** Each group's mode; absent from an older API (derived by `kindMode`). */
  kindModes?: Record<string, KindMode>
}

export interface NotificationSettingsPatch {
  grid?: Grid
  workHours?: { start: string; end: string; days: number[] }
  digestCadence?: DigestCadence
  approvalReminder?: ApprovalReminderFrequency
  timezone?: string
  mutedGroups?: Record<string, boolean>
}

/** A kind's mode as shown: muted is off, else interrupt when computer or phone is on. */
export function kindMode(data: NotificationSettingsData, group: string): KindMode {
  if (data.mutedGroups?.includes(group)) return "off"
  return cellChecked(data, group, "desktop") || cellChecked(data, group, "push")
    ? "interrupt"
    : "inbox"
}

/** The patch that sets a kind to a mode. */
export function kindModePatch(group: string, mode: KindMode): NotificationSettingsPatch {
  if (mode === "off") return { mutedGroups: { [group]: true } }
  const on = mode === "interrupt"
  return { mutedGroups: { [group]: false }, grid: { [group]: { desktop: on, push: on } } }
}

/** What the screen shows at once for a mode change, before the server answers. */
export function withKindMode(
  data: NotificationSettingsData,
  group: string,
  mode: KindMode,
): NotificationSettingsData {
  const muted = new Set(data.mutedGroups ?? [])
  if (mode === "off") muted.add(group)
  else muted.delete(group)
  const grid =
    mode === "off"
      ? data.grid
      : {
          ...data.grid,
          [group]: {
            ...data.grid[group],
            desktop: mode === "interrupt",
            push: mode === "interrupt",
          },
        }
  return {
    ...data,
    grid,
    mutedGroups: [...muted],
    kindModes: { ...(data.kindModes ?? {}), [group]: mode },
  }
}

export interface ConversationRef {
  threadId: string
  title: string | null
  type: string
}

export interface NotificationConversations {
  muted: ConversationRef[]
  allPosts: ConversationRef[]
}

export function fetchNotificationConversations(api: Api): Promise<NotificationConversations> {
  return api.get<NotificationConversations>("/notifications/conversations")
}

/** Unmute a conversation, or put a channel back to mentions only (thread state). */
export function patchThreadState(
  api: Api,
  threadId: string,
  state: { isMuted?: boolean; notifyAllPosts?: boolean },
): Promise<unknown> {
  return api.patch(`/threads/${threadId}/state`, state)
}

export interface OnCallData {
  source: "list" | "admins" | "nobody"
  onCall: Array<{ id: string; name: string }>
  canEdit: boolean
  members: Array<{ id: string; name: string }>
}

export function fetchOnCall(api: Api): Promise<OnCallData> {
  return api.get<OnCallData>("/notifications/on-call")
}

export function putOnCall(api: Api, userIds: string[]): Promise<OnCallData> {
  return api.put<OnCallData>("/notifications/on-call", { userIds })
}

export const SETTINGS_PATH = "/notifications/settings"

export function fetchNotificationSettings(api: Api): Promise<NotificationSettingsData> {
  return api.get<NotificationSettingsData>(SETTINGS_PATH)
}

export function patchNotificationSettings(
  api: Api,
  patch: NotificationSettingsPatch,
): Promise<NotificationSettingsData> {
  return api.patch<NotificationSettingsData>(SETTINGS_PATH, patch)
}

/**
 * What a cell shows. In Liaison is always on; with the cadence off every email
 * cell is off (S9: one rule, whatever the stored cells say).
 */
export function cellChecked(
  data: NotificationSettingsData,
  group: string,
  channel: string,
): boolean {
  if (channel === "in_app") return true
  if (channel === "email" && data.digestCadence === "off") return false
  return data.grid[group]?.[channel] ?? data.defaults[group]?.[channel] ?? false
}

/** The grid as drawn: the groups under no heading, then each heading with its groups. */
export interface GridLayout {
  loose: NotificationGroupRow[]
  sections: Array<{ section: NotificationGroupSectionRow; groups: NotificationGroupRow[] }>
}

/**
 * Split the API's groups into the rows under no heading and the sections. The
 * sections come from the API; an API that sends none gets the shared table
 * (grouping by group id). A section none of whose groups the API lists is not drawn.
 */
export function gridLayout(data: NotificationSettingsData): GridLayout {
  const sections: NotificationGroupSectionRow[] =
    data.sections ??
    NOTIFICATION_GROUP_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      labelKey: s.labelKey,
      groups: [...s.groups],
    }))
  const byId = new Map(data.groups.map((g) => [g.id, g]))
  const placed = new Set(sections.flatMap((s) => s.groups))
  return {
    loose: data.groups.filter((g) => !placed.has(g.id)),
    sections: sections
      .map((section) => ({
        section,
        groups: section.groups.flatMap((id) => {
          const g = byId.get(id)
          return g ? [g] : []
        }),
      }))
      .filter((s) => s.groups.length > 0),
  }
}
