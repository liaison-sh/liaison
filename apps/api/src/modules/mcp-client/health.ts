// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In-memory health cache + privileged writer for `mcp_connection_health`.
//
// Used by the per-call orchestrator (Task 17) to record dial outcomes and by
// `buildToolSet` (Task 26) to filter unreachable MCP tools from the agent's
// outbound tool list. The "disabled" state is NOT owned here — that's
// `mcp_connections.disabled`, toggled by the manager-app's enable/disable
// routes (Task 19). Single source of truth, spec §3.4.

import type { HealthRow, McpRepo } from "~/apps/mcp-manager/types"
import { extendDemoOrgOnMcpConnected } from "~/modules/demo/demo-connected-ttl"
import { getHealthGate } from "./health-gate"

export type HealthStatus = HealthRow["status"]

interface CacheEntry {
  status: HealthStatus
  consecutiveFailures: number
}

export class HealthTracker {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly repo: McpRepo) {}

  /**
   * Successful handshake / call → reset counter, status = connected. A row in
   * `needs_reauth` stays there: after a 403 insufficient_scope the token still
   * works for other tools, and the "Sign in again" the person owes must not be
   * hidden by them. Only a new sign-in clears it (`clearNeedsReauth`).
   */
  async markConnected(connectionId: string): Promise<void> {
    const wasConnected = this.cache.get(connectionId)?.status === "connected"
    const now = new Date()
    const status =
      (await this.repo.recordHealth(
        connectionId,
        {
          status: "connected",
          consecutiveFailures: 0,
          lastHandshakeAt: now,
          lastError: null,
        },
        { keepNeedsReauth: true },
      )) ?? "connected"
    this.cache.set(connectionId, { status, consecutiveFailures: 0 })
    getHealthGate().setHealthStatus(connectionId, status)
    // A demo visitor workspace that reached a real MCP server lives longer.
    // Only on the move to connected (not every call), and a no-op without
    // demo mode; it never throws.
    if (!wasConnected && status === "connected") await extendDemoOrgOnMcpConnected(connectionId)
  }

  /** A new sign-in (or new credentials): back to idle until the next call. */
  async clearNeedsReauth(connectionId: string): Promise<void> {
    await this.repo.recordHealth(connectionId, {
      status: "idle",
      lastError: null,
      consecutiveFailures: 0,
    })
    this.cache.set(connectionId, { status: "idle", consecutiveFailures: 0 })
    getHealthGate().setHealthStatus(connectionId, "idle")
  }

  /** Transport dial failed (network, refused, timeout). */
  async markDialFailed(connectionId: string, err: Error): Promise<void> {
    const prev = this.cache.get(connectionId)?.consecutiveFailures ?? 0
    const nextCount = prev + 1
    await this.repo.recordHealth(connectionId, {
      status: "down",
      consecutiveFailures: nextCount,
      lastError: err.message,
      lastErrorAt: new Date(),
    })
    this.cache.set(connectionId, { status: "down", consecutiveFailures: nextCount })
    getHealthGate().setHealthStatus(connectionId, "down")
  }

  /** Server returned a non-transport-level error (handshake worked, call failed). */
  async markFailed(connectionId: string, err: Error): Promise<void> {
    const prev = this.cache.get(connectionId)?.consecutiveFailures ?? 0
    const nextCount = prev + 1
    await this.repo.recordHealth(connectionId, {
      status: "failed",
      consecutiveFailures: nextCount,
      lastError: err.message,
      lastErrorAt: new Date(),
    })
    this.cache.set(connectionId, { status: "failed", consecutiveFailures: nextCount })
    getHealthGate().setHealthStatus(connectionId, "failed")
  }

  /** OAuth refresh failed / 401-on-refresh — UI must surface a re-consent prompt. */
  async markNeedsReauth(connectionId: string, reason: string): Promise<void> {
    await this.repo.recordHealth(connectionId, {
      status: "needs_reauth",
      lastError: reason,
      lastErrorAt: new Date(),
    })
    // Don't reset consecutiveFailures — re-auth doesn't change the failure count;
    // a successful markConnected after re-auth will reset it.
    const prev = this.cache.get(connectionId)?.consecutiveFailures ?? 0
    this.cache.set(connectionId, { status: "needs_reauth", consecutiveFailures: prev })
    getHealthGate().setHealthStatus(connectionId, "needs_reauth")
  }

  /** Drop the cached entry (the row was reset elsewhere, e.g. by a sign-in). */
  forget(connectionId: string): void {
    this.cache.delete(connectionId)
  }

  /** Test/runtime introspection — used by `buildToolSet` (Task 26). */
  getCachedStatus(connectionId: string): HealthStatus | null {
    return this.cache.get(connectionId)?.status ?? null
  }
}
