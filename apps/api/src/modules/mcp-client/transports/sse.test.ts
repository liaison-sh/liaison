// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SSE is the deprecated MCP transport. We assert the adapter constructs the
// SDK transport correctly and rejects on connection failure to a closed port.
// A full handshake against a fixture SSE server is intentionally skipped —
// the SDK's own test matrix covers the protocol; we only need to confirm our
// thin wrapper plumbs config through.

import { describe, expect, it } from "bun:test"
import { dialSse } from "~/modules/mcp-client/transports/sse"

describe("dialSse", () => {
  it("rejects fast on a closed port (no hang)", async () => {
    // Port 1 is privileged + nothing listens — should fail quickly.
    const start = Date.now()
    let threw = false
    try {
      await dialSse({
        url: "http://127.0.0.1:1/",
        bearerToken: null,
        timeoutMs: 1500,
        allowPrivate: true,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Bound the failure time so a regression to "wait full 30s default" surfaces here.
    expect(Date.now() - start).toBeLessThan(5000)
  })
})
