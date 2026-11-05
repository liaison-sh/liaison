// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The import runs in view (progress cards, the Imports view), by id. A card
// reads its run once and re-reads it when the server says the run changed or
// progressed (the `import_run` event, which carries only the id and status).
// A card under an agent's approval knows the approval, not the run: it finds
// the run the approval started (`?approvalRequestId=`) and re-asks on any
// `import_run` event until there is one.

import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export type ImportRunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "undoing"
  | "undone"

export interface ImportRun {
  id: string
  kindSet: string[]
  sourceLabel: string
  status: ImportRunStatus
  dryRun: boolean
  counts: Record<string, { created: number; skipped: number; failed: number }>
  errors: Array<Record<string, unknown>>
  report: Record<string, unknown>
  createdAt: string
  finishedAt: string | null
}

const QUIET = { suppressGlobalError: true } as const

const [state, setState] = createStore<{
  byId: Record<string, ImportRun>
  /** approval id -> run id ("" while the approval has started nothing yet). */
  byApproval: Record<string, string>
}>({ byId: {}, byApproval: {} })
const inFlight = new Map<string, Promise<ImportRun | undefined>>()
/** The one read queued behind an in-flight read, for a change that arrived meanwhile. */
const queued = new Map<string, Promise<ImportRun | undefined>>()

export function resetImportRunStore(): void {
  inFlight.clear()
  queued.clear()
  setState({ byId: {}, byApproval: {} })
}

onSessionTeardown(resetImportRunStore)

export function getById(id: string): ImportRun | undefined {
  return state.byId[id]
}

export function runIdForApproval(approvalRequestId: string): string | undefined {
  const id = state.byApproval[approvalRequestId]
  return id ? id : undefined
}

function upsert(row: ImportRun): void {
  setState(
    produce((s) => {
      s.byId[row.id] = row
    }),
  )
}

/**
 * Read a run from the server (always). A read already on its way may have left
 * the server before the change that asks for this one (a final status landing
 * during a progress read), so the run is read once more when it settles; reads
 * asked meanwhile share that one.
 */
export function reload(api: ApiClient, id: string): Promise<ImportRun | undefined> {
  const existing = inFlight.get(id)
  if (existing) {
    let again = queued.get(id)
    if (!again) {
      again = existing
        .catch(() => undefined)
        .then(() => {
          queued.delete(id)
          return reload(api, id)
        })
      queued.set(id, again)
    }
    return again
  }
  const promise = api
    .get<ImportRun>(`/imports/${id}`, QUIET)
    .then((row) => {
      if (row?.id) upsert(row)
      return row
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, promise)
  return promise
}

export function ensureLoaded(api: ApiClient, id: string): Promise<ImportRun | undefined> {
  const row = state.byId[id]
  return row ? Promise.resolve(row) : reload(api, id)
}

/** The run an approval started, once it exists. */
export async function findForApproval(
  api: ApiClient,
  approvalRequestId: string,
): Promise<ImportRun | undefined> {
  const known = runIdForApproval(approvalRequestId)
  if (known) return ensureLoaded(api, known)
  setState(
    produce((s) => {
      if (!(approvalRequestId in s.byApproval)) s.byApproval[approvalRequestId] = ""
    }),
  )
  const rows = await api.get<ImportRun[]>(
    `/imports?approvalRequestId=${encodeURIComponent(approvalRequestId)}`,
    QUIET,
  )
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (row?.id) {
    upsert(row)
    setState(
      produce((s) => {
        s.byApproval[approvalRequestId] = row.id
      }),
    )
  }
  return row
}

/** The server said a run changed: re-read it if a card shows it, or look again for approvals still waiting. */
export function handleEvent(api: ApiClient, data: unknown): void {
  const id =
    data && typeof data === "object" && "id" in data && typeof data.id === "string" ? data.id : null
  if (id && state.byId[id]) void reload(api, id).catch(() => undefined)
  for (const [approval, runId] of Object.entries(state.byApproval)) {
    if (runId === "") void findForApproval(api, approval).catch(() => undefined)
  }
}

/** Undo a finished run (the server checks who may), then re-read it. */
export async function undo(
  api: ApiClient,
  id: string,
): Promise<{ deleted: number; refused: unknown[] }> {
  const report = await api.post<{ deleted: number; refused: unknown[] }>(
    `/imports/${id}/undo`,
    undefined,
    QUIET,
  )
  await reload(api, id)
  return report
}

export const importRunStore = {
  getById,
  runIdForApproval,
  reload,
  ensureLoaded,
  findForApproval,
  handleEvent,
  undo,
}
