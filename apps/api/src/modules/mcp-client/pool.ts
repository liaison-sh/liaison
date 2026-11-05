// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Single-flight connection pool with idle reap + dial backoff.
//
// Owns the lifecycle of one live MCP transport per `connectionId`:
//   - get(id): returns cached live conn; if absent, dials (single-flighted)
//   - reapIdle(): closes any live conn untouched for > idleMs
//   - drop(id): explicit close + evict (e.g. after a connection is disabled)
//
// Tests pass a mock `dial` + `clock` so the pool is fully deterministic; in
// production, `dial` wraps the MCP transport handshake from `mcp-client/transports`.

export interface PooledLive {
  /** Stable identifier for assertions; live transport object is opaque. */
  id: string
  close: () => Promise<void>
}

export type Dial<T extends PooledLive = PooledLive> = (connectionId: string) => Promise<T>

export interface ConnectionPoolOptions<T extends PooledLive = PooledLive> {
  dial: Dial<T>
  /** Reap entries whose `lastUsedAt` is older than this many ms. */
  idleMs: number
  /** Injectable clock for deterministic tests. */
  clock: () => number
  /**
   * Backoff schedule. Length = max dial attempts. Defaults to a 250ms / 1s /
   * 4s / 16s / 30s ramp; tests typically override with `[1, 1, …]`.
   */
  backoffMs?: number[]
  /**
   * Whether a dial failure is worth retrying. A refused credential (401) is
   * not: retrying it only delays the refresh that can fix it. Default: all.
   */
  retryable?: (err: unknown) => boolean
}

interface CacheEntry<T extends PooledLive> {
  conn: T
  lastUsedAt: number
}

export class ConnectionPool<T extends PooledLive = PooledLive> {
  private readonly live = new Map<string, CacheEntry<T>>()
  private readonly inflight = new Map<string, Promise<T>>()
  private reapHandle: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: ConnectionPoolOptions<T>) {}

  /**
   * Acquire a live connection. Production tool calls absorb transient blips
   * via the backoff ramp (default 250ms → 30s). Admin-initiated interactive
   * paths (e.g. the "test connection" wizard click) pass `{ backoff: false }`
   * so a transient dial failure surfaces immediately — silently retrying
   * through 51 seconds of backoff would hang the UI.
   *
   * Honours cache + single-flight either way: concurrent callers dial once.
   * On failure with `backoff: false`: throws the original error; does NOT
   * seed the cache, so a retry truly re-dials.
   */
  async get(connectionId: string, opts: { backoff?: boolean } = {}): Promise<T> {
    return this.acquire(connectionId, opts.backoff !== false)
  }

  private acquire(connectionId: string, withBackoff: boolean): Promise<T> {
    const cached = this.live.get(connectionId)
    if (cached) {
      cached.lastUsedAt = this.opts.clock()
      return Promise.resolve(cached.conn)
    }
    const inflight = this.inflight.get(connectionId)
    if (inflight) return inflight

    const dial = withBackoff ? this.dialWithBackoff(connectionId) : this.opts.dial(connectionId)
    const promise = dial
      .then((conn) => {
        this.live.set(connectionId, { conn, lastUsedAt: this.opts.clock() })
        return conn
      })
      .finally(() => {
        this.inflight.delete(connectionId)
      })

    this.inflight.set(connectionId, promise)
    return promise
  }

  /**
   * Closes (best-effort) any entry whose lastUsedAt is older than idleMs and
   * evicts it from the cache. Safe to call multiple times — already-reaped
   * entries are no-ops (no double-close).
   */
  reapIdle(): void {
    const now = this.opts.clock()
    for (const [id, entry] of this.live.entries()) {
      if (now - entry.lastUsedAt > this.opts.idleMs) {
        // Delete first, close after — protects against re-entrant reaps double-closing.
        this.live.delete(id)
        entry.conn.close().catch(() => {})
      }
    }
  }

  /**
   * Owned-timer API so initMcpClient (boot wiring, Task 27) doesn't have to
   * wire setInterval itself. The timer is `.unref()`'d so the process can
   * exit cleanly without an explicit `stopReapTimer()` call.
   */
  startReapTimer(intervalMs: number): void {
    if (this.reapHandle) return
    this.reapHandle = setInterval(() => this.reapIdle(), intervalMs)
    const h = this.reapHandle as unknown as { unref?: () => void }
    if (typeof h.unref === "function") h.unref()
  }

  stopReapTimer(): void {
    if (this.reapHandle) {
      clearInterval(this.reapHandle)
      this.reapHandle = null
    }
  }

  /** Force-close + evict a specific connection (e.g. on disable / delete). */
  async drop(connectionId: string): Promise<void> {
    const entry = this.live.get(connectionId)
    if (entry) {
      this.live.delete(connectionId)
      await entry.conn.close().catch(() => {})
    }
  }

  /** Force-close everything; intended for shutdown / test cleanup. */
  async drainAll(): Promise<void> {
    const entries = Array.from(this.live.values())
    this.live.clear()
    await Promise.allSettled(entries.map((e) => e.conn.close()))
  }

  /** Currently-live connection count (test-only introspection). */
  size(): number {
    return this.live.size
  }

  private async dialWithBackoff(connectionId: string): Promise<T> {
    const delays = this.opts.backoffMs ?? [250, 1000, 4000, 16000, 30000]
    let lastErr: unknown
    for (let i = 0; i < delays.length; i++) {
      try {
        return await this.opts.dial(connectionId)
      } catch (err) {
        lastErr = err
        if (this.opts.retryable && !this.opts.retryable(err)) throw err
        if (i < delays.length - 1) {
          await new Promise((r) => setTimeout(r, delays[i]))
        }
      }
    }
    throw new Error(
      `dial exhausted after ${delays.length} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
    )
  }
}
