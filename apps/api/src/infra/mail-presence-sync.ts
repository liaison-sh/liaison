// SPDX-License-Identifier: FSL-1.1-ALv2
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "mail-presence-sync" })

export async function triggerMailSyncForUser(
  orgId: string,
  userId: string,
  accounts: Array<{
    id: string
    provider: string
    sync_status: string
    last_sync_at: string | null
  }>,
  enqueueFn: (app: string, job: string, payload: any, opts?: any) => Promise<string>,
) {
  for (const account of accounts) {
    if (account.sync_status !== "active") continue

    if (account.last_sync_at) {
      const elapsed = Date.now() - new Date(account.last_sync_at).getTime()
      if (elapsed < 60_000) continue
    }

    const jobName =
      account.provider === "gmail" ? "gmail-incremental-sync" : "imap-incremental-sync"
    try {
      await enqueueFn(
        "mail",
        jobName,
        { orgId, accountId: account.id },
        { jobId: `${jobName}:${account.id}` },
      )
      log.info(
        { userId, accountId: account.id, jobName },
        "Enqueued catch-up sync for reconnected user",
      )
    } catch (err) {
      log.warn({ err, userId, accountId: account.id }, "Failed to enqueue catch-up sync")
    }
  }
}
