// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { enqueueTransferLinkIngest, type TicketsServiceCtx } from "~/apps/tickets/inbound"
import * as jobsModule from "~/infra/jobs/jobs"

const ORG = "00000000-0000-0000-0000-0000000e0001"
const MSG = "00000000-0000-0000-0000-0000000e0011"

function ctx(): TicketsServiceCtx {
  return {
    db: { execute: async () => [] as never, queueEvent: async () => {} } as never,
    orgId: ORG,
  }
}

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16)
}

describe("inbound transfer-link enqueue wiring", () => {
  let enqueueSpy: ReturnType<typeof spyOn>
  afterEach(() => enqueueSpy?.mockRestore())

  it("enqueues files-link-ingest with the exact (messageId, urlHash) jobId for a whitelisted link", async () => {
    enqueueSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job-id")
    const url = "https://wetransfer.com/downloads/zzz"
    await enqueueTransferLinkIngest(ctx(), MSG, {
      messageId: "<e1@x.test>",
      textBody: `Files here: ${url}`,
    } as never)
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const call = enqueueSpy.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      { jobId: string },
    ]
    expect(call[0]).toBe("kernel")
    expect(call[1]).toBe("files-link-ingest")
    expect(call[2].messageId).toBe(MSG)
    expect(call[2].url).toBe(url)
    expect(call[3].jobId).toBe(`files-link-ingest:${MSG}:${urlHash(url)}`)
  })

  it("queues at most a few links per message, and a capped number per sender per day", async () => {
    enqueueSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job-id")
    const sender = `flood-${Date.now()}-${Math.random()}@attacker.test`
    const body = Array.from({ length: 8 }, (_, i) => `https://wetransfer.com/downloads/f${i}`).join(
      " ",
    )
    await enqueueTransferLinkIngest(ctx(), MSG, {
      from: { email: sender },
      textBody: body,
    } as never)
    expect(enqueueSpy).toHaveBeenCalledTimes(3)
    // Further mails from the same sender stop at the daily cap.
    for (let i = 0; i < 5; i++) {
      await enqueueTransferLinkIngest(ctx(), `${MSG.slice(0, -2)}${10 + i}`, {
        from: { email: sender },
        textBody: body,
      } as never)
    }
    expect(enqueueSpy).toHaveBeenCalledTimes(10)
  })

  it("does NOT enqueue when the messageId is the (initial) sentinel", async () => {
    enqueueSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job-id")
    await enqueueTransferLinkIngest(ctx(), "(initial)", {
      textBody: "Files here: https://wetransfer.com/downloads/zzz",
    } as never)
    expect(enqueueSpy).toHaveBeenCalledTimes(0)
  })

  it("does NOT enqueue for a non-whitelisted link", async () => {
    enqueueSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job-id")
    await enqueueTransferLinkIngest(ctx(), MSG, {
      textBody: "Files here: https://dropbox.com/s/xyz",
    } as never)
    expect(enqueueSpy).toHaveBeenCalledTimes(0)
  })
})
