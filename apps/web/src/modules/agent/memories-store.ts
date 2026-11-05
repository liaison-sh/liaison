// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent user-memory store. Mirrors the shape of `routines-store` /
 * `skills-store`: module-level singleton, `load*(api)` + mutation helpers
 * that hit `/api/agent/memories*` and update the store in place.
 *
 * Its reader is the agent page's Memory tab (`MemoryTree`, P4c FX-F1): the
 * typed memory rows it resolves `[[name]]` against, and the create and delete
 * calls the per agent tree surface itself does not carry.
 */
import type { MemoryEntry, MemoryType } from "@liaison/shared"
import { createStore } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface MemoriesState {
  memories: MemoryEntry[]
  loading: boolean
  error: string | null
}

const [memoriesStore, setMemoriesStore] = createStore<MemoriesState>({
  memories: [],
  loading: false,
  error: null,
})

export { memoriesStore }

export async function loadMemories(api: ApiClient): Promise<void> {
  setMemoriesStore("loading", true)
  setMemoriesStore("error", null)
  try {
    const data = (await api.get<MemoryEntry[]>("/agent/memories")) ?? []
    setMemoriesStore("memories", Array.isArray(data) ? data : [])
  } catch (err) {
    setMemoriesStore("error", err instanceof Error ? err.message : "Failed to load memories")
  } finally {
    setMemoriesStore("loading", false)
  }
}

export interface CreateMemoryInput {
  type: MemoryType
  name: string
  description: string
  content: string
}

export async function createMemory(api: ApiClient, input: CreateMemoryInput): Promise<MemoryEntry> {
  const created = await api.post<MemoryEntry>("/agent/memories", input)
  setMemoriesStore("memories", (prev) => [
    created,
    ...prev.filter((m) => !(m.type === created.type && m.name === created.name)),
  ])
  return created
}

export async function deleteMemory(api: ApiClient, type: string, name: string): Promise<void> {
  const snapshot = memoriesStore.memories.find((m) => m.type === type && m.name === name)
  setMemoriesStore("memories", (prev) => prev.filter((m) => !(m.type === type && m.name === name)))
  try {
    await api.delete(`/agent/memories/${type}/${name}`)
  } catch (err) {
    if (snapshot) setMemoriesStore("memories", (prev) => [snapshot, ...prev])
    throw err
  }
}

export function resetMemoriesStore(): void {
  setMemoriesStore({ memories: [], loading: false, error: null })
}

onSessionTeardown(resetMemoriesStore)
