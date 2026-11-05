// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-app RPC bridge extensions.
//
// The generic sandbox bridge (`rpc-bridge.ts`) exposes capability-gated kernel
// primitives (`messages.post`, `sequences.allocate`, `pdf.render`, …) that any
// app may call. App-SPECIFIC operations — a connector's REST calls, an app's
// own search/projection helpers — do not belong on the generic surface and must
// not make the kernel branch on app-name literals. Instead an app registers a
// bridge-extension factory at install time; `createRpcBridge` merges the
// resulting methods into the bridge it hands a sandbox of THAT app only.
//
// The factory receives a small, stable {@link BridgeExtensionContext} (the same
// ambient RLS transaction + identity the inline methods closed over) and returns
// a flat record of `name -> async (paramsJson) => string` methods, matching the
// RPC dispatch shape the executor/worker-pool expect.

import type { RlsClient } from "~/db"
import { createTypedRegistry } from "~/modules/apps/registries"

/**
 * Ambient context handed to a bridge-extension factory. Mirrors the closure the
 * generic bridge already provides to its inline methods: the per-request RLS
 * transaction, the org/user identity, the calling app name, and the resolved
 * actor type for event attribution.
 */
export interface BridgeExtensionContext {
  appName: string
  orgId: string
  userId: string
  txDb: RlsClient
  actorType: "user" | "agent" | "system" | "mcp"
  /** The calling actor's scopes, when the dispatch carried them (undefined for
   *  host-initiated runs such as event handlers). Lets an app gate a method on
   *  a PARAM-dependent scope that the tool-level scope cannot express. */
  callerScopes?: string[]
  /** The dispatch's cancellation signal, when it carried one: host-side work a
   *  method started should stop when it fires. */
  signal?: AbortSignal
}

/** An RPC bridge method: takes the JSON-encoded params, returns a JSON string. */
export type BridgeExtensionMethod = (paramsJson: string) => Promise<string>

/** Factory producing an app's bridge methods from the per-request context. */
export type BridgeExtensionFactory = (
  ctx: BridgeExtensionContext,
) => Record<string, BridgeExtensionMethod>

/**
 * Per-app bridge-extension factories, keyed by [orgId, appName]. Registered at
 * app-install time; read by `createRpcBridge` to merge an app's own methods into
 * its sandbox bridge. The wildcard org `"*"` registers in-tree app extensions
 * that apply to every org.
 */
export const appBridgeExtensionRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  BridgeExtensionFactory
>()

/**
 * Resolves the extension methods for `(orgId, appName)`, preferring an org-scoped
 * registration and falling back to the wildcard one. Returns an empty record when
 * no extension is registered.
 */
export function buildBridgeExtensions(
  ctx: BridgeExtensionContext,
): Record<string, BridgeExtensionMethod> {
  const factory =
    appBridgeExtensionRegistry.get([ctx.orgId, ctx.appName]) ??
    appBridgeExtensionRegistry.get(["*", ctx.appName])
  if (!factory) return {}
  return factory(ctx)
}
