// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Notification groups and channels: the model behind Settings -> Notifications
 * and the API router (`apps/api/src/modules/notifications/router.ts`).
 *
 * A group is a user-facing bucket of attention kinds; the grid says, per group,
 * on which channel the user wants to hear about it. `in_app` (the feed and the
 * bell) is always on and not switchable.
 */
import type { AttentionKind } from "../types/attention"

export const NOTIFICATION_CHANNELS = ["in_app", "desktop", "push", "email"] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const NOTIFICATION_GROUP_IDS = [
  "direct",
  "replies",
  "approvals",
  "decisions",
  "work",
  "mail",
  "agent",
  "session_needs_you",
  "session_done",
  "session_failed",
  "monitoring",
  "system",
] as const
export type NotificationGroupId = (typeof NOTIFICATION_GROUP_IDS)[number]

/**
 * Kinds a group can own: every kernel `AttentionKind`, plus the app kinds the
 * spec places by name (`knowledge_review` from the knowledge app) and the
 * `new_email` kind the mail producer adds.
 */
export type NotificationKind =
  | "tickets:ticket.created"
  | AttentionKind
  | "knowledge_review"
  | "new_email"
  | NodeSessionNoticeKind
  | MonitoringIncidentKind

/**
 * The notices of a computer session (node session) to its owner: it needs
 * them, it is done, it failed. Written by apps/api push/node-session-notify.ts.
 */
export const NODE_SESSION_NOTICE_KINDS = [
  "node_session_needs_you",
  "node_session_done",
  "node_session_failed",
] as const
export type NodeSessionNoticeKind = (typeof NODE_SESSION_NOTICE_KINDS)[number]

/**
 * The incident kinds the monitoring bundled app writes (translations of
 * `bundled-apps/monitoring/app.manifest.json`). Listed by name rather than
 * matched by prefix; `apps/api/src/modules/notifications/monitoring-group.test.ts`
 * keeps this list in step with the manifest.
 */
export const MONITORING_INCIDENT_KINDS = [
  "monitoring:incident.critical",
  "monitoring:incident.warning",
] as const
export type MonitoringIncidentKind = (typeof MONITORING_INCIDENT_KINDS)[number]

export interface NotificationGroup {
  id: NotificationGroupId
  /** i18n key of the plain label shown in Settings -> Notifications. */
  labelKey: string
  /** English label, for API consumers that do not translate (agent tools, logs). */
  label: string
  kinds: readonly NotificationKind[]
}

/**
 * The group table of the spec. Chat messages are not attention kinds: a message
 * in a direct room (or one that mentions the user) belongs to `direct`, any
 * other thread message to `replies` (`groupForChatMessage`).
 */
export const NOTIFICATION_GROUPS: readonly NotificationGroup[] = [
  {
    id: "direct",
    labelKey: "notifications.groups.direct",
    label: "Direct messages and mentions",
    // A reply in a thread you follow is addressed to you like a mention is.
    kinds: ["mention", "thread_followup", "dm_window_closing"],
  },
  {
    id: "replies",
    labelKey: "notifications.groups.replies",
    label: "Replies in your threads",
    kinds: ["thread_reply", "file_shared"],
  },
  {
    id: "approvals",
    labelKey: "notifications.groups.approvals",
    label: "Approvals and access requests",
    // What only you (or your role) can decide: a direct ask.
    kinds: ["approval_pending", "scope_request", "admin_action", "routine_mailbox_wait", "tickets:ticket.created"],
  },
  {
    // The outcome of your own request: news for the inbox, never an
    // interrupt by default (notification etiquette, rule 9).
    id: "decisions",
    labelKey: "notifications.groups.decisions",
    label: "Decisions on your requests",
    kinds: ["approval_decision", "scope_request_decided"],
  },
  {
    id: "work",
    labelKey: "notifications.groups.work",
    label: "Tickets, tasks and knowledge",
    kinds: [
      "sla_risk",
      "awaiting_agent",
      "unassigned",
      "nudge_due",
      "followup_due",
      "task_overdue",
      "task_due_this_week",
      "task_blocked",
      "knowledge_review",
    ],
  },
  { id: "mail", labelKey: "notifications.groups.mail", label: "New email", kinds: ["new_email"] },
  {
    id: "agent",
    labelKey: "notifications.groups.agent",
    label: "Agent and routine alerts",
    kinds: ["agent_notification"],
  },
  {
    id: "session_needs_you",
    labelKey: "notifications.groups.session_needs_you",
    label: "Computer session needs you",
    kinds: ["node_session_needs_you"],
  },
  {
    id: "session_done",
    labelKey: "notifications.groups.session_done",
    label: "Computer session done",
    kinds: ["node_session_done"],
  },
  {
    id: "session_failed",
    labelKey: "notifications.groups.session_failed",
    label: "Computer session failed",
    kinds: ["node_session_failed"],
  },
  {
    id: "monitoring",
    labelKey: "notifications.groups.monitoring",
    label: "Monitoring incidents",
    kinds: MONITORING_INCIDENT_KINDS,
  },
  {
    id: "system",
    labelKey: "notifications.groups.system",
    label: "System alerts",
    kinds: ["system_alert"],
  },
]

/** A heading in Settings -> Notifications and the groups listed under it. */
export interface NotificationGroupSection {
  id: string
  /** i18n key of the heading, relative to the kernel catalog. */
  labelKey: string
  /** English heading, for API consumers that do not translate. */
  label: string
  groups: readonly NotificationGroupId[]
}

/**
 * Groups shown under their own heading, after the ungrouped rows: the three
 * computer session rows sit under "Computer sessions".
 */
export const NOTIFICATION_GROUP_SECTIONS: readonly NotificationGroupSection[] = [
  {
    id: "sessions",
    labelKey: "notifications.sections.sessions",
    label: "Computer sessions",
    groups: ["session_needs_you", "session_done", "session_failed"],
  },
]

// No compile-time exhaustiveness: the table is built with a cast. `groups.test.ts`
// checks at runtime that every known kind has exactly one group; a kind the table
// does not name falls back to `work` (see `groupForKind`).
const KIND_TO_GROUP: Record<NotificationKind, NotificationGroupId> = Object.fromEntries(
  NOTIFICATION_GROUPS.flatMap((g) => g.kinds.map((k) => [k, g.id])),
) as Record<NotificationKind, NotificationGroupId>

export function isNotificationGroupId(value: string): value is NotificationGroupId {
  return (NOTIFICATION_GROUP_IDS as readonly string[]).includes(value)
}

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
}

/**
 * The group of an attention kind. A kind the table does not name, including any
 * app-namespaced `<app>:<kind>` other than the monitoring incident kinds, falls
 * back to `work`.
 */
export function groupForKind(kind: string): NotificationGroupId {
  return (KIND_TO_GROUP as Record<string, NotificationGroupId>)[kind] ?? "work"
}

/** The group of a chat message: direct room or @mention -> direct, else replies. */
export function groupForChatMessage(args: {
  direct: boolean
  mentioned: boolean
}): NotificationGroupId {
  return args.direct || args.mentioned ? "direct" : "replies"
}

export type NotificationGridRow = Record<NotificationChannel, boolean>
export type NotificationGrid = Record<NotificationGroupId, NotificationGridRow>

function row(inApp: boolean, desktop: boolean, push: boolean, email: boolean): NotificationGridRow {
  return { in_app: inApp, desktop, push, email }
}

/**
 * The default grid. Only a direct ask interrupts (push, desktop): a direct
 * message, a mention, a reply in a reply thread you follow, an approval you can
 * decide, a computer session of yours, an incident. Everything else goes to the
 * inbox quietly: a channel post (`replies`) unless the member opts that channel
 * into every post (`user_thread_state.notify_all_posts`, read by the router),
 * the decision on your own request, new email. The email column keeps the
 * digest content it had before the grid, except monitoring incidents, which
 * leave the digest (the feed and push carry them); `mail` email is off because
 * the email is already in the mailbox. `in_app` is always on.
 */
export const DEFAULT_GRID: Readonly<NotificationGrid> = Object.freeze({
  direct: row(true, true, true, true),
  replies: row(true, false, false, true),
  approvals: row(true, true, true, true),
  decisions: row(true, false, false, true),
  work: row(true, false, false, true),
  mail: row(true, false, false, false),
  agent: row(true, true, true, true),
  // A computer session: phone and computer, no email (the person is at work on it).
  session_needs_you: row(true, true, true, false),
  session_done: row(true, true, true, false),
  session_failed: row(true, true, true, false),
  // Incidents: phone and computer on (critical ones come through at any hour), no
  // email, since the feed has them and the digest is not the place for alerts.
  monitoring: row(true, true, true, false),
  system: row(true, false, false, true),
})

/** A sparse grid: only the cells that differ from `DEFAULT_GRID`. */
export type NotificationGridOverrides = Partial<
  Record<NotificationGroupId, Partial<Record<NotificationChannel, boolean>>>
>

/**
 * Defaults merged with stored cells. Unknown groups, channels and non-boolean
 * values are ignored; `in_app` stays true whatever is stored.
 */
export function effectiveGrid(overrides: unknown): NotificationGrid {
  const grid = Object.fromEntries(
    NOTIFICATION_GROUP_IDS.map((g) => [g, { ...DEFAULT_GRID[g] }]),
  ) as NotificationGrid
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return grid
  for (const [group, cells] of Object.entries(overrides as Record<string, unknown>)) {
    if (!isNotificationGroupId(group)) continue
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) continue
    for (const [channel, value] of Object.entries(cells as Record<string, unknown>)) {
      if (!isNotificationChannel(channel) || channel === "in_app") continue
      if (typeof value !== "boolean") continue
      grid[group][channel] = value
    }
  }
  return grid
}

/** The sparse form of a grid: only the cells that differ from the defaults. */
export function gridOverrides(grid: NotificationGrid): NotificationGridOverrides {
  const out: NotificationGridOverrides = {}
  for (const group of NOTIFICATION_GROUP_IDS) {
    for (const channel of NOTIFICATION_CHANNELS) {
      if (channel === "in_app") continue
      if (grid[group][channel] !== DEFAULT_GRID[group][channel]) {
        out[group] = { ...out[group], [channel]: grid[group][channel] }
      }
    }
  }
  return out
}

export interface UrgencyFacts {
  kind: string
  /** The stored `attention_events.is_urgent` (translation override, else urgency >= 70). */
  isUrgent: boolean
  /** For `approval_pending`: the users who can decide it. */
  approverIds?: readonly string[]
}

/**
 * The one urgent predicate, used by the router and the digest: the stored
 * `is_urgent`, or an `approval_pending` whose approver set includes the user.
 * Urgent items ignore quiet time, nothing else.
 */
export function isUrgentFor(item: UrgencyFacts, userId: string): boolean {
  if (item.isUrgent) return true
  return item.kind === "approval_pending" && (item.approverIds ?? []).includes(userId)
}
