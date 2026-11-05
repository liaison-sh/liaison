// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent skills store — manages the list of skills (built-in + org + personal)
 * visible to the current user, plus optimistic CRUD against the
 * `/api/agent/skills` and `/api/agent/app-skills` REST surface.
 *
 * Stays small and explicit so the visibility contract with the backend
 * (`resolveAllSkills`) stays observable: the API returns a flattened list
 * with `source: "personal" | "org" | "app"`, and we group + dedupe in selectors.
 */
import { createStore } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export type SkillSource = "personal" | "org" | "app"

export interface SkillRow {
  /** UUID for org/user skills, `built-in/<app>/<name>` for app-shipped */
  id: string
  name: string
  description: string
  source: SkillSource
  /** Set when `source === "app"` */
  appName?: string | null
  requiredScopes: string[]
  /** Optional routing domain slug; null/undefined means general (no domain). */
  domain?: string | null
  /** Optional — full body is only fetched on detail-open */
  body?: string
  /** "agent" if the skill was authored by an agent (approved by a user) */
  createdByActorType?: "user" | "agent" | "system" | "mcp" | null
  /** Set on app-skills when the caller has disabled them */
  disabled?: boolean
  /** The agent that OWNS this skill, on the per-agent listing (P4c-T32). */
  ownerAgentId?: string | null
  /** The server's A15 answer for THIS viewer (P4c-T32b). Never recomputed here. */
  canWrite?: boolean
}

interface SkillsState {
  skills: SkillRow[]
  loading: boolean
  error: string | null
  /** Selected detail entityId for ws-driven refetch routing */
  openDetailId: string | null
  /**
   * P4c-T36: the agent page's Skills tab asks a DIFFERENT question than the
   * flat `/agent/skills` screen ("what does this agent own" vs "what can I
   * see"), so its answer is cached per ownerAgentId instead of overwriting
   * `skills`. Both surfaces stay mounted at once in the shell; one list would
   * mean each clobbering the other on every load.
   */
  byAgent: Record<string, SkillRow[]>
}

const [skillsStore, setSkillsStore] = createStore<SkillsState>({
  skills: [],
  loading: false,
  error: null,
  openDetailId: null,
  byAgent: {},
})

export { skillsStore }

export function setOpenSkillDetailId(id: string | null): void {
  setSkillsStore("openDetailId", id)
}

export async function loadSkills(api: ApiClient, opts?: { ownerAgentId?: string }): Promise<void> {
  const ownerAgentId = opts?.ownerAgentId
  setSkillsStore("loading", true)
  setSkillsStore("error", null)
  try {
    const query = ownerAgentId ? `?ownerAgentId=${encodeURIComponent(ownerAgentId)}` : ""
    const data = (await api.get<SkillRow[]>(`/agent/skills${query}`)) ?? []
    const rows = Array.isArray(data) ? data : []
    if (ownerAgentId) setSkillsStore("byAgent", ownerAgentId, rows)
    else setSkillsStore("skills", rows)
  } catch (err) {
    setSkillsStore("error", err instanceof Error ? err.message : "Failed to load skills")
  } finally {
    setSkillsStore("loading", false)
  }
}

/** The rows one surface reads: an agent's own list, or the flat listing. */
export function skillsForAgent(ownerAgentId?: string): SkillRow[] {
  if (!ownerAgentId) return skillsStore.skills
  return skillsStore.byAgent[ownerAgentId] ?? []
}

/** Apply `fn` to the flat list AND to every per-agent bucket, so a mutation
 *  made on one surface is visible on the other without a refetch. */
function mapEverySkillList(fn: (rows: SkillRow[]) => SkillRow[]): void {
  setSkillsStore("skills", (prev) => fn(prev))
  for (const key of Object.keys(skillsStore.byAgent)) {
    setSkillsStore("byAgent", key, (prev) => fn(prev ?? []))
  }
}

/** The row behind an id, wherever it is cached. */
function findSkillRow(id: string): SkillRow | undefined {
  const flat = skillsStore.skills.find((s) => s.id === id)
  if (flat) return flat
  for (const key of Object.keys(skillsStore.byAgent)) {
    const hit = (skillsStore.byAgent[key] ?? []).find((s) => s.id === id)
    if (hit) return hit
  }
  return undefined
}

export interface CreateSkillInput {
  name: string
  description: string
  body: string
  scope: "user" | "org"
  requiredScopes: string[]
  /** Optional routing domain slug; omitted/empty means general (no domain). */
  domain?: string
  /** Author the skill FOR this agent (P4c-T32b). A15 decides on the server:
   *  a refusal is a 403 `agent_write_forbidden`, never a silent relocation. */
  ownerAgentId?: string
}

export async function createSkill(api: ApiClient, input: CreateSkillInput): Promise<SkillRow> {
  const optimisticId = `optimistic-${Date.now()}`
  const owner = input.ownerAgentId
  const optimistic: SkillRow = {
    id: optimisticId,
    name: input.name,
    description: input.description,
    body: input.body,
    source: input.scope === "org" ? "org" : "personal",
    requiredScopes: input.requiredScopes,
    domain: input.domain && input.domain.length > 0 ? input.domain : null,
    createdByActorType: "user",
    ownerAgentId: owner ?? null,
    canWrite: owner ? true : undefined,
  }
  // The optimistic row lands in the list the caller is looking at.
  if (owner) setSkillsStore("byAgent", owner, (prev) => [optimistic, ...(prev ?? [])])
  else setSkillsStore("skills", (prev) => [optimistic, ...prev])

  try {
    // Map UI "scope" field → API "visibility" field (required by validator).
    // The internal store keeps "scope" so existing UI code is unchanged.
    const payload = {
      name: input.name,
      description: input.description,
      body: input.body,
      requiredScopes: input.requiredScopes,
      visibility: input.scope === "org" ? ("org" as const) : ("personal" as const),
      // Only send domain when set; the backend field is optional and a blank
      // string would fail the slug schema.
      ...(input.domain && input.domain.length > 0 ? { domain: input.domain } : {}),
      ...(owner ? { ownerAgentId: owner } : {}),
    }
    const created = await api.post<SkillRow>("/agent/skills", payload)
    mapEverySkillList((prev) =>
      prev.map((s) =>
        s.id === optimisticId
          ? {
              ...optimistic,
              ...created,
              source: created.source ?? optimistic.source,
              canWrite: created.canWrite ?? optimistic.canWrite,
            }
          : s,
      ),
    )
    return created
  } catch (err) {
    mapEverySkillList((prev) => prev.filter((s) => s.id !== optimisticId))
    throw err
  }
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  body?: string
  requiredScopes?: string[]
  /** Optional routing domain slug; omitted means unchanged. */
  domain?: string
}

export async function updateSkill(
  api: ApiClient,
  id: string,
  input: UpdateSkillInput,
): Promise<SkillRow> {
  const snapshot = findSkillRow(id)
  mapEverySkillList((prev) => prev.map((s) => (s.id === id ? { ...s, ...input } : s)))
  try {
    const updated = await api.put<SkillRow>(`/agent/skills/${id}`, input)
    mapEverySkillList((prev) => prev.map((s) => (s.id === id ? { ...s, ...updated } : s)))
    return updated
  } catch (err) {
    if (snapshot) {
      mapEverySkillList((prev) => prev.map((s) => (s.id === id ? snapshot : s)))
    }
    throw err
  }
}

export async function deleteSkill(api: ApiClient, id: string): Promise<void> {
  const snapshot = findSkillRow(id)
  const owner = snapshot?.ownerAgentId ?? null
  mapEverySkillList((prev) => prev.filter((s) => s.id !== id))
  try {
    await api.delete(`/agent/skills/${id}`)
  } catch (err) {
    if (snapshot) {
      if (owner) setSkillsStore("byAgent", owner, (prev) => [snapshot, ...(prev ?? [])])
      else setSkillsStore("skills", (prev) => [snapshot, ...prev])
    }
    throw err
  }
}

export async function forkSkill(api: ApiClient, id: string, newName?: string): Promise<SkillRow> {
  // Built-in skill ids are 3-segment paths ("built-in/<app>/<name>") and
  // the slashes would otherwise collide with the route's `:id` single-
  // segment match. Encode so the whole id lands in one segment; Hono
  // auto-decodes on the server side.
  const created = await api.post<SkillRow>(
    `/agent/skills/${encodeURIComponent(id)}/fork`,
    newName ? { name: newName } : {},
  )
  setSkillsStore("skills", (prev) => [created, ...prev])
  return created
}

/**
 * Toggle an app-shipped skill on/off for the caller (scope='user') or the org
 * (scope='org'). Updates the `disabled` flag optimistically.
 */
export async function toggleAppSkill(
  api: ApiClient,
  appName: string,
  skillName: string,
  scope: "user" | "org",
): Promise<void> {
  const id = `built-in/${appName}/${skillName}`
  const snapshot = skillsStore.skills.find((s) => s.id === id)
  const prevDisabled = snapshot?.disabled ?? false

  setSkillsStore("skills", (prev) =>
    prev.map((s) => (s.id === id ? { ...s, disabled: !prevDisabled } : s)),
  )

  try {
    await api.post(`/agent/app-skills/${appName}/${skillName}/toggle`, { scope })
  } catch (err) {
    setSkillsStore("skills", (prev) =>
      prev.map((s) => (s.id === id ? { ...s, disabled: prevDisabled } : s)),
    )
    throw err
  }
}

/**
 * WS message handler — when the agent or another tab updates a skill we own,
 * refetch the list. The agent app's `wsMessages` map dispatches here.
 */
export interface SkillUpdatedMessage {
  type: "skill:updated"
  skillId: string
  name?: string
}

/** Module-level handle used by tests + the WS dispatcher to drive refetches. */
let wsApi: ApiClient | null = null
export function bindSkillsWsApi(api: ApiClient): void {
  wsApi = api
}

export function onSkillUpdated(_msg: SkillUpdatedMessage): void {
  if (!wsApi) return
  void loadSkills(wsApi)
  // Every agent bucket already on screen is refreshed too: the frame does not
  // say which agent owns the skill, so the only correct answer is to re-read
  // each list a surface is currently showing.
  for (const ownerAgentId of Object.keys(skillsStore.byAgent)) {
    void loadSkills(wsApi, { ownerAgentId })
  }
}

export function resetSkillsStore(): void {
  setSkillsStore({ skills: [], loading: false, error: null, openDetailId: null, byAgent: {} })
}

onSessionTeardown(resetSkillsStore)
