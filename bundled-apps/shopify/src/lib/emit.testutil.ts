// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-fidelity helper for Cluster-1 (canonical event identity).
//
// The mocks in mutations.test / webhooks.test / job tests historically used a
// PERMISSIVE `ctx.emit` that recorded whatever it was given. That is exactly
// why the namespaced-token drift shipped: nothing in the unit tests enforced
// the kernel's real contract.
//
// The kernel enforces, at the sandbox bridge (rpc-bridge.ts) AND the outbox
// publish guard (event-bus.ts), that the emitted `${entity}:${action}` key is
// a member of the app's declared `events.emits`, and composes the realtime
// channel as `events:${app}:${entity}:${action}`. This helper reproduces that
// guard from the REAL `app.manifest.json`, so any future drift between an emit
// call site and the manifest fails the unit test instead of silently dropping
// the event at runtime.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AppContext } from "@liaison/app-sdk"

export interface RecordedEmit {
  entity: string
  action: string
  entityId?: string
  data?: unknown
  metadata?: Record<string, unknown>
}

// Mirrors apps/api/src/lib/redis.ts: REDIS_PREFIX defaults to "" (it is only
// set for E2E worker isolation, e.g. "w0:"). Honour the same env var so the
// composed channel matches the kernel exactly under any harness.
const REDIS_PREFIX = process.env.REDIS_PREFIX ?? ""

/** Compose the realtime channel exactly as event-bus.ts:channelName does. */
export function channelName(app: string, entity: string, action: string): string {
  return `${REDIS_PREFIX}events:${app}:${entity}:${action}`
}

let cachedEmits: Set<string> | null = null

/** Load `events.emits` from the real Shopify app.manifest.json. */
export function loadDeclaredEmits(): Set<string> {
  if (cachedEmits) return cachedEmits
  const manifestPath = join(import.meta.dir, "..", "..", "app.manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    events?: { emits?: string[] }
  }
  cachedEmits = new Set(manifest.events?.emits ?? [])
  return cachedEmits
}

/**
 * Build an enforcing `ctx.emit` that mirrors the kernel guard. Throws (like
 * rpc-bridge.ts) when `${entity}:${action}` is not in the manifest's declared
 * emits — so a unit test that drives a real handler asserts against the REAL
 * contract, not the implementation's shape.
 *
 * Returns the recorder and the bound emit fn; pass `emit` into the test ctx.
 */
export function createEnforcingEmit(opts?: { app?: string; failNext?: () => boolean }): {
  emit: AppContext["emit"]
  emits: RecordedEmit[]
  channels: string[]
} {
  const app = opts?.app ?? "shopify"
  const declared = loadDeclaredEmits()
  const emits: RecordedEmit[] = []
  const channels: string[] = []
  const emit = (async (ev: RecordedEmit) => {
    if (opts?.failNext?.()) {
      throw new Error("downstream emit failed")
    }
    const eventKey = `${ev.entity}:${ev.action}`
    if (!declared.has(eventKey)) {
      throw new Error(
        `App "${app}" emitted undeclared event "${eventKey}" (not in app.manifest.json#events.emits)`,
      )
    }
    emits.push(ev)
    channels.push(channelName(app, ev.entity, ev.action))
  }) as AppContext["emit"]
  return { emit, emits, channels }
}
