// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { RequestBodyTooLargeError, readRequestTextWithLimit } from "~/lib/request-body"

describe("readRequestTextWithLimit", () => {
  it("reads request text within the byte limit", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "hello",
      headers: { "content-type": "text/plain" },
    })

    await expect(readRequestTextWithLimit(request, 10)).resolves.toBe("hello")
  })

  it("rejects oversized requests from content-length before reading", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "tiny",
      headers: { "content-length": "11" },
      duplex: "half",
    } as RequestInit)

    await expect(readRequestTextWithLimit(request, 10)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    )
  })

  it("rejects oversized streamed bodies even without content-length", async () => {
    const encoder = new TextEncoder()
    const request = new Request("https://example.com", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("12345"))
          controller.enqueue(encoder.encode("67890"))
          controller.enqueue(encoder.encode("X"))
          controller.close()
        },
      }),
      duplex: "half",
    } as RequestInit)

    await expect(readRequestTextWithLimit(request, 10)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    )
  })
})
