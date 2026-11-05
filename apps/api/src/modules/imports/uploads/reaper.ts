// SPDX-License-Identifier: FSL-1.1-ALv2
import { registerScheduledJob } from "~/infra/jobs/jobs"
import { reapExpiredImportUploads } from "./service"

/** Hourly: abort import uploads left open past their 24-hour expiry. */
export const IMPORT_UPLOAD_REAPER_CRON = "17 * * * *"

export async function registerImportUploadReaper(): Promise<void> {
  await registerScheduledJob(
    "kernel",
    "import-uploads-reaper",
    IMPORT_UPLOAD_REAPER_CRON,
    async () => {
      await reapExpiredImportUploads()
    },
  )
}
