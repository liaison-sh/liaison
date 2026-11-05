// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Legacy SSE transport adapter. Deprecated in favor of Streamable HTTP, but
// kept because some MCP servers still ship only the SSE flavor.

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { dialOver } from "./dial"
import type { HttpDialOptions, LiveConnection } from "./types"

/** The SDK uses the dial's fetch for the event stream GET and the POST-back channel. */
export function dialSse(opts: HttpDialOptions): Promise<LiveConnection> {
  return dialOver(opts, (url, fetch) => new SSEClientTransport(url, { fetch }))
}
