// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The loader's side of a bridge call: per-run stats keyed by the run's
// execNonce (read and dropped by the /run handler), and the call itself
// (bridge-reply.ts). A host binds `callBridge` into whatever capability it
// hands the isolate (a WorkerEntrypoint on Workers, an RPC stub in workerd, a
// plain object in a test).
import { type BridgeFetch, type BridgeReply, bridgeCall } from "./bridge-reply"

export interface BridgeProps {
  bridgeUrl: string
  runToken: string
  runId: string
  execNonce: string
  bridgeMethods: string[]
}

export type BridgeResult = BridgeReply
export type FetchLike = BridgeFetch

/** Per-run bridge stats, keyed by execNonce. */
export const runStats = new Map<string, { calls: number; ms: number }>()

export function callBridge(
  props: BridgeProps,
  method: string,
  args: unknown,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
  now: () => number = () => Date.now(),
  onResponseText?: (text: string) => void,
): Promise<BridgeResult> {
  return bridgeCall(props, method, args, {
    fetch: fetchImpl,
    now,
    stats: runStats.get(props.execNonce),
    ...(onResponseText ? { onResponseText } : {}),
  })
}
