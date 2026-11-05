// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore, unwrap } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface DimensionDef {
  app: string
  key: string
  localKey?: string
  label: string
  type: string
  order?: string[]
  values?: string[]
  valueSource?: { kind: string }
}

export interface DimensionValue {
  value: string
  label: string
  sublabel?: string
}

export interface DimensionGrantRow {
  direct: string[]
  derived: Array<{ roleId: string; values: string[] }>
  effective: string[]
}

export interface GrantUser {
  id: string
  name: string
  email?: string | null
  isActive?: boolean
}

interface AdminApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
  delete: <T = unknown>(path: string) => Promise<T>
}

interface DimensionGrantState {
  dimensionDefs: DimensionDef[]
  error: string | null
  grantsByUser: Record<string, Record<string, DimensionGrantRow>>
  selectedUserId: string | null
  users: GrantUser[]
  valuesByKey: Record<string, DimensionValue[]>
}

const [dimensionGrantStore, setDimensionGrantStore] = createStore<DimensionGrantState>({
  dimensionDefs: [],
  error: null,
  grantsByUser: {},
  selectedUserId: null,
  users: [],
  valuesByKey: {},
})

function unwrapData<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in result
    ? (result as { data: T }).data
    : (result as T)
}

function grantRows(payload: {
  direct?: Record<string, string[]>
  derived?: Record<string, Array<{ roleId: string; values: string[] }>>
}): Record<string, DimensionGrantRow> {
  const keys = new Set([
    ...Object.keys(payload.direct ?? {}),
    ...Object.keys(payload.derived ?? {}),
  ])
  const rows: Record<string, DimensionGrantRow> = {}
  for (const key of keys) {
    const direct = payload.direct?.[key] ?? []
    const derived = payload.derived?.[key] ?? []
    rows[key] = {
      direct,
      derived,
      effective: [...new Set([...direct, ...derived.flatMap((entry) => entry.values)])],
    }
  }
  return rows
}

export async function loadDimensions(api: Pick<AdminApi, "get">): Promise<void> {
  setDimensionGrantStore(
    "dimensionDefs",
    unwrapData<DimensionDef[]>(await api.get("/apps/dimensions")),
  )
}

export async function loadValues(api: Pick<AdminApi, "get">, dimensionKey: string): Promise<void> {
  const values = unwrapData<DimensionValue[]>(
    await api.get(`/apps/dimensions/${encodeURIComponent(dimensionKey)}/values`),
  )
  setDimensionGrantStore("valuesByKey", dimensionKey, values)
}

export async function loadUsers(api: Pick<AdminApi, "get">): Promise<void> {
  const users = unwrapData<GrantUser[]>(await api.get("/admin/users?limit=100"))
  setDimensionGrantStore("users", users)
  if (!dimensionGrantStore.selectedUserId && users[0])
    setDimensionGrantStore("selectedUserId", users[0].id)
}

export function selectUser(userId: string): void {
  setDimensionGrantStore("selectedUserId", userId)
}

export async function loadGrantsForUser(api: Pick<AdminApi, "get">, userId: string): Promise<void> {
  const payload = unwrapData<{
    direct?: Record<string, string[]>
    derived?: Record<string, Array<{ roleId: string; values: string[] }>>
  }>(await api.get(`/admin/roles/users/${userId}/dimensions`))
  setDimensionGrantStore("grantsByUser", userId, grantRows(payload))
}

export async function toggleGrant(
  api: AdminApi,
  userId: string,
  dimensionKey: string,
  value: string,
  on: boolean,
): Promise<void> {
  const snapshot = structuredClone(
    unwrap(dimensionGrantStore.grantsByUser[userId] ?? {}),
  ) as Record<string, DimensionGrantRow>
  const current = dimensionGrantStore.grantsByUser[userId]?.[dimensionKey]?.direct ?? []
  const dimensionType = dimensionGrantStore.dimensionDefs.find(
    (def) => def.key === dimensionKey,
  )?.type
  const next =
    dimensionType === "level"
      ? on
        ? [value]
        : []
      : on
        ? [...new Set([...current, value])]
        : current.filter((entry) => entry !== value)

  setDimensionGrantStore("error", null)
  setDimensionGrantStore("grantsByUser", userId, dimensionKey, {
    direct: next,
    derived: dimensionGrantStore.grantsByUser[userId]?.[dimensionKey]?.derived ?? [],
    effective: [
      ...new Set([
        ...next,
        ...(dimensionGrantStore.grantsByUser[userId]?.[dimensionKey]?.derived ?? []).flatMap(
          (entry) => entry.values,
        ),
      ]),
    ],
  })

  try {
    if (next.length === 0) {
      await api.delete(
        `/admin/roles/users/${userId}/dimensions/${encodeURIComponent(dimensionKey)}`,
      )
    } else {
      await api.post(`/admin/roles/users/${userId}/dimensions`, {
        dimension: dimensionKey,
        values: next,
      })
    }
    await loadGrantsForUser(api, userId)
  } catch (err) {
    setDimensionGrantStore("grantsByUser", userId, snapshot)
    setDimensionGrantStore("error", err instanceof Error ? err.message : "Failed to update grants")
    throw err
  }
}

export function resetDimensionGrantStore(): void {
  setDimensionGrantStore({
    dimensionDefs: [],
    error: null,
    grantsByUser: {},
    selectedUserId: null,
    users: [],
    valuesByKey: {},
  })
}

onSessionTeardown(resetDimensionGrantStore)

export { dimensionGrantStore }
