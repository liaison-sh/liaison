// SPDX-License-Identifier: FSL-1.1-ALv2
// The page's calls: field values through the kernel settings routes
// (`GET|PATCH /api/apps/:app/settings/{org|user}`, one `{ path, value }` per
// write, or `{ values }` for a section saved as one unit) and the app's own tools for list, tree and options (`run-tool`, as
// the viewer: the tool's scopes and approval policy apply).
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { runTool } from "~/lib/run-tool"
import type { SettingsScope } from "./types"

export interface SettingsValues {
  values: Record<string, unknown>
  /** Fields whose value could not be read (a get tool failed or waits for approval). */
  errors?: Record<string, { code: string; message: string }>
}

export function loadSettingsValues(
  api: ApiClient,
  app: string,
  scope: SettingsScope,
): Promise<SettingsValues> {
  return api.get<SettingsValues>(`/apps/${app}/settings/${scope}`, { suppressGlobalError: true })
}

export type SaveOutcome =
  | { kind: "saved"; value: unknown }
  | { kind: "pending"; approvalRequestId: string | null }

// One app's saves run one at a time. A tool-backed field is written by reading
// the whole object, changing one path and writing it back (settings-routes.ts),
// so two saves in flight together lose the first: filling the ship-from fields
// in a row kept only the last one.
const saveQueues = new Map<string, Promise<unknown>>()

/** Save one field. Throws ApiError on refusal (403, 422 with the message, ...). */
export function saveSetting(
  api: ApiClient,
  app: string,
  scope: SettingsScope,
  path: string,
  value: unknown,
): Promise<SaveOutcome> {
  const key = `${app}/${scope}`
  const run = (saveQueues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => patchSetting(api, app, scope, path, value))
  saveQueues.set(key, run)
  void run
    .finally(() => {
      if (saveQueues.get(key) === run) saveQueues.delete(key)
    })
    .catch(() => {})
  return run
}

/**
 * Save several fields of one tool-backed section as one unit (M1): one
 * `PATCH { values }`, one set call on the server, one approval when it is gated.
 */
export function saveSettingsUnit(
  api: ApiClient,
  app: string,
  scope: SettingsScope,
  values: Record<string, unknown>,
): Promise<UnitSaveOutcome> {
  const key = `${app}/${scope}`
  const run = (saveQueues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async (): Promise<UnitSaveOutcome> => {
      const res = await api.patch<{
        values?: Record<string, unknown>
        pending?: { approvalRequestId: string | null }
      }>(`/apps/${app}/settings/${scope}`, { values }, { suppressGlobalError: true })
      if (res?.pending) return { kind: "pending", approvalRequestId: res.pending.approvalRequestId }
      return { kind: "saved", values: res?.values ?? values }
    })
  saveQueues.set(key, run)
  void run
    .finally(() => {
      if (saveQueues.get(key) === run) saveQueues.delete(key)
    })
    .catch(() => {})
  return run
}

export type UnitSaveOutcome =
  | { kind: "saved"; values: Record<string, unknown> }
  | { kind: "pending"; approvalRequestId: string | null }

async function patchSetting(
  api: ApiClient,
  app: string,
  scope: SettingsScope,
  path: string,
  value: unknown,
): Promise<SaveOutcome> {
  const res = await api.patch<{
    path: string
    value?: unknown
    pending?: { approvalRequestId: string | null }
  }>(`/apps/${app}/settings/${scope}`, { path, value }, { suppressGlobalError: true })
  if (res?.pending) return { kind: "pending", approvalRequestId: res.pending.approvalRequestId }
  return { kind: "saved", value: res && "value" in res ? res.value : value }
}

export type ToolOutcome<T = unknown> =
  | { kind: "ok"; data: T }
  | { kind: "pending"; approvalRequestId: string | null }
  | { kind: "error"; status: number; code: string; message: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Run one of `app`'s tools as the viewer; never throws. */
export async function callAppTool<T = unknown>(
  api: ApiClient,
  app: string,
  tool: string,
  params: Record<string, unknown> = {},
): Promise<ToolOutcome<T>> {
  try {
    const data = await runTool<unknown>(api, `${app}:${tool}`, params, {
      suppressGlobalError: true,
    })
    if (isRecord(data) && isRecord(data.blocked)) {
      const id = data.blocked.approvalRequestId
      return { kind: "pending", approvalRequestId: typeof id === "string" ? id : null }
    }
    // "Not connected" and other tool refusals come back as data carrying an error.
    if (isRecord(data) && isRecord(data.error) && typeof data.error.code === "string") {
      const message = typeof data.error.message === "string" ? data.error.message : data.error.code
      return { kind: "error", status: 200, code: data.error.code, message }
    }
    return { kind: "ok", data: data as T }
  } catch (err) {
    if (err instanceof ApiError) {
      return { kind: "error", status: err.status, code: err.code ?? "error", message: err.message }
    }
    return {
      kind: "error",
      status: 0,
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Rows out of a list tool's answer: an array, or `{ rows | items | nodes | data }`. */
export function rowsOf(data: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(data)
    ? data
    : isRecord(data)
      ? ([data.rows, data.items, data.nodes, data.data].find(Array.isArray) ?? onlyArray(data))
      : undefined
  return (arr ?? []).filter(isRecord)
}

/** The one array an answer holds under a name of its own (`{ terms: [...] }`). */
function onlyArray(data: Record<string, unknown>): unknown[] | undefined {
  const arrays = Object.values(data).filter(Array.isArray)
  return arrays.length === 1 ? arrays[0] : undefined
}

/** The value at a dot path of a row. */
export function valueAt(row: Record<string, unknown>, path: string): unknown {
  let cur: unknown = row
  for (const seg of path.split(".")) {
    if (!isRecord(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}
