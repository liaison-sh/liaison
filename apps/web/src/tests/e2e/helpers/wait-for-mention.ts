// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 10 search indexing is async: writes → outbox → durable consumer →
// BullMQ → Meili. Mention/search tests must poll `/api/mentions` after seeding
// to confirm the document is indexed before driving the UI. Without this the
// autocomplete popup never opens, even when the underlying data exists.

interface WaitOpts {
  /** Bearer token */
  token: string
  /** API base URL (e.g. env.serverUrl) */
  serverUrl: string
  /** Query string passed to /api/mentions */
  query: string
  /** Predicate that returns true when the indexer has caught up */
  predicate: (row: Record<string, unknown>) => boolean
  /** Optional type filter (matches the route's `type` query param) */
  type?: "user" | "entity" | "thread"
  timeoutMs?: number
  intervalMs?: number
}

/**
 * Poll `/api/mentions` until `predicate` returns true (Meili surfaces the
 * expected document) or the timeout elapses. Returns the matched row, or null
 * if the timeout fires first.
 */
export async function waitForMentionIndex(opts: WaitOpts): Promise<Record<string, unknown> | null> {
  const { token, serverUrl, query, predicate, type, timeoutMs = 30_000, intervalMs = 250 } = opts
  const deadline = Date.now() + timeoutMs
  const params = new URLSearchParams({ q: query, limit: "20" })
  if (type) params.set("type", type)
  const url = `${serverUrl}/api/mentions?${params.toString()}`
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).catch(
      () => null,
    )
    if (res?.status === 200) {
      const body = (await res.json().catch(() => null)) as { data?: any[] } | null
      const rows = body?.data ?? []
      const hit = rows.find((r) => predicate(r))
      if (hit) return hit
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}
