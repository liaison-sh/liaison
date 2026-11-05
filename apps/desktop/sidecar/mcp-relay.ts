// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host's own way into the Liaison tool catalog, with the SESSION's token.
// The webview has no Liaison credential of its own for a local session: the
// agent scoped token lives in the 0600 MCP config the shell wrote and in this
// process, so a tool the host wants to call (the approval poller, "attach this
// turn to Liaison") is relayed through here rather than handing the token out.
//
// The smallest correct client, and deliberately not an MCP SDK dependency.
// Liaison's own gateway (apps/api/src/modules/mcp/transport-routes.ts) runs
// the streamable HTTP transport STATELESS: `sessionIdGenerator: undefined`, a
// fresh server per request. So there is no `Mcp-Session-Id` to carry and no
// initialize handshake to do first: an initialize would be answered by a
// server instance that is thrown away before the next request arrives. One
// POST carrying one JSON-RPC request is the whole protocol here.
//
// The transport answers with `text/event-stream` unless it is configured for
// JSON responses, so both framings are read.

import type { McpConfigFile } from "./index"

export interface McpRelayError {
  message: string
  status?: number
}

export interface McpRelayOutcome {
  result?: unknown
  error?: McpRelayError
}

/** What the host sends with an `mcp_call` line, answered with `mcp_result`. */
export type McpRelay = (tool: string, args: Record<string, unknown>) => Promise<McpRelayOutcome>

interface JsonRpcAnswer {
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/** The first JSON-RPC object in an SSE body, whatever the event names are. */
export function parseSseAnswer(body: string): JsonRpcAnswer | null {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      return JSON.parse(payload) as JsonRpcAnswer
    } catch {
      // A data line that is not JSON belongs to some other event; keep reading.
    }
  }
  return null
}

/**
 * How long one relayed tool call may take. A relay that never answers is a
 * host waiting forever for an mcp_result, which looks to the user like an
 * approval poll that simply stopped.
 */
export const MCP_RELAY_TIMEOUT_MS = 20_000

export async function callMcpTool(
  mcp: McpConfigFile,
  tool: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = MCP_RELAY_TIMEOUT_MS,
): Promise<McpRelayOutcome> {
  // EVERY await lives in here. Reading the body is a second await over the
  // same connection and it fails on its own, and the host fires this call and
  // forgets it, so anything that escapes is an unhandled rejection with no
  // mcp_result behind it.
  try {
    const response = await fetchImpl(mcp.liaisonMcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcp.agentScopedToken}`,
        "Content-Type": "application/json",
        // Both framings are accepted, because which one comes back is the
        // server's choice and not this client's.
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const text = await response.text()
    if (!response.ok) {
      return {
        error: { message: text.slice(0, 500) || response.statusText, status: response.status },
      }
    }
    const contentType = response.headers.get("content-type") ?? ""
    let answer: JsonRpcAnswer | null
    if (contentType.includes("text/event-stream")) {
      answer = parseSseAnswer(text)
    } else {
      try {
        answer = JSON.parse(text) as JsonRpcAnswer
      } catch {
        answer = null
      }
    }
    if (!answer) {
      return { error: { message: `unreadable MCP answer: ${text.slice(0, 200)}` } }
    }
    if (answer.error) {
      return { error: { message: answer.error.message ?? `MCP error ${answer.error.code}` } }
    }
    return { result: answer.result }
  } catch (error) {
    const failure = error as Error
    // An aborted request reads as a DOMException with no useful message, so
    // the deadline is named rather than left for the host to guess at.
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      return { error: { message: `MCP call timed out after ${timeoutMs} ms` } }
    }
    return { error: { message: failure.message || String(failure) } }
  }
}

/**
 * Where the relay gets the token for one call: the current one, or (`force`) a
 * renewed one. `mcp-token.ts` `freshToken` over the session's config file.
 */
export type TokenFor = (force: boolean) => Promise<string>

/**
 * The relay one session runs with, bound to that session's own token. With a
 * `tokenFor`, the token is read (and renewed when it is close to expiry) on
 * every call rather than once at spawn, and a 401 is answered by renewing it
 * and trying ONCE more: the same thing the CLI does for the model's own calls
 * through the headers helper. Without one, the token the file was read with.
 */
export function relayFor(
  mcp: McpConfigFile,
  tokenFor?: TokenFor,
  fetchImpl: typeof fetch = fetch,
): McpRelay {
  if (!tokenFor) return (tool, args) => callMcpTool(mcp, tool, args, fetchImpl)
  const withToken = async (force: boolean): Promise<McpConfigFile | McpRelayOutcome> => {
    try {
      return { ...mcp, agentScopedToken: await tokenFor(force) }
    } catch (error) {
      return { error: { message: (error as Error).message || String(error) } }
    }
  }
  return async (tool, args) => {
    const first = await withToken(false)
    if (!("agentScopedToken" in first)) return first
    const outcome = await callMcpTool(first, tool, args, fetchImpl)
    if (outcome.error?.status !== 401) return outcome
    const renewed = await withToken(true)
    if (!("agentScopedToken" in renewed)) return outcome
    return callMcpTool(renewed, tool, args, fetchImpl)
  }
}
