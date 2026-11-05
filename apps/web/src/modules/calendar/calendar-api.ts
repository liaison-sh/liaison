// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar API client — thin wrappers over the generic manifest tool-execution endpoint
// (`POST /apps/calendar/tools/<toolName>`, apps/api/src/modules/apps/routes.ts) since calendar
// has no dedicated routes.ts — everything is exposed as agent tools that the UI reuses directly
// (Design: "Agents can operate the calendar with the same permission + sync semantics as the UI").
import type { ApiClient } from "~/lib/api-client"
import { hasScope } from "~/modules/auth/auth-store"

export interface CalendarPoint {
  date?: string
  dateTime?: string
  /** IANA zone of a timed point (Google sets it on recurring series). */
  timeZone?: string
}

export interface CalendarListItem {
  id: string
  name: string
  color: string | null
  accessRole: string | null
  selected: boolean
}

export interface CalendarEventDto {
  eventId: string
  /** Google's id of the event. On a recurring master it is the id its exception rows carry in
   * `recurringEventId`, which is how the expander pairs them. */
  googleEventId?: string | null
  calendarId: string
  title: string | null
  description?: string | null
  location?: string | null
  start: CalendarPoint | null
  end: CalendarPoint | null
  allDay: boolean
  recurrence: string[] | null
  recurringEventId: string | null
  originalStartTime: CalendarPoint | null
  status: string
  hangoutLink?: string | null
  attendees?: CalendarAttendee[]
  /** False when Google would not apply a guest-list change from this account. */
  attendeesEditable?: boolean
  /** Google's message when it refused this event's last change from Liaison. */
  pushError?: string | null
  /** Why a delete Google refused brought this event back. */
  pushNotice?: string | null
}

export interface CalendarAttendee {
  email: string
  displayName?: string
  /** Google's responseStatus: needsAction | accepted | declined | tentative. */
  responseStatus?: string
  organizer?: boolean
  self?: boolean
  optional?: boolean
}

async function invokeTool<T>(api: ApiClient, tool: string, params: object): Promise<T> {
  return api.post(`/apps/calendar/tools/${tool}`, { params })
}

export async function listCalendars(api: ApiClient): Promise<CalendarListItem[]> {
  return invokeTool(api, "list_calendars", {})
}

export async function listEvents(
  api: ApiClient,
  params: { calendarId?: string; timeMin: string; timeMax: string },
): Promise<CalendarEventDto[]> {
  return invokeTool(api, "list_events", params)
}

export interface CreateEventInput {
  calendarId: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay?: boolean
  attendees?: string[]
  recurrence?: string[]
}

export async function createEvent(
  api: ApiClient,
  input: CreateEventInput,
): Promise<{ eventId: string }> {
  return invokeTool(api, "create_event", input)
}

export interface UpdateEventInput {
  eventId: string
  title?: string
  description?: string
  location?: string
  start?: string
  end?: string
  allDay?: boolean
  attendees?: string[]
  /** Required by the API for an event that belongs to a recurring meeting. */
  scope?: "occurrence" | "series"
}

export async function updateEvent(
  api: ApiClient,
  input: UpdateEventInput,
): Promise<{ eventId: string }> {
  return invokeTool(api, "update_event", input)
}

export async function deleteEvent(
  api: ApiClient,
  eventId: string,
  scope?: "occurrence" | "series",
): Promise<void> {
  await invokeTool(api, "delete_event", { eventId, ...(scope ? { scope } : {}) })
}

// --- Connect / settings (kernel connections framework) ---

export interface CalendarConnectionDto {
  /** The calendar app's own account row id (retry_import, calendar ownership). */
  id: string
  /** The kernel connection id: the one `DELETE /connections/:id` disconnects. */
  connectedAccountId: string
  connectionName: string
  ownerType: "user" | "org"
  identifier: string
  status: string
  /** Why the last import failed (status 'error'), else null. */
  lastSyncError: string | null
  createdAt: string
}

/** Lists this org's calendar connections (both personal — filtered server-side to the caller's
 * own — and org-wide) via the calendar app's own `list_accounts` tool. The generic
 * connections-framework list route (`GET /connections/:appName`) deliberately excludes
 * org-owned non-kernel connections — apps are expected to expose their own accounts listing
 * (mirrors mail's `listAccounts`) — so calendar cannot rely on it for Settings. */
export async function listCalendarConnections(api: ApiClient): Promise<CalendarConnectionDto[]> {
  const rows = await invokeTool<
    Array<{
      id: string
      connectedAccountId: string
      identifier: string
      displayName: string | null
      ownerType: string
      status: string
      lastSyncError?: string | null
      createdAt: string
    }>
  >(api, "list_accounts", {})
  return rows.map((r) => ({
    id: r.id,
    connectedAccountId: r.connectedAccountId,
    connectionName: "google-calendar",
    ownerType: r.ownerType === "org" ? "org" : "user",
    identifier: r.identifier,
    status: r.status,
    lastSyncError: r.lastSyncError ?? null,
    createdAt: r.createdAt,
  }))
}

/** Whether the signed-in user may manage org calendar connections. Mirrors the server checks
 * (connections route requireOrgConnectScope, calendar bridge isCalendarAdmin), which both use
 * the backend hasScope: '*', 'calendar', 'calendar:*' and calendar:accounts:admin pass. The web
 * hasScope covers all but 'calendar:*', hence the second test. */
export function canManageOrgCalendars(): boolean {
  return hasScope("calendar:accounts:admin") || hasScope("calendar:*")
}

/** Who the server lets retry an import: a personal account is only ever listed to its owner,
 * an org account needs the calendar admin scope. */
export function canRetryCalendarImport(account: Pick<CalendarConnectionDto, "ownerType">): boolean {
  return account.ownerType === "user" || canManageOrgCalendars()
}

/** Re-runs the import of an account whose last import failed (the `retry_import` tool). */
export async function retryCalendarImport(api: ApiClient, accountId: string): Promise<void> {
  await invokeTool(api, "retry_import", { accountId })
}

/** Toggles a calendar's `selected` flag — the calendar_setSelected bridge method, reached via
 * the generic tool-execution endpoint (no dedicated route; mirrors every other calendar tool). */
export async function setCalendarSelected(
  api: ApiClient,
  calendarId: string,
  selected: boolean,
): Promise<void> {
  await api.post("/apps/calendar/tools/set_selected", { params: { calendarId, selected } })
}
