// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { LOG_SERIALIZERS } from "~/lib/logger"
import { errorHandler } from "~/middleware/error-handler"
import { BugReportForwardError } from "./bug-report-payload"

const preview = { reporter: { email: "reporter@example.com" }, description: "it broke" }

describe("BugReportForwardError", () => {
  // Discriminator: an enumerable `details` puts the reporter's email in the
  // server log through the error serializer.
  it("keeps the preview out of the logged error", () => {
    const err = new BugReportForwardError("changed", 409, "FORWARD_PAYLOAD_CHANGED", preview)
    const logged = JSON.stringify(LOG_SERIALIZERS.err(err))
    expect(logged).not.toContain("reporter@example.com")
    expect(logged).toContain("FORWARD_PAYLOAD_CHANGED")
  })

  it("still answers the client with the preview in details", async () => {
    const app = new Hono()
    app.onError(errorHandler)
    app.get("/", () => {
      throw new BugReportForwardError("changed", 409, "FORWARD_PAYLOAD_CHANGED", preview)
    })
    const res = await app.request("/")
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: unknown } }
    expect(body.error.code).toBe("FORWARD_PAYLOAD_CHANGED")
    expect(body.error.details).toEqual(preview)
  })
})
