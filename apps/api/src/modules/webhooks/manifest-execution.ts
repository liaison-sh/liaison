// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ManifestHandlerRef } from "~/modules/apps/app-registries"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool } from "~/modules/apps/sandbox/pool"
import { getWorkerPool, initWorkerPool } from "~/modules/apps/sandbox/worker-pool"

interface ExecuteManifestWebhookOptions {
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
  handlerRef,
  bundleSource,
  params,
  bridge,
  extraArgs,
}: ExecuteManifestWebhookOptions): Promise<unknown> {
  if (handlerRef.trusted) {
    return executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: handlerRef.exportName,
      params,
      bridge,
      extraArgs,
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
  })
}
