// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface AgentReference {
  id: string
  app: string
  entityType: string
  entityId: string
  tabType: string
  label: string
  icon: string
  lastVisitedAt: string
}

type AgentReferenceState = {
  items: AgentReference[]
  threadId: string | null
  loading: boolean
}

const [state, setState] = createStore<AgentReferenceState>({
  items: [],
  threadId: null,
  loading: false,
})

let timer: ReturnType<typeof setTimeout> | null = null

async function load(api: ApiClient, threadId: string): Promise<void> {
  const requestedThreadId = threadId
  setState({ threadId, loading: true })
  try {
    const res = await api.getEnvelope<{ items: AgentReference[] }>(
      `/threads/${threadId}/references`,
    )
    // Drop the response if the active chat changed while we were waiting.
    if (state.threadId !== requestedThreadId) return
    setState({ items: res.data.items ?? [], threadId, loading: false })
  } catch {
    if (state.threadId !== requestedThreadId) return
    setState("loading", false)
  }
}

function markStaleAndReload(api: ApiClient): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    if (state.threadId) void load(api, state.threadId)
  }, 250)
}

function clear(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  setState({ items: [], threadId: null, loading: false })
}

export function resetAgentReferenceStore(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  setState({ items: [], threadId: null, loading: false })
}

onSessionTeardown(resetAgentReferenceStore)

export const agentReferenceStore = {
  get items() {
    return state.items
  },
  get threadId() {
    return state.threadId
  },
  get loading() {
    return state.loading
  },
  load,
  markStaleAndReload,
  clear,
  _setForTest(s: Partial<AgentReferenceState>) {
    setState(s)
  },
}
