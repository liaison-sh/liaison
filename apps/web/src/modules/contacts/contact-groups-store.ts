// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contact groups (S15): named groups of hand-picked contacts, over
// /api/contacts/groups. The server counts only the members the viewer may see.

import { createSignal } from "solid-js"
import { subscribeResync } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface ContactGroup {
  id: string
  name: string
  memberCount: number
}

export interface GroupMembershipChange {
  groupId: string
  groupName: string
  changed: number
  unchanged: number
  notFound: string[]
}

interface GroupsApi {
  get: <T>(path: string) => Promise<T | { data: T }>
  post: <T>(path: string, body?: unknown) => Promise<T | { data: T }>
}

function unwrap<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

const [groups, setGroups] = createSignal<ContactGroup[]>([])
const [groupsLoaded, setGroupsLoaded] = createSignal(false)

let _api: GroupsApi | null = null

function byName(a: ContactGroup, b: ContactGroup): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

export async function loadGroups(api: GroupsApi): Promise<void> {
  _api = api
  const list = unwrap<ContactGroup[]>(await api.get<ContactGroup[]>("/contacts/groups"))
  setGroups((list ?? []).map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })))
  setGroupsLoaded(true)
}

export async function createGroup(api: GroupsApi, name: string): Promise<ContactGroup> {
  const created = unwrap<ContactGroup>(await api.post<ContactGroup>("/contacts/groups", { name }))
  setGroups((list) => [...list.filter((g) => g.id !== created.id), created].sort(byName))
  return created
}

export async function addToGroup(
  api: GroupsApi,
  groupId: string,
  contactIds: string[],
): Promise<GroupMembershipChange> {
  const change = unwrap<GroupMembershipChange>(
    await api.post<GroupMembershipChange>(`/contacts/groups/${groupId}/members`, { contactIds }),
  )
  setGroups((list) =>
    list.map((g) => (g.id === groupId ? { ...g, memberCount: g.memberCount + change.changed } : g)),
  )
  return change
}

export async function removeFromGroup(
  api: GroupsApi,
  groupId: string,
  contactIds: string[],
): Promise<GroupMembershipChange> {
  const change = unwrap<GroupMembershipChange>(
    await api.post<GroupMembershipChange>(`/contacts/groups/${groupId}/members/remove`, {
      contactIds,
    }),
  )
  setGroups((list) =>
    list.map((g) =>
      g.id === groupId ? { ...g, memberCount: Math.max(0, g.memberCount - change.changed) } : g,
    ),
  )
  return change
}

/** The groups one contact is in, as far as the viewer can see. */
export async function loadContactGroups(
  api: GroupsApi,
  contactId: string,
): Promise<Array<{ id: string; name: string }>> {
  return unwrap(await api.get<Array<{ id: string; name: string }>>(`/contacts/${contactId}/groups`))
}

let _resyncSubscribed = false

export function subscribeGroupsResync(): void {
  if (_resyncSubscribed) return
  _resyncSubscribed = true
  subscribeResync(() => {
    if (_api && groupsLoaded()) void loadGroups(_api)
  })
}

export function resetContactGroupsStore(): void {
  setGroups([])
  setGroupsLoaded(false)
  _api = null
}

onSessionTeardown(resetContactGroupsStore)

export { groups, groupsLoaded }
