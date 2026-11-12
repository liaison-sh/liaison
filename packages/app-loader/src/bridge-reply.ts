// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One app bridge call as the app loader makes it: the request it sends and how
// the cell's answer becomes the isolate's reply. Every loader host (Workers,
// workerd, the test stand-in) runs this one module. Standalone: no imports, no
// platform APIs beyond fetch and crypto.randomUUID.
//
// Request: POST props.bridgeUrl with `authorization: Bearer <runToken>`,
// `x-exec-nonce: <execNonce>`, body `{callId, method, args}`. A method outside
// props.bridgeMethods is refused without a request.
//
// Reply (what the isolate's bridge.call resolves with, never throws):
//   {data}                                   cell 2xx with a `data` field
//   {data: undefined}                        cell 2xx with a JSON object and no `data`
//   {error, errorStatus, errorCode?}         cell JSON `{error}` (any status);
//                                            errorCode from `errorCode`, else `reason`
//   {error: reason, errorStatus, errorCode}  cell JSON `{reason}` only
//   errorCode "unknown_method"      404     method not listed for the run
//   errorCode "bridge_bad_response" status  anything else (502 when status < 400)
//   errorCode "bridge_unreachable"  502     the request itself failed
// Vectors: test/bridge-reply-vectors.json.

export const BRIDGE_REPLY_VERSION = 1

export interface BridgeCallProps {
  bridgeUrl: string
  runToken: string
  execNonce: string
  bridgeMethods: string[]
}

export type BridgeReply =
  | { data: unknown }
  | { error: string; errorStatus: number; errorCode?: string }

export type BridgeFetch = (url: string, init: RequestInit) => Promise<Response>

export interface BridgeCallOptions {
  fetch?: BridgeFetch
  now?: () => number
  /** Counted only when a request was sent (an unknown method is not a call). */
  stats?: { calls: number; ms: number }
  /** Sees every answer body the cell sent (e.g. a test's secret scan). */
  onResponseText?: (text: string) => void
  callId?: () => string
}

export function bridgeRequestInit(
  props: BridgeCallProps,
  callId: string,
  method: string,
  args: unknown,
): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${props.runToken}`,
      "x-exec-nonce": props.execNonce,
      "content-type": "application/json",
    },
    body: JSON.stringify({ callId, method, args }),
  }
}

export function unknownMethodReply(method: unknown): BridgeReply {
  return {
    error: `Unknown bridge method: ${String(method)}`,
    errorStatus: 404,
    errorCode: "unknown_method",
  }
}

export function bridgeUnreachableReply(err: unknown): BridgeReply {
  const message = err instanceof Error ? err.message : String(err)
  return {
    error: `Bridge unreachable: ${message}`,
    errorStatus: 502,
    errorCode: "bridge_unreachable",
  }
}

/** The cell's HTTP answer (status + body text) as the isolate's reply. */
export function bridgeReplyFromHttp(status: number, text: string): BridgeReply {
  const ok = status >= 200 && status < 300
  let body: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed
  } catch {}
  if (ok && body && "data" in body) return { data: body.data }
  if (body && typeof body.error === "string") {
    const errorStatus = typeof body.errorStatus === "number" ? body.errorStatus : status
    const out: BridgeReply = { error: body.error, errorStatus }
    if (typeof body.errorCode === "string") out.errorCode = body.errorCode
    else if (typeof body.reason === "string") out.errorCode = body.reason
    return out
  }
  if (body && typeof body.reason === "string") {
    return { error: body.reason, errorStatus: status, errorCode: body.reason }
  }
  // A bare `{}` 2xx is the cell's JSON for an undefined result.
  if (ok && body) return { data: undefined }
  return {
    error: `Bridge returned ${status}`,
    errorStatus: status >= 400 ? status : 502,
    errorCode: "bridge_bad_response",
  }
}

export async function bridgeCall(
  props: BridgeCallProps,
  method: unknown,
  args: unknown,
  opts: BridgeCallOptions = {},
): Promise<BridgeReply> {
  if (typeof method !== "string" || !props.bridgeMethods.includes(method)) {
    return unknownMethodReply(method)
  }
  const doFetch: BridgeFetch = opts.fetch ?? ((u, i) => fetch(u, i))
  const now = opts.now ?? Date.now
  const callId = opts.callId ? opts.callId() : crypto.randomUUID()
  const t0 = now()
  try {
    const res = await doFetch(props.bridgeUrl, bridgeRequestInit(props, callId, method, args))
    const text = await res.text()
    opts.onResponseText?.(text)
    return bridgeReplyFromHttp(res.status, text)
  } catch (e) {
    return bridgeUnreachableReply(e)
  } finally {
    if (opts.stats) {
      opts.stats.calls++
      opts.stats.ms += now() - t0
    }
  }
}
