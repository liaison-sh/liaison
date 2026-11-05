// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Streamable HTTP transport adapter. Wraps the SDK's
// `StreamableHTTPClientTransport`. Credentials (Authorization + custom headers)
// are attached per request by the transport's fetch. HTTP 401 (and 403
// insufficient_scope) surface as `McpAuthChallengeError` so the caller
// (per-call orchestrator) can refresh or step up.

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { dialOver } from "./dial"
import type { HttpDialOptions, LiveConnection } from "./types"

export function dialHttp(opts: HttpDialOptions): Promise<LiveConnection> {
  return dialOver(opts, (url, fetch) => new StreamableHTTPClientTransport(url, { fetch }))
}
