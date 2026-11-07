// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ManifestHandlerRef } from "~/modules/apps/app-registries"
import { executeInSandbox, resolveToolTimeoutMs } from "~/modules/apps/sandbox/executor"
import { getSandboxPool } from "~/modules/apps/sandbox/pool"
import { getWorkerPool, initWorkerPool } from "~/modules/apps/sandbox/worker-pool"

/**
 * What a declared budget leaves for waiting on a pinned slot and answering. The
 * manifest maximum (29 s, 1 s under the default request ceiling of 30 s) is what
 * keeps the two apart; see `deliveryBudget`.
 */
const ANSWER_MARGIN_MS = 1_000

/**
 * A primary delivery's budget, or null when the handler declares none. The run
 * goes through the tools' resolver (instance ceiling included) and fits inside
 * REQUEST_TIMEOUT_MS, the ceiling every request of this server works under: a
 * provider is still on the line. `slotWaitMs` is what is left of that ceiling
 * for the pinned slot such a handler waits for.
 */
export function deliveryBudget(
  declared: number | undefined,
  requestTimeoutMs: number,
): { timeoutMs: number; slotWaitMs: number } | null {
  const resolved = resolveToolTimeoutMs(declared)
  if (resolved === undefined) return null
  const timeoutMs = Math.max(1_000, Math.min(resolved, requestTimeoutMs - ANSWER_MARGIN_MS))
  return { timeoutMs, slotWaitMs: Math.max(0, requestTimeoutMs - timeoutMs) }
}

interface ExecuteManifestWebhookOptions {
  /** The manifest\'s budget for one run of this handler; unset keeps the sandbox default. */
  timeoutMs?: number
  /** The app the handler belongs to: an org's custom app counts against its org's sandbox share. */
  appName: string
  handlerRef: ManifestHandlerRef
  bundleSource: string
  params: unknown
  bridge: Record<string, (...args: any[]) => any>
  /**
   * Extra positional args appended after `(params, ctx)` when invoking
   * the handler. Manifest webhook handlers declare a 3-arg signature
   * `(payload, ctx, headers)` per the SDK — the webhook router passes
   * the inbound HTTP headers here so the bundle can read e.g.
   * `x-shopify-webhook-id` for dedup.
   */
  extraArgs?: unknown[]
}

export async function executeManifestWebhook({
  appName,
  handlerRef,
  bundleSource,
  params,
  bridge,
  extraArgs,
  timeoutMs,
}: ExecuteManifestWebhookOptions): Promise<unknown> {
  if (handlerRef.trusted) {
    return executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: handlerRef.exportName,
      params,
      bridge,
      extraArgs,
      ...(timeoutMs ? { timeoutMs } : {}),
    })
  }

  await initWorkerPool()
  return getWorkerPool().execute({
    bundleSource,
    exportName: handlerRef.exportName,
    params,
    bridge,
    extraArgs,
    // Webhook handlers are external-triggered background work; they must not
    // starve foreground (user/agent) tool calls under load (worker-pool reserves
    // capacity for interactive execs).
    priority: "background",
    appId: appName,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}
