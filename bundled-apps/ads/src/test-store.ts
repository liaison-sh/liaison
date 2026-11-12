// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ads suite's in-memory `ctx.store` (versioned documents, `ifVersion`
// conflicts like the bridge) and a `ctx.timers` that records its wake-ups.

export interface MemoryStoreDoc {
  id: string
  data: unknown
  version: number
  updatedAt: string
}

export function createMemoryStore() {
  const docs = new Map<string, MemoryStoreDoc>()
  const k = (c: string, id: string) => `${c}/${id}`
  const conflict = () =>
    Object.assign(new Error("version_conflict"), { code: "version_conflict", status: 409 })
  return {
    docs,
    async get<T = Record<string, unknown>>(
      c: string,
      id: string,
    ): Promise<(MemoryStoreDoc & { data: T }) | null> {
      const d = docs.get(k(c, id))
      return d ? (structuredClone(d) as MemoryStoreDoc & { data: T }) : null
    },
    async set(c: string, id: string, data: unknown, opts?: { ifVersion?: number }) {
      const cur = docs.get(k(c, id))
      if (opts?.ifVersion !== undefined && (cur?.version ?? 0) !== opts.ifVersion) throw conflict()
      const d = {
        id,
        data: structuredClone(data),
        version: (cur?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      }
      docs.set(k(c, id), d)
      return structuredClone(d)
    },
    async delete(c: string, id: string) {
      return { deleted: docs.delete(k(c, id)) }
    },
  }
}

export function createRecordingTimers() {
  const wakes: Array<{ seconds: number; job: string; payload: unknown; jobId?: string }> = []
  return {
    wakes,
    async wakeIn(
      seconds: number,
      job: string,
      payload?: Record<string, unknown>,
      opts?: { jobId?: string },
    ) {
      wakes.push({ seconds, job, payload, ...(opts?.jobId ? { jobId: opts.jobId } : {}) })
    },
  }
}
