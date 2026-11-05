// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { triggerMailSyncForUser } from "~/infra/mail-presence-sync"

describe("triggerMailSyncForUser", () => {
  it("enqueues incremental sync for active accounts older than 60s", async () => {
    const enqueued: any[] = []
    const mockEnqueue = async (app: string, job: string, payload: any, opts?: any) => {
      enqueued.push({ app, job, payload, opts })
      return "job-1"
    }

    const accounts = [
      {
        id: "acc-1",
        provider: "gmail",
        sync_status: "active",
        last_sync_at: new Date(Date.now() - 120_000).toISOString(),
      },
      {
        id: "acc-2",
        provider: "imap",
        sync_status: "active",
        last_sync_at: new Date().toISOString(),
      },
      {
        id: "acc-3",
        provider: "gmail",
        sync_status: "disconnected",
        last_sync_at: null,
      },
    ]

    await triggerMailSyncForUser("org-1", "user-1", accounts as any, mockEnqueue)

    expect(enqueued.length).toBe(1)
    expect(enqueued[0].job).toBe("gmail-incremental-sync")
    expect(enqueued[0].payload.accountId).toBe("acc-1")
  })

  it("includes shared inbox accounts granted through mail:inbox", async () => {
    const enqueued: any[] = []
    const mockEnqueue = async (app: string, job: string, payload: any, opts?: any) => {
      enqueued.push({ app, job, payload, opts })
      return "job-1"
    }

    await triggerMailSyncForUser(
      "org-1",
      "user-1",
      [
        {
          id: "shared-1",
          provider: "imap",
          sync_status: "active",
          last_sync_at: null,
        },
      ] as any,
      mockEnqueue,
    )

    expect(enqueued).toEqual([
      expect.objectContaining({
        job: "imap-incremental-sync",
        payload: { orgId: "org-1", accountId: "shared-1" },
      }),
    ])
  })
})
