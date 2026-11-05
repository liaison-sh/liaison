// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The desktop node calls the API from its own origin (tauri://localhost),
// cross origin: every node call carries X-Node-Credential, so the preflight
// must allow that header or the browser refuses the claim before it is sent
// (walk N2: "node job not claimed: Load failed", the job stuck in offered).
import { describe, expect, it } from "bun:test"
import { app } from "~/app"
import { NODE_CREDENTIAL_HEADER } from "./credentials"
import { NODE_PROTOCOL_HEADER } from "./jobs"

describe("CORS for the desktop node", () => {
  it("a preflight for a claim allows the node credential header", async () => {
    const res = await app.request("/api/nodes/jobs/00000000-0000-0000-0000-000000000000/claim", {
      method: "OPTIONS",
      headers: {
        Origin: "tauri://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,x-node-credential,x-liaison-node-protocol",
      },
    })
    const allowed = (res.headers.get("access-control-allow-headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim())
    expect(allowed).toContain(NODE_CREDENTIAL_HEADER.toLowerCase())
    // D46: a claim names the node protocol; without it the claim is refused.
    expect(allowed).toContain(NODE_PROTOCOL_HEADER.toLowerCase())
  })
})
