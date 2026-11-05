// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S3: the host API majors this server supports, public so a client or an app
// author can ask before signing in. It answers majors only (A13): the exact
// server version is not published.
import { describe, expect, it } from "bun:test"
import { app } from "~/app"

describe("GET /api/apps/host-api", () => {
  it("answers the supported majors with no credential, and nothing else", async () => {
    const response = await app.request("/api/apps/host-api")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: unknown }
    expect(body).toEqual({ data: { majors: [1] } })
  })
})
