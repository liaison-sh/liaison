// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll } from "bun:test"
import { JobsTestAccess, registerJobWorker } from "~/infra/jobs/jobs"
import { AGENT_SUBRUN_JOB_NAME } from "~/modules/agent/subruns/spawn-agent"

type Handler = (payload: unknown) => Promise<void>

/** A queued sub-run stays queued: the job is taken and nothing runs it. */
const runNothing: Handler = async () => {}

/**
 * The sub-run job handler belongs to the test file: handlers are process-wide and a batch runs
 * several files in one process, so a file that starts the real worker would run the sub-runs the
 * next file only means to queue. Called at a file's top level. `live: false` (a file that asserts
 * on queued rows) also takes the job away from any worker started before it.
 */
export function ownSubrunHandler(opts: { live: boolean }): void {
  let before: Handler | undefined
  beforeAll(() => {
    before = JobsTestAccess.getHandler("kernel", AGENT_SUBRUN_JOB_NAME)
    if (!opts.live) registerJobWorker("kernel", AGENT_SUBRUN_JOB_NAME, runNothing)
  })
  afterAll(() => {
    registerJobWorker("kernel", AGENT_SUBRUN_JOB_NAME, before ?? runNothing)
  })
}
