// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table backed by a project (its rows are the project's tasks): the values a project offers
// as read-through columns, and the project's name, read once per project and kept for the
// column markers and the plain-words refusals.
import { createSignal } from "solid-js"
import type { TableBacking } from "./dashboards-client"

/** The task values every project offers, in the order the create form lists them. */
export const BUILTIN_TASK_FIELDS = ["title", "status", "assignee", "due", "priority"] as const

/** One value a project's tasks offer to a backed table. */
export interface BackingField {
  key: string
  /** A built-in's label comes from i18n; a project field's is its own. */
  label?: string
  builtin: boolean
}

export interface ProjectShape {
  name: string
  fields: BackingField[]
}

interface ProjectsApi {
  get: <T = unknown>(path: string, init?: { suppressGlobalError?: boolean }) => Promise<T>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** The project's name and the values its tasks offer (built-ins first, then its own fields). */
export async function readProjectShape(api: ProjectsApi, projectId: string): Promise<ProjectShape> {
  const body = await api.get<unknown>(`/projects/${encodeURIComponent(projectId)}`, {
    suppressGlobalError: true,
  })
  const name = isRecord(body) && typeof body.name === "string" ? body.name : ""
  rememberName(projectId, name)
  const own = isRecord(body) && Array.isArray(body.fields) ? body.fields : []
  const builtins = new Set<string>(BUILTIN_TASK_FIELDS)
  return {
    name,
    fields: [
      ...BUILTIN_TASK_FIELDS.map((key) => ({ key, builtin: true })),
      ...own
        .filter(
          (f): f is { key: string; label: string } =>
            isRecord(f) &&
            typeof f.key === "string" &&
            typeof f.label === "string" &&
            !builtins.has(f.key),
        )
        .map((f) => ({ key: f.key, label: f.label, builtin: false })),
    ],
  }
}

// ── Project names, read once ────────────────────────────────────────────────

const [names, setNames] = createSignal<Record<string, string>>({})
const asked = new Set<string>()

function rememberName(id: string, name: string): void {
  if (name) setNames((n) => (n[id] === name ? n : { ...n, [id]: name }))
}

/**
 * The name of a backed table's parent record (reactive), or undefined until it is read. Only a
 * project is named; another app's record reads as undefined and the copy says "the record".
 */
export function backingName(
  api: ProjectsApi,
  backing: TableBacking | undefined,
): string | undefined {
  if (!backing) return undefined
  const known = names()[backing.parentId]
  if (known !== undefined || backing.app !== "projects") return known
  if (!asked.has(backing.parentId)) {
    asked.add(backing.parentId)
    void readProjectShape(api, backing.parentId).catch(() => {})
  }
  return undefined
}

/** Tests: forget every name read. */
export function resetBackingNames(): void {
  asked.clear()
  setNames({})
}
